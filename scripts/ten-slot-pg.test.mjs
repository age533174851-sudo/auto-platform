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
  migrationPaths, restartCommand, restartCluster, intentRow,
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
  // **운영 스키마와 같은 칸을 깔아 둔다.**
  //
  //   097은 `live_orders`에 의도를 적는다. 그 표의 칸은 012 이후
  //   078(`stop_policy`) · 090(실행 계약 세 칸) · 091(진입 위험 좌표 두 칸)이
  //   더한다. 097보다 번호가 작으므로 **운영 DB에는 이미 있는 칸**이다.
  //
  //   여기서 012만 깔면 시험은 "그 칸이 없는 DB"를 보게 되고, 097이 그
  //   칸을 못 적는 것이 결함인지 스키마가 없어서인지 구분할 수 없다.
  //   운영과 같은 모양을 깔아야 **적지 않는 것이 결함으로 드러난다.**
  const SCHEMA = [
    '012_live_orders.sql',
    '078_live_orders_stop_policy.sql',
    '090_live_orders_execution_identity.sql',
    '091_live_orders_entry_risk_snapshot.sql',
  ];
  // 097 **이전**의 실제 스키마다. RED는 여기서 재현한다.
  const red = createScratchDb(target, 'tsred', migrationPaths(root, SCHEMA));
  const green = createScratchDb(target, 'tsgreen',
    migrationPaths(root, [...SCHEMA, '097_ten_slot_atomic_claim.sql']));
  process.on('exit', () => {
    try { dropScratchDb(target, red); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
    try { dropScratchDb(target, green); } catch { /* 같음 */ }
  });

  let seq = 0;
  const fresh = (equity = 1000, environment = 'TESTNET') => {
    const campaignId = `c-${++seq}-${Date.now().toString(36)}`;
    const rows = psql(target, green, openCampaignSql({
      campaignId, userId: '11111111-1111-4111-8111-111111111111',
      environment, startingEquity: equity,
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

  // ── 환경 경계 — MOCK / TESTNET / LIVE의 장부는 절대 섞이지 않는다 ──
  //
  // RPC가 `p_mode`를 **호출자에게서 받아** `live_orders.mode`에 그대로
  // 적었다. 캠페인의 `environment`와 비교하는 코드가 한 줄도 없어서,
  // TESTNET 캠페인이 `mode='LIVE'`인 의도를 커밋할 수 있었다. 라우트가
  // 아직 안 붙어 실제 주문이 나간 적은 없지만, 붙는 순간 TESTNET/LIVE
  // 격리가 깨진다. `CLAUDE.md`의 절대 규칙이라 미리 막는다.
  test('★ 캠페인 환경과 주문 모드가 어긋나면 예약도 의도도 만들지 않는다', () => {
    for (const [environment, mode] of [
      ['TESTNET', 'LIVE'], ['LIVE', 'TESTNET'],
      ['TESTNET', null], ['TESTNET', 'PAPER'], ['LIVE', 'MOCK'],
    ]) {
      const campaignId = fresh(1000, environment);
      const r = claim({ campaignId, expectedVersion: 0, mode,
        clientOrderId: `envmix-${campaignId}` });
      assert.equal(r.code, 'ENVIRONMENT_MISMATCH',
        `환경 ${environment} 캠페인이 mode=${mode} 의도를 받았다`);
      const s = readState(target, green, campaignId);
      assert.deepEqual({ version: s.version, active: s.active, claims: s.claims, intents: s.intents },
        { version: 0, active: 0, claims: 0, intents: 0 },
        `환경 ${environment} / mode ${mode}에서 무언가 남았다`);
    }
  });

  test('★ MOCK 캠페인은 실거래 장부에 의도를 적지 않는다', () => {
    for (const mode of ['TESTNET', 'LIVE', 'MOCK', null]) {
      const campaignId = fresh(1000, 'MOCK');
      const r = claim({ campaignId, expectedVersion: 0, mode,
        clientOrderId: `mock-${campaignId}` });
      // 모의 장부를 실거래 장부로 조용히 바꾸지 않는다. 막고 말한다.
      assert.equal(r.code, 'MOCK_NOT_TRADABLE', `MOCK 캠페인이 mode=${mode}로 통과했다`);
      const s = readState(target, green, campaignId);
      assert.deepEqual({ version: s.version, claims: s.claims, intents: s.intents },
        { version: 0, claims: 0, intents: 0 });
    }
  });

  test('★ 장부에 적히는 환경은 호출자 값이 아니라 캠페인에서 나온다', () => {
    for (const environment of ['TESTNET', 'LIVE']) {
      const campaignId = fresh(1000, environment);
      const coid = `envok-${campaignId}`;
      const r = claim({ campaignId, expectedVersion: 0, mode: environment, clientOrderId: coid });
      assert.equal(r.code, 'RESERVATION_AND_INTENT_DURABLE');
      const [row] = psql(target, green,
        `SELECT mode FROM live_orders WHERE client_order_id = '${coid}'`);
      assert.equal(row, environment, `장부에 ${row}가 적혔다 (캠페인은 ${environment})`);
    }
  });

  // ── 캠페인 정체성 — 같은 ID를 다른 주인·다른 환경으로 열 수 없다 ──
  //
  // `ten_slot_open_campaign`은 `campaign_id`로 줄이 있으면 **무조건**
  // `ALREADY_OPEN`을 돌려줬다. 저장된 `user_id`·`connection_id`·
  // `environment`·`starting_equity`를 요청 값과 대조하는 코드가 없었다.
  // `ten_slot_claim`은 저장된 캠페인의 user/connection을 `live_orders`에
  // 적으므로, 호출자가 `ALREADY_OPEN`을 성공으로 읽으면 **남의 캠페인을
  // 자기 것으로 오인한 채** 주문 의도를 적게 된다.
  const OWNER_A = '11111111-1111-4111-8111-111111111111';
  const OWNER_B = '22222222-2222-4222-8222-222222222222';
  const CONN_A = '33333333-3333-4333-8333-333333333333';
  const openSql = (campaignId, o = {}) => openCampaignSql({
    campaignId, userId: o.userId ?? OWNER_A,
    connectionId: o.connectionId === undefined ? CONN_A : o.connectionId,
    environment: o.environment ?? 'TESTNET',
    startingEquity: o.startingEquity ?? 1000,
  });
  /** 저장된 줄을 그대로 읽는다 — 함수가 무엇을 돌려줬는지와 별개로 본다 */
  const storedRow = (campaignId) => psql(target, green,
    `SELECT user_id || '|' || coalesce(connection_id::text, '-') || '|' || environment
            || '|' || starting_equity || '|' || version
       FROM ten_slot_campaigns WHERE campaign_id = '${campaignId}'`)[0];

  test('★ 같은 정체성으로 다시 열면 멱등이다 — 아무것도 바뀌지 않는다', () => {
    const campaignId = `ident-same-${++seq}-${Date.now().toString(36)}`;
    assert.deepEqual(psql(target, green, openSql(campaignId)), ['OPENED|0']);
    const before = storedRow(campaignId);
    assert.deepEqual(psql(target, green, openSql(campaignId)), ['ALREADY_OPEN|0']);
    assert.equal(storedRow(campaignId), before);
    assert.equal(readState(target, green, campaignId).statuses.length, 10);
  });

  test('★ 같은 ID를 다른 정체성으로 열면 ALREADY_OPEN으로 성공처럼 끝나지 않는다', () => {
    const variants = [
      ['다른 주인', { userId: OWNER_B }],
      ['연결 없음', { connectionId: null }],
      ['다른 연결', { connectionId: '44444444-4444-4444-8444-444444444444' }],
      ['TESTNET → LIVE', { environment: 'LIVE' }],
      ['TESTNET → MOCK', { environment: 'MOCK' }],
      ['다른 시작 자본', { startingEquity: 5000 }],
    ];
    for (const [label, over] of variants) {
      const campaignId = `ident-${++seq}-${Date.now().toString(36)}`;
      assert.deepEqual(psql(target, green, openSql(campaignId)), ['OPENED|0']);
      const before = storedRow(campaignId);
      assert.deepEqual(psql(target, green, openSql(campaignId, over)),
        ['CAMPAIGN_IDENTITY_MISMATCH|0'], `${label}이 ALREADY_OPEN으로 통과했다`);
      // 저장된 줄은 한 글자도 바뀌지 않았다.
      assert.equal(storedRow(campaignId), before, `${label}에서 저장된 캠페인이 바뀌었다`);
      const st = readState(target, green, campaignId);
      assert.deepEqual({ version: st.version, claims: st.claims, intents: st.intents },
        { version: 0, claims: 0, intents: 0 });
    }
  });

  test('★ 같은 ID를 동시에 열어도 예외가 아니라 정해진 코드로 끝난다', async () => {
    // 없는 줄의 FOR UPDATE는 삽입 경쟁을 직렬화하지 못한다 — 둘 다 INSERT로 간다.
    for (const [label, over, loser] of [
      ['같은 정체성', {}, 'ALREADY_OPEN'],
      ['다른 정체성', { userId: OWNER_B }, 'CAMPAIGN_IDENTITY_MISMATCH'],
    ]) {
      const campaignId = `ident-race-${++seq}-${Date.now().toString(36)}`;
      const results = await raceClaims(target, green,
        [openSql(campaignId), openSql(campaignId, over)], 991777);
      for (const r of results) {
        assert.equal(r.code, 0, `${label}: 호출이 예외로 끝났다 — ${r.err}`);
      }
      const codes = results
        .map(r => (r.rows.find(l => l.includes('|')) || '').split('|')[0]).sort();
      assert.deepEqual(codes, [loser, 'OPENED'].sort(),
        `${label}: 동시 개설 결과가 ${codes}다`);
      // 슬롯은 정확히 10줄. 두 번 들어가지 않았다.
      assert.equal(readState(target, green, campaignId).statuses.length, 10);
    }
  });

  // ── 주문 의도가 **모양부터** 성립하는가 ──
  //
  // `INTENT_INVALID` 검사에는 `client_order_id`와 `requested_lots`뿐이었다.
  // `quantity`·`leverage`·`symbol`·`side`·`exchange`·`order_type`·LIMIT 가격은
  // 아무 검사 없이 `live_orders`에 들어갔고, `012`에도 그 칸들의 CHECK가 없다.
  // 그래서 수량 -0.001, 배율 -1, 빈 종목, `side='HOLD'` 같은 입력이
  // **내구적으로 예약**될 수 있었다 — 전송은 반드시 실패하는데 슬롯은
  // RESERVED로 잡힌 채 남는다.
  //
  // 여기서 보는 것은 **도메인(어디서도 유효하지 않은 값)**이다. 거래소별
  // LOT_SIZE·틱·배율 한도는 SQL에 복제하지 않는다 — 그 정본은 실행기다.
  test('★ 모양이 성립하지 않는 주문 의도는 예약도 만들지 않는다', () => {
    const bad = [
      ['수량 음수', { quantity: -0.001 }],
      ['수량 0', { quantity: 0 }],
      ['수량 없음', { quantity: null }],
      ['배율 음수', { leverage: -1 }],
      ['배율 0', { leverage: 0 }],
      ['진입인데 배율 없음', { leverage: null }],
      ['빈 종목', { symbol: '' }],
      ['공백 종목', { symbol: '   ' }],
      ['종목 없음', { symbol: null }],
      ['알 수 없는 방향', { side: 'HOLD' }],
      ['방향 없음', { side: null }],
      ['알 수 없는 거래소', { exchange: 'not-a-venue' }],
      ['거래소 없음', { exchange: null }],
      ['알 수 없는 주문유형', { orderType: 'INVALID' }],
      ['LIMIT인데 가격 없음', { orderType: 'LIMIT', price: null }],
      ['LIMIT인데 가격 0', { orderType: 'LIMIT', price: 0 }],
      ['LIMIT인데 가격 음수', { orderType: 'LIMIT', price: -100 }],
    ];
    for (const [label, over] of bad) {
      const campaignId = fresh();
      const r = claim({ campaignId, expectedVersion: 0,
        clientOrderId: `shape-${campaignId}`, ...over });
      assert.equal(r.code, 'INTENT_INVALID', `${label}이 예약됐다`);
      const st = readState(target, green, campaignId);
      assert.deepEqual({ version: st.version, active: st.active, claims: st.claims, intents: st.intents },
        { version: 0, active: 0, claims: 0, intents: 0 }, `${label}에서 무언가 남았다`);
    }
  });

  test('★ 정당한 주문은 막지 않는다 — MARKET · LIMIT · 청산(배율 없음)', () => {
    const good = [
      ['MARKET 진입', {}],
      ['LIMIT 진입', { orderType: 'LIMIT', price: 95000 }],
      ['SELL 진입', { side: 'SELL' }],
      ['Gate 거래소', { exchange: 'gate' }],
      // 청산은 배율이 없을 수 있다 — 실행기도 reduceOnly에서는 배율을 요구하지 않는다.
      ['청산(배율 없음)', { reduceOnly: true, leverage: null }],
    ];
    for (const [label, over] of good) {
      const campaignId = fresh();
      const r = claim({ campaignId, expectedVersion: 0,
        clientOrderId: `shapeok-${campaignId}`, ...over });
      assert.equal(r.code, 'RESERVATION_AND_INTENT_DURABLE', `${label}을 잘못 막았다`);
    }
  });

  // ── 무한대와 너무 짧은 주문 ID ──
  //
  // `NUMERIC`에는 `'Infinity'`가 있다. **NaN도 아니고 0 이하도 아니라서**
  // 앞의 모양 검사를 그대로 통과한다. 실행기는 `isFinite`로 막는데 SQL은
  // 막지 않았다. 그리고 `client_order_id`는 SQL이 1자부터 받는데
  // 실행기는 4자 미만을 거절한다 — 예약은 되고 전송은 안 되는 조합이다.
  test('★ 무한대 수량·가격은 예약도 만들지 않는다', () => {
    for (const [label, over] of [
      ['수량 Infinity', { quantityExpr: "'Infinity'::numeric" }],
      ['수량 -Infinity', { quantityExpr: "'-Infinity'::numeric" }],
      ['LIMIT 가격 Infinity', { orderType: 'LIMIT', priceExpr: "'Infinity'::numeric" }],
      ['MARKET 가격 Infinity', { priceExpr: "'Infinity'::numeric" }],
    ]) {
      const campaignId = fresh();
      const r = claim({ campaignId, expectedVersion: 0,
        clientOrderId: `inf-${campaignId}`, ...over });
      assert.equal(r.code, 'INTENT_INVALID', `${label}이 예약됐다`);
      const st = readState(target, green, campaignId);
      assert.deepEqual({ version: st.version, active: st.active, claims: st.claims, intents: st.intents },
        { version: 0, active: 0, claims: 0, intents: 0 }, `${label}에서 무언가 남았다`);
    }
  });

  test('★ 쓸 수 없는 시작 자본으로는 캠페인을 열지 않는다', () => {
    for (const [label, expr] of [
      ['Infinity', "'Infinity'::numeric"],
      ['-Infinity', "'-Infinity'::numeric"],
      ['NaN', "'NaN'::numeric"],
      ['0', '0'],
      ['음수', '-1'],
      ['없음', 'NULL'],
    ]) {
      const campaignId = `inf-eq-${++seq}-${Date.now().toString(36)}`;
      // 예외가 아니라 **호출부가 읽을 수 있는 코드**로 돌려준다.
      assert.deepEqual(psql(target, green, openCampaignSql({
        campaignId, userId: '11111111-1111-4111-8111-111111111111',
        environment: 'TESTNET', startingEquityExpr: expr,
      })), ['CAMPAIGN_INVALID|'], `${label} 시작 자본이 통과했다`);
      const [count] = psql(target, green,
        `SELECT count(*) FROM ten_slot_campaigns WHERE campaign_id = '${campaignId}'`);
      assert.equal(count, '0', `${label} 시작 자본의 캠페인이 저장됐다`);
    }
  });

  test('★ 함수를 거치지 않아도 쓸 수 없는 시작 자본은 표가 거절한다', () => {
    // 함수의 판정과 표의 CHECK는 같은 식을 **두 곳에** 적고 있다.
    // 어긋나면 여기서 드러난다 — 함수를 우회한 직접 INSERT가 통과하면 안 된다.
    for (const expr of ["'Infinity'::numeric", "'NaN'::numeric", '0', '-1']) {
      const r = psql(target, green, `INSERT INTO ten_slot_campaigns
        (campaign_id, user_id, environment, starting_equity)
        VALUES ('direct-${++seq}', '11111111-1111-4111-8111-111111111111',
                'TESTNET', ${expr})`, { expectError: true });
      assert.match(r.error, /ten_slot_campaigns_equity_chk|not-null/,
        `직접 INSERT로 ${expr}가 들어갔다`);
    }
  });

  test('★ 주문 ID 최소 길이가 실행기와 같다 (4자)', () => {
    for (const coid of ['a', 'ab', 'abc']) {
      const campaignId = fresh();
      const r = claim({ campaignId, expectedVersion: 0, clientOrderId: coid });
      assert.equal(r.code, 'INTENT_INVALID', `${coid.length}자 주문 ID가 예약됐다`);
      const st = readState(target, green, campaignId);
      assert.deepEqual({ version: st.version, claims: st.claims }, { version: 0, claims: 0 });
    }
    // 4자는 실행기가 받는다 — 여기서도 막지 않는다.
    const ok = fresh();
    assert.equal(claim({ campaignId: ok, expectedVersion: 0, clientOrderId: 'abcd' }).code,
      'RESERVATION_AND_INTENT_DURABLE', '실행기가 받는 4자 ID를 잘못 막았다');
  });

  // ── 손상 판정이 오프라인 정본과 같은 선을 긋는가 ──
  //
  // SQL은 "슬롯 10줄 · 활성 <=1 · 최초 FREE 인덱스 == 비FREE 개수"만 봤다.
  // 그건 **비FREE가 앞쪽에 몰려 있는가**만 보는 것이고, 그 앞쪽 안에서
  // SPENT가 먼저인지(SPENT* → 활성? → FREE*)는 보지 않는다.
  // `validSlotOrder`는 본다. 그래서 `[RESERVED, SPENT, FREE×8]` 같은
  // 손상된 장부를 SQL은 통과시키고 `SLOT_BUSY`(일시적으로 바쁨)로 적었다 —
  // **장부가 깨진 것을 바쁜 것으로 잘못 분류**하면 원인을 못 찾는다.
  //
  // 앞의 304건 비교는 `SPENT* → 활성? → FREE*` 모양만 만들었기 때문에
  // 이 역순을 한 번도 보지 않았다. 그래서 여기서 따로 본다.
  //
  // 활성 둘은 `ten_slot_active_one`이 애초에 못 만들게 하므로 DB에서
  // 구성할 수 없다 — 표현 불가능한 것은 비교 대상이 아니다.
  const arrangeSlots = (campaignId, statuses) => psql(target, green,
    statuses.map((st, i) =>
      `UPDATE ten_slot_slots SET status = '${st}' WHERE campaign_id = '${campaignId}' AND slot_index = ${i};`)
      .join('\n'));

  test('★ 활성 뒤에 SPENT가 오는 장부를 "바쁨"으로 적지 않는다', () => {
    const F = (n) => Array(n).fill('FREE');
    const cases = [
      // 오프라인 validSlotOrder가 거부하는 배열 — SQL도 거부해야 한다
      ['활성 뒤 SPENT', ['RESERVED', 'SPENT', ...F(8)], 'COUPLING_CORRUPT'],
      ['SPENT·활성·SPENT', ['SPENT', 'UNKNOWN', 'SPENT', ...F(7)], 'COUPLING_CORRUPT'],
      ['활성 뒤 SPENT (OPEN)', ['OPEN', 'SPENT', 'SPENT', ...F(7)], 'COUPLING_CORRUPT'],
      ['FREE 뒤 SPENT', ['SPENT', 'FREE', 'SPENT', ...F(7)], 'COUPLING_CORRUPT'],
      ['FREE 뒤 활성', ['SPENT', 'FREE', 'CLOSING', ...F(7)], 'COUPLING_CORRUPT'],
      ['맨 앞 FREE 뒤 SPENT', ['FREE', 'SPENT', ...F(8)], 'COUPLING_CORRUPT'],
      // 정상 배열은 그대로 — 잘못 막지 않는다
      ['정상 SPENT→활성→FREE', ['SPENT', 'RESERVED', ...F(8)], 'SLOT_BUSY'],
      ['정상 SPENT만', ['SPENT', 'SPENT', ...F(8)], 'RESERVATION_AND_INTENT_DURABLE'],
      ['정상 전부 FREE', F(10), 'RESERVATION_AND_INTENT_DURABLE'],
    ];
    for (const [label, statuses, expected] of cases) {
      const campaignId = fresh();
      arrangeSlots(campaignId, statuses);
      // 오프라인 정본이 같은 배열을 어떻게 보는지 함께 확인한다.
      let ledger = createOfflineLedger(campaignId, 1000);
      ledger = { ...ledger, slots: ledger.slots.map((sl, i) => ({ ...sl, status: statuses[i] })) };
      const offline = planOfflineClaim(ledger, ledger.version, CLEAR);
      const offlineCode = offline.ok ? 'RESERVATION_AND_INTENT_DURABLE' : offline.code;
      const normalise = (c) => (c === 'LEDGER_UNKNOWN' ? 'COUPLING_CORRUPT' : c);
      assert.equal(normalise(offlineCode), expected,
        `${label}: 오프라인 정본이 ${offlineCode}다 — 기대와 다르다`);

      const r = claim({ campaignId, expectedVersion: 0, clientOrderId: `order-${campaignId}` });
      assert.equal(r.code, expected, `${label}: SQL이 ${r.code}로 적었다`);
      if (expected !== 'RESERVATION_AND_INTENT_DURABLE') {
        const st = readState(target, green, campaignId);
        assert.deepEqual({ version: st.version, claims: st.claims, intents: st.intents },
          { version: 0, claims: 0, intents: 0 }, `${label}에서 무언가 남았다`);
      }
    }
  });

  // ── 커밋된 의도에 **실행 계약과 손절 정책**이 남는가 ──
  //
  //   RED: `ten_slot_claim`은 수량·가격·배율까지만 적고 `stop_policy`와
  //   실행 계약 세 칸(090) · 손절/익절가 · 진입 위험 좌표 두 칸(091)을
  //   받지도 적지도 않았다.
  //
  //   왜 그게 결함인가. 이 함수가 적는 줄은 **전송 전 의도**이고, 전송은
  //   `orderExecutor`가 그 줄을 이어받아(`adoptIntent`) 한다. 이어받는 줄에
  //   `stop_policy='NO_FIXED_SL'`이 없으면 복구 경로는 그 포지션을
  //   **고정 손절 주문으로 읽는다** — 078 주석이 적은 바로 그 고장이다.
  //   계약 세 칸이 없으면 "배율 100이고 손절이 없으니 Exact100X겠지"로
  //   되돌아간다 — 090이 끝낸 그 추론이다.
  //
  //   그래서 **적을 수 있어야 하고, 적은 대로 남아야 한다.**
  test('의도에 손절 정책·실행 계약·진입 위험 좌표가 그대로 남는다', () => {
    const campaignId = fresh();
    const coid = `order-${campaignId}`;
    const r = claim({
      campaignId, expectedVersion: 0, clientOrderId: coid,
      leverage: 100, stopPolicy: 'NO_FIXED_SL',
      profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 3,
      adversePct: 0.42, liqPctRaw: 0.97,
    });
    assert.equal(r.code, 'RESERVATION_AND_INTENT_DURABLE');

    const row = intentRow(target, green, coid);
    assert.ok(row, '의도 줄이 없다');
    // 상태·환경은 기존 보장 그대로다.
    assert.equal(row.status, 'INTENT');
    assert.equal(row.mode, 'TESTNET');
    // ★ 여기가 RED였다.
    assert.equal(row.stopPolicy, 'NO_FIXED_SL', 'stop_policy가 안 남았다');
    assert.equal(row.profileId, 'MAX_LEV_100X');
    assert.equal(row.presetId, 'EXACT_100X');
    assert.equal(row.contractVersion, '3');
    assert.equal(Number(row.adversePct), 0.42);
    assert.equal(Number(row.liqPctRaw), 0.97);
    // NO_FIXED_SL이므로 손절가는 없는 것이 맞다. **0이 아니라 기록 없음이다.**
    assert.equal(row.stopLoss, '');
    assert.equal(row.takeProfit, '');
  });

  test('고정 손절 프로필의 손절·익절가도 그대로 남는다', () => {
    const campaignId = fresh();
    const coid = `order-${campaignId}`;
    const r = claim({
      campaignId, expectedVersion: 0, clientOrderId: coid,
      stopPolicy: 'FIXED_SL', stopLoss: 61000, takeProfit: 72000,
      orderType: 'LIMIT', price: 65000,
    });
    assert.equal(r.code, 'RESERVATION_AND_INTENT_DURABLE');
    const row = intentRow(target, green, coid);
    assert.equal(row.stopPolicy, 'FIXED_SL');
    assert.equal(Number(row.stopLoss), 61000);
    assert.equal(Number(row.takeProfit), 72000);
    assert.equal(row.orderType, 'LIMIT');
    assert.equal(Number(row.price), 65000);
    // 계약을 안 넘겼으면 **추측해서 채우지 않는다.** NULL은 "기록 없음"이다.
    assert.equal(row.profileId, '');
    assert.equal(row.presetId, '');
    assert.equal(row.contractVersion, '');
  });

  // **반쪽은 받지 않는다.** 실행 계약 세 칸은 전부 오거나 전부 없다.
  //
  //   090의 CHECK 제약도 같은 선을 긋지만, 제약에 걸리면 **예외**가 나고
  //   슬롯은 되돌아간다 — 호출부는 "왜 거절됐는지"를 코드로 받지 못한다.
  //   그래서 ③에서 코드로 거절한다. 제약은 마지막 그물로 남겨 둔다.
  //
  //   짝 규칙(`MAX_LEV_100X`는 `EXACT_100X`와만)은 **여기에 적지 않는다** —
  //   그 표의 정본은 `src/lib/execution/profile.ts`이고, SQL에 베끼면 같은
  //   판단이 두 곳에 생긴다(074·CLAUDE.md의 규칙).
  test('실행 계약이 반쪽이면 거절하고 아무것도 남기지 않는다', () => {
    const half = [
      ['프로필만', { profileId: 'MAX_LEV_100X' }],
      ['프리셋만', { presetId: 'EXACT_100X' }],
      ['버전만', { contractVersion: 3 }],
      ['버전 빠짐', { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X' }],
      ['프리셋 빠짐', { profileId: 'MAX_LEV_100X', contractVersion: 3 }],
      ['프로필 빠짐', { presetId: 'EXACT_100X', contractVersion: 3 }],
      ['빈 프로필', { profileId: '   ', presetId: 'EXACT_100X', contractVersion: 3 }],
      ['빈 프리셋', { profileId: 'MAX_LEV_100X', presetId: '', contractVersion: 3 }],
      ['버전 0', { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 0 }],
      ['버전 음수', { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: -1 }],
    ];
    for (const [label, extra] of half) {
      const campaignId = fresh();
      const r = claim({
        campaignId, expectedVersion: 0, clientOrderId: `order-${campaignId}`, ...extra,
      });
      assert.equal(r.code, 'INTENT_INVALID', `${label}: ${r.code}로 적었다`);
      const st = readState(target, green, campaignId);
      assert.deepEqual({ version: st.version, claims: st.claims, intents: st.intents },
        { version: 0, claims: 0, intents: 0 }, `${label}에서 무언가 남았다`);
    }
  });

  // **모순은 조용히 정리하지 않는다.** 실행기와 같은 판단이다.
  test('손절 정책과 손절가가 모순이면 거절한다', () => {
    const bad = [
      ['NO_FIXED_SL + 손절가', { stopPolicy: 'NO_FIXED_SL', stopLoss: 61000 }],
      ['모르는 정책', { stopPolicy: 'MAYBE_SL' }],
      ['빈 정책', { stopPolicy: '  ' }],
      ['손절가 0', { stopLoss: 0 }],
      ['손절가 음수', { stopLoss: -1 }],
      ['손절가 NaN', { stopLossExpr: "'NaN'::numeric" }],
      ['손절가 Infinity', { stopLossExpr: "'Infinity'::numeric" }],
      ['익절가 0', { takeProfit: 0 }],
      ['익절가 NaN', { takeProfitExpr: "'NaN'::numeric" }],
      ['위험거리 0', { adversePct: 0 }],
      ['위험거리 음수', { adversePct: -0.1 }],
      ['위험거리 NaN', { adversePctExpr: "'NaN'::double precision" }],
      ['청산여유 0', { liqPctRaw: 0 }],
      ['청산여유 Infinity', { liqPctRawExpr: "'Infinity'::double precision" }],
    ];
    for (const [label, extra] of bad) {
      const campaignId = fresh();
      const r = claim({
        campaignId, expectedVersion: 0, clientOrderId: `order-${campaignId}`, ...extra,
      });
      assert.equal(r.code, 'INTENT_INVALID', `${label}: ${r.code}로 적었다`);
      const st = readState(target, green, campaignId);
      assert.deepEqual({ version: st.version, claims: st.claims, intents: st.intents },
        { version: 0, claims: 0, intents: 0 }, `${label}에서 무언가 남았다`);
    }
  });

  // 위험 좌표 두 칸은 **서로 독립**이다. 091이 CHECK를 걸지 않은 이유가
  // 그것이다 — 한쪽만 구해진 상황이 실제로 있고, 그때 저장을 통째로
  // 실패시키면 구한 값까지 버린다. 여기서도 반쪽을 받는다.
  test('진입 위험 좌표는 한쪽만 있어도 받는다', () => {
    for (const [label, extra, expect] of [
      ['위험거리만', { adversePct: 0.42 }, { adversePct: '0.42', liqPctRaw: '' }],
      ['청산여유만', { liqPctRaw: 0.97 }, { adversePct: '', liqPctRaw: '0.97' }],
    ]) {
      const campaignId = fresh();
      const coid = `order-${campaignId}`;
      const r = claim({ campaignId, expectedVersion: 0, clientOrderId: coid, ...extra });
      assert.equal(r.code, 'RESERVATION_AND_INTENT_DURABLE', label);
      const row = intentRow(target, green, coid);
      assert.equal(row.adversePct === '' ? '' : String(Number(row.adversePct)),
        expect.adversePct, `${label}: 위험거리`);
      assert.equal(row.liqPctRaw === '' ? '' : String(Number(row.liqPctRaw)),
        expect.liqPctRaw, `${label}: 청산여유`);
    }
  });
}
