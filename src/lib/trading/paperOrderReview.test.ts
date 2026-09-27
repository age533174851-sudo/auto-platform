// src/lib/trading/paperOrderReview.test.ts
//
// **확인 시트 — 순서와 값에 관한 사실들.**
//
// 무엇을 막는가
// ─────────────
// 이 층이 생기기 전에는 같은 방향을 두 번 누르면 곧바로 `form.submit()`이
// 나갔다. 확인 창을 끼워 넣으면서 가장 쉽게 생기는 고장은 셋이다:
//
//   ⑴ 확인 창을 열었는데 **그 자리에서 주문도 같이 나간다**
//   ⑵ 취소했는데 나간다 / 확인을 두 번 눌러 두 번 나간다
//   ⑶ 창에는 ETHUSDT가 적혀 있는데 **BTCUSDT가 나간다**
//
// 셋 다 "이 상태에서 저 사건이 오면 무엇이 일어나는가"이고, `useState`
// 안에 두면 시험이 닿지 못한다. 그래서 전이를 순수 함수로 빼 두고
// (`reviewReduce`), 여기서 **실제로 눌러 본다.**
//
// ★ 이 시험은 화면을 보지 않는다. 부수효과를 센다.
import { test, eq, assert } from '../../test/harness';
import {
  REVIEW_CLOSED, canOpenReview, confirmVerdict, reviewPhaseOf, reviewReduce,
  reviewRows, sameTicket,
  type ReviewEnv, type ReviewEvent, type ReviewState, type ReviewTicket,
} from './paperOrderReview';
import { ctaVerdict } from './ctaVerdict';
import { switchBlockedReason, switchLockState } from './tradeIdentity';
import { buildPaperPlan } from '../engine/paperPlan';

const ETH: ReviewTicket = { market: 'USDM', symbol: 'ETHUSDT', side: 'LONG' };
const BTC: ReviewTicket = { market: 'USDM', symbol: 'BTCUSDT', side: 'LONG' };

/** 보낼 수 있는 상태의 기본 환경 */
const env = (o: Partial<ReviewEnv> = {}): ReviewEnv => ({
  current: ETH, gateReady: true, busy: false, intentOpen: true,
  ctaAction: 'OPEN_REVIEW', ...o,
});

/**
 * 사건을 차례로 먹인다. **제출이 몇 번 났는지**를 센다.
 *
 * 환경을 사건마다 바꿀 수 있게 배열로 받는다 — "확인 창이 열린 뒤에
 * 게이트가 닫혔다" 같은 순서를 재현해야 한다.
 */
function drive(steps: Array<{ e: ReviewEvent; env?: Partial<ReviewEnv> }>,
  start: ReviewState = REVIEW_CLOSED) {
  let st = start;
  let submits = 0;
  for (const s of steps) {
    const step = reviewReduce(st, env(s.env), s.e);
    st = step.state;
    submits += step.effects.filter(f => f === 'SUBMIT').length;
  }
  return { state: st, submits, phase: reviewPhaseOf(st, false) };
}

/**
 * 실제 `buildPaperPlan` 결과 — 미리보기 식을 새로 적지 않는다.
 *
 * 선물은 **손절이 필수**다(`buildPaperPlan`이 거부한다). 청산 너머가
 * 아니도록 진입가 가까이 둔다.
 */
function realPlan(o: { markPrice: number | null; quantity: number; leverage?: number }) {
  return buildPaperPlan({
    symbol: 'ETHUSDT', side: 'LONG', market: 'USDM',
    quantity: o.quantity, leverage: o.leverage ?? 10,
    markPrice: o.markPrice,
    stopPrice: o.markPrice == null ? null : o.markPrice * 0.99,
    takeProfit: null,
    availableBalance: 10_000, marginMode: 'ISOLATED',
  });
}

const rowOf = (rows: ReturnType<typeof reviewRows>, key: string) => {
  const r = rows.find(x => x.key === key);
  assert(!!r, `${key} 칸이 없다`);
  return r!;
};

