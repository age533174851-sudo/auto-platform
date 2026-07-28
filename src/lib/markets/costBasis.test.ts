// src/lib/markets/costBasis.test.ts
//
// 이 계산이 틀리면 화면의 수익률이 통째로 틀린다.
// 특히 "보유 수량"이 실제보다 많게 나오면, 그 수량으로 매도를 걸었다가
// 거래소에서 거부된다.
import { test, assert, eq } from '../../test/harness';
import { computeCostBasis, unrealizedPnl, type SpotTrade } from './costBasis';

const buy = (qty: number, price: number, fee = 0, feeAsset = 'USDT'): SpotTrade =>
  ({ isBuyer: true, qty, price, commission: fee, commissionAsset: feeAsset, baseAsset: 'BTC' });
const sell = (qty: number, price: number, fee = 0, feeAsset = 'USDT'): SpotTrade =>
  ({ isBuyer: false, qty, price, commission: fee, commissionAsset: feeAsset, baseAsset: 'BTC' });

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

export function runCostBasisTests() {
  console.log('[현물 원가 — 평균 매수가]');

  test('여러 번 사면 이동평균이 된다', () => {
    const r = computeCostBasis([buy(1, 100), buy(1, 200)]);
    eq(r.qty, 2);
    assert(near(r.avgPrice!, 150), String(r.avgPrice));
  });

  test('일부를 팔아도 평균 단가는 그대로다', () => {
    const r = computeCostBasis([buy(1, 100), buy(1, 200), sell(1, 300)]);
    eq(r.qty, 1);
    assert(near(r.avgPrice!, 150), '매도 후 단가가 흔들렸다: ' + r.avgPrice);
    assert(near(r.realizedPnl, 150), String(r.realizedPnl));
  });

  test('전량 매도하면 평균가는 0이 아니라 null이다', () => {
    const r = computeCostBasis([buy(1, 100), sell(1, 120)]);
    eq(r.qty, 0);
    eq(r.avgPrice, null, '보유가 없는데 "0원에 샀다"로 표시된다');
    assert(near(r.realizedPnl, 20), String(r.realizedPnl));
  });

  test('거래가 없으면 보유도 평균가도 없다', () => {
    const r = computeCostBasis([]);
    eq(r.qty, 0);
    eq(r.avgPrice, null);
    eq(r.realizedPnl, 0);
  });

  console.log('[현물 원가 — 수수료]');

  test('매수 수수료를 코인으로 내면 받은 수량이 줄어든다', () => {
    // 1 BTC를 사고 수수료로 0.001 BTC를 냈으면 실제로 받은 건 0.999
    const r = computeCostBasis([buy(1, 100, 0.001, 'BTC')]);
    assert(near(r.qty, 0.999), `보유 수량이 틀리면 매도가 거부된다: ${r.qty}`);
    // 원가는 낸 돈(100) 기준이므로 단가는 100보다 높아진다
    assert(r.avgPrice! > 100, String(r.avgPrice));
  });

  test('매수 수수료를 USDT로 내면 수량은 그대로다', () => {
    const r = computeCostBasis([buy(1, 100, 0.1, 'USDT')]);
    eq(r.qty, 1);
    assert(near(r.avgPrice!, 100), String(r.avgPrice));
  });

  test('매도 수수료는 실현손익에서 뺀다', () => {
    const r = computeCostBasis([buy(1, 100), sell(1, 120, 0.5, 'USDT')]);
    assert(near(r.realizedPnl, 19.5), `수수료가 반영되지 않았다: ${r.realizedPnl}`);
  });

  test('수수료 합계를 따로 센다', () => {
    const r = computeCostBasis([buy(1, 100, 0.1), sell(1, 120, 0.2)]);
    assert(near(r.feePaid, 0.3), String(r.feePaid));
  });

  console.log('[현물 원가 — 이상한 입력]');

  test('보유보다 많이 팔린 기록이 있어도 음수 보유가 되지 않는다', () => {
    // 이체로 들어온 코인을 판 경우 등. 현물에 마이너스 보유는 없다.
    const r = computeCostBasis([buy(1, 100), sell(3, 120)]);
    eq(r.qty, 0, '음수 보유가 생겼다 — 현물에는 공매도가 없다');
    assert(r.avgPrice === null);
  });

  test('수량이 0이거나 값이 이상한 체결은 건너뛴다', () => {
    const r = computeCostBasis([
      buy(1, 100),
      { isBuyer: true, qty: 0, price: 100, commission: 0, commissionAsset: 'USDT', baseAsset: 'BTC' },
      { isBuyer: true, qty: NaN, price: 100, commission: 0, commissionAsset: 'USDT', baseAsset: 'BTC' },
    ]);
    eq(r.qty, 1);
  });

  test('전량 매도 후 부동소수점 찌꺼기가 남지 않는다', () => {
    const r = computeCostBasis([buy(0.1, 100), buy(0.2, 100), sell(0.30000000000000004, 100)]);
    eq(r.qty, 0, `찌꺼기가 남으면 "0.0000000001개 보유"가 된다: ${r.qty}`);
  });

  console.log('[현물 원가 — 평가 손익]');

  test('평가 손익과 수익률을 낸다', () => {
    const basis = computeCostBasis([buy(2, 100)]);
    const u = unrealizedPnl(basis, 120);
    assert(u !== null && near(u.pnl, 40), String(u?.pnl));
    assert(u !== null && near(u.pct, 20), String(u?.pct));
  });

  test('평균가나 현재가를 모르면 계산하지 않는다', () => {
    eq(unrealizedPnl(computeCostBasis([]), 120), null, '보유가 없는데 손익을 냈다');
    eq(unrealizedPnl(computeCostBasis([buy(1, 100)]), null), null, '현재가 없이 손익을 냈다');
  });
}
