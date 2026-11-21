// src/lib/portfolio/storedHoldings.ts
//
// `tg_portfolio_v2`(PortfolioPage가 적는 수동 보유 목록)를 평가하는 단 한 곳.
//
// 저장 모양은 PortfolioPage.submit()이 정한다:
//   { id: 'pos-…', assetId, assetName, category, buyPrice, quantity, … }
// `id`는 **행 id**다 — 종목이 아니다. 종목은 `assetId`다.
//
// 시세는 PortfolioPage와 같은 규칙으로 고른다: `a.id === assetId`인 Asset의
// `p`(화면용 원화 환산가), 없으면 매수가. 둘 다 모르면 값은 0이 아니라
// `null`이다 — 모르는 것을 0으로 적지 않는다.

export type HoldingPriceSource = 'live' | 'buy' | 'none';

export interface StoredHoldingValue {
  assetId: string;
  category: string;
  quantity: number;
  price: number | null;
  priceSource: HoldingPriceSource;
  /** price × quantity. 가격을 모르면 null */
  value: number | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function positive(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

/** `Asset[]`(page.tsx가 실제로 넘기는 모양) 또는 `Record<id, price>`를 같은 조회로 바꾼다 */
function priceLookupOf(prices: unknown): (assetId: string) => number | null {
  if (Array.isArray(prices)) {
    const m = new Map<string, number | null>();
    for (const a of prices) {
      if (a && typeof a === 'object' && typeof (a as any).id === 'string') {
        m.set((a as any).id, positive((a as any).p));
      }
    }
    return id => m.get(id) ?? null;
  }
  if (prices && typeof prices === 'object') {
    const rec = prices as Record<string, unknown>;
    return id => positive(rec[id]);
  }
  return () => null;
}

export function valueStoredHoldings(raw: unknown, prices: unknown): StoredHoldingValue[] {
  if (!Array.isArray(raw)) return [];
  const priceOf = priceLookupOf(prices);
  const out: StoredHoldingValue[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    const assetId = typeof r.assetId === 'string' ? r.assetId.trim() : '';
    if (!assetId) continue;
    const quantity = positive(r.quantity);
    if (quantity === null) continue;

    const live = priceOf(assetId);
    const buy = positive(r.buyPrice);
    const price = live ?? buy;
    const priceSource: HoldingPriceSource = live !== null ? 'live' : buy !== null ? 'buy' : 'none';
    out.push({
      assetId,
      category: typeof r.category === 'string' && r.category ? r.category : 'crypto',
      quantity,
      price,
      priceSource,
      value: price !== null ? price * quantity : null,
    });
  }
  return out;
}

/** 값을 아는 줄만 더한다. 모르는 줄은 0으로 세지 않고 뺀다 — 호출자가 개수를 따로 적는다 */
export function sumKnownValues(holdings: StoredHoldingValue[]): number {
  return holdings.reduce((s, h) => s + (h.value ?? 0), 0);
}
