// src/lib/strategies/sleeveLedger.test.ts
//
// 막으려는 것:
//  1. **한 전략이 남의 포지션을 닫는 것.** 같은 심볼에 두 전략이 들어가면
//     거래소에서는 한 포지션으로 합쳐진다. 그때 단타의 '전량청산'이 장기
//     전략의 몫까지 닫고, 그 전략은 자기가 아직 들고 있다고 믿는다 —
//     손절도 익절도 안 걸린 채로
//  2. 배정 합계가 총자금을 넘는 것. 두 전략이 같은 돈을 각자 자기 것으로
//     세고, 둘 다 진입하는 순간 증거금이 모자란다
//  3. 미실현 이익을 쓸 수 있는 돈으로 세는 것 — 다음 봉에 사라진다
//  4. 한 전략이 망가졌다고 전체 계좌를 끄는 것
//  5. 거래소 조회 실패를 '포지션 없음'으로 읽어 멀쩡한 포지션이 유령이 되는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  freshSleeve, equityOf, availableOf, checkAllocation, canClose,
  applyFill, applyRealized, sleeveGate, reconcileSleeves,
  stageSpendsRealMoney, STAGE_ORDER,
} from './sleeveLedger';

/** 사용자가 제안한 테스트넷 $50,000 배분 */
const PLAN = [
  { id: 'VWAP_PULLBACK', label: 'VWAP 눌림목', allocated: 6000 },
  { id: 'EMA_PULLBACK', label: 'EMA 눌림목', allocated: 5000 },
  { id: 'BREAKOUT_RETEST', label: '돌파 재시험', allocated: 6000 },
  { id: 'OPENING_RANGE', label: '오프닝 레인지', allocated: 5000 },
  { id: 'BOLLINGER_SQUEEZE', label: '스퀴즈 돌파', allocated: 4000 },
  { id: 'DONCHIAN_BREAKOUT', label: '돈치안 돌파', allocated: 4000 },
  { id: 'MEAN_REVERSION', label: '평균회귀', allocated: 4000 },
  { id: 'LIQUIDITY_SWEEP', label: '유동성 스윕', allocated: 4000 },
  { id: 'ORDERBOOK_IMBALANCE', label: '호가 불균형', allocated: 3000 },
  { id: 'CVD_OI', label: 'CVD·OI', allocated: 3000 },
  { id: 'WEDOM', label: '웨돔', allocated: 3000 },
  { id: 'INBEOM_ANGLE', label: '인범 빗각', allocated: 1500 },
];

