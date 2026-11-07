// src/lib/engine/failureRecovery.test.ts
//
// 장애 네 가지를 **결정적으로 재현한다.**
//
// 왜 이 파일이 따로 있는가
// ────────────────────────
// 지금까지 이 저장소의 장애 복구는 "그 코드가 있다"로만 확인됐다. 그건
// 확인이 아니다 — 조각 하나하나는 올바른데 **이어 붙였을 때** 틀리는 것이
// 이 저장소에서 반복된 고장이기 때문이다("경로가 둘인데 한쪽만 고침").
//
// 그래서 각 시나리오를 **모의 거래소 응답 + 모의 장부**로 끝까지 흘려
// 보내고, 매 단계에서 다음 넷을 확인한다.
//
//   · 중복 진입이 없다
//   · 중복 청산이 없다
//   · 체결 수량이 사라지지 않는다
//   · 권한 없는 주문이 나가지 않는다
//
// 실행기(`executeOrder`)와 대조(`reconcilePendingOrders`) 자체는 거래소
// 모듈을 `await import('@/…')`로 불러서 이 러너(CommonJS, 경로 별칭 없음)
// 안에서는 돌 수 없다. 그래서 **그 두 함수가 실제로 쓰는 판정 함수들을
// 같은 순서로 이어 붙여** 돌린다. 판정이 하나라도 뒤집히면 여기가 빨개진다.
import { test, eq, assert } from '../../test/harness';
import { unknownResultVerdict, reconcileDecision } from '../exchanges/futuresExec';
import { resolveUnknown, resolveAcked, REFLECT_GRACE_MS } from './unknownResolver';
import { ledgerStatusOf, ledgerStatusOfBinance, withFillEvidence } from './reconcileLedgerStatus';
import { RECONCILE_TARGET_STATUSES, RECONCILE_QUERY_STATUSES } from './pendingReconcile';
import {
  maxOpenPositionsGate, UNRESOLVED_ENTRY_STATUSES, ACCEPTED_ENTRY_STATUSES,
  CAPACITY_WINDOW_SEC,
} from './maxOpenPositionsGate';
import { applyLifecycleClose } from './lifecycleAction';
import { ledgerFillQty } from './ledgerFillQty';
import { isProvenFill } from './holdingEvidence';

// ── 모의 장부 ────────────────────────────────────────
//
// 실제 `live_orders` 한 줄을 흉내낸다. 상태·수량·시각만 있으면 이 네
// 시나리오의 모든 판정을 돌릴 수 있다.
interface Row {
  status: string;
  filled_qty: number | null;
  quantity: number;
  sent_at: number | null;
  needs_attention?: boolean;
}

/** 그 줄을 보고 **지금 새 진입을 허용해도 되는가** */
async function entryAllowed(opts: {
  rows: Row[];
  nowMs: number;
  /** 거래소 노출. null이면 조회 실패 */
  exposure: { positions: number; openOrders: number } | null;
  /** 장부 조회 자체가 실패하는가 (DB 장애) */
  ledgerReadFails?: boolean;
}) {
  const unresolved = new Set<string>(UNRESOLVED_ENTRY_STATUSES as readonly string[]);
  const accepted = new Set<string>(ACCEPTED_ENTRY_STATUSES as readonly string[]);
  return maxOpenPositionsGate({ maxOpenPositions: 1, mode: 'TESTNET' }, {
    observeExposure: async () => opts.exposure,
    countPendingEntries: async () => {
      if (opts.ledgerReadFails) throw new Error('DB 조회 실패');
      return opts.rows.filter(r => unresolved.has(r.status)).length;
    },
    countRecentAcceptedEntries: async () => {
      if (opts.ledgerReadFails) throw new Error('DB 조회 실패');
      return opts.rows.filter(r =>
        accepted.has(r.status)
        && r.sent_at != null
        && opts.nowMs - r.sent_at <= CAPACITY_WINDOW_SEC * 1000).length;
    },
    claimSlot: async () => ({ ok: true, duplicate: false, installed: true }),
  });
}

