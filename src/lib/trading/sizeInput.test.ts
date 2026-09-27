// src/lib/trading/sizeInput.test.ts
//
// **직접 입력을 조용히 고치지 않는다. MAX는 수수료까지 센다.**
//
// 두 고장을 막는다
// ────────────────
//  ① 잔고 100인데 총액 500을 적으면 예전 역함수는 **100%로 잘라서** 줬다.
//     슬라이더를 맞추는 용도로는 맞지만 직접 입력에서는 사용자가 적은 것과
//     나가는 것이 달라진다. 아무도 틀렸다고 말하지 않는다.
//  ② `MAX = 100%`로 두면 `buildPaperPlan`이 증거금 **위에** 수수료를 더
//     요구해서 주문이 막힌다. 임의 여유분(0.1%)을 두면 그 숫자가 실제
//     수수료와 어긋나는 날 다시 막히고, 왜인지 아무도 모른다.
import { test, eq, assert, close } from '../../test/harness';
import {
  quantityInputToPercent, notionalInputToPercent, maxAllocationPercent,
  planSizing, percentFromNotional, PRO_PERCENTS, BUY_PERCENTS,
} from './positionSizing';
import { PAPER_FEE_RATE_PCT, paperFeeRate, buildPaperPlan } from '../engine/paperPlan';

