// src/lib/markets/ranking.ts
//
// **목록 순서도 권위다.**
//
// 순위는 값보다 세게 읽힌다 — 맨 위에 있는 것이 "가장 큰 자산"으로 읽히고,
// 사용자는 그 순서를 근거로 무엇을 볼지 정한다. 그래서 손으로 적은 시총
// 표로 정렬하던 것을 뺐다(`MCAP_QUARANTINED_NOT_REAL`).
//
// 무엇으로 대신하나
// ─────────────────
// **거래대금**이다. 거래소가 실제로 관측한 값이고, "지금 사람들이 여기서
// 얼마나 거래하고 있나"를 말한다.
//
// 거래량(기초 수량)으로 줄 세우면 안 된다
// ───────────────────────────────────────
// `volume24h`는 **개수**다 — BTC 몇 개, 주식 몇 주. 도지코인 1억 개와
// 비트코인 100개를 같은 자로 잴 수 없다. 개수는 자산마다 단위가 달라서
// 비교 자체가 성립하지 않는다.
//
// 통화가 다르면 더하지 않는다
// ───────────────────────────
// USDT 거래대금과 KRW 거래대금을 한 줄로 세우면 환율을 몰래 1로 쓰는
// 것과 같다. 이 저장소에는 표시용 상수(`KRW = 1375`)가 있는데 그건
// 환율이 아니다 — 그걸로 순위를 만들면 "상수 때문에 생긴 순위"가 된다.
//
// 그래서 **같은 quote 안에서만** 비교한다. 비교할 수 없는 것은 순위를
// 만들지 않고 `UNAVAILABLE`로 둔다. 모르는 것을 맨 아래로 보내면 그것도
// 순위를 매긴 것이다.

export type RankStatus = 'RANKED' | 'UNAVAILABLE';

export interface TradingValue {
  /** 거래대금. 못 구하면 null */
  value: number | null;
  /** 그 금액의 통화. 이게 다르면 비교하지 않는다 */
  currency: string | null;
  reason: string | null;
}

/**
 * 거래대금 = 거래소 원가 × 기초 거래량.
 *
 * **표시용 환산가(`price`)를 쓰지 않는다.** 그 값에는 상수가 곱해져 있어
 * 통화를 섞는 순간 상수가 순위를 정하게 된다. 거래소가 실제로 부른 값
 * (`quotePrice` + `quoteCurrency`)만 쓴다.
 */
export function tradingValueOf(i: {
  quotePrice?: any; quoteCurrency?: any; volume?: any;
}): TradingValue {
  const px = num(i.quotePrice);
  const vol = num(i.volume);
  const cur = typeof i.quoteCurrency === 'string' && i.quoteCurrency
    ? i.quoteCurrency.toUpperCase() : null;

  if (cur == null) {
    return { value: null, currency: null, reason: '거래 통화를 모릅니다 — 다른 통화와 비교할 수 없습니다' };
  }
  if (px == null) {
    return { value: null, currency: cur, reason: '거래소 원가를 받지 못했습니다' };
  }
  if (vol == null) {
    return { value: null, currency: cur, reason: '거래량을 받지 못했습니다' };
  }
  if (px < 0 || vol < 0) {
    return { value: null, currency: cur, reason: '거래대금이 음수입니다' };
  }
  return { value: px * vol, currency: cur, reason: null };
}

export interface RankedItem<T> {
  item: T;
  tradingValue: number | null;
  currency: string | null;
  status: RankStatus;
  reason: string | null;
}

export interface RankedUniverse<T> {
  /** 이 묶음의 통화. 같은 통화끼리만 줄 세운다 */
  currency: string;
  items: RankedItem<T>[];
}

export interface RankResult<T> {
  universes: RankedUniverse<T>[];
  /** 비교할 수 없어 순위를 만들지 않은 것들. **맨 아래로 보내지 않는다** */
  unavailable: RankedItem<T>[];
}

/**
 * 거래대금 내림차순 — **같은 통화 안에서만.**
 *
 * 통화 묶음끼리는 서로 비교하지 않는다. 묶음의 순서는 통화 이름
 * 오름차순이다(그 자체로는 아무 신호도 주지 않는다).
 */
export function rankByTradingValue<T>(
  items: T[],
  read: (t: T) => { quotePrice?: any; quoteCurrency?: any; volume?: any },
): RankResult<T> {
  const byCurrency = new Map<string, RankedItem<T>[]>();
  const unavailable: RankedItem<T>[] = [];

  for (const item of Array.isArray(items) ? items : []) {
    const tv = tradingValueOf(read(item));
    if (tv.value == null || tv.currency == null) {
      unavailable.push({
        item, tradingValue: null, currency: tv.currency,
        status: 'UNAVAILABLE', reason: tv.reason,
      });
      continue;
    }
    const row: RankedItem<T> = {
      item, tradingValue: tv.value, currency: tv.currency,
      status: 'RANKED', reason: null,
    };
    const bucket = byCurrency.get(tv.currency);
    if (bucket) bucket.push(row);
    else byCurrency.set(tv.currency, [row]);
  }

  const universes = [...byCurrency.entries()]
    .map(([currency, rows]) => ({
      currency,
      items: rows.sort((a, b) => (b.tradingValue ?? 0) - (a.tradingValue ?? 0)),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return { universes, unavailable };
}

/**
 * 시가총액으로 줄 세워도 되는가.
 *
 * **아직 아니다.** 손으로 적은 표를 격리했고 실제 공급자가 없다. 정본이
 * 생기기 전까지 이 축을 사용자에게 고르게 하지 않는다 — 고를 수 있으면
 * 그 순위가 사실이라는 뜻이 된다.
 */
export const MARKET_CAP_RANKING_AVAILABLE = false;

/**
 * 사용자가 고를 수 있는 정렬 축.
 *
 * `price`(한 주당 가격)는 뺐다. 주당 가격은 자산의 크기도 활동성도
 * 말하지 않는다 — 액면분할 한 번에 뒤집히는 숫자다.
 */
export const RANKING_AXES = [
  { id: 'tradingValue', label: '거래대금' },
  { id: 'volume', label: '거래량' },
  { id: 'gainers', label: '상승률' },
  { id: 'losers', label: '하락률' },
] as const;

export type RankingAxis = typeof RANKING_AXES[number]['id'];

function num(v: any): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
