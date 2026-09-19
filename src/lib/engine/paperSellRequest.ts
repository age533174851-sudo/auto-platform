// src/lib/engine/paperSellRequest.ts
//
// **얼마를 팔라는 것인지 읽는 한 곳.**
//
// 비율과 수량 중 **정확히 하나**여야 한다. 둘 다 오는데 하나를 골라 주면
// 사용자가 누른 적 없는 수량이 나간다. 둘 다 없으면 무엇을 팔라는지 모른다.
// 둘 다 거부다 — 추측하지 않는다.

export type SellAmount =
  | { ok: true; percent: number | null; quantity: number | null }
  | { ok: false; code: 'AMBIGUOUS' | 'BAD_PERCENT' | 'BAD_QUANTITY'; reason: string };

const present = (v: any): boolean => v != null && v !== '' && typeof v !== 'boolean';

export function sellAmountOf(body: any): SellAmount {
  const hasPct = present(body?.percent);
  const hasQty = present(body?.quantity);

  // 둘 다이거나 둘 다 아니면 거부. `===`로 한 번에 본다.
  if (hasPct === hasQty) {
    return { ok: false, code: 'AMBIGUOUS', reason: '비율과 수량 중 하나만 보내세요' };
  }

  if (hasPct) {
    const p = Number(body.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      return { ok: false, code: 'BAD_PERCENT', reason: '비율은 0보다 크고 100 이하여야 합니다' };
    }
    return { ok: true, percent: p, quantity: null };
  }

  const q = Number(body.quantity);
  if (!Number.isFinite(q) || q <= 0) {
    return { ok: false, code: 'BAD_QUANTITY', reason: '수량은 0보다 커야 합니다' };
  }
  return { ok: true, percent: null, quantity: q };
}

export function sellAmountFailed(a: SellAmount): a is Extract<SellAmount, { ok: false }> {
  return a.ok === false;
}
