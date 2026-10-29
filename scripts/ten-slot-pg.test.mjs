// 실제 PostgreSQL 16에서 10슬롯 예약의 원자성을 확인한다 (#531).
//
// 여기서 확인하는 것은 모델이 아니라 **커밋된 행**이다. 백엔드를 여러 개
// 띄워 같은 캠페인을 동시에 잡게 하고, 끝난 뒤 DB에 남은 것을 센다.
//
// `TEN_SLOT_PG_URL`이 없으면 **건너뛴다고 말하고 끝낸다.** 돌지 않은 것을
// 통과로 적지 않는다 — 그게 "UNKNOWN을 0으로 적는" 일이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PG_URL_ENV, PG_RESTART_ENV, pgTarget, psql, createScratchDb, dropScratchDb,
  openCampaignSql, claimSql, parseClaim, readState, raceClaims, psqlSpawn,
  migrationPaths, restartCommand, restartCluster,
} from './ten-slot-pg.mjs';
import { createOfflineLedger, planOfflineClaim } from './ten-slot-offline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = pgTarget();
const CLEAR = { positions: 0, openOrders: 0, pendingEntries: 0 };

/** pg_sleep에 들어간 그 백엔드만 끊는다. 다른 세션은 건드리지 않는다 */
async function killSleeper(tag, db) { // db는 반드시 넘긴다
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100));
    const [killed] = psql(target, db, `SELECT count(*) FROM (
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE application_name = ${JSON.stringify(tag).replace(/"/g, "'")}
         AND state = 'active' AND query LIKE '%pg_sleep%') t`);
    if (killed !== '0') return killed;
  }
  return '0';
}