export function runSizeInputTests() {
  console.log('[수량·총액 직접 입력 / MAX]');

  test('★ 잔고를 넘는 총액은 조용히 100%로 고치지 않는다', () => {
    const r = notionalInputToPercent({ notional: 500, availableBalance: 100, leverage: 1 });
    eq(r.code, 'OVER_BUDGET');
    eq(r.percent, null, '넘쳤는데 쓸 수 있는 비율을 돌려줬다');
    close(r.rawPercent as number, 500, 1e-9);
    assert(!!r.reason && /500/.test(r.reason), '얼마나 넘쳤는지 적지 않았다');
  });

  test('★ 잔고를 넘는 수량도 같다', () => {
    // 100달러 잔고에 1 BTC(=50,000) → 500배
    const r = quantityInputToPercent({
      quantity: 1, availableBalance: 100, price: 50000, leverage: 1 });
    eq(r.code, 'OVER_BUDGET');
    eq(r.percent, null);
  });

  test('범위 안이면 그대로 쓴다 — 역함수와 같은 기준이다', () => {
    const r = notionalInputToPercent({ notional: 50, availableBalance: 100, leverage: 1 });
    eq(r.code, 'OK');
    close(r.percent as number, 50, 1e-9);
    // 슬라이더용 역함수와 **같은 값**이어야 한다. 두 칸이 다른 기준을 쓰면
    // 같은 주문이 칸에 따라 다른 비율로 보인다.
    close(percentFromNotional({ notional: 50, availableBalance: 100, leverage: 1 }) as number,
      r.percent as number, 1e-9);
  });

  test('배율이 있으면 증거금 기준이다 — 명목가 기준이 아니다', () => {
    // 명목가 500, 10배 → 증거금 50 → 잔고 100의 50%
    const r = notionalInputToPercent({ notional: 500, availableBalance: 100, leverage: 10 });
    eq(r.code, 'OK');
    close(r.percent as number, 50, 1e-9);
  });

  test('★ 못 읽은 것을 0으로 접지 않는다', () => {
    eq(notionalInputToPercent({ notional: 10, availableBalance: null, leverage: 1 }).code,
      'BALANCE_UNKNOWN');
    eq(quantityInputToPercent({
      quantity: 1, availableBalance: 100, price: null, leverage: 1 }).code, 'PRICE_UNKNOWN');
    eq(notionalInputToPercent({ notional: -1, availableBalance: 100, leverage: 1 }).code,
      'INVALID');
    // 못 읽었을 때 비율을 만들어 주지 않는다
    for (const r of [
      notionalInputToPercent({ notional: 10, availableBalance: null, leverage: 1 }),
      quantityInputToPercent({ quantity: 1, availableBalance: 100, price: null, leverage: 1 }),
    ]) { eq(r.percent, null); assert(!!r.reason, '사유가 없다'); }
  });

  // ── MAX ──

  test('★ MAX는 수수료를 남긴다 — 100%가 아니다', () => {
    const fee = paperFeeRate(null);
    const m = maxAllocationPercent({ leverage: 1, feeRate: fee });
    assert(m.percent != null && m.percent < 100, 'MAX가 100%다 — 수수료 자리가 없다');
    close(m.percent as number, 100 / (1 + 1 * fee), 1e-9);
  });

  test('★ MAX로 주문하면 실제로 통과한다 (증거금 + 수수료 <= 잔고)', () => {
    const bal = 1000, price = 100, lev = 10;
    const fee = paperFeeRate(null);
    const m = maxAllocationPercent({ leverage: lev, feeRate: fee });
    const sized = planSizing({
      availableBalance: bal, percent: m.percent as number, price, leverage: lev });
    eq(sized.code, 'OK');
    const plan = buildPaperPlan({
      market: 'USDM', side: 'LONG', symbol: 'BTCUSDT',
      quantity: sized.quantity, markPrice: price, leverage: lev,
      stopPrice: price * 0.99, availableBalance: bal,
    } as any);
    assert(plan.ok, `MAX로 만든 수량이 계획에서 거절됐다: ${(plan as any).reason}`);
    // ★ 이것이 이 시험의 요점이다
    assert(plan.requiredMargin + plan.entryFee <= bal + 1e-6,
      `증거금 ${plan.requiredMargin} + 수수료 ${plan.entryFee} > 잔고 ${bal}`);
  });

  test('★ 100%로 주문하면 수수료만큼 넘친다 — 그래서 MAX가 따로 필요하다', () => {
    const bal = 1000, price = 100, lev = 10;
    const sized = planSizing({ availableBalance: bal, percent: 100, price, leverage: lev });
    const plan = buildPaperPlan({
      market: 'USDM', side: 'LONG', symbol: 'BTCUSDT',
      quantity: sized.quantity, markPrice: price, leverage: lev,
      stopPrice: price * 0.99, availableBalance: bal,
    } as any);
    assert(plan.requiredMargin + plan.entryFee > bal,
      '100%인데 수수료 자리가 남았다 — 이 시험의 전제가 깨졌다');
  });

  test('★ 수수료율은 정본 하나다 — 화면이 숫자를 베껴 적지 않는다', () => {
    eq(paperFeeRate(null), PAPER_FEE_RATE_PCT / 100);
    eq(paperFeeRate(0.1), 0.001);
    // 못 읽으면 기본값이다. 0으로 접으면 수수료가 사라진다.
    eq(paperFeeRate(undefined), PAPER_FEE_RATE_PCT / 100);
    eq(paperFeeRate(NaN as any), PAPER_FEE_RATE_PCT / 100);
  });

  test('MAX를 못 구하면 null이다 — 100%로 떨어뜨리지 않는다', () => {
    eq(maxAllocationPercent({ leverage: null, feeRate: 0.0005 }).percent, null);
    eq(maxAllocationPercent({ leverage: 1, feeRate: null }).percent, null);
  });

  test('초보와 프로는 표시 preset만 다르고 계산은 같다', () => {
    // 프로가 초보 계약을 바꾸지 않는다
    eq(BUY_PERCENTS.join(','), '10,25,50,100');
    eq(PRO_PERCENTS.join(','), '25,50,75');
    // 같은 비율이면 같은 수량이다 — 엔진이 하나이기 때문이다
    for (const pct of [25, 50, 75]) {
      const a = planSizing({ availableBalance: 200, percent: pct, price: 10, leverage: 1 });
      const b = planSizing({ availableBalance: 200, percent: pct, price: 10, leverage: 1 });
      eq(a.quantity, b.quantity);
      close(a.quantity, (200 * pct / 100) / 10, 1e-9);
    }
  });
}
