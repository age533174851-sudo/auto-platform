// src/lib/engine/orderSizing.test.ts
//
// 막으려는 것:
//  1. **손절 2%가 무엇의 2%인지 모르는 것.** 가격 2% / 증거금 2% /
//     계좌 2% / ROI −2%는 5배에서 전부 다른 가격이고 100배에서는
//     쉰 배 차이가 난다
//  2. 위험과 무관한 수량(잔고의 25/50/75/100%)으로 주문을 만드는 것
//  3. 확인창에 적힌 예상 손실과 실제로 나가는 수량이 어긋나는 것 —
//     수량을 거래소 단위로 내린 뒤에 손실을 다시 계산하지 않으면 그렇게 된다
//  4. 잔고를 못 읽었는데 0으로 눕혀 '계산됨'으로 그리는 것
//  5. 수량을 단위에 맞추느라 **올려서** 허용 위험을 넘는 것
import { test, assert, eq, close } from '../../test/harness';
import { planSize, lossPreview, stopPriceOf, floorToStep, STOP_BASIS_LABEL } from './orderSizing';

export function runOrderSizingTests() {
  console.log('[수량 계산 — 위험에서 수량이 나온다]');

  test('계좌 1% 위험 · 손절 2%면 수량이 정해진다', () => {
    // 잔고 10,000 × 1% = 100을 잃는다. 손절 거리는 64,000 × 2% = 1,280.
    // 수량 = 100 / 1280 = 0.078125
    const r = planSize({
      equity: 10_000, entryPrice: 64_000, side: 'LONG',
      basis: 'ACCOUNT_RISK', pct: 1, leverage: 5,
    }, { pricePctForAccountRisk: 2 });
    eq(r.ok, true);
    close(r.qty as number, 0.078125, 1e-9);
    close(r.stopPrice as number, 62_720, 1e-9);
    close(r.maxLoss as number, 100, 1e-9);
    close(r.maxLossPctOfEquity as number, 1, 1e-9);
  });

  test('숏은 손절이 진입가 위다', () => {
    const r = planSize({
      equity: 10_000, entryPrice: 64_000, side: 'SHORT',
      basis: 'ACCOUNT_RISK', pct: 1,
    }, { pricePctForAccountRisk: 2 });
    close(r.stopPrice as number, 65_280, 1e-9);
    assert((r.stopPrice as number) > 64_000, '숏 손절이 진입가 아래에 있다');
  });

  test('명목가와 필요 증거금을 함께 준다', () => {
    const r = planSize({
      equity: 10_000, entryPrice: 64_000, side: 'LONG',
      basis: 'ACCOUNT_RISK', pct: 1, leverage: 5,
    }, { pricePctForAccountRisk: 2 });
    close(r.notional as number, 0.078125 * 64_000, 1e-6);
    close(r.margin as number, (0.078125 * 64_000) / 5, 1e-6);
  });

  test('배율을 모르면 증거금을 지어내지 않는다', () => {
    const r = planSize({
      equity: 10_000, entryPrice: 64_000, basis: 'ACCOUNT_RISK', pct: 1,
    }, { pricePctForAccountRisk: 2 });
    eq(r.margin, null);
    eq(r.ok, true, '증거금을 몰라도 수량은 나온다');
  });

  console.log('[수량 계산 — 단위에 맞추되 올리지 않는다]');

  test('수량은 단위로 내린다 — 올리면 허용 위험을 넘는다', () => {
    const r = planSize({
      equity: 10_000, entryPrice: 64_000, basis: 'ACCOUNT_RISK', pct: 1,
      qtyStep: 0.001,
    }, { pricePctForAccountRisk: 2 });
    eq(r.qty, 0.078, '0.079로 올리면 예산을 넘는다');
  });

  test('내린 뒤에 손실을 다시 계산한다', () => {
    // 예산에서 역산한 값을 그대로 적으면, 화면의 '예상 최대 손실'과
    // 실제가 달라진다. 확인창이 거짓말을 하는 것이다.
    const r = planSize({
      equity: 10_000, entryPrice: 64_000, basis: 'ACCOUNT_RISK', pct: 1,
      qtyStep: 0.001,
    }, { pricePctForAccountRisk: 2 });
    close(r.maxLoss as number, 0.078 * 1280, 1e-9);
    assert((r.maxLoss as number) < 100, '내렸는데 손실이 예산 그대로다');
  });

  test('floorToStep은 단위가 없으면 그대로 둔다', () => {
    eq(floorToStep(0.078125, null), 0.078125);
    eq(floorToStep(0.078125, 0), 0.078125);
    eq(floorToStep(0.078125, 0.01), 0.07);
  });

  test('최소 수량에 못 미치면 얼마인지 보여준다', () => {
    // 숫자가 없으면 얼마나 키워야 하는지 모른다.
    const r = planSize({
      equity: 100, entryPrice: 64_000, basis: 'ACCOUNT_RISK', pct: 0.5,
      minQty: 0.01,
    }, { pricePctForAccountRisk: 2 });
    eq(r.status, 'BELOW_MIN_QTY');
    eq(r.ok, false);
    assert(r.qty != null, '못 미친다는 것만 적고 얼마인지 안 적었다');
    assert(r.reason.includes('0.01'), r.reason);
  });

  console.log('[수량 계산 — 모르는 것을 0으로 눕히지 않는다]');

  test('잔고를 못 읽으면 계산하지 않는다', () => {
    for (const eq0 of [null, undefined, 0, -5]) {
      const r = planSize({ equity: eq0, entryPrice: 64_000, basis: 'ACCOUNT_RISK', pct: 1 },
        { pricePctForAccountRisk: 2 });
      eq(r.status, 'EQUITY_UNKNOWN', String(eq0));
      eq(r.qty, null, String(eq0));
    }
  });

  test('진입가를 못 읽으면 계산하지 않는다', () => {
    eq(planSize({ equity: 10_000, entryPrice: null, basis: 'ACCOUNT_RISK', pct: 1 },
      { pricePctForAccountRisk: 2 }).status, 'PRICE_UNKNOWN');
  });

  test('손절이 없으면 크기를 정할 근거가 없다', () => {
    const r = planSize({ equity: 10_000, entryPrice: 64_000, basis: 'ACCOUNT_RISK', pct: 0 },
      { pricePctForAccountRisk: 2 });
    eq(r.status, 'STOP_INVALID');
    assert(r.reason.includes('손절 없는 진입'), r.reason);
  });

  test('계좌 위험률만으로는 손절 가격이 안 나온다', () => {
    // 같은 손실을 좁은 손절 × 큰 수량으로도, 넓은 손절 × 작은 수량으로도
    // 만들 수 있다. 임의로 정하면 그 값이 곧 사용자가 모르는 청산 거리다.
    const r = planSize({ equity: 10_000, entryPrice: 64_000, basis: 'ACCOUNT_RISK', pct: 1 });
    eq(r.status, 'STOP_INVALID');
    assert(r.reason.includes('가격 손절폭도 필요'), r.reason);
  });

  console.log('[수량 계산 — 증거금이 잔고를 넘으면]');

  test('필요 증거금이 잔고를 넘으면 막고 숫자를 적는다', () => {
    // 손절이 아주 좁으면 수량이 커지고, 낮은 배율에서는 증거금이 잔고를
    // 넘는다. 거래소가 거부하기 전에 여기서 잡는다.
    const r = planSize({
      equity: 1_000, entryPrice: 64_000, basis: 'ACCOUNT_RISK', pct: 5, leverage: 1,
    }, { pricePctForAccountRisk: 0.1 });
    eq(r.status, 'MARGIN_EXCEEDS_EQUITY');
    eq(r.ok, false);
    assert(r.qty != null && r.margin != null, '막기만 하고 숫자를 안 줬다');
    assert(r.reason.includes('배율을 올리거나'), r.reason);
  });

  console.log('[손절 기준 — 2%가 무엇의 2%인가]');

  test('가격 손절폭을 가격으로 옮긴다', () => {
    close(stopPriceOf(64_000, 'LONG', 2), 62_720, 1e-9);
    close(stopPriceOf(64_000, 'SHORT', 2), 65_280, 1e-9);
  });

  test('수량이 정해져 있으면 계좌 예상 손실을 적는다', () => {
    // 이 숫자가 없으면 '손절 2%'가 무엇의 2%인지 알 수 없다.
    const r = lossPreview({
      equity: 10_000, entryPrice: 64_000, qty: 0.155, side: 'LONG', pricePct: 2,
    });
    close(r.stopPrice as number, 62_720, 1e-9);
    close(r.loss as number, 0.155 * 1280, 1e-9);
    close(r.lossPctOfEquity as number, (0.155 * 1280) / 10_000 * 100, 1e-9);
  });

  test('잔고를 모르면 비율을 지어내지 않는다 — 금액만 준다', () => {
    const r = lossPreview({ entryPrice: 64_000, qty: 0.155, pricePct: 2 });
    assert(r.loss != null, '금액은 낼 수 있다');
    eq(r.lossPctOfEquity, null);
    assert(r.reason.includes('비율은 계산하지 못했습니다'), r.reason);
  });

  test('수량이 없으면 손절가만 준다', () => {
    const r = lossPreview({ equity: 10_000, entryPrice: 64_000, pricePct: 2 });
    assert(r.stopPrice != null);
    eq(r.loss, null);
  });

  test('기준 이름이 화면에 그대로 나갈 수 있다', () => {
    eq(STOP_BASIS_LABEL.PRICE, '가격 변동률');
    eq(STOP_BASIS_LABEL.ACCOUNT_RISK, '계좌 위험률');
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(planSize({}).ok, false);
    eq(lossPreview({}).loss, null);
  });
}