export function runSleeveLedgerTests() {
  console.log('[전략 계좌 — 배정하지 않은 돈은 쓸 수 없다]');

  test('제안한 $50,000 배분이 성립한다', () => {
    const r = checkAllocation(50_000, PLAN);
    eq(r.ok, true, r.reason);
    eq(r.allocated, 48_500);
    eq(r.reserve, 1_500, '예비 현금');
    assert(r.reason.includes('예비 현금'), r.reason);
  });

  test('합이 총자금을 넘으면 거부한다', () => {
    // 넘겨 두면 두 전략이 같은 돈을 각자 자기 것으로 세고, 둘 다
    // 진입하는 순간 증거금이 모자란다.
    const r = checkAllocation(10_000, [
      { id: 'A', label: 'A', allocated: 6000 },
      { id: 'B', label: 'B', allocated: 6000 },
    ]);
    eq(r.ok, false);
    assert(r.reason.includes('같은 돈을 각자'), r.reason);
  });

  test('id가 겹치면 거부한다 — 한쪽 포지션이 조용히 사라진다', () => {
    const r = checkAllocation(10_000, [
      { id: 'A', label: 'A', allocated: 1000 },
      { id: 'A', label: 'A 둘째', allocated: 1000 },
    ]);
    eq(r.ok, false);
    assert(r.reason.includes('겹칩니다'), r.reason);
  });

  test('총자금을 모르면 배분하지 않는다', () => {
    for (const t of [0, -1, null, undefined]) {
      eq(checkAllocation(t as any, PLAN).ok, false, String(t));
    }
  });

  test('비중을 %로 알려준다', () => {
    const r = checkAllocation(50_000, PLAN);
    const vwap = r.shares.find(s => s.id === 'VWAP_PULLBACK')!;
    close(vwap.pct, 12, 1e-9);
  });

  console.log('[전략 계좌 — 미실현 이익은 쓸 수 있는 돈이 아니다]');

  test('자산은 배정 + 실현 − 수수료 + 미실현이다', () => {
    let s = freshSleeve({ id: 'A', label: 'A', allocated: 5000 });
    s = applyRealized(s, 300, 12);
    s.unrealizedPnl = 100;
    close(equityOf(s), 5000 + 300 - 12 + 100, 1e-9);
  });

  test('미실현 이익은 가용 현금에 안 더한다', () => {
    // 아직 안 닫은 이익은 다음 봉에 사라질 수 있고, 그걸로 새 포지션을
    // 열면 이익이 사라지는 순간 증거금이 모자란다.
    const s = freshSleeve({ id: 'A', label: 'A', allocated: 5000 });
    s.unrealizedPnl = 1000;
    close(availableOf(s), 5000, 1e-9);
  });

  test('미실현 손실은 뺀다 — 있는 돈이 아니다', () => {
    const s = freshSleeve({ id: 'A', label: 'A', allocated: 5000 });
    s.unrealizedPnl = -800;
    close(availableOf(s), 4200, 1e-9);
  });

  test('묶인 증거금은 뺀다', () => {
    const s = freshSleeve({ id: 'A', label: 'A', allocated: 5000 });
    s.reservedMargin = 1200;
    close(availableOf(s), 3800, 1e-9);
  });

  test('가용 현금은 음수가 되지 않는다', () => {
    const s = freshSleeve({ id: 'A', label: 'A', allocated: 100 });
    s.reservedMargin = 9999;
    eq(availableOf(s), 0);
  });

  console.log('[전략 계좌 — 남의 포지션을 닫지 않는다]');

  test('자기 몫만 닫을 수 있다', () => {
    // 이게 이 파일이 있는 가장 큰 이유다.
    let longTerm = freshSleeve({ id: 'LONG_TERM', label: '장기', allocated: 30000 });
    let scalp = freshSleeve({ id: 'SCALP', label: '단타', allocated: 5000 });
    longTerm = applyFill(longTerm, 'BTCUSDT', 0.2);
    scalp = applyFill(scalp, 'BTCUSDT', 0.1);
    // 거래소에는 0.3으로 보인다. 단타가 0.3을 닫으려 하면 막힌다.
    const r = canClose(scalp, 'BTCUSDT', 0.3);
    eq(r.allowed, false);
    eq(r.owned, 0.1);
    assert(r.reason.includes('다른 전략의 것'), r.reason);
    // 자기 몫은 닫힌다.
    eq(canClose(scalp, 'BTCUSDT', 0.1).allowed, true);
  });

  test('안 가진 심볼은 못 닫는다 — 거래소에 있어도 남의 것이다', () => {
    const s = freshSleeve({ id: 'A', label: 'A', allocated: 5000 });
    const r = canClose(s, 'ETHUSDT', 1);
    eq(r.allowed, false);
    assert(r.reason.includes('남의 것'), r.reason);
  });

  test('부동소수 꼬리는 봐 준다', () => {
    // 거래소가 준 수량을 그대로 넣으면 마지막 자리가 다를 수 있고,
    // 그때 전량청산이 막히면 그것대로 사고다.
    let s = freshSleeve({ id: 'A', label: 'A', allocated: 5000 });
    s = applyFill(s, 'BTCUSDT', 0.976);
    eq(canClose(s, 'BTCUSDT', 0.9760000000000001).allowed, true);
  });

  test('숏도 절대값으로 본다', () => {
    let s = freshSleeve({ id: 'A', label: 'A', allocated: 5000 });
    s = applyFill(s, 'BTCUSDT', -0.5);
    eq(canClose(s, 'BTCUSDT', 0.5).allowed, true);
  });

  test('0에 가까운 잔량은 지운다 — 유령 포지션을 만들지 않는다', () => {
    let s = freshSleeve({ id: 'A', label: 'A', allocated: 5000 });
    s = applyFill(s, 'BTCUSDT', 0.5);
    s = applyFill(s, 'BTCUSDT', -0.5);
    eq(Object.keys(s.positions).length, 0);
  });

  console.log('[전략 계좌 — 하나가 망가져도 나머지는 돈다]');

  test('낙폭 한도를 넘으면 그 계좌만 멈춘다', () => {
    const spec = { id: 'A', label: 'A', allocated: 5000, maxDrawdownPct: 10 };
    let s = freshSleeve(spec);
    s = applyRealized(s, -600);   // -12%
    const g = sleeveGate(s, spec);
    eq(g.allowed, false);
    eq(g.halted, 'DRAWDOWN');
    assert(g.reason.includes('이 전략만'), g.reason);
    assert(g.reason.includes('기존 포지션 관리는 계속'), g.reason);
  });

  test('낙폭은 최고 자산 기준이다', () => {
    const spec = { id: 'A', label: 'A', allocated: 1000, maxDrawdownPct: 20 };
    let s = freshSleeve(spec);
    s = applyRealized(s, 1000);    // 2000까지 올라감
    s = applyRealized(s, -300);    // 1700 → 최고 2000 대비 15%
    close(s.maxDrawdownPct, 15, 1e-6);
    eq(sleeveGate(s, spec).allowed, true, '배정 원금 대비로 재면 아직 +70%다');
  });

  test('현금이 없으면 남의 계좌 돈을 끌어오지 않는다', () => {
    const spec = { id: 'A', label: 'A', allocated: 1000 };
    const s = freshSleeve(spec);
    s.reservedMargin = 1000;
    const g = sleeveGate(s, spec);
    eq(g.halted, 'NO_CASH');
    assert(g.reason.includes('다른 계좌의 돈'), g.reason);
  });

  test('실전 단계가 아니면 실전 자금을 안 쓴다', () => {
    const spec = { id: 'A', label: 'A', allocated: 5000, stage: 'TESTNET' as const };
    const s = freshSleeve(spec);
    eq(sleeveGate(s, spec, { requireLive: true }).halted, 'STAGE_NOT_LIVE');
    eq(sleeveGate(s, spec).allowed, true, '테스트넷 주문은 된다');
  });

  test('실전으로 세는 단계는 둘뿐이다', () => {
    for (const st of STAGE_ORDER) {
      eq(stageSpendsRealMoney(st), st === 'LIVE_SMALL' || st === 'LIVE_LIMITED', st);
    }
    eq(stageSpendsRealMoney(null), false, '모르면 실전이 아니다');
  });

  console.log('[전략 계좌 — 거래소와 대조]');

  test('장부 합과 거래소가 맞으면 조용하다', () => {
    let a = freshSleeve({ id: 'A', label: 'A', allocated: 1000 });
    let b = freshSleeve({ id: 'B', label: 'B', allocated: 1000 });
    a = applyFill(a, 'BTCUSDT', 0.2);
    b = applyFill(b, 'BTCUSDT', 0.1);
    eq(reconcileSleeves([a, b], { BTCUSDT: 0.3 }).length, 0);
  });

  test('거래소에만 있으면 손으로 낸 주문일 수 있다고 적는다', () => {
    const r = reconcileSleeves([], { BTCUSDT: 0.5 });
    eq(r.length, 1);
    assert(r[0].reason.includes('손으로 낸 주문'), r[0].reason);
  });

  test('장부에만 있으면 이미 닫혔을 수 있다고 적는다', () => {
    let a = freshSleeve({ id: 'A', label: 'A', allocated: 1000 });
    a = applyFill(a, 'ETHUSDT', 2);
    const r = reconcileSleeves([a], { ETHUSDT: 0 });
    eq(r.length, 1);
    assert(r[0].reason.includes('이미 닫혔거나'), r[0].reason);
  });

  test('조회 실패를 포지션 없음으로 읽지 않는다', () => {
    // 멀쩡한 포지션이 유령이 된다.
    let a = freshSleeve({ id: 'A', label: 'A', allocated: 1000 });
    a = applyFill(a, 'BTCUSDT', 0.2);
    const r = reconcileSleeves([a], { BTCUSDT: null });
    eq(r.length, 1);
    eq(r[0].exchange, null);
    assert(r[0].reason.includes('모르는 것'), r[0].reason);
  });

  test('수량이 다르면 양쪽을 적는다', () => {
    let a = freshSleeve({ id: 'A', label: 'A', allocated: 1000 });
    a = applyFill(a, 'BTCUSDT', 0.2);
    const r = reconcileSleeves([a], { BTCUSDT: 0.35 });
    eq(r.length, 1);
    eq(r[0].ledger, 0.2);
    eq(r[0].exchange, 0.35);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(reconcileSleeves(null, null).length, 0);
    eq(availableOf(null), 0);
    eq(equityOf(undefined), 0);
    eq(canClose(null, 'BTCUSDT', 1).allowed, false);
    eq(sleeveGate(null, null).allowed, false);
  });
}
