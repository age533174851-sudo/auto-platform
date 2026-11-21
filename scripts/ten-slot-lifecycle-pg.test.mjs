// 앱이 고른 사건이 **실제 PostgreSQL 098의 전이와 같은지** 확인한다 (#537).
//
// 왜 이 파일이 생겼나
// ───────────────────
// `src/lib/engine/tenSlotLifecycle.ts`는 전송 결과와 포지션 조회를 보고
// "098에 적을 사건"을 고른다. 그 모듈의 시험은 **가짜 DB**로 돌았다 —
// 우리가 보낸 것을 기록하고 시나리오가 정한 코드를 돌려주는 가짜다.
// 그래서 "모듈이 ACK을 골랐다"는 확인되지만 **"그 ACK이 실제로 슬롯을
// OPEN으로 옮기는가"는 확인되지 않았다.**
//
// 그게 `CLAUDE.md`가 말하는 상습 고장 ②다: 같은 판단이 두 곳(모듈과
// 098의 전이표)에 있고, 둘이 갈려도 아무도 모른다. 모듈이 `FILL`이나
// `SL_ATTACHED` 같은 없는 사건을 고르기 시작하면 가짜 DB는 통과시키고
// 운영 DB는 거절한다.
//
// 그래서 여기서는
//   · 모듈을 **복제하지 않고 같은 파일을 컴파일해서** 쓴다
//     (`scripts/gen-migration-manifest.mjs`의 `loadPlan()`과 같은 방식)
//   · 모듈이 고른 사건을 **그대로** `ten_slot_apply_event`에 보낸다
//   · DB가 돌려준 `code`·`slot_status`를 모듈의 `eventResultOf`로 읽고,
//     **커밋된 행**이 모듈이 주장한 상태와 같은지 본다
//
// `TEN_SLOT_PG_URL`이 없으면 **건너뛴다고 말하고 끝낸다.** 돌지 않은
// 것을 통과로 적지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  PG_URL_ENV, pgTarget, psql, createScratchDb, dropScratchDb,
  openCampaignSql, claimSql, parseClaim, migrationPaths, DEFAULT_OWNER,
  applyEventSql, parseEvent, eventRows,
} from './ten-slot-pg.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = pgTarget();

/**
 * 앱 모듈을 **그대로 컴파일해서** 불러온다.
 *
 * 로직을 이 스크립트에 옮겨 적으면 그 순간 경로가 둘이 된다. 같은
 * 파일을 쓰는 것이 이 시험의 핵심이다 — 모듈이 바뀌면 이 시험이 바뀐
 * 모듈을 본다.
 */
async function loadLifecycle() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-tsl-'));
  cpSync(join(root, 'src', 'lib', 'engine', 'tenSlotLifecycle.ts'), join(dir, 'tenSlotLifecycle.ts'));
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`TypeScript를 찾을 수 없습니다: ${tsc} — 먼저 npm install`);
  execFileSync(process.execPath, [tsc, 'tenSlotLifecycle.ts', '--module', 'commonjs',
    '--target', 'es2019', '--skipLibCheck'], { cwd: dir, stdio: 'pipe' });
  return await import(`file://${join(dir, 'tenSlotLifecycle.js')}`);
}

