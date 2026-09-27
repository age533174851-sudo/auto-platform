// src/lib/trading/marketInstrument.test.ts
//
// **화면이 보는 종목과 주문이 나가는 종목은 같아야 한다.**
//
// Phase 1에는 구멍이 있었다 — `stream`/`form`/`sell`이 들어올 때의 문맥에
// 묶여 있어서, 시장 탭을 바꿔도 주문은 원래 종목으로 나갔다. 다른 시장이
// 잠겨 있어서 드러나지 않았을 뿐이다.
//
// 그래서 여기서는 **정체성**을 입출력으로 단정한다. 화면 코드가 아니라
// 판정 정본을 직접 부른다 — 화면을 고쳐도 이 계약은 남아야 한다.
import { test, eq, assert } from '../../test/harness';

/** 던져야 하는 자리. harness에 없으므로 여기서 최소한만 만든다 */
function throws(fn: () => unknown, msg = '던지지 않았다') {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg);
}
import {
  instrumentForMarket, instrumentFromCatalog, selectInstrument,
  EMPTY_SELECTION, type SelectedByMarket,
} from './marketInstrument';
import { activeIdentity, identityKey, identityResetState, switchBlockedReason, switchLockState } from './tradeIdentity';
import {
  parseSpotCatalog, parseUsdmCatalog, catalogOpenFor, searchCatalog,
} from './instrumentCatalog';

const ENTRY = { symbol: 'BTCUSDT', market: 'SPOT' as const };

const usdmRow = {
  symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL',
  baseAsset: 'ETH', quoteAsset: 'USDT',
};
const pickUsdm = () => instrumentFromCatalog(parseUsdmCatalog({ symbols: [usdmRow] }, 111)[0]);

