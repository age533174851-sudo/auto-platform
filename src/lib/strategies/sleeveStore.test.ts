// src/lib/strategies/sleeveStore.test.ts
//
// 막으려는 것:
//  1. **표가 없는데 소유권을 강제하는 것.** 마이그레이션 전에 막으면
//     모든 주문이 "어느 전략 것인지 모른다"로 서고, 푸는 방법이 SQL뿐이다.
//     권한 표(039)에서 이미 한 번 한 실수다
//  2. 조회 실패를 '계좌 없음'으로 읽어, 모든 포지션이 주인 없는 것이
//     되고 소유권 검사가 통째로 통과하는 것
//  3. peak_equity 0을 그대로 써서 낙폭이 언제나 0%가 되는 것 —
//     그러면 낙폭 정지가 영영 안 걸린다
//  4. jsonb에 섞인 문자열 하나가 NaN을 만들어, 비교가 조용히 통과하는 것
import { test, assert, eq } from '../../test/harness';
import {
  recordOf, rowOf, positionsOf, avgPricesOf, stageOf, checkOwnership, type SleeveLoad,
} from './sleeveStore';

const row = (over: any = {}) => ({
  id: 'row-1', user_id: 'u1', sleeve_id: 'MINERVINI_TREND', label: '미네르비니 추세',
  allocated: 5000, stage: 'TESTNET',
  reserved_margin: 100, realized_pnl: 250, unrealized_pnl: -30, fees: 12,
  peak_equity: 5300, max_drawdown_seen_pct: 2.4,
  positions: { BTCUSDT: 0.6 },
  cost_basis: { BTCUSDT: 62000 },
  ...over,
});

const loadOf = (over: Partial<SleeveLoad> = {}): SleeveLoad => ({
  installed: true, known: true, records: [], reason: '', ...over,
});