if (!target.ok) {
  test(`실제 PostgreSQL 전이 확인을 건너뜁니다 (${target.reason})`, { skip: target.reason }, () => {});
} else {
  const SCHEMA = [
    '012_live_orders.sql',
    '078_live_orders_stop_policy.sql',
    '090_live_orders_execution_identity.sql',
    '091_live_orders_entry_risk_snapshot.sql',
    '097_ten_slot_atomic_claim.sql',
    '098_ten_slot_apply_event.sql',
  ];
  const db = createScratchDb(target, 'tslife', migrationPaths(root, SCHEMA));
  process.on('exit', () => {
    try { dropScratchDb(target, db); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
  });

  const lc = await loadLifecycle();

  let seq = 0;
  /** 캠페인 하나를 열고 슬롯 하나를 예약한다. 예약된 상태가 RESERVED다 */
  const reserved = () => {
    const campaignId = `lc-${++seq}-${Date.now().toString(36)}`;
    const opened = psql(target, db, openCampaignSql({
      campaignId, userId: DEFAULT_OWNER, environment: 'TESTNET', startingEquity: 1000,
    }));
    assert.equal(opened[0], 'OPENED|0');
    // **예약이 쓴 그 번호를 들고 다닌다.** 098은 사건이 그 예약과 같은
    // 주문에 대한 말인지 `client_order_id`로 확인한다 — 모듈도
    // `p_client_order_id`로 그 값을 보낸다(`applySlotEvent`).
    const clientOrderId = `co-${seq}-${Date.now().toString(36)}`;
    const c = parseClaim(psql(target, db, claimSql({
      campaignId, expectedVersion: 0, clientOrderId, signalId: `sig-${seq}`,
    })));
    assert.equal(c.code, 'RESERVATION_AND_INTENT_DURABLE', `예약이 안 됐습니다: ${c.code}`);
    return { campaignId, clientOrderId, slotIndex: Number(c.slotIndex), version: Number(c.version) };
  };

  /** 모듈이 고른 사건을 **그대로** DB에 보낸다. 손으로 고치지 않는다 */
  const send = (slot, plan, over = {}) => {
    const rows = psql(target, db, applyEventSql({
      campaignId: slot.campaignId, expectedVersion: slot.version, slotIndex: slot.slotIndex,
      eventId: `ev-${slot.campaignId}-${plan.kind}-${over.tag ?? '1'}`,
      kind: plan.kind, evidence: plan.evidence,
      exchangeOrderId: plan.exchangeOrderId, filledQty: plan.filledQty, avgPrice: plan.avgPrice,
      callerUserId: DEFAULT_OWNER,
      // 모듈이 `applySlotEvent`에서 넘기는 그 값이다. 하네스가 빠뜨리면
      // 098이 CLAIM_IDENTITY_MISMATCH로 거절하고, **제품이 아니라 시험이
      // 틀린 것이다.**
      clientOrderId: slot.clientOrderId,
      ...over,
    }));
    const got = parseEvent(rows);
    // **DB가 돌려준 것을 앱의 판독기로 읽는다.** 여기서 갈리면 앱은
    // 성공한 호출을 실패로, 또는 그 반대로 읽는다.
    const read = lc.eventResultOf({
      code: got.code, slot_status: got.status, campaign_version: got.version,
    });
    return { got, read };
  };

  /** 지금 DB에 적힌 슬롯 상태 — 모델이 아니라 **커밋된 행** */
  const slotStatus = (slot) =>
    psql(target, db, `SELECT status FROM ten_slot_slots
      WHERE campaign_id = '${slot.campaignId}' AND slot_index = ${slot.slotIndex}`)[0];

  test('★ 모듈이 고른 ACK이 실제로 RESERVED → OPEN을 만든다', () => {
    const slot = reserved();
    assert.equal(slotStatus(slot), 'RESERVED');

    const plan = lc.slotEventForExec({ status: 'ACKED', exchangeOrderId: '555', filledQty: 0 });
    assert.equal(plan.kind, 'ACK');
    assert.equal(plan.evidence, 'VENUE_ORDER');

    const { got, read } = send(slot, plan);
    assert.equal(got.code, 'EVENT_APPLIED', `DB가 거절했습니다: ${got.code}`);
    assert.equal(read.ok, true, read.message);
    // **앱이 읽은 상태와 커밋된 행이 같은가.**
    assert.equal(read.slotStatus, 'OPEN');
    assert.equal(slotStatus(slot), 'OPEN');
  });

  test('★ 번호 없는 ACKED는 모듈이 UNKNOWN_RESPONSE로 고르고 DB도 UNKNOWN으로 옮긴다', () => {
    const slot = reserved();
    const plan = lc.slotEventForExec({ status: 'ACKED', exchangeOrderId: null });
    assert.equal(plan.kind, 'UNKNOWN_RESPONSE');
    assert.equal(plan.evidence, 'NONE');

    const { got, read } = send(slot, plan);
    assert.equal(got.code, 'EVENT_APPLIED', `DB가 거절했습니다: ${got.code}`);
    assert.equal(read.slotStatus, 'UNKNOWN');
    assert.equal(slotStatus(slot), 'UNKNOWN');
  });

  test('★ 닫기 요청 → 확인의 두 걸음이 OPEN → CLOSING → SPENT로 간다', () => {
    const slot = reserved();
    const ack = send(slot, lc.slotEventForExec({ status: 'ACKED', exchangeOrderId: '777' }));
    assert.equal(ack.got.code, 'EVENT_APPLIED');
    slot.version = ack.got.version;

    const req = lc.slotEventForCloseRequest();
    assert.equal(req.kind, 'CLOSE_REQUEST');
    const r1 = send(slot, req, { tag: 'req' });
    assert.equal(r1.got.code, 'EVENT_APPLIED', `DB가 거절했습니다: ${r1.got.code}`);
    assert.equal(r1.read.slotStatus, 'CLOSING');
    assert.equal(slotStatus(slot), 'CLOSING');
    slot.version = r1.got.version;

    const done = lc.slotEventForCloseConfirm({
      ok: true, remainingQty: 0, openEntryOrders: 0, openProtectiveOrders: 0,
    });
    assert.equal(done.kind, 'CLOSED');
    assert.equal(done.evidence, 'VENUE_POSITION');
    const r2 = send(slot, done, { tag: 'done' });
    assert.equal(r2.got.code, 'EVENT_APPLIED', `DB가 거절했습니다: ${r2.got.code}`);
    assert.equal(r2.read.slotStatus, 'SPENT');
    assert.equal(slotStatus(slot), 'SPENT');
  });

  test('★ 모듈이 "적을 사건이 없다"고 하면 DB에 아무것도 가지 않는다', () => {
    // 전송이 REJECTED로 끝난 경우. 098에는 "안 나갔다"를 적을 사건이 없다.
    const slot = reserved();
    const before = eventRows(target, db, slot.campaignId).length;

    const none = lc.slotEventForExec({ status: 'REJECTED' });
    assert.equal(none.kind, null);
    assert.equal(none.needsHuman, true);

    // **보내지 않는다.** 이 시험의 요점은 "보내지 않음"이 지켜지는가다.
    assert.equal(eventRows(target, db, slot.campaignId).length, before);
    assert.equal(slotStatus(slot), 'RESERVED');
  });

  test('★ 포지션이 남아 있으면 닫힘을 적지 않는다 — DB도 그대로다', () => {
    const slot = reserved();
    const ack = send(slot, lc.slotEventForExec({ status: 'ACKED', exchangeOrderId: '888' }));
    slot.version = ack.got.version;
    const req = send(slot, lc.slotEventForCloseRequest(), { tag: 'req' });
    slot.version = req.got.version;
    assert.equal(slotStatus(slot), 'CLOSING');

    const before = eventRows(target, db, slot.campaignId).length;
    const notYet = lc.slotEventForCloseConfirm({
      ok: true, remainingQty: 0.5, openEntryOrders: 0, openProtectiveOrders: 0,
    });
    assert.equal(notYet.kind, null, '포지션이 남았는데 사건을 골랐습니다');

    assert.equal(eventRows(target, db, slot.campaignId).length, before);
    assert.equal(slotStatus(slot), 'CLOSING');
  });

  test('★ 조회가 실패하면 UNKNOWN을 적고, DB도 UNKNOWN이 된다', () => {
    const slot = reserved();
    const ack = send(slot, lc.slotEventForExec({ status: 'ACKED', exchangeOrderId: '999' }));
    slot.version = ack.got.version;
    const req = send(slot, lc.slotEventForCloseRequest(), { tag: 'req' });
    slot.version = req.got.version;

    // **못 읽은 것을 0으로 적지 않는다.**
    const unk = lc.slotEventForCloseConfirm({
      ok: false, remainingQty: null, openEntryOrders: null, openProtectiveOrders: null,
    });
    assert.equal(unk.kind, 'UNKNOWN_RESPONSE');
    const r = send(slot, unk, { tag: 'unk' });
    assert.equal(r.got.code, 'EVENT_APPLIED', `DB가 거절했습니다: ${r.got.code}`);
    assert.equal(r.read.slotStatus, 'UNKNOWN');
    assert.equal(slotStatus(slot), 'UNKNOWN');
  });

  test('★ 모듈이 고를 수 있는 모든 사건 종류가 098의 전이표에 있다', () => {
    // **여기가 두 경로가 갈리는 것을 잡는 자리다.** 모듈이 098에 없는
    // 사건(`FILL`·`SL_ATTACHED` 같은 것)을 고르기 시작하면 가짜 DB는
    // 통과시킨다. 실제 098은 `EVENT_OUT_OF_ORDER`를 돌려주는데, 그 코드는
    // **순서 위반과 구분되지 않는다** — 그래서 응답 코드만 보면 "모르는
    // 종류"를 "아직 때가 아니다"로 읽는다.
    //
    // 그래서 응답이 아니라 **전이표 자체**(`ten_slot_next_status`)에
    // 물어본다. 그 종류로 갈 수 있는 상태가 하나도 없으면 098은 그 사건을
    // 모르는 것이다.
    const kinds = new Map();   // kind → evidence (모듈이 함께 고른 증거)
    for (const exec of [
      { status: 'ACKED', exchangeOrderId: '1' }, { status: 'FILLED', exchangeOrderId: '2' },
      { status: 'RECONCILED', exchangeOrderId: '3' }, { status: 'ACKED' },
      { status: 'SENT' }, { status: 'UNKNOWN' }, { status: 'INTENT' },
    ]) {
      const v = lc.slotEventForExec(exec);
      if (v.kind) kinds.set(v.kind, v.evidence);
    }
    const req = lc.slotEventForCloseRequest();
    kinds.set(req.kind, req.evidence);
    for (const pos of [
      { ok: true, remainingQty: 0, openEntryOrders: 0, openProtectiveOrders: 0 },
      { ok: false, remainingQty: null, openEntryOrders: null, openProtectiveOrders: null },
    ]) {
      const v = lc.slotEventForCloseConfirm(pos);
      if (v.kind) kinds.set(v.kind, v.evidence);
    }

    // 모듈이 아무것도 고르지 못하면 이 시험이 헛돌고 있다.
    assert.ok(kinds.size >= 4, `모듈이 고른 사건 종류가 ${kinds.size}개뿐입니다 (헛돌고 있습니다)`);

    const STATES = ['FREE', 'RESERVED', 'OPEN', 'CLOSING', 'SPENT', 'UNKNOWN'];
    for (const [kind, evidence] of kinds) {
      const reachable = psql(target, db, `SELECT count(*) FROM (SELECT
        public.ten_slot_next_status(s, ${JSON.stringify(kind).replace(/"/g, "'")},
          ${JSON.stringify(evidence).replace(/"/g, "'")}) AS t
        FROM unnest(ARRAY[${STATES.map(x => `'${x}'`).join(',')}]) AS s) q WHERE q.t IS NOT NULL`)[0];
      assert.notEqual(reachable, '0',
        `098의 전이표에 ${kind}/${evidence}로 갈 수 있는 상태가 없습니다 — 모듈과 DB가 갈렸습니다`);
    }

    // **반대 방향도 본다.** 전이표가 아는 종류를 모듈이 하나도 고르지
    // 못하면 그 전이는 앱에서 영원히 안 쓰인다 — 그것도 알아야 한다.
    const known = psql(target, db, `SELECT DISTINCT k FROM unnest(ARRAY[
      'ACK','PARTIAL_FILL','CLOSE_REQUEST','CLOSED','UNKNOWN_RESPONSE']) AS k
      WHERE EXISTS (SELECT 1 FROM unnest(ARRAY[${STATES.map(x => `'${x}'`).join(',')}]) AS s
        WHERE public.ten_slot_next_status(s, k, 'VENUE_ORDER') IS NOT NULL
           OR public.ten_slot_next_status(s, k, 'VENUE_POSITION') IS NOT NULL
           OR public.ten_slot_next_status(s, k, 'NONE') IS NOT NULL)`);
    const unused = known.filter(k => k && !kinds.has(k));
    // `PARTIAL_FILL`은 지금 모듈이 고르지 않는다 — 098에 있고 앱이 안 쓴다.
    // 그 사실을 **적어 두고** 통과시킨다. 숨기면 나중에 "있는 줄 알았다"가 된다.
    assert.deepEqual(unused, ['PARTIAL_FILL'],
      `098에 있는데 모듈이 고르지 않는 사건: ${unused.join(', ') || '없음'}`
      + ' — 목록이 바뀌었으면 이 시험을 보고 결정하세요');
  });
}
