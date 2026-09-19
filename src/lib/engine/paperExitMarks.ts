// src/lib/engine/paperExitMarks.ts
//
// **감시기가 어느 가격으로 판정하는지 정하는 한 곳.**
//
// 예전에는 이 판단이 `/api/paper/exit-monitor` 안에 묻혀 있었고, 거기서
// 심볼만 보고 전부 선물 마크가를 불렀다. 그래서 익절이 걸린 **현물 포지션이
// 선물 가격으로 닫혔다** — `/api/paper/close`가 이미 고친 고장이 이 경로에만
// 남아 있었다.
//
// 라우트 안에 있는 동안은 시험을 붙일 수 없었다(그 파일은 Next 런타임과
// `@/` 별칭을 물고 있다). 꺼내 놓으면 시험이 붙는다.

export type MarkMarket = 'SPOT' | 'USDM';

/**
 * 이 줄의 시장. **모르는 값은 USDM으로 흘려보내지 않는다.**
 * 흘려보내면 현물이 선물 규칙으로 판정된다.
 */
export function exitMarketOf(row: any): MarkMarket | null {
  const m = String(row?.market ?? '').toUpperCase();
  return m === 'SPOT' || m === 'USDM' ? m : null;
}

/**
 * 가격 지도의 키. **심볼만으로는 안 된다** — 같은 심볼이 현물과 선물에
 * 동시에 있으면 두 가격이 한 칸을 덮어쓰고, 나중에 넣은 쪽이 둘 다 판정한다.
 */
export function exitMarkKey(row: any): string {
  return `${exitMarketOf(row) ?? ''}:${String(row?.symbol ?? '')}`;
}

/** 시세를 받아야 할 (시장, 심볼) 쌍. 시장이나 심볼을 모르면 빼 둔다. */
export function exitMarkPairs(rows: any): Array<{ key: string; market: MarkMarket; symbol: string }> {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set<string>();
  const out: Array<{ key: string; market: MarkMarket; symbol: string }> = [];
  for (const r of list) {
    const market = exitMarketOf(r);
    const symbol = String(r?.symbol ?? '');
    if (!market || !symbol) continue;       // fail-closed: 지도에 없으면 안 건드린다
    const key = `${market}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, market, symbol });
  }
  return out;
}

/**
 * 청산가. **`Number(null)`은 0이다** — 현물에는 청산가가 없어서 이 칸이
 * 비는데, 0을 넣으면 "청산가 0"이라는 없는 값이 판정 입력으로 들어간다.
 * 없는 것은 없다고 넘긴다.
 */
export function exitLiquidationOf(row: any): number | undefined {
  const v = row?.liquidation_price;
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