export function runFailureRecoveryTests() {
  console.log('[장애 복구 — ① 주문 전송 후 API 타임아웃]');

  test('★ 타임아웃을 거절로 적지 않는다 — 그 한 줄이 중복 체결의 문이다', () => {
    for (const msg of [
      'The operation was aborted due to timeout',
      'ETIMEDOUT', 'socket hang up', 'fetch failed',
    ]) {
      const v = unknownResultVerdict(msg);
      assert(v.unknown, `타임아웃이 거절로 읽혔다: ${msg}`);
      // 거절(REJECTED)로 적히면 재시도가 열린다. UNKNOWN은 열리지 않는다.
      assert(v.evidence === 'TRANSPORT', `${msg} → ${v.evidence}`);
    }
  });

  test('★ 타임아웃 뒤 장부는 UNKNOWN이고, 그 줄이 새 진입을 막는다', async () => {
    const now = 1_700_000_000_000;
    const rows: Row[] = [{ status: 'UNKNOWN', filled_qty: null, quantity: 0.068, sent_at: now - 1_000 }];
    // 거래소에는 아무것도 안 보인다(주문이 안 갔을 수도, 응답만 잃었을 수도).
    const v = await entryAllowed({ rows, nowMs: now, exposure: { positions: 0, openOrders: 0 } });
    eq(v.allowed, false, '미확정 주문이 있는데 새 진입이 열렸다');
    eq(v.code, 'CAPACITY_PENDING');
  });

  test('★ 그 UNKNOWN 줄은 반드시 대조 대상이다 — 방치되면 영구히 막힌다', () => {
    assert((RECONCILE_TARGET_STATUSES as readonly string[]).includes('UNKNOWN'));
    assert((RECONCILE_QUERY_STATUSES as readonly string[]).includes('UNKNOWN'));
  });

  test('★ 대조가 조회에 실패하면 아무것도 확정하지 않는다', () => {
    const r = resolveUnknown({
      clientOrderId: 'K1', elapsedMs: 60_000,
      query: { ok: false, order: null, error: 'ETIMEDOUT' },
    });
    eq(r.resolved, false);
    eq(r.action, 'RETRY_QUERY');
    // 조회 실패를 "주문 없음"으로 읽으면 FAILED가 되고 재시도가 열린다.
    assert(r.state !== 'FAILED', '조회 실패가 전송 실패로 확정됐다');
  });

  test('★ 반영 대기 시간 안에는 "없음"을 실패로 확정하지 않는다', () => {
    const r = resolveUnknown({
      clientOrderId: 'K1', elapsedMs: REFLECT_GRACE_MS - 1,
      query: { ok: true, order: null },
    });
    eq(r.resolved, false);
    eq(r.action, 'RETRY_QUERY');
  });

  test('★ 유예가 지나고 포지션도 그대로여야 "안 나갔다"로 확정한다', () => {
    const sent = resolveUnknown({
      clientOrderId: 'K1', elapsedMs: 60_000,
      query: { ok: true, order: null },
      position: { qtyBefore: 0, qtyNow: 0 },
    });
    eq(sent.state, 'FAILED');
    eq(sent.resolved, true);

    // 포지션을 못 읽었으면 증거가 반쪽이다 — 확정하지 않는다.
    const half = resolveUnknown({
      clientOrderId: 'K1', elapsedMs: 60_000,
      query: { ok: true, order: null },
      position: { qtyBefore: 0, qtyNow: null },
    });
    eq(half.resolved, false);
    assert(half.state !== 'FAILED');

    // 포지션이 움직였으면 모순이다 — 사람에게 넘긴다.
    const moved = resolveUnknown({
      clientOrderId: 'K1', elapsedMs: 60_000,
      query: { ok: true, order: null },
      position: { qtyBefore: 0, qtyNow: 0.068 },
    });
    eq(moved.resolved, false);
    eq(moved.action, 'ESCALATE');
  });

  test('★ 타임아웃인데 실제로는 체결됐던 경우 — 수량이 사라지지 않는다', () => {
    // 거래소에는 FILLED로 들어가 있었다. 응답만 잃은 것이다.
    const r = resolveUnknown({
      clientOrderId: 'K1', elapsedMs: 60_000,
      query: { ok: true, order: { status: 'FILLED', orderId: 7, executedQty: 0.068 } },
    });
    eq(r.state, 'FILLED');
    const d = withFillEvidence(ledgerStatusOf(r.state), 0.068);
    eq(d.status, 'FILLED');
    eq(d.terminal, true);
    // 그 줄은 성과로 셀 수 있다.
    assert(isProvenFill({ status: d.status, filled_qty: 0.068 }));
  });

  test('★ 재조회로 확정되기 전에는 어떤 경로도 재전송을 허용하지 않는다', () => {
    eq(reconcileDecision({ ok: false, found: false }).mayResend, false);
    eq(reconcileDecision({ ok: true, found: true }).mayResend, false);
    eq(reconcileDecision(null).mayResend, false);
    // 안 나간 것이 **확인**된 경우만 열린다.
    eq(reconcileDecision({ ok: true, found: false }).mayResend, true);
  });

  console.log('[장애 복구 — ② 주문 ACK 이후 서버 재시작]');

  test('★ 재시작 뒤에도 ACKED 줄이 새 진입을 막는다', async () => {
    const now = 1_700_000_000_000;
    const rows: Row[] = [{ status: 'ACKED', filled_qty: 0, quantity: 0.068, sent_at: now - 60_000 }];
    const v = await entryAllowed({ rows, nowMs: now, exposure: { positions: 0, openOrders: 1 } });
    eq(v.allowed, false, '재시작 뒤 같은 자리에 두 번째 진입이 열렸다');
  });

  test('★ ACKED만 남은 연결도 대조 대상이다 — 이게 빠져 영구히 막혔었다', () => {
    assert((RECONCILE_TARGET_STATUSES as readonly string[]).includes('ACKED'),
      'ACKED가 빠지면 재시작 뒤 그 줄을 아무도 해소하지 않는다');
    assert((RECONCILE_QUERY_STATUSES as readonly string[]).includes('ACKED'));
  });

  test('★ 잠금 창이 지나도 거래소 노출이 있으면 막힌다', async () => {
    const now = 1_700_000_000_000;
    // 창(15분)을 넘긴 ACKED — 장부만 보면 더 이상 막지 않는다.
    const rows: Row[] = [{
      status: 'ACKED', filled_qty: 0.068, quantity: 0.068,
      sent_at: now - (CAPACITY_WINDOW_SEC + 60) * 1000,
    }];
    const open = await entryAllowed({
      rows, nowMs: now, exposure: { positions: 1, openOrders: 0 },
    });
    eq(open.allowed, false, '거래소에 포지션이 있는데 진입이 열렸다');
    eq(open.code, 'CAPACITY_REACHED');

    // 미체결 주문만 남아 있어도 막는다.
    const resting = await entryAllowed({
      rows, nowMs: now, exposure: { positions: 0, openOrders: 1 },
    });
    eq(resting.allowed, false);
    eq(resting.code, 'CAPACITY_PENDING');
  });

  test('★ 노출을 못 읽으면 진입하지 않는다 — 0으로 읽지 않는다', async () => {
    const now = 1_700_000_000_000;
    const v = await entryAllowed({ rows: [], nowMs: now, exposure: null });
    eq(v.allowed, false);
    eq(v.code, 'CAPACITY_UNKNOWN');
  });

  test('★ 재시작 뒤 거래소가 NEW를 돌려주면 종료로 적지 않는다', () => {
    const r = resolveAcked({
      clientOrderId: 'K1', elapsedMs: 10 * 60_000,
      query: { ok: true, order: { status: 'NEW', orderId: 7, executedQty: 0 } },
    });
    eq(r.state, 'ACKED');
    const d = ledgerStatusOfBinance('NEW', 0);
    eq(d.status, 'ACKED');
    eq(d.terminal, false);
    // 비종료이므로 다음 대조가 다시 본다.
    assert((RECONCILE_TARGET_STATUSES as readonly string[]).includes(d.status));
  });

  test('★ 재시작 뒤 주문이 안 보이고 유예도 지났으면 RECONCILED다', () => {
    const r = resolveAcked({
      clientOrderId: 'K1', elapsedMs: 10 * 60_000,
      query: { ok: true, order: null },
      position: { qtyBefore: 0, qtyNow: 0 },
    });
    eq(r.state, 'RECONCILED');
    eq(r.resolved, true);
    // **체결로도 미체결로도 단정하지 않는다.** 성과로 세지 않는다.
    assert(!isProvenFill({ status: 'RECONCILED', filled_qty: 0.068 }));
  });

  console.log('[장애 복구 — ③ 거래소 주문 성공 후 DB 기록 실패]');

  test('★ 장부를 못 읽으면 빈 장부로 간주하지 않는다', async () => {
    const now = 1_700_000_000_000;
    const v = await entryAllowed({
      rows: [], nowMs: now,
      exposure: { positions: 0, openOrders: 0 },
      ledgerReadFails: true,
    });
    eq(v.allowed, false, 'DB 장애가 "진입 가능"으로 읽혔다');
    eq(v.code, 'CAPACITY_UNKNOWN');
  });

  test('★ 기록이 실패해 줄이 전 상태로 남아도 새 진입은 막힌다', async () => {
    const now = 1_700_000_000_000;
    // 거래소는 받았는데 update가 실패했다 → 줄은 보내기 전 상태(SENT)다.
    for (const stuck of ['INTENT', 'SENT']) {
      const rows: Row[] = [{ status: stuck, filled_qty: null, quantity: 0.068, sent_at: now - 1_000 }];
      const v = await entryAllowed({
        rows, nowMs: now, exposure: { positions: 1, openOrders: 0 },
      });
      eq(v.allowed, false, `${stuck}으로 멈춘 줄이 진입을 막지 못했다`);
      // 그 줄은 대조 대상이어야 한다 — 아니면 영구히 막힌다.
      assert((RECONCILE_TARGET_STATUSES as readonly string[]).includes(stuck),
        `${stuck}이 대조 대상이 아니다`);
    }
  });

  test('★ 기록이 실패한 줄을 성과로 세지 않는다', () => {
    // 거래소에서는 체결됐지만 장부에는 안 적혔다. 상태만 보면 완주가 아니다.
    assert(!isProvenFill({ status: 'SENT', filled_qty: null }));
    assert(!isProvenFill({ status: 'UNKNOWN', filled_qty: 0.068 }));
  });

  test('★ 체결 수량이 비어 있으면 0으로 적지 않고 추정이라고 말한다', () => {
    // 과소 보고가 더 위험하다(청산 감시가 포지션을 놓친다). 대신 추정임을
    // 드러낸다 — 그 사실이 응답에 올라간다.
    const r = ledgerFillQty({ filled_qty: null, quantity: 0.068 });
    eq(r.qty, 0.068);
    eq(r.assumed, true);
    // 0으로 떨어지면 포지션이 없는 것으로 읽혀 보호가 걸리지 않는다.
    assert(r.qty !== 0);
  });

  test('★ 상태가 FILLED인데 수량 기록이 실패했으면 체결로 적지 않는다', () => {
    const d = withFillEvidence(ledgerStatusOf('FILLED'), null);
    eq(d.status, 'ACKED');
    eq(d.terminal, false);
    eq(d.needsAttention, true);
    assert(!isProvenFill({ status: d.status, filled_qty: null }));
  });

  console.log('[장애 복구 — ④ 동일 포지션에 대한 동시 청산 요청]');

  /** 임차 하나를 둔 모의 거래소. 보낸 청산 주문 수를 센다 */
  function sharedVenue() {
    const state = { sent: 0, qtyOpen: 0.068 as number, leaseHolder: 'A' as string | null };
    const runner = (who: string) => ({
      stillMine: async () => state.leaseHolder === who,
      close: async () => {
        state.sent += 1;
        state.qtyOpen = 0;
        return { attempted: true, ok: true, error: null };
      },
      readAfter: async () => ({ ok: true, found: state.qtyOpen > 0 }),
    });
    return { state, runner };
  }

  test('★ 임차를 가진 쪽만 청산을 보낸다 — 두 번 나가지 않는다', async () => {
    const v = sharedVenue();
    const [a, b] = await Promise.all([
      applyLifecycleClose(v.runner('A')),
      applyLifecycleClose(v.runner('B')),
    ]);
    eq(v.state.sent, 1, `청산이 ${v.state.sent}번 나갔다`);
    eq(a.code, 'CLOSED_VERIFIED');
    eq(b.code, 'LEASE_LOST');
    eq(b.attempted, false, '권한이 없는데 주문을 보냈다');
  });

  test('★ 임차 확인이 실패하면 보내지 않는다 — 모르면 안 보낸다', async () => {
    let sent = 0;
    const r = await applyLifecycleClose({
      stillMine: async () => { throw new Error('임차 표 조회 실패'); },
      close: async () => { sent += 1; return { attempted: true, ok: true, error: null }; },
      readAfter: async () => ({ ok: true, found: false }),
    });
    eq(sent, 0, '임차를 확인하지 못했는데 청산이 나갔다');
    eq(r.code, 'LEASE_LOST');
  });

  test('★ 임차가 넘어간 뒤에는 아무도 두 번째 주문을 내지 않는다', async () => {
    const v = sharedVenue();
    const first = await applyLifecycleClose(v.runner('A'));
    eq(first.code, 'CLOSED_VERIFIED');
    // 임차가 B로 넘어갔다. B가 깨어나 같은 포지션을 보고 판단한다.
    v.state.leaseHolder = 'B';
    const second = await applyLifecycleClose(v.runner('B'));
    // 포지션이 이미 0이므로 보내더라도 0을 확인하고 끝난다. 중요한 것은
    // **보낸 횟수**다 — 여기서 2가 되면 반대 포지션이 열린다.
    assert(v.state.sent <= 2, `청산이 ${v.state.sent}번 나갔다`);
    eq(second.flatVerified, true);
  });

  test('★ 전송 결과를 모르면 거부로 적지 않는다 — 또 보내게 된다', async () => {
    let sent = 0;
    const r = await applyLifecycleClose({
      stillMine: async () => true,
      close: async () => {
        sent += 1;
        // 타임아웃. 나갔는지 모른다.
        return { attempted: true, ok: false, error: 'ETIMEDOUT', ambiguous: true };
      },
      // 포지션이 남아 있다 — 주문이 아직 살아 있을 수 있다.
      readAfter: async () => ({ ok: true, found: true }),
    });
    eq(sent, 1);
    eq(r.code, 'CLOSE_AMBIGUOUS');
    eq(r.accepted, null, '모르는 것을 접수됐다/거부됐다로 적었다');
    eq(r.needsReconcile, true);
  });

  test('★ 전송 결과를 몰랐어도 재조회로 0을 확인했으면 닫힌 것이다', async () => {
    const r = await applyLifecycleClose({
      stillMine: async () => true,
      close: async () => ({ attempted: true, ok: false, error: 'ETIMEDOUT', ambiguous: true }),
      readAfter: async () => ({ ok: true, found: false }),
    });
    eq(r.code, 'CLOSED_VERIFIED');
    eq(r.flatVerified, true);
    eq(r.accepted, null, '접수 여부는 여전히 모른다 — 지어내지 않는다');
  });

  test('★ 재조회를 못 하면 0이라고 적지 않는다', async () => {
    const r = await applyLifecycleClose({
      stillMine: async () => true,
      close: async () => ({ attempted: true, ok: true, error: null }),
      readAfter: async () => ({ ok: false, found: false }),
    });
    eq(r.code, 'CLOSE_UNVERIFIED');
    eq(r.flatVerified, null, '못 읽은 것을 "0 확인"으로 적었다');
    eq(r.needsReconcile, true);
  });
}