export function runSleeveStoreTests() {
  console.log('[전략 계좌 저장 — 행을 장부로 옮긴다]');

  test('설정과 장부를 모두 읽는다', () => {
    const r = recordOf(row())!;
    eq(r.rowId, 'row-1');
    eq(r.spec.id, 'MINERVINI_TREND');
    eq(r.spec.allocated, 5000);
    eq(r.spec.stage, 'TESTNET');
    eq(r.state.realizedPnl, 250);
    eq(r.state.positions.BTCUSDT, 0.6);
  });

  test('최고점이 0이면 배정액으로 올린다', () => {
    // 0으로 두면 낙폭이 언제나 0%로 계산되고(최고점이 0이니까),
    // 낙폭 정지가 영영 안 걸린다.
    const r = recordOf(row({ peak_equity: 0 }))!;
    eq(r.state.peakEquity, 5000);
  });

  test('모르는 단계는 가장 앞으로 본다 — 오타가 실전이 되면 안 된다', () => {
    eq(stageOf('LIVE_HUGE'), 'SPECIFICATION');
    eq(stageOf(null), 'SPECIFICATION');
    eq(stageOf('live_small'), 'LIVE_SMALL', '대소문자는 가리지 않는다');
  });

  test('전략 id가 없으면 계좌가 아니다', () => {
    eq(recordOf(row({ sleeve_id: '' })), null);
    eq(recordOf(null), null);
  });

  test('연결을 안 붙인 것과 못 읽은 것을 구분한다', () => {
    eq(recordOf(row({ connection_id: null }))!.connectionId, null);
    eq(recordOf(row({ connection_id: '' }))!.connectionId, null);
    eq(recordOf(row({ connection_id: 'c1' }))!.connectionId, 'c1');
  });

  console.log('[전략 계좌 저장 — 소유 수량 맵]');

  test('숫자가 아닌 값은 버린다', () => {
    // 문자열 하나가 섞이면 그 뒤의 모든 산술이 NaN이 되고,
    // NaN은 비교에서 언제나 false라 소유권 검사가 조용히 통과한다.
    const p = positionsOf({ BTCUSDT: 0.6, ETHUSDT: 'many', SOLUSDT: null });
    eq(Object.keys(p).join(','), 'BTCUSDT');
  });

  test('0은 지운다', () => {
    // 0을 들고 있으면 '소유한다(수량 0)'와 '안 갖고 있다'가 같은 모양이다.
    eq(Object.keys(positionsOf({ BTCUSDT: 0 })).length, 0);
  });

  test('숏은 음수로 남긴다', () => {
    eq(positionsOf({ ETHUSDT: -2 }).ETHUSDT, -2);
  });

  test('심볼은 대문자로 모은다', () => {
    eq(positionsOf({ btcusdt: 1 }).BTCUSDT, 1);
  });

  test('맵이 아니면 빈 것으로 본다', () => {
    eq(Object.keys(positionsOf(null)).length, 0);
    eq(Object.keys(positionsOf([1, 2] as any)).length, 0);
    eq(Object.keys(positionsOf('BTC' as any)).length, 0);
  });

  console.log('[전략 계좌 저장 — 왕복]');

  test('읽고 쓰면 같은 값이 나온다', () => {
    const r = recordOf(row())!;
    const back = recordOf({ ...rowOf(r), id: 'row-1' })!;
    eq(back.spec.allocated, r.spec.allocated);
    eq(back.state.realizedPnl, r.state.realizedPnl);
    eq(back.state.peakEquity, r.state.peakEquity);
    eq(back.state.positions.BTCUSDT, r.state.positions.BTCUSDT);
    eq(back.spec.stage, r.spec.stage);
  });

  test('안 정한 한도는 null로 남는다 — 0으로 적으면 전부 막힌다', () => {
    const r = recordOf(row({ max_leverage: null, risk_per_trade_pct: null }))!;
    eq(rowOf(r).max_leverage, null);
    eq(rowOf(r).risk_per_trade_pct, null);
  });

  console.log('[전략 계좌 소유권 — 막는 자리]');

  const rec = () => recordOf(row())!;

  test('계좌를 지목한 청산만 따진다', () => {
    // 손으로 누르는 청산까지 막으면 사용자가 자기 포지션을 못 닫는다.
    const v = checkOwnership(loadOf({ records: [rec()] }), null, 'BTCUSDT', 1);
    eq(v.allowed, true);
    eq(v.enforced, false);
  });

  test('표가 없으면 아무것도 막지 않는다', () => {
    // 마이그레이션 전에 막으면 푸는 방법이 SQL뿐이다.
    const v = checkOwnership(
      loadOf({ installed: false, known: false, reason: '표가 없습니다' }),
      'MINERVINI_TREND', 'BTCUSDT', 1);
    eq(v.allowed, true);
    eq(v.enforced, false);
  });

  test('표는 있는데 못 읽었으면 막는다', () => {
    // 이건 진짜 모름이다. 모르는 위에서 남의 포지션을 닫으면 되돌릴 수 없다.
    const v = checkOwnership(
      loadOf({ known: false, reason: '조회 실패' }),
      'MINERVINI_TREND', 'BTCUSDT', 1);
    eq(v.allowed, false);
    eq(v.enforced, true);
    assert(v.reason.includes('모르는 채로 닫지 않습니다'), v.reason);
  });

  test('없는 계좌를 지목하면 막는다', () => {
    const v = checkOwnership(loadOf({ records: [rec()] }), '없는전략', 'BTCUSDT', 1);
    eq(v.allowed, false);
    eq(v.enforced, true);
  });

  test('자기 몫까지만 닫을 수 있다', () => {
    const load = loadOf({ records: [rec()] });
    eq(checkOwnership(load, 'MINERVINI_TREND', 'BTCUSDT', 0.6).allowed, true);
    const over = checkOwnership(load, 'MINERVINI_TREND', 'BTCUSDT', 1.0);
    eq(over.allowed, false);
    eq(over.ownedQty, 0.6);
    assert(over.reason.includes('다른 전략의 것'), over.reason);
  });

  test('안 갖고 있는 심볼은 거래소에 있어도 남의 것이다', () => {
    const v = checkOwnership(loadOf({ records: [rec()] }), 'MINERVINI_TREND', 'ETHUSDT', 1);
    eq(v.allowed, false);
    assert(v.reason.includes('남의 것'), v.reason);
  });

  console.log('[전략 계좌 저장 — 매입 평균가]');

  test('평균가를 읽고 쓴다', () => {
    const r = recordOf(row())!;
    eq(r.state.avgPrices!.BTCUSDT, 62000);
    eq((rowOf(r).cost_basis as any).BTCUSDT, 62000);
  });

  test('0과 음수는 가격이 아니다', () => {
    // 0을 그대로 쓰면 청산 손익이 통째로 이익으로 잡히고,
    // 그 숫자가 낙폭이 되어 계좌를 멈춘다.
    eq(Object.keys(avgPricesOf({ BTCUSDT: 0 })).length, 0);
    eq(Object.keys(avgPricesOf({ BTCUSDT: -1 })).length, 0);
    eq(Object.keys(avgPricesOf({ BTCUSDT: 'cheap' })).length, 0);
  });

  test('칸이 없으면 빈 것으로 본다 — 042 이전 행', () => {
    // 그 포지션은 평균가를 모르고, 그 청산은 손익이 안 적힌다.
    const r = recordOf(row({ cost_basis: undefined }))!;
    eq(Object.keys(r.state.avgPrices!).length, 0);
  });
}
