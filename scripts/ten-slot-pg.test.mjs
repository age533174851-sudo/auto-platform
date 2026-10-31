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
  migrationPaths, restartCommand, restartCluster, intentRow, DEFAULT_OWNER,
  applyEventSql, parseEvent, eventRows,
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
    migrationPaths(root, [...SCHEMA, '097_ten_slot_atomic_claim.sql',
      '098_ten_slot_apply_event.sql']));
  process.on('exit', () => {
    try { dropScratchDb(target, red); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
    try { dropScratchDb(target, green); } catch { /* 같음 */ }
  });

  let seq = 0;
  const fresh = (equity = 1000, environment = 'TESTNET') => {
    const campaignId = `c-${++seq}-${Date.now().toString(36)}`;
    const rows = psql(target, green, openCampaignSql({
      campaignId, userId: DEFAULT_OWNER,
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

  // ── 호출자가 이 캠페인의 주인인가 ──
  //
  //   `ten_slot_claim`은 `service_role`로 불린다. 그 역할은 **모든 줄을
  //   볼 수 있다** — RLS가 막아 주지 않는다. 그래서 캠페인 id 문자열만
  //   알면 남의 캠페인에 주문 의도를 커밋할 수 있었다.
  //
  //   장부에 적히는 `user_id`·`connection_id`는 캠페인에서 끌어오므로
  //   **피해자 이름으로 주문이 남는다.** 라우트가 붙는 순간 그건 남의
  //   계좌로 나가는 주문이다.
  //
  //   그래서 호출자의 정체성을 **인자로 받아 캠페인과 대조한다.** 이것은
  //   호출부의 인증을 대신하지 않는다 — 인증된 정체성을 여기까지 **들고
  //   와야 한다**는 요구다. 들고 오지 않으면 거절한다(모르는 것은 통과가
  //   아니다).
  test('남의 캠페인에는 의도를 커밋하지 못한다', () => {
    const campaignId = fresh();
    const r = claim({
      campaignId, expectedVersion: 0, clientOrderId: `order-${campaignId}`,
      callerUserId: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(r.code, 'CALLER_NOT_OWNER');
    const st = readState(target, green, campaignId);
    assert.deepEqual({ version: st.version, claims: st.claims, intents: st.intents },
      { version: 0, claims: 0, intents: 0 }, '남의 캠페인에 무언가 남았다');
  });

  test('호출자를 모르면 거절한다 — UNKNOWN은 통과가 아니다', () => {
    const campaignId = fresh();
    const r = claim({
      campaignId, expectedVersion: 0, clientOrderId: `order-${campaignId}`,
      callerUserId: null,
    });
    assert.equal(r.code, 'CALLER_UNKNOWN');
    const st = readState(target, green, campaignId);
    assert.deepEqual({ version: st.version, claims: st.claims, intents: st.intents },
      { version: 0, claims: 0, intents: 0 });
  });

  // 연결도 같은 선이다. 주인은 맞는데 **다른 거래소 연결**로 들어오면
  // 그 주문은 다른 계좌로 나간다. `IS DISTINCT FROM`으로 본다 — `=`는
  // NULL을 만나면 NULL을 돌려줘 **다른 것을 같다고 읽는다.**
  test('연결이 다르면 주인이라도 거절한다', () => {
    const campaignId = fresh();
    const r = claim({
      campaignId, expectedVersion: 0, clientOrderId: `order-${campaignId}`,
      callerConnectionId: '33333333-3333-4333-8333-333333333333',
    });
    assert.equal(r.code, 'CALLER_NOT_OWNER');
    const st = readState(target, green, campaignId);
    assert.deepEqual({ version: st.version, claims: st.claims, intents: st.intents },
      { version: 0, claims: 0, intents: 0 });
  });

  test('주인과 연결이 모두 맞으면 통과한다', () => {
    const conn = '44444444-4444-4444-8444-444444444444';
    const campaignId = `c-${++seq}-${Date.now().toString(36)}`;
    assert.equal(psql(target, green, openCampaignSql({
      campaignId, userId: DEFAULT_OWNER, connectionId: conn,
      environment: 'TESTNET', startingEquity: 1000,
    }))[0], 'OPENED|0');

    // 연결을 안 넘기면 캠페인의 연결과 다르다 — 거절해야 한다.
    assert.equal(claim({
      campaignId, expectedVersion: 0, clientOrderId: `order-a-${campaignId}`,
    }).code, 'CALLER_NOT_OWNER');

    const ok = claim({
      campaignId, expectedVersion: 0, clientOrderId: `order-${campaignId}`,
      callerConnectionId: conn,
    });
    assert.equal(ok.code, 'RESERVATION_AND_INTENT_DURABLE');
    // 장부에 남는 주인은 **캠페인에서 끌어온 값**이지 호출자가 넘긴 값이 아니다.
    const [row] = psql(target, green,
      `SELECT user_id, connection_id FROM live_orders
        WHERE client_order_id = '${`order-${campaignId}`}'`);
    assert.equal(String(row), `${DEFAULT_OWNER}|${conn}`);
  });

  // 없는 캠페인은 주인을 알 수 없다. `CAMPAIGN_MISSING`이 유일하게
  // 참인 답이다 — 소유권 코드로 바꾸면 주인에게 거짓말을 하게 된다.
  test('없는 캠페인은 소유권 이전에 CAMPAIGN_MISSING이다', () => {
    const r = claim({
      campaignId: `c-none-${Date.now().toString(36)}`, expectedVersion: 0,
      clientOrderId: 'order-none-0001',
      callerUserId: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(r.code, 'CAMPAIGN_MISSING');
  });

  // ── 거부 응답이 **남의 장부를 알려 주지 않는가** ──
  //
  //   ①-b 주석은 "아래 검사를 남의 캠페인에 수행하면 그 응답이 남의 장부
  //   상태를 알려 준다"고 적어 두고, **거부 응답에 `v_campaign.version`을
  //   그대로 담았다.** 막겠다고 적은 것을 같은 줄에서 흘린 셈이다.
  //
  //   **버전을 먼저 1로 올린다.** 버전 0만 시험하면 유출된 0과 비워 둔
  //   NULL을 구분할 수 없어 이 결함이 숨는다.
  test('소유권 거부 응답은 남의 버전·슬롯·주문을 알려 주지 않는다', () => {
    const campaignId = fresh();
    assert.equal(claim({
      campaignId, expectedVersion: 0, clientOrderId: `order-own-${campaignId}`,
    }).code, 'RESERVATION_AND_INTENT_DURABLE');

    const before = readState(target, green, campaignId);
    assert.equal(before.version, 1, '버전을 올리지 못해 이 시험이 무의미해졌다');

    const cases = [
      ['다른 사용자', 'CALLER_NOT_OWNER',
        { callerUserId: '22222222-2222-4222-8222-222222222222' }],
      ['다른 연결', 'CALLER_NOT_OWNER',
        { callerConnectionId: '33333333-3333-4333-8333-333333333333' }],
      ['호출자 없음', 'CALLER_UNKNOWN', { callerUserId: null }],
    ];
    for (const [label, expected, extra] of cases) {
      const r = claim({
        campaignId, expectedVersion: 1,
        clientOrderId: `order-probe-${label.length}-${campaignId}`, ...extra,
      });
      assert.equal(r.code, expected, `${label}: ${r.code}로 적었다`);
      // ★ 여기가 RED였다 — 남의 버전 1이 응답에 담겼다.
      assert.equal(r.version, null, `${label}: 남의 버전 ${r.version}을 알려 줬다`);
      assert.equal(r.slotIndex, null, `${label}: 슬롯 번호를 알려 줬다`);
      assert.equal(r.liveOrderId, null, `${label}: 주문 id를 알려 줬다`);
    }

    // 비인가 요청이 장부를 **한 칸도** 바꾸지 않았다.
    assert.deepEqual(readState(target, green, campaignId), before,
      '비인가 요청이 장부를 바꿨다');
  });

  // ══════════════════════════════════════════════════════════════════
  // 098 — 슬롯 전이를 **증거로만** 움직인다
  //
  //   097은 `FREE → RESERVED`까지만 했다. 그 뒤를 움직이는 코드가 DB에
  //   없었고, 그러면 응용 코드가 `UPDATE`를 직접 쳐야 한다 — 전이 규칙이
  //   치는 자리마다 하나씩 생긴다. RED는 실제로 그 함수가 없다는 것이다:
  //
  //     ERROR:  function ten_slot_apply_event(...) does not exist
  //     SELECT count(*) FROM pg_proc WHERE proname LIKE 'ten_slot_apply%' → 0
  // ══════════════════════════════════════════════════════════════════

  // 098은 거래소 증거를 내는 이벤트에 **어느 예약인지**를 요구한다.
  // `fresh()`+`claim()`이 쓰는 주문 ID 규칙(`order-<캠페인>`)을 기본값으로
  // 둔다 — 실제 호출부도 자기 예약의 ID를 들고 온다.
  // **`undefined`만 기본값으로 채운다.** 일부러 넘긴 `null`은 그대로 둬야
  // 거절해야 하는 경우가 통과로 보이지 않는다(`claimSql`과 같은 이유).
  const ev = (args) => parseEvent(psql(target, green, applyEventSql({
    clientOrderId: args.clientOrderId === undefined
      ? `order-${args.campaignId}` : args.clientOrderId,
    ...args,
  })));

  /** 슬롯 0을 RESERVED로 만들고 캠페인 버전을 돌려준다 */
  const reserved = () => {
    const campaignId = fresh();
    const r = claim({
      campaignId, expectedVersion: 0, clientOrderId: `order-${campaignId}`,
    });
    assert.equal(r.code, 'RESERVATION_AND_INTENT_DURABLE');
    return { campaignId, version: r.version, slotIndex: r.slotIndex };
  };

  test('★ 수명주기: RESERVED → OPEN → CLOSING → SPENT', () => {
    const { campaignId, version } = reserved();
    let v = version;

    const steps = [
      ['ACK', 'VENUE_ORDER', 'OPEN'],
      ['CLOSE_REQUEST', 'NONE', 'CLOSING'],
      ['CLOSED', 'VENUE_POSITION', 'SPENT'],
    ];
    for (const [kind, evidence, expected] of steps) {
      const r = ev({
        campaignId, expectedVersion: v, slotIndex: 0,
        eventId: `ev-${kind}-${campaignId}`, kind, evidence,
        exchangeOrderId: kind === 'CLOSE_REQUEST' ? null : '7001',
      });
      assert.equal(r.code, 'EVENT_APPLIED', `${kind}: ${r.code}`);
      assert.equal(r.status, expected, `${kind} 뒤 상태`);
      assert.equal(r.version, v + 1, `${kind}이 버전을 올리지 않았다`);
      v = r.version;
    }

    const st = readState(target, green, campaignId);
    assert.equal(st.statuses[0], 'SPENT');
    // SPENT는 활성이 아니다 — 다음 슬롯을 잡을 수 있다.
    assert.equal(st.active, 0, '소비된 슬롯이 아직 활성으로 세어진다');

    // 증거 로그가 전이의 양쪽을 그대로 갖고 있다.
    const log = eventRows(target, green, campaignId);
    assert.deepEqual(log.map(e => [e.from, e.to]),
      [['RESERVED', 'OPEN'], ['OPEN', 'CLOSING'], ['CLOSING', 'SPENT']]);
  });

  test('★ 증거가 없으면 OPEN·SPENT로 올리지 않는다', () => {
    const { campaignId, version } = reserved();
    // ACK인데 거래소에서 확인하지 못했다 → 올리지 않는다.
    const a = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-noack-${campaignId}`, kind: 'ACK', evidence: 'NONE',
    });
    assert.equal(a.code, 'EVIDENCE_MISSING');
    assert.equal(a.status, 'RESERVED', '상태가 움직였다');
    assert.equal(a.version, version, '거절인데 버전이 올라갔다');

    // 주문 조회로 접수는 확인했지만, **포지션이 사라진 것은 다른 사실**이다.
    const ok = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-ack-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001',
    });
    assert.equal(ok.code, 'EVENT_APPLIED');
    const cr = ev({
      campaignId, expectedVersion: ok.version, slotIndex: 0,
      eventId: `ev-cr-${campaignId}`, kind: 'CLOSE_REQUEST', evidence: 'NONE',
    });
    assert.equal(cr.code, 'EVENT_APPLIED', 'CLOSE_REQUEST는 우리 쪽 의도다');
    const bad = ev({
      campaignId, expectedVersion: cr.version, slotIndex: 0,
      eventId: `ev-badclose-${campaignId}`, kind: 'CLOSED', evidence: 'VENUE_ORDER',
    });
    assert.equal(bad.code, 'EVENT_OUT_OF_ORDER',
      '주문 증거로 포지션이 닫혔다고 적었다');
    assert.equal(bad.status, 'CLOSING');
  });

  test('★ UNKNOWN은 FREE로 돌아가지 않고 증거로만 풀린다', () => {
    for (const [label, resolve, expected] of [
      ['주문 증거로 OPEN', { kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '7001' }, 'OPEN'],
      ['포지션 증거로 SPENT', { kind: 'CLOSED', evidence: 'VENUE_POSITION' }, 'SPENT'],
      ['닫기 의도로 CLOSING', { kind: 'CLOSE_REQUEST', evidence: 'NONE' }, 'CLOSING'],
    ]) {
      const { campaignId, version } = reserved();
      const u = ev({
        campaignId, expectedVersion: version, slotIndex: 0,
        eventId: `ev-unk-${label.length}-${campaignId}`,
        kind: 'UNKNOWN_RESPONSE', evidence: 'NONE',
      });
      assert.equal(u.code, 'EVENT_APPLIED', label);
      assert.equal(u.status, 'UNKNOWN', label);
      // UNKNOWN은 **활성**이다 — 그 자리에 새 주문이 들어가지 않는다.
      const mid = readState(target, green, campaignId);
      assert.equal(mid.active, 1, `${label}: UNKNOWN이 활성에서 빠졌다`);
      assert.equal(claim({
        campaignId, expectedVersion: u.version,
        clientOrderId: `order-after-unk-${label.length}-${campaignId}`,
      }).code, 'SLOT_BUSY', `${label}: UNKNOWN인데 새 예약이 열렸다`);

      const r = ev({
        campaignId, expectedVersion: u.version, slotIndex: 0,
        eventId: `ev-res-${label.length}-${campaignId}`, ...resolve,
      });
      assert.equal(r.code, 'EVENT_APPLIED', label);
      assert.equal(r.status, expected, label);
    }
  });

  test('★ FREE·SPENT 슬롯에는 어떤 이벤트도 적용되지 않는다', () => {
    const { campaignId, version } = reserved();
    // 슬롯 1은 아직 FREE다 — 예약이 없으므로 **거래소 증거를 내는
    // 이벤트는 정체성에서 먼저 막힌다.** FREE 슬롯에 예약이 없다는 것은
    // 정의상 참이고, 전이표보다 앞선 사실이다.
    const onFree = ev({
      campaignId, expectedVersion: version, slotIndex: 1,
      eventId: `ev-free-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001',
    });
    assert.equal(onFree.code, 'CLAIM_IDENTITY_MISMATCH');
    assert.equal(onFree.status, 'FREE');
    assert.equal(onFree.version, version, '거절인데 버전이 올라갔다');

    // 증거를 내지 않는 이벤트는 전이표가 막는다 — 그 길은 그대로다.
    const onFreeNone = ev({
      campaignId, expectedVersion: version, slotIndex: 1,
      eventId: `ev-freenone-${campaignId}`, kind: 'CLOSE_REQUEST', evidence: 'NONE',
    });
    assert.equal(onFreeNone.code, 'EVENT_OUT_OF_ORDER');
    assert.equal(onFreeNone.status, 'FREE');

    // 슬롯 0을 SPENT까지 보낸 뒤 다시 이벤트를 넣는다.
    let v = version;
    for (const [kind, evidence] of [
      ['ACK', 'VENUE_ORDER'], ['CLOSE_REQUEST', 'NONE'], ['CLOSED', 'VENUE_POSITION'],
    ]) {
      v = ev({
        campaignId, expectedVersion: v, slotIndex: 0,
        eventId: `ev-sp-${kind}-${campaignId}`, kind, evidence,
        exchangeOrderId: kind === 'CLOSE_REQUEST' ? null : '7001',
      }).version;
    }
    for (const kind of ['ACK', 'PARTIAL_FILL', 'CLOSE_REQUEST', 'CLOSED', 'UNKNOWN_RESPONSE']) {
      const r = ev({
        campaignId, expectedVersion: v, slotIndex: 0,
        eventId: `ev-dead-${kind}-${campaignId}`, kind,
        evidence: kind === 'CLOSED' ? 'VENUE_POSITION'
          : kind === 'CLOSE_REQUEST' || kind === 'UNKNOWN_RESPONSE' ? 'NONE' : 'VENUE_ORDER',
        exchangeOrderId: '7001', filledQty: kind === 'PARTIAL_FILL' ? 0.003 : undefined,
      });
      assert.equal(r.code, 'EVENT_OUT_OF_ORDER', `SPENT에 ${kind}: ${r.code}`);
      assert.equal(r.status, 'SPENT');
    }
  });

  test('★ 부분 체결은 상태를 바꾸지 않고 기록만 남는다', () => {
    const { campaignId, version } = reserved();
    const a = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-a-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001',
    });
    const p1 = ev({
      campaignId, expectedVersion: a.version, slotIndex: 0,
      eventId: `ev-p1-${campaignId}`, kind: 'PARTIAL_FILL', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001', filledQty: 0.003, avgPrice: 65000,
    });
    assert.equal(p1.code, 'EVENT_APPLIED');
    assert.equal(p1.status, 'OPEN', '부분 체결이 상태를 바꿨다');
    const p2 = ev({
      campaignId, expectedVersion: p1.version, slotIndex: 0,
      eventId: `ev-p2-${campaignId}`, kind: 'PARTIAL_FILL', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001', filledQty: 0.007, avgPrice: 65100,
    });
    assert.equal(p2.status, 'OPEN');
    // **쌓인다.** 두 번째가 첫 번째를 덮어쓰지 않는다.
    const log = eventRows(target, green, campaignId).filter(e => e.kind === 'PARTIAL_FILL');
    assert.equal(log.length, 2);
    assert.deepEqual(log.map(e => Number(e.filledQty)), [0.003, 0.007]);
  });

  test('★ 같은 event_id 재시도는 멱등이고 버전을 올리지 않는다', () => {
    const { campaignId, version } = reserved();
    const args = {
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-idem-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001',
    };
    const first = ev(args);
    assert.equal(first.code, 'EVENT_APPLIED');
    assert.equal(first.version, version + 1);

    // 응답을 못 받고 **같은 버전으로** 다시 보낸다. CAS보다 멱등이 먼저다 —
    // CAS를 먼저 보면 이 재시도가 STALE_VERSION으로 깨진다.
    const again = ev(args);
    assert.equal(again.code, 'EVENT_ALREADY_APPLIED');
    assert.equal(again.status, 'OPEN');
    assert.equal(again.version, first.version, '멱등 재시도가 버전을 올렸다');

    // 새 버전으로 보내도 같다.
    const third = ev({ ...args, expectedVersion: first.version });
    assert.equal(third.code, 'EVENT_ALREADY_APPLIED');

    assert.equal(eventRows(target, green, campaignId).length, 1,
      '증거 줄이 두 개가 됐다');
  });

  test('★ 같은 event_id로 다른 사건이 오면 fail closed', () => {
    const { campaignId, version } = reserved();
    const id = `ev-conf-${campaignId}`;
    assert.equal(ev({
      campaignId, expectedVersion: version, slotIndex: 0, eventId: id,
      kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '7001',
    }).code, 'EVENT_APPLIED');

    for (const [label, diff] of [
      ['다른 종류', { kind: 'UNKNOWN_RESPONSE', evidence: 'NONE' }],
      ['다른 증거', { kind: 'ACK', evidence: 'VENUE_POSITION' }],
      ['다른 주문번호', { kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '9999' }],
      ['주문번호 없음', { kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: null }],
      // 다른 슬롯은 **정체성에서 먼저** 막힌다(그 슬롯에는 예약이 없다).
      // 같은 키의 다른 사건이라는 사실보다 "당신 예약이 아니다"가 앞선다.
      ['다른 슬롯', { slotIndex: 1, kind: 'ACK', evidence: 'VENUE_ORDER',
        exchangeOrderId: '7001', expect: 'CLAIM_IDENTITY_MISMATCH' }],
      ['수량 추가', { kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '7001', filledQty: 0.01 }],
    ]) {
      const { expect = 'EVENT_CONFLICT', ...rest } = diff;
      const r = ev({ campaignId, expectedVersion: version + 1, slotIndex: 0, eventId: id, ...rest });
      assert.equal(r.code, expect, `${label}: ${r.code}`);
    }
    assert.equal(eventRows(target, green, campaignId).length, 1);
  });

  test('★ 오래된 버전은 거절한다 (멱등 재시도와 구분된다)', () => {
    const { campaignId, version } = reserved();
    const a = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-s1-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001',
    });
    assert.equal(a.code, 'EVENT_APPLIED');
    // **다른** event_id인데 옛 버전으로 들어왔다 → CAS 실패.
    const stale = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-s2-${campaignId}`, kind: 'CLOSE_REQUEST', evidence: 'NONE',
    });
    assert.equal(stale.code, 'STALE_VERSION');
    assert.equal(stale.version, a.version, '주인에게 다음 시도를 알려 줘야 한다');
    assert.equal(readState(target, green, campaignId).statuses[0], 'OPEN');
  });

  test('★ 동시 두 호출이 같은 event_id면 한쪽만 적용된다', async () => {
    const { campaignId, version } = reserved();
    const sql = applyEventSql({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-race-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001', clientOrderId: `order-${campaignId}`,
    });
    const out = await raceClaims(target, green, [sql, sql]);
    // `raceClaims`는 `{ code, out, rows }`를 준다. 배리어 SQL의 출력이
    // 섞여 있으므로 `|`가 있는 줄만 결과로 읽는다 (동시 예약 시험과 같다).
    const codes = out.map(r => parseEvent(r.rows.filter(l => l.includes('|'))).code).sort();
    assert.deepEqual(codes, ['EVENT_ALREADY_APPLIED', 'EVENT_APPLIED'],
      `동시 결과가 ${JSON.stringify(codes)}다`);
    assert.equal(eventRows(target, green, campaignId).length, 1);
    assert.equal(readState(target, green, campaignId).version, version + 1,
      '버전이 두 번 올라갔다');
  });

  test('★ 중지된 캠페인도 닫을 수 있다 — 중지는 새 진입만 막는다', () => {
    const { campaignId, version } = reserved();
    const a = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-k0-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001',
    });
    const [killed] = psql(target, green,
      `SELECT code FROM ten_slot_kill(${JSON.stringify(campaignId).replace(/"/g, "'")})`);
    assert.equal(String(killed).split('|')[0], 'KILL_PERSISTED');
    const v = readState(target, green, campaignId).version;

    // 새 진입은 막힌다.
    assert.equal(claim({
      campaignId, expectedVersion: v, clientOrderId: `order-k-${campaignId}`,
    }).code, 'KILL_SWITCH');

    // 그런데 **닫는 길은 열려 있어야 한다.** 막으면 포지션이 갇힌다.
    const cr = ev({
      campaignId, expectedVersion: v, slotIndex: 0,
      eventId: `ev-k1-${campaignId}`, kind: 'CLOSE_REQUEST', evidence: 'NONE',
    });
    assert.equal(cr.code, 'EVENT_APPLIED', '중지가 닫기를 막았다');
    const done = ev({
      campaignId, expectedVersion: cr.version, slotIndex: 0,
      eventId: `ev-k2-${campaignId}`, kind: 'CLOSED', evidence: 'VENUE_POSITION',
    });
    assert.equal(done.code, 'EVENT_APPLIED');
    assert.equal(done.status, 'SPENT');
    assert.ok(a.version < done.version);
  });

  test('★ 남의 슬롯은 움직이지 못하고 거부 응답이 장부를 알려 주지 않는다', () => {
    const { campaignId, version } = reserved();
    for (const [label, expected, extra] of [
      ['다른 사용자', 'CALLER_NOT_OWNER',
        { callerUserId: '22222222-2222-4222-8222-222222222222' }],
      ['다른 연결', 'CALLER_NOT_OWNER',
        { callerConnectionId: '33333333-3333-4333-8333-333333333333' }],
      ['호출자 없음', 'CALLER_UNKNOWN', { callerUserId: null }],
    ]) {
      const r = ev({
        campaignId, expectedVersion: version, slotIndex: 0,
        eventId: `ev-own-${label.length}-${campaignId}`,
        kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '7001', ...extra,
      });
      assert.equal(r.code, expected, `${label}: ${r.code}`);
      assert.equal(r.version, null, `${label}: 남의 버전 ${r.version}을 알려 줬다`);
      assert.equal(r.status, null, `${label}: 남의 슬롯 상태를 알려 줬다`);
    }
    assert.equal(readState(target, green, campaignId).statuses[0], 'RESERVED');
    assert.equal(eventRows(target, green, campaignId).length, 0);
  });

  test('★ 없는 캠페인·없는 슬롯을 구분한다', () => {
    const { campaignId, version } = reserved();
    assert.equal(ev({
      campaignId: `c-none-${Date.now().toString(36)}`, expectedVersion: 0,
      slotIndex: 0, eventId: 'ev-none-0001', kind: 'ACK', evidence: 'VENUE_ORDER',
    }).code, 'CAMPAIGN_MISSING');
    // 097은 슬롯 10개를 만든다. 10번은 없다.
    assert.equal(ev({
      campaignId, expectedVersion: version, slotIndex: 10,
      eventId: `ev-slot10-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
    }).code, 'SLOT_MISSING');
  });

  test('★ 재시작해도 전이와 증거가 그대로다', { skip: restartCommand() ? false : `${PG_RESTART_ENV}가 없습니다` }, async () => {
    const { campaignId, version } = reserved();
    const a = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-r1-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001',
    });
    const u = ev({
      campaignId, expectedVersion: a.version, slotIndex: 0,
      eventId: `ev-r2-${campaignId}`, kind: 'UNKNOWN_RESPONSE', evidence: 'NONE',
    });
    assert.equal(u.status, 'UNKNOWN');

    restartCluster();

    const st = readState(target, green, campaignId);
    assert.equal(st.statuses[0], 'UNKNOWN', '재시작 뒤 상태가 달라졌다');
    assert.equal(st.version, u.version);
    assert.deepEqual(eventRows(target, green, campaignId).map(e => e.to),
      ['OPEN', 'UNKNOWN']);
    // 재시작 뒤에도 멱등이고, UNKNOWN 슬롯은 여전히 비지 않는다.
    assert.equal(ev({
      campaignId, expectedVersion: u.version, slotIndex: 0,
      eventId: `ev-r2-${campaignId}`, kind: 'UNKNOWN_RESPONSE', evidence: 'NONE',
    }).code, 'EVENT_ALREADY_APPLIED');
    assert.equal(claim({
      campaignId, expectedVersion: u.version,
      clientOrderId: `order-restart-${campaignId}`,
    }).code, 'SLOT_BUSY');
  });

  test('★ 전이표 전수 — SQL이 표 밖의 길을 만들지 않는다', () => {
    const FROM = ['FREE', 'RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN', 'SPENT'];
    const KIND = ['ACK', 'PARTIAL_FILL', 'CLOSE_REQUEST', 'CLOSED', 'UNKNOWN_RESPONSE'];
    const EVID = ['VENUE_ORDER', 'VENUE_POSITION', 'NONE'];
    // 시험이 기대하는 표. **SQL과 따로 적는다** — 같은 파일을 읽으면
    // 틀린 것이 둘 다 틀려서 맞아 보인다.
    const expect = (from, kind, evidence) => {
      if (kind === 'ACK' && evidence === 'VENUE_ORDER'
          && ['RESERVED', 'UNKNOWN'].includes(from)) return 'OPEN';
      if (kind === 'PARTIAL_FILL' && evidence === 'VENUE_ORDER' && from === 'OPEN') return 'OPEN';
      if (kind === 'CLOSE_REQUEST' && ['OPEN', 'UNKNOWN'].includes(from)) return 'CLOSING';
      if (kind === 'CLOSED' && evidence === 'VENUE_POSITION'
          && ['CLOSING', 'UNKNOWN'].includes(from)) return 'SPENT';
      if (kind === 'UNKNOWN_RESPONSE'
          && ['RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN'].includes(from)) return 'UNKNOWN';
      return '';
    };
    let n = 0;
    const pairs = [];
    for (const from of FROM) for (const kind of KIND) for (const evidence of EVID) {
      pairs.push(`('${from}','${kind}','${evidence}')`);
      n++;
    }
    const rows = psql(target, green, `SELECT t.f, t.k, t.e,
        coalesce(ten_slot_next_status(t.f, t.k, t.e), '')
      FROM (VALUES ${pairs.join(',')}) AS t(f, k, e)`);
    assert.equal(rows.length, n, `전수가 ${rows.length}건이다`);
    for (const line of rows) {
      const [from, kind, evidence, got] = String(line).split('|');
      assert.equal(got, expect(from, kind, evidence),
        `${from} + ${kind}(${evidence}) → SQL은 ${got || '없음'}`);
    }
    // **FREE로 돌아가는 길이 표 안에 하나도 없다.**
    assert.equal(rows.filter(l => String(l).endsWith('|FREE')).length, 0,
      'FREE로 되돌리는 전이가 있다');
    assert.equal(n, 90);
  });

  // ── 예외 경로도 **같은 정본으로** 판정하는가 ──
  //
  //   정상 경로(③)는 기존 `event_id`를 찾으면 payload를 대조하고 다르면
  //   `EVENT_CONFLICT`를 돌려준다. 그런데 `unique_violation` 핸들러는
  //   **그 대조가 없었다** — `event_id`만 다시 찾아 `EVENT_ALREADY_APPLIED`와
  //   그 줄의 `to_status`를 돌려줬다.
  //
  //   같은 판단이 두 곳에 있고 한쪽에만 비교가 있었다. 이 저장소의 상습
  //   고장 ②를 내가 다시 만든 것이다.
  //
  //   결과: 서로 다른 사용자가 소유한 **다른 캠페인**에 같은 `event_id`가
  //   오면, 진 쪽은 "이미 적용됐다"는 거짓 성공과 **남의 캠페인 상태**를
  //   받는다. 자기 캠페인에는 그 이벤트가 없고 상태도 안 바뀌었는데.
  //
  //   ★ 결정적으로 재현한다 (경합에 기대지 않는다):
  //     A: 한 트랜잭션에서 apply_event를 호출하고 **커밋하지 않은 채** 쉰다
  //     B: 400ms 뒤 같은 event_id로 호출 → ③은 아무것도 못 보고 INSERT로
  //        가서 PK 인덱스에서 **대기**한다 → A 커밋 후 unique_violation
  test('★ 예외 경로가 다른 캠페인의 사건을 멱등 성공으로 적지 않는다', async () => {
    const stamp = Date.now().toString(36);
    const idA = `c-xa-${stamp}`;
    const idB = `c-xb-${stamp}`;
    const ownerB = '55555555-5555-4555-8555-555555555555';

    // 서로 다른 주인이 소유한 캠페인 둘. 다른 행을 잠그므로 병렬로 진행된다.
    for (const [cid, owner] of [[idA, DEFAULT_OWNER], [idB, ownerB]]) {
      assert.equal(psql(target, green, openCampaignSql({
        campaignId: cid, userId: owner, environment: 'TESTNET', startingEquity: 1000,
      }))[0], 'OPENED|0');
      assert.equal(parseClaim(psql(target, green, claimSql({
        campaignId: cid, expectedVersion: 0, clientOrderId: `order-${cid}`,
        callerUserId: owner,
      }))).code, 'RESERVATION_AND_INTENT_DURABLE');
    }

    const shared = `shared-event-${stamp}`;
    // A는 커밋을 늦춘다. 한 `-c`에 담으면 psql이 하나의 트랜잭션으로 돈다.
    const a = psqlSpawn(target, green,
      `${applyEventSql({
        campaignId: idA, expectedVersion: 1, slotIndex: 0, eventId: shared,
        kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: 'order-A',
        clientOrderId: `order-${idA}`,
      })}; SELECT pg_sleep(1.5);`);

    await new Promise(r => setTimeout(r, 400));

    // B는 **다른 캠페인·다른 주인·다른 사건**이다.
    const b = psqlSpawn(target, green, applyEventSql({
      campaignId: idB, expectedVersion: 1, slotIndex: 0, eventId: shared,
      kind: 'UNKNOWN_RESPONSE', evidence: 'NONE', callerUserId: ownerB,
      clientOrderId: `order-${idB}`,
    }));

    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, `A가 실패했다: ${ra.err.trim()}`);
    assert.equal(rb.code, 0, `B가 실패했다: ${rb.err.trim()}`);

    const got = parseEvent(rb.out.replace(/\n$/, '').split('\n').filter(l => l.includes('|')));
    // ★ 여기가 RED였다 — `EVENT_ALREADY_APPLIED`와 A의 `OPEN`이 돌아왔다.
    assert.equal(got.code, 'EVENT_CONFLICT',
      `B가 ${got.code}를 받았다 (상태 ${got.status})`);
    assert.equal(got.status, null, `B가 남의 캠페인 상태 ${got.status}를 받았다`);

    // B의 장부는 아무것도 바뀌지 않았다.
    const stB = readState(target, green, idB);
    assert.equal(stB.version, 1, 'B의 버전이 움직였다');
    assert.equal(stB.statuses[0], 'RESERVED', 'B의 슬롯이 움직였다');
    assert.equal(eventRows(target, green, idB).length, 0, 'B에 증거가 남았다');

    // A는 정상 적용됐다.
    assert.equal(readState(target, green, idA).statuses[0], 'OPEN');
    assert.deepEqual(eventRows(target, green, idA).map(e => [e.eventId, e.to]),
      [[shared, 'OPEN']]);
  });

  // 같은 캠페인·같은 사건의 동시 재시도는 **여전히 멱등**이어야 한다.
  // 위 수정이 이것까지 거절하면 응답 유실 복구가 막힌다.
  test('★ 예외 경로에서 진짜 같은 사건은 멱등으로 남는다', async () => {
    const { campaignId, version } = reserved();
    const shared = `same-event-${Date.now().toString(36)}`;
    const args = {
      campaignId, expectedVersion: version, slotIndex: 0, eventId: shared,
      kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '7001',
      clientOrderId: `order-${campaignId}`,
    };
    const a = psqlSpawn(target, green, `${applyEventSql(args)}; SELECT pg_sleep(1.5);`);
    await new Promise(r => setTimeout(r, 400));
    const b = psqlSpawn(target, green, applyEventSql(args));
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, ra.err.trim());
    assert.equal(rb.code, 0, rb.err.trim());

    const got = parseEvent(rb.out.replace(/\n$/, '').split('\n').filter(l => l.includes('|')));
    assert.equal(got.code, 'EVENT_ALREADY_APPLIED', `B가 ${got.code}를 받았다`);
    assert.equal(got.status, 'OPEN');
    assert.equal(got.version, version + 1, '멱등 응답이 엉뚱한 버전을 줬다');
    assert.equal(eventRows(target, green, campaignId).length, 1);
    assert.equal(readState(target, green, campaignId).version, version + 1,
      '버전이 두 번 올라갔다');
  });

  // ── `evidence` 라벨만으로는 아무것도 증명하지 못한다 ──
  //
  //   전이표는 `p_evidence` **문자열**만 봤다. 그래서 호출부가
  //   `VENUE_ORDER`라고 적으면, 거래소 주문 번호를 **안 넘겨도**
  //   `RESERVED → OPEN`이 됐다. 번호를 넘기더라도 그것이 이 슬롯의
  //   예약과 연결된 주문인지 대조하는 코드가 없었다.
  //
  //   즉 "증거로만 움직인다"고 적어 두고 **라벨만 보고 움직였다.**
  //
  //   ★ DB가 할 수 있는 것과 할 수 없는 것을 분명히 한다:
  //     할 수 있다 — 증거의 **몸통**이 있는지(주문 번호·체결 수량),
  //                   그것이 이 슬롯의 예약·장부와 **같은 주문**인지,
  //                   한 슬롯 안에서 주문 번호가 **흔들리지 않는지**
  //     할 수 없다 — 그 번호를 **정말 거래소에서 읽었는지**.
  //                   그건 인증된 서버 어댑터가 보장해야 하고, DB는
  //                   그것을 검증할 수 없다. 이 공백은 숨기지 않는다.
  test('★ VENUE_ORDER인데 주문 번호가 없으면 OPEN으로 올리지 않는다', () => {
    const { campaignId, version } = reserved();
    for (const [label, extra] of [
      ['번호 없음', { exchangeOrderId: null }],
      ['빈 번호', { exchangeOrderId: '' }],
      ['공백 번호', { exchangeOrderId: '   ' }],
    ]) {
      const r = ev({
        campaignId, expectedVersion: version, slotIndex: 0,
        eventId: `ev-noid-${label.length}-${campaignId}`,
        kind: 'ACK', evidence: 'VENUE_ORDER',
        clientOrderId: `order-${campaignId}`, ...extra,
      });
      assert.equal(r.code, 'EVIDENCE_MISSING', `${label}: ${r.code}`);
      assert.equal(r.status, 'RESERVED', `${label}: 상태가 움직였다`);
      assert.equal(r.version, version, `${label}: 거절인데 버전이 올라갔다`);
    }
    assert.equal(eventRows(target, green, campaignId).length, 0);
  });

  test('★ 부분 체결인데 수량이 없거나 0이면 받지 않는다', () => {
    const { campaignId, version } = reserved();
    const coid = `order-${campaignId}`;
    const a = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-pfa-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: '7001', clientOrderId: coid,
    });
    assert.equal(a.code, 'EVENT_APPLIED');
    for (const [label, extra] of [
      ['수량 없음', { filledQty: null }],
      ['수량 0', { filledQty: 0 }],
    ]) {
      const r = ev({
        campaignId, expectedVersion: a.version, slotIndex: 0,
        eventId: `ev-pf-${label.length}-${campaignId}`,
        kind: 'PARTIAL_FILL', evidence: 'VENUE_ORDER',
        exchangeOrderId: '7001', clientOrderId: coid, ...extra,
      });
      assert.equal(r.code, 'EVIDENCE_MISSING', `${label}: ${r.code}`);
      assert.equal(r.version, a.version, `${label}: 거절인데 버전이 올라갔다`);
    }
  });

  test('★ 한 슬롯 안에서 거래소 주문 번호가 흔들리면 거절한다', () => {
    const { campaignId, version } = reserved();
    const coid = `order-${campaignId}`;
    const a = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-oa-${campaignId}`, kind: 'ACK', evidence: 'VENUE_ORDER',
      exchangeOrderId: 'order-A', clientOrderId: coid,
    });
    assert.equal(a.code, 'EVENT_APPLIED');
    // **다른 주문의 번호**로 부분 체결을 적으려 한다.
    const bad = ev({
      campaignId, expectedVersion: a.version, slotIndex: 0,
      eventId: `ev-ob-${campaignId}`, kind: 'PARTIAL_FILL', evidence: 'VENUE_ORDER',
      exchangeOrderId: 'order-B', filledQty: 0.003, clientOrderId: coid,
    });
    assert.equal(bad.code, 'ORDER_ID_MISMATCH', `${bad.code}로 적었다`);
    assert.equal(bad.version, a.version, '거절인데 버전이 올라갔다');
    // 같은 번호는 통과한다.
    assert.equal(ev({
      campaignId, expectedVersion: a.version, slotIndex: 0,
      eventId: `ev-oc-${campaignId}`, kind: 'PARTIAL_FILL', evidence: 'VENUE_ORDER',
      exchangeOrderId: 'order-A', filledQty: 0.003, clientOrderId: coid,
    }).code, 'EVENT_APPLIED');
  });

  test('★ 예약·장부와 같은 주문인지 대조한다', () => {
    const { campaignId, version } = reserved();
    for (const [label, extra] of [
      ['주문 ID 없음', { clientOrderId: null }],
      ['남의 주문 ID', { clientOrderId: 'order-somebody-else' }],
      ['공백', { clientOrderId: '  ' }],
    ]) {
      const r = ev({
        campaignId, expectedVersion: version, slotIndex: 0,
        eventId: `ev-cid-${label.length}-${campaignId}`,
        kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '7001', ...extra,
      });
      assert.equal(r.code, 'CLAIM_IDENTITY_MISMATCH', `${label}: ${r.code}`);
      assert.equal(r.version, version, `${label}: 거절인데 버전이 올라갔다`);
    }
    assert.equal(eventRows(target, green, campaignId).length, 0);
  });

  // **모른다고 적는 것은 여전히 언제나 할 수 있다.** 위 요구가
  // `UNKNOWN_RESPONSE`까지 막으면 모호한 응답을 기록할 길이 사라진다 —
  // 그게 이 함수가 막으려던 상태다.
  test('★ 증거 없는 이벤트는 추가 인자를 요구하지 않는다', () => {
    const { campaignId, version } = reserved();
    const u = ev({
      campaignId, expectedVersion: version, slotIndex: 0,
      eventId: `ev-nou-${campaignId}`, kind: 'UNKNOWN_RESPONSE', evidence: 'NONE',
      clientOrderId: null, exchangeOrderId: null,
    });
    assert.equal(u.code, 'EVENT_APPLIED', 'UNKNOWN을 적을 길이 막혔다');
    assert.equal(u.status, 'UNKNOWN');
    const cr = ev({
      campaignId, expectedVersion: u.version, slotIndex: 0,
      eventId: `ev-nocr-${campaignId}`, kind: 'CLOSE_REQUEST', evidence: 'NONE',
      clientOrderId: null, exchangeOrderId: null,
    });
    assert.equal(cr.code, 'EVENT_APPLIED', '닫기 의도를 적을 길이 막혔다');
    assert.equal(cr.status, 'CLOSING');
  });

  // ── 멱등 재시도가 **예약 정체성 검사를 건너뛰는가** ──
  //
  //   ③ 멱등은 `ten_slot_event_same`의 7칸만 보고 `EVENT_ALREADY_APPLIED`를
  //   돌려주고 끝난다. ⑥-b의 예약 정체성 검사까지 가지 않는다.
  //
  //   그래서 올바르게 적용된 뒤 **같은 event_id·같은 7칸에 엉뚱한
  //   `client_order_id`**를 넣어 다시 부르면 "이미 적용됐다"가 돌아온다.
  //   장부는 바뀌지 않지만, 호출자는 **자기가 넘긴 정체성이 승인된 것처럼**
  //   읽을 수 있다.
  //
  //   ★ 상태 오염은 아니다 (버전·슬롯·증거 줄 전부 불변). 하지만 이
  //   저장소는 **거절하는 쪽으로 기울여 두는** 쪽을 택해 왔다 — 자기
  //   주문 ID를 틀리게 아는 호출부는 어느 슬롯을 다루는지 잘못 알고 있을
  //   수 있고, 그건 조용히 통과시킬 종류가 아니다.
  test('★ 멱등 재시도도 예약 정체성을 건너뛰지 않는다', () => {
    const { campaignId, version } = reserved();
    const coid = `order-${campaignId}`;
    const base = {
      campaignId, slotIndex: 0, eventId: `ev-idid-${campaignId}`,
      kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '7001',
    };
    const first = ev({ ...base, expectedVersion: version, clientOrderId: coid });
    assert.equal(first.code, 'EVENT_APPLIED');

    // 올바른 ID로 다시 보내면 **멱등이어야 한다** — 이 수정이 응답 유실
    // 복구를 깨뜨리지 않았는지 확인한다.
    const good = ev({ ...base, expectedVersion: version, clientOrderId: coid });
    assert.equal(good.code, 'EVENT_ALREADY_APPLIED', '정상 재시도가 깨졌다');
    assert.equal(good.status, 'OPEN');
    assert.equal(good.version, first.version);

    // ★ 여기가 RED였다 — 엉뚱한 ID로도 `EVENT_ALREADY_APPLIED`가 돌아왔다.
    for (const [label, bad] of [
      ['ID 없음', null],
      ['남의 ID', 'order-somebody-else'],
      ['공백', '   '],
    ]) {
      const r = ev({ ...base, expectedVersion: version, clientOrderId: bad });
      assert.equal(r.code, 'CLAIM_IDENTITY_MISMATCH', `${label}: ${r.code}`);
      assert.equal(r.version, first.version, `${label}: 버전이 움직였다`);
    }

    // 장부는 한 칸도 바뀌지 않았다.
    assert.equal(eventRows(target, green, campaignId).length, 1);
    const st = readState(target, green, campaignId);
    assert.equal(st.version, first.version);
    assert.equal(st.statuses[0], 'OPEN');
  });

  // 동시 경합(PK 충돌 → 예외 핸들러)에서도 엉뚱한 ID가 멱등 성공하지
  // 않아야 한다. 정상 경로만 고치면 **경로가 둘인데 한쪽만 고침**이다.
  test('★ 동시 PK 충돌에서도 엉뚱한 예약 ID는 멱등 성공하지 않는다', async () => {
    const { campaignId, version } = reserved();
    const coid = `order-${campaignId}`;
    const shared = `ev-idrace-${Date.now().toString(36)}`;
    const base = {
      campaignId, expectedVersion: version, slotIndex: 0, eventId: shared,
      kind: 'ACK', evidence: 'VENUE_ORDER', exchangeOrderId: '7001',
    };
    const a = psqlSpawn(target, green,
      `${applyEventSql({ ...base, clientOrderId: coid })}; SELECT pg_sleep(1.5);`);
    await new Promise(r => setTimeout(r, 400));
    // B는 같은 사건인데 **예약 ID를 틀리게** 들고 왔다.
    const b = psqlSpawn(target, green,
      applyEventSql({ ...base, clientOrderId: 'order-somebody-else' }));
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, ra.err.trim());
    assert.equal(rb.code, 0, rb.err.trim());

    const got = parseEvent(rb.out.replace(/\n$/, '').split('\n').filter(l => l.includes('|')));
    assert.equal(got.code, 'CLAIM_IDENTITY_MISMATCH', `B가 ${got.code}를 받았다`);
    assert.equal(eventRows(target, green, campaignId).length, 1);
    assert.equal(readState(target, green, campaignId).version, version + 1,
      '버전이 두 번 올라갔다');
  });
}
