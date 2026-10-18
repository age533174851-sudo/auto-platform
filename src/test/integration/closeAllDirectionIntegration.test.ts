// src/test/integration/closeAllDirectionIntegration.test.ts
//
// **전체 포지션 종료가 SHORT를 BUY로 닫는가 — 실제 어댑터 경로.**
//
// 실제로 도는 것: `closeAllPositions` → `getFuturesPositions` →
//   `parseFuturesPositionRows` → `placeFuturesOrderSafe` → `quantizeOrder`
//   → 서명 생성 · 질의 조립. 가짜는 `fetch` 한 겹뿐이다.
//
// 왜 이 묶음이 필요한가
// ─────────────────────
// `FuturesPosition.amount`는 **절댓값이다.** 파서가 `Math.abs`를 건다.
// 방향은 `side` 칸에 따로 있다. 그런데 `closeAllPositions`는 수량의
// **부호**로 방향을 정하고 있었다 — 절댓값에는 음수가 없으니 결과는
// 언제나 SELL이었고, SHORT는 SELL + reduceOnly로 나가 거래소가 거절했다.
//
// 즉 **긴급 전체 종료를 눌러도 SHORT는 끝내 닫히지 않았다.** 5회 재시도가
// 전부 거절되고 `success: false`로 끝난다. 사람은 큰 빨간 버튼을 눌렀다고
// 믿는데 숏은 그대로 열려 있다.
//
// `killClosePlan`은 **이미 이 교훈을 반영해** `side`를 정본으로 쓰고,
// 주석에 "부호만 보고 방향을 정하면 SHORT 포지션이 전부 LONG으로 읽힌다"고
// 적어 두었다. 같은 판단이 두 곳에 있었고 한쪽만 고쳐져 있던 것이다.

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import { closeAllPositions } from '../../lib/exchanges/binanceFutures';

const POS = '/fapi/v2/positionRisk';
const ORDER = '/fapi/v1/order';
const EXINFO = '/fapi/v1/exchangeInfo';

const KEY = 'K'.repeat(64);
const SECRET = 'S'.repeat(64);

/** 실제 응답에 있는 칸을 전부 채운 줄. 한 칸이라도 빠지면 파서가 막는다. */
function row(symbol: string, positionAmt: string, over: Record<string, unknown> = {}) {
  return {
    symbol, positionAmt,
    entryPrice: '100000', markPrice: '100000', unRealizedProfit: '0',
    liquidationPrice: '0', leverage: '10', marginType: 'isolated',
    updateTime: 1_760_000_000_000,
    ...over,
  };
}

function venueFor(rows: any[]): FakeVenue {
  const v = new FakeVenue();
  // 종료 주문이 나가면 다음 조회에서는 평탄이다 — 재시도 루프가 멈춘다.
  v.on(POS, { json: () => (v.orderSends().length === 0
    ? rows
    : rows.map((r) => ({ ...r, positionAmt: '0', entryPrice: '0' }))) });
  v.on(EXINFO, { json: { symbols: rows.map((r) => ({
    symbol: r.symbol, filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ],
  })) } });
  v.on(ORDER, { json: { orderId: 5001, status: 'FILLED', executedQty: '0.010' } }, 'POST');
  return v;
}

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}

export async function runCloseAllDirectionTests() {
  console.log('[통합 — 전체 종료의 방향]');

  // ══════════ ① LONG은 SELL로 닫는다 ══════════
  {
    const v = venueFor([row('BTCUSDT', '0.010')]);
    const r: any = await on(v, () => closeAllPositions(KEY, SECRET, true, 2));

    test('★ ① LONG 포지션은 SELL로 닫는다', () => {
      eq(v.orderSends().length, 1);
      eq(v.orderSends()[0].params.side, 'SELL');
      eq(v.orderSends()[0].params.reduceOnly, 'true');
      eq(r.success, true);
      eq(r.remaining, 0);
    });
  }

  // ══════════ ② SHORT는 BUY로 닫는다 ══════════
  //
  // 이것이 이 묶음의 이유다. 고치기 전에는 여기서 SELL이 나갔다.
  {
    const v = venueFor([row('BTCUSDT', '-0.010')]);
    const r: any = await on(v, () => closeAllPositions(KEY, SECRET, true, 2));

    test('★ ② SHORT 포지션은 BUY로 닫는다 (절댓값에 속지 않는다)', () => {
      eq(v.orderSends().length, 1);
      eq(v.orderSends()[0].params.side, 'BUY',
        'SHORT를 SELL로 보내면 reduceOnly라 거절당하고 숏은 끝내 안 닫힌다');
      eq(v.orderSends()[0].params.quantity, '0.01');
      eq(r.success, true);
      eq(r.remaining, 0);
    });
  }

  // ══════════ ③ 섞여 있어도 각자의 방향으로 나간다 ══════════
  {
    const v = venueFor([row('BTCUSDT', '0.010'), row('ETHUSDT', '-0.200')]);
    await on(v, () => closeAllPositions(KEY, SECRET, true, 2));

    test('★ ③ LONG·SHORT가 섞이면 각각 SELL·BUY로 나간다', () => {
      const sends = v.orderSends();
      eq(sends.length, 2);
      const bySym: Record<string, string> = {};
      for (const s of sends) bySym[s.params.symbol] = s.params.side;
      eq(bySym.BTCUSDT, 'SELL');
      eq(bySym.ETHUSDT, 'BUY',
        '한 회차에 섞여 있으면 한쪽만 틀리는 것이 가장 늦게 발견된다');
    });
  }

  // ══════════ ④ 방향을 모르면 보내지 않는다 ══════════
  //
  // 짐작해서 보내면 청산이 아니라 **반대 방향 신규 진입**이 될 수 있다.
  // 거절당하는 것보다 반대 포지션이 나쁘다.
  {
    const v = new FakeVenue();
    v.on(POS, { json: [row('BTCUSDT', '0.010')] });
    v.on(EXINFO, { json: { symbols: [{ symbol: 'BTCUSDT', filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
    ] }] } });
    v.on(ORDER, { json: { orderId: 1, status: 'FILLED' } }, 'POST');
    // 파서를 지나지 않는 모양을 직접 넣는다 — 방향 칸이 없는 줄이
    // 어떤 경로로든 들어왔을 때 무엇이 나가는지를 본다.
    const r: any = await on(v, () => closeAllPositions(KEY, SECRET, true, 1,
      { fetchPositions: async () => ({ success: true,
        positions: [{ symbol: 'BTCUSDT', amount: 0.01, side: undefined }] }) } as any));

    test('★ ④ 방향을 못 읽은 줄에는 청산 주문을 보내지 않는다', () => {
      eq(v.orderSends().length, 0, '방향을 짐작해서 보내면 반대 진입이 된다');
      eq(r.success, false, '못 닫은 것을 닫았다고 적지 않는다');
      assert(r.attempts.some((a: any) => a.ok === false),
        '보내지 않은 사실이 기록에 남아야 한다');
    });
  }
}