if (!target.ok) {
  test(`실제 PostgreSQL 검증을 건너뜁니다 (${target.reason})`, { skip: target.reason }, () => {});
} else {
  // 012만 적용한 DB = 097 **이전**의 실제 스키마다. RED는 여기서 재현한다.
  const red = createScratchDb(target, 'tsred', migrationPaths(root, ['012_live_orders.sql']));
  const green = createScratchDb(target, 'tsgreen',
    migrationPaths(root, ['012_live_orders.sql', '097_ten_slot_atomic_claim.sql']));
  process.on('exit', () => {
    try { dropScratchDb(target, red); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
    try { dropScratchDb(target, green); } catch { /* 같음 */ }
  });

  let seq = 0;
  const fresh = (equity = 1000) => {
    const campaignId = `c-${++seq}-${Date.now().toString(36)}`;
    const rows = psql(target, green, openCampaignSql({
      campaignId, userId: '11111111-1111-4111-8111-111111111111',
      environment: 'TESTNET', startingEquity: equity,
    }));
    assert.equal(rows[0], 'OPENED|0');
    return campaignId;
  };
  const claim = (args) => parseClaim(psql(target, green, claimSql(args)));

  // ── RED: 097 이전에는 "같은 캠페인 동시 두 건"을 막는 것이 DB에 없었다 ──
  test('★ RED — 097 이전 스키마에서는 동시 두 건이 둘 다 커밋된다', async () => {
    const signal = 'red-campaign-1';
    const insert = coid => `INSERT INTO live_orders
      (client_order_id, signal_id, exchange, mode, symbol, side, quantity, leverage, status)
      VALUES ('${coid}', '${signal}', 'binance', 'TESTNET', 'BTCUSDT', 'BUY', 0.001, 10, 'INTENT')`;
    const results = await raceClaims(target, red, [insert('red-a'), insert('red-b')], 991001);
    assert.equal(results.filter(r => r.code === 0).length, 2, '둘 다 성공해야 RED가 재현된다');
    const [count] = psql(target, red,
      `SELECT count(*) FROM live_orders WHERE signal_id = '${signal}' AND status = 'INTENT'`);
    // 한 포지션만 허용하는 캠페인에 **의도가 두 건** 남았다.
    // 012의 유일한 방어선은 client_order_id 전역 UNIQUE이고, ID가 다르면 통과한다.
    assert.equal(count, '2');
  });

  test('★ GREEN — 같은 버전으로 동시에 들어온 8건 중 정확히 하나만 예약된다', async () => {
    const campaignId = fresh();
    const statements = Array.from({ length: 8 }, (_, i) =>
      claimSql({ campaignId, expectedVersion: 0, clientOrderId: `race-${campaignId}-${i}` }));
    const results = await raceClaims(target, green, statements);
    const codes = results.map(r => parseClaim(r.rows.filter(l => l.includes('|'))).code);
    assert.equal(codes.filter(c => c === 'RESERVATION_AND_INTENT_DURABLE').length, 1);
    // 진 쪽은 **버전을 보고 진 것**이다. 아무도 "성공했는지 모르겠다"로 끝나지 않는다.
    assert.equal(codes.filter(c => c === 'STALE_VERSION').length, 7);
    const s = readState(target, green, campaignId);
    assert.deepEqual(
      { version: s.version, active: s.active, claims: s.claims, intents: s.intents },
      { version: 1, active: 1, claims: 1, intents: 1 });
    assert.equal(s.statuses[0], 'RESERVED');
  });

  test('동시 작업자가 새 버전을 다시 읽고 들어오면 SLOT_BUSY로 막힌다', () => {
    const campaignId = fresh();
    const first = claim({ campaignId, expectedVersion: 0, clientOrderId: `busy-${campaignId}-a` });
    assert.equal(first.code, 'RESERVATION_AND_INTENT_DURABLE');
    const second = claim({ campaignId, expectedVersion: first.version, clientOrderId: `busy-${campaignId}-b` });
    assert.equal(second.code, 'SLOT_BUSY');
    const s = readState(target, green, campaignId);
    assert.equal(s.version, 1);
    assert.equal(s.claims, 1);
  });

  test('잠금을 쥔 트랜잭션이 커밋될 때까지 뒤에 온 요청은 기다린 뒤 진다', async () => {
    const campaignId = fresh();
    // 캠페인 줄을 먼저 잠그고 2초 쥔다. 그 사이 두 번째 요청이 들어온다.
    // 한 문장으로 보내면 psql이 전부 한 트랜잭션으로 보낸다 — 잠금이 끝까지 유지된다.
    const holder = psqlSpawn(target, green,
      `SELECT version FROM ten_slot_campaigns WHERE campaign_id = '${campaignId}' FOR UPDATE;
       SELECT pg_sleep(1.5);
       ${claimSql({ campaignId, expectedVersion: 0, clientOrderId: `wait-${campaignId}-a` })};`);
    await new Promise(r => setTimeout(r, 400));
    const started = Date.now();
    const latecomer = psqlSpawn(target, green,
      claimSql({ campaignId, expectedVersion: 0, clientOrderId: `wait-${campaignId}-b` }));
    const [a, b] = await Promise.all([holder.done, latecomer.done]);
    assert.equal(a.code, 0, a.err);
    assert.equal(b.code, 0, b.err);
    // 뒤에 온 쪽은 **기다렸다.** 즉 판단이 잠금 안에서 일어났다.
    assert.ok(Date.now() - started > 700, '잠금을 기다리지 않았습니다 — 판단이 잠금 밖에 있습니다');
    assert.equal(parseClaim(b.rows ?? b.out.split('\n').filter(Boolean)).code, 'STALE_VERSION');
    const s = readState(target, green, campaignId);
    assert.equal(s.claims, 1);
  });

  test('같은 client_order_id 재시도는 두 번째 의도를 만들지 않는다', () => {
    const campaignId = fresh();
    const coid = `retry-${campaignId}`;
    const first = claim({ campaignId, expectedVersion: 0, clientOrderId: coid });
    assert.equal(first.code, 'RESERVATION_AND_INTENT_DURABLE');
    const before = readState(target, green, campaignId);
    // 응답을 못 받았다고 생각한 호출부가 **같은 ID로 다시** 들어온다.
    const again = claim({ campaignId, expectedVersion: 0, clientOrderId: coid });
    assert.equal(again.code, 'ORDER_ID_REUSED');
    assert.deepEqual(readState(target, green, campaignId), before);
    const [orders] = psql(target, green,
      `SELECT count(*) FROM live_orders WHERE client_order_id = '${coid}'`);
    assert.equal(orders, '1');
  });

  test('다른 경로가 먼저 쓴 client_order_id는 예약을 만들지 않는다', () => {
    const campaignId = fresh();
    const coid = `foreign-${campaignId}`;
    psql(target, green, `INSERT INTO live_orders
      (client_order_id, exchange, mode, symbol, side, quantity, leverage, status)
      VALUES ('${coid}', 'binance', 'TESTNET', 'BTCUSDT', 'BUY', 0.001, 10, 'SENT')`);
    const r = claim({ campaignId, expectedVersion: 0, clientOrderId: coid });
    assert.equal(r.code, 'ORDER_ID_REUSED');
    const s = readState(target, green, campaignId);
    assert.equal(s.version, 0);
    assert.equal(s.active, 0);
    assert.equal(s.claims, 0);
  });

  // ── 롤백: 한쪽만 남는 상태가 만들어질 수 있는가 ──
  for (const victim of ['ten_slot_claims', 'live_orders']) {
    test(`${victim} 쓰기가 실패하면 예약과 의도가 함께 되돌아간다`, () => {
      const campaignId = fresh();
      const coid = `rollback-${victim}-${campaignId}`;
      psql(target, green, `CREATE OR REPLACE FUNCTION pg_temp_fail() RETURNS TRIGGER
        LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''주입된 쓰기 실패''; END';
        CREATE TRIGGER ten_slot_fail_${victim} BEFORE INSERT ON ${victim}
        FOR EACH ROW EXECUTE FUNCTION pg_temp_fail()`);
      try {
        const r = psql(target, green, claimSql({ campaignId, expectedVersion: 0, clientOrderId: coid }),
          { expectError: true });
        // 함수가 **삼키지 않는다.** 모르는 실패를 '중복'으로 바꾸면 고장이 사라진다.
        assert.match(r.error, /주입된 쓰기 실패/);
      } finally {
        psql(target, green, `DROP TRIGGER ten_slot_fail_${victim} ON ${victim};
          DROP FUNCTION pg_temp_fail()`);
      }
      const s = readState(target, green, campaignId);
      assert.deepEqual({ version: s.version, active: s.active, claims: s.claims },
        { version: 0, active: 0, claims: 0 });
      const [orders] = psql(target, green,
        `SELECT count(*) FROM live_orders WHERE client_order_id = '${coid}'`);
      assert.equal(orders, '0', '의도만 남았습니다 — 한 트랜잭션이 아닙니다');
    });
  }

  test('커밋 전에 백엔드가 죽으면 아무것도 남지 않는다', async () => {
    const campaignId = fresh();
    const coid = `crash-before-${campaignId}`;
    const tag = `crash_before_${seq}`;
    const worker = psqlSpawn(target, green, [
      `SET application_name = '${tag}'`,
      'BEGIN',
      claimSql({ campaignId, expectedVersion: 0, clientOrderId: coid }),
      'SELECT pg_sleep(30)',
      'COMMIT',
    ]);
    // 커밋 전에 **그 백엔드만** 끊는다.
    const killed = await killSleeper(tag, green);
    assert.equal(killed, '1', '대상 백엔드를 찾지 못했습니다');
    await worker.done;
    const s = readState(target, green, campaignId);
    assert.deepEqual({ version: s.version, active: s.active, claims: s.claims, intents: s.intents },
      { version: 0, active: 0, claims: 0, intents: 0 });
  });

  test('커밋 뒤 응답이 유실돼도 재조회로 확정되고 두 번째 주문을 만들지 않는다', async () => {
    const campaignId = fresh();
    const coid = `lost-ack-${campaignId}`;
    const tag = `lost_ack_${seq}`;
    const worker = psqlSpawn(target, green, [
      `SET application_name = '${tag}'`,
      claimSql({ campaignId, expectedVersion: 0, clientOrderId: coid }),
      'SELECT pg_sleep(30)',
    ]);
    // 커밋은 끝났고 응답만 못 받은 상태를 만든다.
    assert.equal(await killSleeper(tag, green), '1');
    await worker.done;
    // 호출부는 결과를 모른다. **client_order_id로 재조회해 확정한다.**
    const [found] = psql(target, green, `SELECT status FROM live_orders WHERE client_order_id = '${coid}'`);
    assert.equal(found, 'INTENT');
    // 그 상태에서 다시 예약을 시도해도 두 번째 의도는 생기지 않는다.
    assert.equal(claim({ campaignId, expectedVersion: 0, clientOrderId: coid }).code, 'ORDER_ID_REUSED');
    const s = readState(target, green, campaignId);
    assert.deepEqual({ version: s.version, active: s.active, claims: s.claims, intents: s.intents },
      { version: 1, active: 1, claims: 1, intents: 1 });
  });

  test('재시작 뒤에도 커밋된 예약과 의도가 그대로이고 재시도는 막힌다',
    { skip: restartCommand() ? false : `${PG_RESTART_ENV}가 없습니다` }, () => {
      const campaignId = fresh();
      const coid = `restart-${campaignId}`;
      const first = claim({ campaignId, expectedVersion: 0, clientOrderId: coid });
      assert.equal(first.code, 'RESERVATION_AND_INTENT_DURABLE');
      const before = readState(target, green, campaignId);
      psql(target, green, 'CHECKPOINT');
      restartCluster();
      assert.deepEqual(readState(target, green, campaignId), before);
      assert.equal(claim({ campaignId, expectedVersion: before.version, clientOrderId: coid }).code,
        'ORDER_ID_REUSED');
      // 활성 슬롯이 남아 있으므로 **새 ID로도** 새 예약은 열리지 않는다.
      assert.equal(claim({ campaignId, expectedVersion: before.version, clientOrderId: `${coid}-2` }).code,
        'SLOT_BUSY');
    });

  test('중지된 캠페인은 예약하지 않고, 중지 재시도는 버전을 올리지 않는다', () => {
    const campaignId = fresh();
    assert.deepEqual(psql(target, green,
      `SELECT code, campaign_version FROM ten_slot_kill('${campaignId}')`), ['KILL_PERSISTED|1']);
    assert.deepEqual(psql(target, green,
      `SELECT code, campaign_version FROM ten_slot_kill('${campaignId}')`), ['KILL_ALREADY_PERSISTED|1']);
    assert.equal(claim({ campaignId, expectedVersion: 1, clientOrderId: `killed-${campaignId}` }).code,
      'KILL_SWITCH');
    const s = readState(target, green, campaignId);
    assert.equal(s.version, 1);
    assert.equal(s.claims, 0);
    assert.equal(s.killed, true);
  });

  test('노출을 확인하지 못하면 0으로 적지 않고 막는다', () => {
    const campaignId = fresh();
    for (const exposure of [
      { positions: null, openOrders: 0, pendingEntries: 0 },
      { positions: 0, openOrders: null, pendingEntries: 0 },
      { positions: 0, openOrders: 0, pendingEntries: null },
      { positions: -1, openOrders: 0, pendingEntries: 0 },
    ]) {
      assert.equal(claim({ campaignId, expectedVersion: 0, clientOrderId: `exp-${campaignId}-${Math.random()}`, exposure }).code,
        'EXPOSURE_UNKNOWN');
    }
    assert.equal(claim({ campaignId, expectedVersion: 0, clientOrderId: `busyexp-${campaignId}`,
      exposure: { positions: 1, openOrders: 0, pendingEntries: 0 } }).code, 'EXPOSURE_BUSY');
    const s = readState(target, green, campaignId);
    assert.equal(s.version, 0);
    assert.equal(s.intents, 0);
  });

  test('FREE 슬롯이 없으면 EXHAUSTED이고, 슬롯 배열이 깨지면 고치지 않고 거절한다', () => {
    const campaignId = fresh();
    psql(target, green, `UPDATE ten_slot_slots SET status = 'SPENT' WHERE campaign_id = '${campaignId}'`);
    assert.equal(claim({ campaignId, expectedVersion: 0, clientOrderId: `ex-${campaignId}` }).code, 'EXHAUSTED');
    // SPENT 앞머리 → 활성 → FREE 꼬리가 깨진 스냅샷
    psql(target, green, `UPDATE ten_slot_slots SET status = 'FREE'
      WHERE campaign_id = '${campaignId}' AND slot_index = 0`);
    assert.equal(claim({ campaignId, expectedVersion: 0, clientOrderId: `cc-${campaignId}` }).code,
      'COUPLING_CORRUPT');
    psql(target, green, `DELETE FROM ten_slot_slots WHERE campaign_id = '${campaignId}' AND slot_index = 9`);
    assert.equal(claim({ campaignId, expectedVersion: 0, clientOrderId: `cc2-${campaignId}` }).code,
      'COUPLING_CORRUPT');
  });

  test('없는 캠페인은 만들지 않고, 개설 재호출은 버전을 올리지 않는다', () => {
    assert.equal(claim({ campaignId: 'no-such-campaign', expectedVersion: 0, clientOrderId: 'nc-1' }).code,
      'CAMPAIGN_MISSING');
    const campaignId = fresh();
    const open = openCampaignSql({ campaignId, userId: '11111111-1111-4111-8111-111111111111',
      environment: 'TESTNET', startingEquity: 1000 });
    assert.deepEqual(psql(target, green, open), ['ALREADY_OPEN|0']);
    assert.equal(readState(target, green, campaignId).statuses.length, 10);
  });

  test('의도가 성립하지 않으면 거절한다', () => {
    const campaignId = fresh();
    for (const args of [
      { clientOrderId: null }, { clientOrderId: '   ' }, { clientOrderId: 'x'.repeat(129) },
      { clientOrderId: `lots-${campaignId}`, requestedLots: 0 },
      { clientOrderId: `lots2-${campaignId}`, requestedLots: null },
    ]) {
      assert.equal(claim({ campaignId, expectedVersion: 0, ...args }).code, 'INTENT_INVALID');
    }
    assert.equal(readState(target, green, campaignId).version, 0);
  });

  test('활성 슬롯 둘은 DB가 거절한다 — 응용 코드가 빼먹어도', () => {
    const campaignId = fresh();
    assert.equal(claim({ campaignId, expectedVersion: 0, clientOrderId: `idx-${campaignId}` }).code,
      'RESERVATION_AND_INTENT_DURABLE');
    // FOR UPDATE를 거치지 않는 직접 갱신. 제약이 마지막 방어선이다.
    const r = psql(target, green, `UPDATE ten_slot_slots SET status = 'RESERVED'
      WHERE campaign_id = '${campaignId}' AND slot_index = 1`, { expectError: true });
    assert.match(r.error, /ten_slot_active_one/);
  });

  test('authenticated는 예약 함수를 실행할 수 없다', () => {
    const campaignId = fresh();
    const r = psql(target, green, `SET ROLE authenticated;
      ${claimSql({ campaignId, expectedVersion: 0, clientOrderId: `role-${campaignId}` })}`,
      { expectError: true });
    assert.match(r.error, /permission denied|권한/i);
    assert.equal(readState(target, green, campaignId).version, 0);
  });

  // ── 같은 판단이 두 곳에 있다. 어긋나면 여기서 드러난다 ──
  //
  // SQL 함수와 `planOfflineClaim()`은 같은 코드 이름을 돌려주기로 했다.
  // 로직을 복제하지 않는 쪽이 낫지만 원자성은 DB 안에서만 보장할 수 있다.
  // 그래서 복제를 **전수 비교로 묶어 둔다.**
  test('SQL 판정과 오프라인 정본이 모든 경우에 같은 코드를 돌려준다', () => {
    const cases = [];
    const statuses = ['FREE', 'SPENT', 'RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN'];
    for (const spent of [0, 1, 9, 10]) {
      for (const active of statuses) {
        if (spent === 10 && active !== 'FREE') continue;
        for (const exposure of [CLEAR, { positions: 1, openOrders: 0, pendingEntries: 0 },
          { positions: 0, openOrders: 2, pendingEntries: 0 }, { positions: 0, openOrders: 0, pendingEntries: 3 }]) {
          for (const killed of [false, true]) {
            for (const versionOffset of [0, 1]) {
              cases.push({ spent, active, exposure, killed, versionOffset });
            }
          }
        }
      }
    }
    let compared = 0;
    for (const c of cases) {
      const campaignId = fresh();
      // 오프라인 정본의 상태를 만든다 (버전은 전이 수로 맞춘다).
      let ledger = createOfflineLedger(campaignId, 1000);
      const wanted = ledger.slots.map((_, i) =>
        i < c.spent ? 'SPENT' : (i === c.spent && c.active !== 'FREE' ? c.active : 'FREE'));
      ledger = { ...ledger, killed: c.killed, version: 7,
        slots: ledger.slots.map((s, i) => ({ ...s, status: wanted[i] })) };
      const sql = wanted.map((status, i) =>
        `UPDATE ten_slot_slots SET status = '${status}' WHERE campaign_id = '${campaignId}' AND slot_index = ${i};`)
        .join('\n');
      psql(target, green, `${sql}
        UPDATE ten_slot_campaigns SET version = 7, killed = ${c.killed}
         WHERE campaign_id = '${campaignId}';`);
      const expectedVersion = 7 + c.versionOffset;
      const offline = planOfflineClaim(ledger, expectedVersion, c.exposure);
      const actual = claim({ campaignId, expectedVersion,
        clientOrderId: `diff-${campaignId}`, exposure: c.exposure });
      const offlineCode = offline.ok ? 'RESERVATION_AND_INTENT_DURABLE' : offline.code;
      // 오프라인은 불가능한 스냅샷을 LEDGER_UNKNOWN으로 묶는다. SQL은
      // COUPLING_CORRUPT로 묶는다 — 같은 뜻의 다른 이름이다.
      const normalise = code => (code === 'LEDGER_UNKNOWN' ? 'COUPLING_CORRUPT' : code);
      assert.equal(normalise(actual.code), normalise(offlineCode),
        `어긋남: spent=${c.spent} active=${c.active} killed=${c.killed} ` +
        `offset=${c.versionOffset} exposure=${JSON.stringify(c.exposure)}`);
      if (actual.code === 'RESERVATION_AND_INTENT_DURABLE') {
        assert.equal(actual.slotIndex, offline.index);
      }
      compared++;
    }
    assert.ok(compared >= 160, `비교한 경우가 너무 적습니다 (${compared})`);
  });
}