export function runPaperOrderReviewTests() {
  console.log('[모의 주문 확인 시트]');

  // ══════════ 1~2 · CTA가 무엇을 하는가 ══════════

  test('① 방향을 안 골랐으면 첫 클릭은 고르기뿐 — 확인 창도 주문도 없다', () => {
    const v = ctaVerdict({
      gateReady: true, busy: false, intentOpen: true, locked: false,
      unavailable: false, sideChosen: false, sameSide: false,
    });
    eq(v.action, 'CHOOSE_SIDE');
    // 그 상태에서 시트를 열려고 해도 열리지 않는다
    const r = drive([{ e: { type: 'OPEN' }, env: { ctaAction: v.action } }]);
    eq(r.phase, 'NONE', '방향도 안 골랐는데 확인 창이 열렸다');
    eq(r.submits, 0);
  });

  test('★② 같은 방향 두 번째 클릭은 **확인 창만** 연다 — 주문은 안 나간다', () => {
    const v = ctaVerdict({
      gateReady: true, busy: false, intentOpen: true, locked: false,
      unavailable: false, sideChosen: true, sameSide: true,
    });
    eq(v.action, 'OPEN_REVIEW');
    const r = drive([{ e: { type: 'OPEN' }, env: { ctaAction: v.action } }]);
    eq(r.phase, 'REVIEW');
    eq(r.state.opened?.symbol, 'ETHUSDT');
    eq(r.submits, 0, '★ 확인 창을 여는데 주문이 나갔다');
  });

  // ══════════ 3~4 · 취소와 확인 ══════════

  test('③ 취소하면 주문이 나가지 않는다', () => {
    const r = drive([{ e: { type: 'OPEN' } }, { e: { type: 'CANCEL' } }]);
    eq(r.phase, 'NONE');
    eq(r.submits, 0, '★ 취소했는데 주문이 나갔다');
  });

  test('④ 확인하면 주문이 **정확히 한 번** 나간다', () => {
    const r = drive([{ e: { type: 'OPEN' } }, { e: { type: 'CONFIRM' } }]);
    eq(r.submits, 1);
    eq(r.state.sent, true);
  });

  // ══════════ 5~6 · 열려 있는 동안 정체성을 못 바꾼다 ══════════

  test('⑤ 확인 창이 열려 있으면 시장을 바꿀 수 없다', () => {
    const s = switchLockState({ inFlight: false, reviewing: true });
    eq(s, 'ORDER_REVIEW');
    assert(!!switchBlockedReason(s), '확인 중인데 막는 사유가 없다');
  });

  test('⑥ 확인 창이 열려 있으면 종목도 바꿀 수 없다 — 사유를 돌려쓰지 않는다', () => {
    // 잠금은 하나지만 **사유는 상태마다 다르다.** 확인 중인데 "보내는
    // 중입니다"라고 적으면 사용자는 주문이 이미 나간 줄 안다.
    const reviewing = switchBlockedReason('ORDER_REVIEW');
    const inFlight = switchBlockedReason('ORDER_IN_FLIGHT');
    assert(!!reviewing && !!inFlight, '사유가 비어 있다');
    assert(reviewing !== inFlight, '확인 중과 보내는 중의 사유가 같다');
    eq(switchBlockedReason('NONE'), null);
  });

  // ══════════ 7~8 · 열리면 안 되는 자리 ══════════

  test('★⑦ 청산 탭에서는 확인 창이 열리지 않는다 — 주문도 0', () => {
    const v = ctaVerdict({
      gateReady: true, busy: false, intentOpen: false, locked: false,
      unavailable: false, sideChosen: true, sameSide: true,
    });
    eq(v.action, 'NONE');
    const r = drive([{ e: { type: 'OPEN' }, env: { intentOpen: false, ctaAction: v.action } }]);
    eq(r.phase, 'NONE');
    eq(r.submits, 0);
    // intent만 화면이 알고 폼은 모른다. **둘 다** 막아야 한다.
    const r2 = drive([{ e: { type: 'OPEN' }, env: { intentOpen: false } }]);
    eq(r2.phase, 'NONE', '★ 청산 탭인데 확인 창이 열렸다');
  });

  test('⑧ 게이트가 안 열렸으면 확인 창이 열리지 않는다', () => {
    const v = ctaVerdict({
      gateReady: false, busy: false, intentOpen: true, locked: false,
      unavailable: false, sideChosen: true, sameSide: true,
    });
    eq(v.action, 'NONE');
    const r = drive([{ e: { type: 'OPEN' }, env: { gateReady: false, ctaAction: v.action } }]);
    eq(r.phase, 'NONE');
    eq(r.submits, 0);
  });

  // ══════════ 9~10 · 연타와 도중 변화 ══════════

  test('★⑨ 확인을 연타해도 주문은 한 번뿐이다', () => {
    const r = drive([
      { e: { type: 'OPEN' } },
      { e: { type: 'CONFIRM' } },
      { e: { type: 'CONFIRM' } },
      { e: { type: 'CONFIRM' }, env: { busy: true } },
    ]);
    eq(r.submits, 1, '★ 같은 주문이 여러 번 나갔다');
  });

  test('⑩ 확인 창이 열린 뒤 게이트가 닫히면 확인 버튼이 꺼진다', () => {
    const opened: ReviewState = { opened: ETH, sent: false };
    const v = confirmVerdict({
      phase: 'REVIEW', opened: ETH, current: ETH, gateReady: false, busy: false,
    });
    eq(v.off, true);
    eq(v.action, 'NONE');
    assert(!!v.reason, '왜 못 누르는지 적지 않았다');
    const r = drive([{ e: { type: 'CONFIRM' }, env: { gateReady: false } }], opened);
    eq(r.submits, 0, '★ 게이트가 닫혔는데 주문이 나갔다');
  });

  // ══════════ 11 · 읽은 주문과 나가는 주문이 같다 ══════════

  test('★⑪ 창에 적힌 정체성과 나가는 주문의 정체성이 같다', () => {
    const r = drive([{ e: { type: 'OPEN' } }]);
    eq(r.state.opened?.market, 'USDM');
    eq(r.state.opened?.symbol, 'ETHUSDT');
    const rows = reviewRows({
      market: r.state.opened!.market, marketLabel: 'USDⓈ-M',
      symbol: r.state.opened!.symbol, side: 'LONG', sideLabel: 'LONG',
      orderTypeLabel: '시장가', referencePrice: 3000, quantity: 1,
      leverage: 10, marginMode: 'ISOLATED',
      plan: realPlan({ markPrice: 3000, quantity: 1 }),
    });
    eq((rowOf(rows, 'SYMBOL').value as any).text, 'ETHUSDT');
  });

  test('★⑪-b 종목이 바뀌면 창이 닫힌다 — 읽은 것과 다른 주문을 못 보낸다', () => {
    const r = drive([
      { e: { type: 'OPEN' } },
      { e: { type: 'IDENTITY' }, env: { current: BTC } },
      { e: { type: 'CONFIRM' }, env: { current: BTC } },
    ]);
    eq(r.phase, 'NONE', '종목이 바뀌었는데 창이 그대로다');
    eq(r.submits, 0, '★ 읽은 것과 다른 종목으로 주문이 나갔다');
  });

  test('★⑪-c 창이 남아 있어도 정체성이 다르면 확인이 막힌다', () => {
    // 닫기 전이라도 **확인 버튼 판정이 한 번 더 막는다.** 방어는 둘이다.
    const v = confirmVerdict({
      phase: 'REVIEW', opened: ETH, current: BTC, gateReady: true, busy: false,
    });
    eq(v.off, true);
    eq(v.action, 'NONE');
    const r = drive([{ e: { type: 'CONFIRM' }, env: { current: BTC } }],
      { opened: ETH, sent: false });
    eq(r.submits, 0);
  });

  test('방향이 바뀌어도 다른 주문이다', () => {
    eq(sameTicket(ETH, { ...ETH, side: 'SHORT' }), false);
    const r = drive([{ e: { type: 'CONFIRM' }, env: { current: { ...ETH, side: 'SHORT' } } }],
      { opened: ETH, sent: false });
    eq(r.submits, 0);
  });

  // ══════════ 13~14 · 없는 값을 0으로 적지 않는다 ══════════

  test('★⑬ 청산가가 없으면 "—"다 — 0으로 적지 않는다', () => {
    const rows = reviewRows({
      market: 'USDM', marketLabel: 'USDⓈ-M', symbol: 'ETHUSDT', side: 'LONG',
      sideLabel: 'LONG', orderTypeLabel: '시장가',
      referencePrice: 3000, quantity: 1, leverage: 10, marginMode: 'ISOLATED',
      plan: { ok: true, notional: 3000, requiredMargin: 300, entryFee: 1.5,
              liquidationPrice: null, plan: { liquidationDistancePct: 0 } },
    });
    const liq = rowOf(rows, 'LIQUIDATION_PRICE');
    eq(liq.value.kind, 'UNKNOWN');
    assert(!!(liq.value as any).reason, '왜 없는지 적지 않았다');
    // 거리도 같이 없어야 한다 — 0%는 "이미 청산됐다"로 읽힌다
    eq(rowOf(rows, 'LIQUIDATION_DISTANCE').value.kind, 'UNKNOWN');
  });

  test('★⑬-b 계획을 못 만들었으면 명목가·증거금·수수료도 "—"다', () => {
    // `buildPaperPlan`은 실패해도 0을 채워 돌려준다. 그 0은 "0원"이 아니다.
    const failed = realPlan({ markPrice: null, quantity: 1 });
    eq(failed.ok, false);
    eq(failed.entryFee, 0, '전제가 깨졌다 — 실패한 계획이 0을 채우지 않는다');
    const rows = reviewRows({
      market: 'USDM', marketLabel: 'USDⓈ-M', symbol: 'ETHUSDT', side: 'LONG',
      sideLabel: 'LONG', orderTypeLabel: '시장가',
      referencePrice: null, quantity: 1, leverage: 10, marginMode: 'ISOLATED',
      plan: failed,
    });
    for (const k of ['NOTIONAL', 'REQUIRED_MARGIN', 'ENTRY_FEE']) {
      eq(rowOf(rows, k).value.kind, 'UNKNOWN', `${k}를 0으로 적었다`);
    }
    eq(rowOf(rows, 'REFERENCE_PRICE').value.kind, 'UNKNOWN');
  });

  test('★⑭ 청산까지 거리는 정본 계획의 값 그대로다 — 배율로 다시 계산하지 않는다', () => {
    const plan = realPlan({ markPrice: 3000, quantity: 1, leverage: 10 });
    assert(plan.ok, plan.reason);
    assert(plan.liquidationPrice != null, '전제가 깨졌다 — 선물인데 청산가가 없다');
    const rows = reviewRows({
      market: 'USDM', marketLabel: 'USDⓈ-M', symbol: 'ETHUSDT', side: 'LONG',
      sideLabel: 'LONG', orderTypeLabel: '시장가',
      referencePrice: 3000, quantity: 1, leverage: 10, marginMode: 'ISOLATED', plan,
    });
    const d = rowOf(rows, 'LIQUIDATION_DISTANCE').value as any;
    eq(d.kind, 'PERCENT');
    eq(d.amount, plan.plan!.liquidationDistancePct);
    // `100 / leverage`(= 10%)와 **다른 값**이어야 한다 — 같으면 배율만 보고
    // 계산한 것이고, 격리/교차·잔고가 빠진 숫자다.
    assert(Math.abs(d.amount - 100 / 10) > 1e-9,
      `배율만으로 계산한 값과 같다 (${d.amount})`);
  });

  // ══════════ 15 · 여는 것에는 부수효과가 없다 ══════════

  test('★⑮ 확인 창을 여는 것만으로는 아무것도 보내지 않는다', () => {
    const step = reviewReduce(REVIEW_CLOSED, env(), { type: 'OPEN' });
    eq(step.effects.length, 0, '★ 창을 여는데 부수효과가 났다');
    // 취소도 마찬가지다
    const cancel = reviewReduce({ opened: ETH, sent: false }, env(), { type: 'CANCEL' });
    eq(cancel.effects.length, 0);
  });

  // ══════════ 결과 처리 ══════════

  test('성공하면 창이 닫힌다', () => {
    const r = drive([
      { e: { type: 'OPEN' } }, { e: { type: 'CONFIRM' } },
      { e: { type: 'RESULT', ok: true } },
    ]);
    eq(r.phase, 'NONE');
    eq(r.submits, 1);
  });

  test('★ 실패하면 창이 남는다 — 사유를 잃지 않는다', () => {
    const r = drive([
      { e: { type: 'OPEN' } }, { e: { type: 'CONFIRM' } },
      { e: { type: 'RESULT', ok: false } },
    ]);
    eq(r.phase, 'REVIEW', '실패했는데 창이 닫혀 사유가 사라졌다');
    eq(r.state.sent, false, '다시 시도할 수 없는 상태로 굳었다');
  });

  test('보내는 중에는 닫히지 않는다 — 결과가 갈 곳이 없어진다', () => {
    const r = drive([
      { e: { type: 'OPEN' } }, { e: { type: 'CONFIRM' } },
      { e: { type: 'CANCEL' } },
      { e: { type: 'IDENTITY' }, env: { current: BTC } },
    ]);
    assert(r.state.opened != null, '보내는 중인데 창이 닫혔다');
    eq(r.submits, 1);
  });

  test('보내는 중이면 확인 버튼이 꺼진다', () => {
    for (const o of [{ phase: 'SUBMITTING' as const, busy: false }, { phase: 'REVIEW' as const, busy: true }]) {
      const v = confirmVerdict({
        phase: o.phase, opened: ETH, current: ETH, gateReady: true, busy: o.busy,
      });
      eq(v.off, true);
      eq(v.action, 'NONE');
      assert(/보내는 중/.test(v.reason || ''), `사유가 ${v.reason}이다`);
    }
  });

  test('★ 꺼졌으면 확인 버튼의 할 일은 언제나 NONE이다', () => {
    const cases = [
      { phase: 'NONE' as const, opened: null, current: ETH, gateReady: true, busy: false },
      { phase: 'REVIEW' as const, opened: ETH, current: null, gateReady: true, busy: false },
      { phase: 'REVIEW' as const, opened: null, current: ETH, gateReady: true, busy: false },
      { phase: 'REVIEW' as const, opened: ETH, current: ETH, gateReady: false, busy: false },
      { phase: 'SUBMITTING' as const, opened: ETH, current: ETH, gateReady: true, busy: false },
    ];
    for (const c of cases) {
      const v = confirmVerdict(c);
      eq(v.off, true, JSON.stringify(c));
      eq(v.action, 'NONE', JSON.stringify(c));
      assert(!!v.reason, `사유 없이 꺼졌다: ${JSON.stringify(c)}`);
    }
  });

  test('열 수 있는 조건 — 셋이 전부 맞아야 한다', () => {
    eq(canOpenReview({ phase: 'NONE', ctaAction: 'OPEN_REVIEW', ticket: ETH }), true);
    eq(canOpenReview({ phase: 'REVIEW', ctaAction: 'OPEN_REVIEW', ticket: ETH }), false);
    eq(canOpenReview({ phase: 'NONE', ctaAction: 'CHOOSE_SIDE', ticket: ETH }), false);
    eq(canOpenReview({ phase: 'NONE', ctaAction: 'NONE', ticket: ETH }), false);
    eq(canOpenReview({ phase: 'NONE', ctaAction: 'OPEN_REVIEW', ticket: null }), false);
    eq(canOpenReview({
      phase: 'NONE', ctaAction: 'OPEN_REVIEW',
      ticket: { market: 'USDM', symbol: '', side: 'LONG' },
    }), false);
  });

  test('표시 줄은 정해진 순서와 개수다 — 칸이 조용히 사라지지 않는다', () => {
    const rows = reviewRows({
      market: 'USDM', marketLabel: 'USDⓈ-M', symbol: 'ETHUSDT', side: 'LONG',
      sideLabel: 'LONG', orderTypeLabel: '시장가',
      referencePrice: 3000, quantity: 1, leverage: 10, marginMode: 'ISOLATED',
      plan: realPlan({ markPrice: 3000, quantity: 1 }),
    });
    eq(rows.map(r => r.key).join(','),
      'MARKET,SYMBOL,SIDE,ORDER_TYPE,REFERENCE_PRICE,QUANTITY,NOTIONAL,'
      + 'MARGIN_MODE,LEVERAGE,REQUIRED_MARGIN,ENTRY_FEE,'
      + 'LIQUIDATION_PRICE,LIQUIDATION_DISTANCE');
  });

  test('★ 기준가는 넘겨받은 값 그대로다 — 명목가/수량으로 되만들지 않는다', () => {
    // 수량이 격자에 맞춰 잘리면 `notional / quantity`는 기준가가 아니다.
    const plan = realPlan({ markPrice: 3000, quantity: 1 });
    const rows = reviewRows({
      market: 'USDM', marketLabel: 'USDⓈ-M', symbol: 'ETHUSDT', side: 'LONG',
      sideLabel: 'LONG', orderTypeLabel: '시장가',
      referencePrice: 2999.5, quantity: 1, leverage: 10, marginMode: 'ISOLATED', plan,
    });
    const v = rowOf(rows, 'REFERENCE_PRICE').value as any;
    eq(v.kind, 'PRICE');
    eq(v.amount, 2999.5);
    assert(Math.abs(v.amount - plan.notional / 1) > 1e-9,
      '기준가가 명목가/수량과 같다 — 되만든 값일 수 있다');
  });
}
