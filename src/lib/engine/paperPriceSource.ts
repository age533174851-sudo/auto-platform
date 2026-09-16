// src/lib/engine/paperPriceSource.ts
//
// **한 모의 포지션의 진입가와 청산가는 같은 시장에서 와야 한다.**
//
// 무엇이 고장이었나
// ─────────────────
// 진입(`/api/paper/order`)은 시장을 보고 가격 출처를 갈랐다:
//
//   SPOT → Binance 현물 ticker
//   USDM → Binance 선물 markPrice
//
// 그런데 청산(`/api/paper/close`)은 **`pos.market`을 한 번도 보지 않고**
// 언제나 `getPremiumIndex`(선물)를 불렀다. 그래서 현물로 산 포지션이
// 선물 마크가로 닫혔다. 같은 포지션의 가격 권위가 앞뒤로 다른 것이다.
//
// 차이는 작아 보이지만 그게 요점이 아니다. 진입 라우트가 스스로 적어 둔
// 이유가 그대로 청산에도 해당한다:
//
//   "선물 마크가로 현물을 채우면 펀딩·베이시스만큼 다른 가격에 산 장부가
//    되고, 그 차이가 성적표에 그대로 남는다."
//
// 사고 싶은 가격과 팔리는 가격이 다른 시장에서 오면, 아무것도 안 하고
// 가만히 있어도 손익이 생긴다. 연습 성적표가 그만큼 거짓이 된다.
//
// 왜 모듈 하나인가
// ────────────────
// 이 저장소가 반복해서 겪은 고장이 **"경로가 둘인데 한쪽만 고침"**이다.
// 청산 쪽에 `if (market === 'SPOT')`를 한 줄 더 적으면 지금은 맞지만,
// 시장이 하나 늘거나 출처가 바뀌는 날 다시 갈린다.
//
// 그래서 **진입과 청산이 같은 함수를 부른다.** 같은 파일을 쓰면 갈릴
// 수가 없다 — 규칙을 두 곳에 적고 같기를 바라는 대신, 적는 곳을 하나로
// 만든다.
//
// 모르는 시장은 멈춘다
// ────────────────────
// `COINM`·주식·오타는 **USDM으로 흘려보내지 않는다.** 흘려보내면 현물이
// 선물 규칙으로 닫히던 그 고장이 이름만 바꿔 돌아온다. 모르는 것은
// 가격을 만들지 않고 거기서 끝낸다.

/** 모의 장부가 다루는 시장. **이 둘뿐이다** — 늘리려면 출처도 같이 정해야 한다. */
export type PaperMarket = 'SPOT' | 'USDM';

export const PAPER_MARKETS: PaperMarket[] = ['SPOT', 'USDM'];

/**
 * 밖에서 온 값을 시장으로 읽는다. **모르면 null이다.**
 *
 * 기본값을 주지 않는 것이 요점이다. `market ?? 'USDM'`처럼 적으면 빈 값과
 * 오타가 전부 선물이 되고, 그 순간 현물 포지션이 선물 가격으로 닫힌다.
 */
export function paperMarketOf(raw: any): PaperMarket | null {
  const v = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (v === 'SPOT') return 'SPOT';
  if (v === 'USDM') return 'USDM';
  return null;
}

/** 어느 시장의 가격을 읽는가 — 이름을 붙여 두면 로그·시험이 그것을 확인할 수 있다. */
export type PriceSourceId = 'BINANCE_SPOT_TICKER' | 'BINANCE_USDM_MARK';

/**
 * 시장 → 가격 출처. **순수 함수다.**
 *
 * 이 한 줄이 진입과 청산이 공유하는 계약의 전부다. 네트워크를 타지 않으므로
 * 시험이 모든 시장을 한 번에 확인할 수 있고, 검사기도 이 표를 읽는다.
 */
export function priceSourceFor(market: PaperMarket | null | undefined): PriceSourceId | null {
  if (market === 'SPOT') return 'BINANCE_SPOT_TICKER';
  if (market === 'USDM') return 'BINANCE_USDM_MARK';
  return null;
}

export interface PaperPriceOk {
  ok: true;
  price: number;
  market: PaperMarket;
  source: PriceSourceId;
}

export interface PaperPriceFail {
  ok: false;
  /** UNSUPPORTED_MARKET: 모르는 시장 · NO_PRICE: 출처는 맞는데 값을 못 받았다 */
  code: 'UNSUPPORTED_MARKET' | 'NO_PRICE';
  market: PaperMarket | null;
  reason: string;
}

export type PaperPrice = PaperPriceOk | PaperPriceFail;

/**
 * 못 구했는가 — **타입 가드로 쓴다.**
 *
 * 웹 `tsconfig`는 `strict: false`라 `if (!p.ok)`만으로는 판별 합집합이
 * 좁혀지지 않는다. `paperScopeFailed`와 같은 이유로 여기 하나를 둔다.
 */
export function paperPriceFailed(p: PaperPrice): p is PaperPriceFail {
  return !p || p.ok !== true;
}

/**
 * 이 시장의 지금 가격. **진입도 청산도 이 함수를 부른다.**
 *
 * 값을 못 구하면 **지어내지 않는다.** 추측한 가격 위에 쌓인 손익은 아무
 * 뜻이 없고, 사용자는 그걸 성적표로 읽는다.
 *
 * 출처는 인자로 받지 않는다 — 받으면 부르는 쪽이 현물 포지션에 선물 출처를
 * 넘길 수 있고, 그게 정확히 없애려는 고장이다.
 */
export async function readPaperMarkPrice(
  rawMarket: any, symbol: string,
): Promise<PaperPrice> {
  const market = paperMarketOf(rawMarket);
  const source = priceSourceFor(market);
  if (!market || !source) {
    return {
      ok: false, code: 'UNSUPPORTED_MARKET', market: null,
      reason: `모의 장부가 다루지 않는 시장입니다 (${String(rawMarket ?? '없음')})`
        + ' — 가격을 만들지 않습니다',
    };
  }

  const sym = String(symbol || '').toUpperCase().replace('/', '');
  if (!sym) {
    return { ok: false, code: 'NO_PRICE', market, reason: '종목을 알 수 없어 가격을 구하지 못했습니다' };
  }

  let v = NaN;
  try {
    if (source === 'BINANCE_SPOT_TICKER') {
      // 현물은 **현물 시세**를 쓴다. 이 한 줄이 진입 라우트에 있던 규칙이고,
      // 이제 청산도 같은 줄을 지난다.
      const { fetchSpotPriceMap } = await import('@/lib/markets/pricing');
      const map = await fetchSpotPriceMap();
      v = Number(map.get(sym));
    } else {
      const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
      const px = await getPremiumIndex(sym, false);
      v = Number(px?.markPrice);
    }
  } catch {
    v = NaN;
  }

  if (!Number.isFinite(v) || v <= 0) {
    return {
      ok: false, code: 'NO_PRICE', market,
      reason: '시세를 확인하지 못했습니다 — 가격을 지어내지 않습니다',
    };
  }
  return { ok: true, price: v, market, source };
}