export function runMarketInstrumentTests() {
  console.log('[시장별 종목 정체성]');

  // ── 1 ──
  test('① 들고 온 현물 종목은 현물 화면에서 그대로 쓴다', () => {
    const a = instrumentForMarket('SPOT', ENTRY);
    eq(a.instrument?.symbol, 'BTCUSDT');
    eq(a.instrument?.market, 'SPOT');
    eq(a.instrument?.source, 'ENTRY');
    eq(a.tradable, true);
    eq(a.reason, null);
  });

  // ── 2 ──
  test('② 선물로 옮기면 고르기 전까지 종목이 없다 — 거래소 쓰기 0', () => {
    const a = instrumentForMarket('USDM', ENTRY);
    eq(a.instrument, null);
    eq(a.tradable, false);
    assert(!!a.reason, '왜 없는지 적지 않았다');
    // ★ 활성 정체성도 없어야 한다 — 없으면 시세도 주문도 나가지 않는다
    eq(activeIdentity('USDM', a.instrument), null);
  });

  // ── 3 ──
  test('③ 선물 목록에서 고르면 그 종목이 활성이 된다', () => {
    const sel = selectInstrument(EMPTY_SELECTION, 'USDM', pickUsdm());
    const a = instrumentForMarket('USDM', ENTRY, sel);
    eq(a.instrument?.symbol, 'ETHUSDT');
    eq(a.instrument?.market, 'USDM');
    eq(a.instrument?.source, 'CATALOG');
    eq(a.instrument?.catalogSource, 'BINANCE_USDM_EXCHANGE_INFO');
    eq(a.tradable, true);
    const id = activeIdentity('USDM', a.instrument);
    eq(id?.market, 'USDM');
    eq(id?.symbol, 'ETHUSDT');
  });

  // ── 4 · 5 ──
  test('④⑤ 시장마다 고른 종목을 따로 기억한다 — 왕복해도 서로 안 섞인다', () => {
    let sel: SelectedByMarket = EMPTY_SELECTION;
    sel = selectInstrument(sel, 'USDM', pickUsdm());
    // 현물로 돌아오면 들고 온 종목이 그대로
    eq(instrumentForMarket('SPOT', ENTRY, sel).instrument?.symbol, 'BTCUSDT');
    // 선물로 다시 가면 고른 종목이 그대로
    eq(instrumentForMarket('USDM', ENTRY, sel).instrument?.symbol, 'ETHUSDT');
  });

  // ── 6 · 7 ──
  test('⑥⑦ COIN-M·주식으로 옮겨도 코인 심볼이 따라오지 않는다', () => {
    const sel = selectInstrument(EMPTY_SELECTION, 'USDM', pickUsdm());
    for (const m of ['COINM', 'STOCK'] as const) {
      const a = instrumentForMarket(m, ENTRY, sel);
      eq(a.instrument, null);
      eq(a.tradable, false);
      assert(!/BTCUSDT를 그대로/.test(a.reason || ''), '심볼을 옮겨 적었다');
      assert(!!a.reason, '사유가 없다');
    }
  });

  test('⑥-b 다른 시장 종목을 그 시장 칸에 넣으려 하면 거부한다', () => {
    // 복사가 일어날 수 있는 **유일한 자리**를 막는다
    throws(() => selectInstrument(EMPTY_SELECTION, 'COINM', pickUsdm()));
    throws(() => selectInstrument(EMPTY_SELECTION, 'SPOT', pickUsdm()));
  });

  // ── 8 ──
  test('⑧ 목록을 못 읽은 것과 종목이 0개인 것은 다르다', () => {
    // 목록 권위 자체가 없는 시장
    eq(catalogOpenFor('COINM').open, false);
    eq(catalogOpenFor('STOCK').open, false);
    assert(!!catalogOpenFor('STOCK').reason, 'mock을 근거로 쓰지 않는 이유가 없다');
    assert(/mock/.test(catalogOpenFor('STOCK').reason || ''),
      '주식 목록이 mock을 포함한다는 사실을 적지 않았다');
    eq(catalogOpenFor('SPOT').open, true);
    eq(catalogOpenFor('USDM').open, true);
  });

  // ── 9 ──
  test('⑨ 주문이 날아가는 중에는 전환을 막는 사유가 나온다', () => {
    eq(switchBlockedReason('NONE'), null);
    assert(!!switchBlockedReason('ORDER_IN_FLIGHT'), '진행 중인데 막는 사유가 없다');
    // ★ 확인 중과 보내는 중은 **다른 사유**다. 돌려쓰면 확인 중인데
    //   "보내는 중입니다"가 뜨고, 사용자는 주문이 이미 나간 줄 안다.
    const inFlight = switchBlockedReason('ORDER_IN_FLIGHT');
    const reviewing = switchBlockedReason('ORDER_REVIEW');
    assert(!!reviewing, '확인 중인데 막는 사유가 없다');
    assert(inFlight !== reviewing, '확인 중과 보내는 중의 사유가 같다');
    // 보내는 중이 더 강하다 — 둘 다면 보내는 중이라고 적는다
    eq(switchLockState({ inFlight: true, reviewing: true }), 'ORDER_IN_FLIGHT');
    eq(switchLockState({ inFlight: false, reviewing: true }), 'ORDER_REVIEW');
    eq(switchLockState({ inFlight: false, reviewing: false }), 'NONE');
  });

  // ── 10 ──
  test('⑩ 정체성이 바뀌면 이전 주문 입력을 물려주지 않는다', () => {
    assert(identityKey({ market: 'SPOT', symbol: 'BTCUSDT' })
      !== identityKey({ market: 'USDM', symbol: 'BTCUSDT' }),
      '시장이 달라도 같은 정체성으로 읽혔다 — 이름이 같아도 다른 상품이다');
    eq(identityKey(null), 'NONE');

    const r = identityResetState('USDM');
    eq(r.sideChosen, false);
    eq(r.percent, null);
    eq(r.tp, '');
    eq(r.sl, '');
    eq(r.slPct, null);
    eq(r.message, null);
    // 현물에는 배율이 없다. 선물에서 100배를 쓰다 현물로 가면 1로 돌아와야 한다.
    eq(identityResetState('SPOT').leverage, 1);
    assert(identityResetState('USDM').leverage > 1, '선물 기본 배율이 1이다');
    eq(identityResetState('SPOT').marginMode, 'ISOLATED');
  });

  // ── 목록 파싱 ──
  test('현물 목록은 TRADING · USDT 결제만 통과시킨다', () => {
    const rows = parseSpotCatalog({ symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC' },
      { symbol: 'XXXUSDT', status: 'BREAK', baseAsset: 'XXX', quoteAsset: 'USDT' },
      { symbol: '', status: 'TRADING', baseAsset: '', quoteAsset: 'USDT' },
    ] }, 7);
    eq(rows.length, 1);
    eq(rows[0].symbol, 'BTCUSDT');
    eq(rows[0].market, 'SPOT');
    eq(rows[0].asOf, 7);
  });

  test('★ 선물 목록은 무기한만 통과시킨다 — 분기물은 만기가 있다', () => {
    const rows = parseUsdmCatalog({ symbols: [
      usdmRow,
      { symbol: 'BTCUSDT_240628', status: 'TRADING', contractType: 'CURRENT_QUARTER',
        baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'BTCUSDC', status: 'TRADING', contractType: 'PERPETUAL',
        baseAsset: 'BTC', quoteAsset: 'USDC' },
    ] }, 9);
    eq(rows.length, 1);
    eq(rows[0].symbol, 'ETHUSDT');
    eq(rows[0].market, 'USDM');
  });

  test('★ 현물에 있다는 이유로 선물 목록에 넣지 않는다', () => {
    // 현물 응답만 주고 선물 파서를 돌리면 아무것도 나오면 안 된다
    const rows = parseUsdmCatalog({ symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' },
    ] }, 1);
    eq(rows.length, 0);
  });

  test('검색은 받아 둔 목록 안에서 한다 — 빈 검색어는 목록 그대로', () => {
    const rows = parseSpotCatalog({ symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDT', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT' },
    ] }, 1);
    eq(searchCatalog(rows, '').length, 2);
    eq(searchCatalog(rows, 'eth').length, 1);
    eq(searchCatalog(rows, 'eth')[0].symbol, 'ETHUSDT');
    eq(searchCatalog(rows, 'zzz').length, 0);
  });
}
