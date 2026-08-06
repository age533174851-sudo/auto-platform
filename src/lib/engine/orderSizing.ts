// src/lib/engine/orderSizing.ts
//
// **손절 2%가 무엇의 2%인가.**
//
// 무엇이 문제였나
// ───────────────
// 주문판에 손절 버튼이 `1% / 2% / 3% / 5% / 10%`로 있다. 그런데 그게
// 무엇의 퍼센트인지 어디에도 안 적혀 있다. 넷 다 말이 되는 해석이다:
//
//   · 가격이 2% 움직이면 손절
//   · 증거금의 2%를 잃으면 손절
//   · 계좌 전체의 2%를 잃으면 손절
//   · 배율 적용 ROI가 −2%면 손절
//
// 5배에서 이 넷은 전부 다른 가격이고, 100배에서는 **쉰 배 차이**가 난다.
// 사용자가 "2%면 안전하지"라고 생각한 것이 실제로는 계좌의 20%일 수 있다.
//
// 그리고 수량 칸
// ──────────────
// 지금은 사용자가 BTC 수량을 직접 적거나 잔고의 25/50/75/100%를 고른다.
// 둘 다 **위험과 무관한 숫자**다. 잔고의 50%를 5배로 열면 계좌의 250%가
// 시장에 노출되는데, 손절이 어디인지에 따라 잃는 돈은 완전히 달라진다.
//
// 실제로 정해야 하는 것은 하나다: **이 거래에서 얼마를 잃어도 되는가.**
// 거기서 손절 거리를 나누면 수량이 나온다.
//
//   수량 = (잔고 × 허용위험%) ÷ (진입가 − 손절가)
//
// 이 파일이 그 계산 하나만 한다
// ─────────────────────────────
// 확인창·수량 버튼·손절 기준 표시가 **같은 계산을 쓴다.** 셋이 각자
// 계산하면 확인창에 적힌 예상 손실과 실제로 나가는 수량이 어긋나고,
// 그 어긋남은 주문이 체결된 뒤에나 드러난다.

export type StopBasis =
  /** 가격이 이만큼 움직이면 손절 */
  | 'PRICE'
  /** 계좌의 이만큼을 잃으면 손절 */
  | 'ACCOUNT_RISK';

export const STOP_BASIS_LABEL: Record<StopBasis, string> = {
  PRICE: '가격 변동률',
  ACCOUNT_RISK: '계좌 위험률',
};

export interface SizingInput {
  /** 계좌 잔고(견적통화). **못 읽었으면 null** — 0으로 눕히면 안 된다 */
  equity?: number | null;
  entryPrice?: number | null;
  /** 롱인가 숏인가 */
  side?: 'LONG' | 'SHORT' | null;
  basis?: StopBasis;
  /** basis에 해당하는 % 값 */
  pct?: number | null;
  leverage?: number | null;
  /** 거래소 최소 주문 수량. 모르면 null */
  minQty?: number | null;
  /** 수량 단위. 모르면 null */
  qtyStep?: number | null;
}

export type SizingStatus =
  | 'OK'
  /** 잔고를 못 읽었다 */
  | 'EQUITY_UNKNOWN'
  /** 진입가를 못 읽었다 */
  | 'PRICE_UNKNOWN'
  /** 손절 %가 없거나 0이다 */
  | 'STOP_INVALID'
  /** 계산된 수량이 최소 단위 미만이다 */
  | 'BELOW_MIN_QTY'
  /** 필요 증거금이 잔고를 넘는다 */
  | 'MARGIN_EXCEEDS_EQUITY';

export interface SizingResult {
  status: SizingStatus;
  ok: boolean;
  /** 주문 수량(기초자산). 계산 못 했으면 null */
  qty: number | null;
  /** 손절 가격. 계산 못 했으면 null */
  stopPrice: number | null;
  /** 가격이 몇 % 움직이면 손절인가 */
  stopPricePct: number | null;
  /** 이 거래에서 잃는 돈(견적통화) */
  maxLoss: number | null;
  /** 그것이 계좌의 몇 %인가 */
  maxLossPctOfEquity: number | null;
  /** 명목가 */
  notional: number | null;
  /** 필요 증거금 */
  margin: number | null;
  reason: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 수량을 거래소 단위로 내린다. **올리지 않는다** — 올리면 허용 위험을 넘는다 */
export function floorToStep(qty: number, step: number | null | undefined): number {
  const s = num(step);
  if (s == null || s <= 0) return qty;
  return Math.floor(qty / s) * s;
}

/**
 * 손절 기준을 가격 변동률로 옮긴다.
 *
 * 계좌 위험률 기준이면 **수량이 정해져야** 가격 손절폭이 나온다. 그래서
 * 이 함수는 가격 기준일 때만 바로 답하고, 계좌 위험률일 때는 계산 순서가
 * 반대가 된다(아래 planSize가 그 순서를 갖는다).
 */
export function stopPriceOf(
  entry: number, side: 'LONG' | 'SHORT', pricePct: number,
): number {
  return side === 'SHORT' ? entry * (1 + pricePct / 100) : entry * (1 - pricePct / 100);
}

/**
 * 위험에서 수량을 낸다.
 *
 * **두 기준이 계산 순서가 다르다.**
 *
 *   가격 기준   — 손절폭이 먼저 정해지고, 허용 위험에서 수량이 나온다
 *   계좌 위험률 — 잃을 금액이 먼저 정해지고, 손절폭에서 수량이 나온다
 *
 * 그런데 계좌 위험률만으로는 손절 **가격**이 안 나온다. 같은 손실을
 * 좁은 손절 × 큰 수량으로도, 넓은 손절 × 작은 수량으로도 만들 수 있다.
 * 그래서 계좌 위험률 기준에서도 **가격 손절폭이 하나 있어야 한다** —
 * `pricePctForAccountRisk`로 받는다. 없으면 계산하지 않는다.
 * 임의로 정하면 그 값이 곧 사용자가 모르는 청산 거리가 된다.
 */
export function planSize(
  input: SizingInput,
  opts: { pricePctForAccountRisk?: number | null } = {},
): SizingResult {
  const equity = num(input.equity);
  const entry = num(input.entryPrice);
  const side: 'LONG' | 'SHORT' = input.side === 'SHORT' ? 'SHORT' : 'LONG';
  const basis: StopBasis = input.basis === 'ACCOUNT_RISK' ? 'ACCOUNT_RISK' : 'PRICE';
  const pct = num(input.pct);
  const lev = num(input.leverage);

  const empty = (status: SizingStatus, reason: string): SizingResult => ({
    status, ok: false, qty: null, stopPrice: null, stopPricePct: null,
    maxLoss: null, maxLossPctOfEquity: null, notional: null, margin: null, reason,
  });

  // **못 읽은 것을 0으로 눕히지 않는다.** 0 잔고로 계산하면 수량 0이
  // 나오고, 화면은 그것을 '계산됨'으로 그린다.
  if (equity == null || equity <= 0) {
    return empty('EQUITY_UNKNOWN', '계좌 잔고를 읽지 못했습니다 — 위험 기준 수량을 낼 수 없습니다');
  }
  if (entry == null || entry <= 0) {
    return empty('PRICE_UNKNOWN', '진입가를 읽지 못했습니다');
  }
  if (pct == null || pct <= 0) {
    return empty('STOP_INVALID', '손절 값이 없습니다 — 손절 없는 진입은 크기를 정할 근거가 없습니다');
  }

  // ── 가격 손절폭을 정한다 ──
  const pricePct = basis === 'PRICE' ? pct : num(opts.pricePctForAccountRisk);
  if (pricePct == null || pricePct <= 0) {
    return empty('STOP_INVALID',
      '계좌 위험률만으로는 손절 가격이 정해지지 않습니다 — 가격 손절폭도 필요합니다');
  }

  const stopPrice = stopPriceOf(entry, side, pricePct);
  const stopDistance = Math.abs(entry - stopPrice);
  if (!(stopDistance > 0)) {
    return empty('STOP_INVALID', '손절 거리가 0입니다');
  }

  // ── 잃어도 되는 금액 ──
  const riskPct = basis === 'ACCOUNT_RISK' ? pct : null;
  // 가격 기준일 때도 **계좌 위험은 계산해서 보여준다.** 그게 사용자가
  // 실제로 알아야 하는 숫자다.
  const riskBudget = riskPct != null ? equity * (riskPct / 100) : null;

  let qty: number;
  if (riskBudget != null) {
    qty = riskBudget / stopDistance;
  } else {
    // 가격 기준인데 위험 예산이 없으면 수량을 정할 수 없다. 이 경로는
    // 사용자가 수량을 직접 넣는 경우이므로, 여기서는 계산하지 않는다.
    return empty('STOP_INVALID',
      '수량을 내려면 계좌 위험률이 필요합니다 — 가격 손절폭만으로는 정해지지 않습니다');
  }

  qty = floorToStep(qty, input.qtyStep);
  const minQty = num(input.minQty);
  if (minQty != null && minQty > 0 && qty < minQty) {
    return {
      ...empty('BELOW_MIN_QTY',
        `이 위험(${riskPct}%)으로는 최소 주문 수량(${minQty})에 못 미칩니다 — 위험을 키우거나 손절을 좁히세요`),
      // 무엇이 모자란지는 보여준다. 숫자가 없으면 얼마나 키워야 하는지 모른다.
      qty, stopPrice, stopPricePct: pricePct,
    };
  }
  if (!(qty > 0)) {
    return { ...empty('BELOW_MIN_QTY', '계산된 수량이 0입니다 — 위험을 키우거나 손절을 좁히세요'),
      stopPrice, stopPricePct: pricePct };
  }

  const notional = qty * entry;
  const margin = lev != null && lev > 0 ? notional / lev : null;
  // **수량을 내린 뒤 손실을 다시 계산한다.** 예산에서 역산한 값을 그대로
  // 적으면 화면의 '예상 최대 손실'과 실제가 달라진다.
  const maxLoss = qty * stopDistance;

  if (margin != null && margin > equity) {
    return {
      status: 'MARGIN_EXCEEDS_EQUITY', ok: false,
      qty, stopPrice, stopPricePct: pricePct,
      maxLoss, maxLossPctOfEquity: (maxLoss / equity) * 100,
      notional, margin,
      reason: `필요 증거금 ${margin.toFixed(2)}이 잔고 ${equity.toFixed(2)}를 넘습니다 — 배율을 올리거나 위험을 줄이세요`,
    };
  }

  return {
    status: 'OK', ok: true,
    qty, stopPrice, stopPricePct: pricePct,
    maxLoss, maxLossPctOfEquity: (maxLoss / equity) * 100,
    notional, margin,
    reason: '',
  };
}

/**
 * 가격 손절폭이 계좌의 몇 %인가.
 *
 * 수량이 이미 정해진 경우(사용자가 직접 넣은 경우)에 쓴다. 손절 버튼
 * 옆에 "계좌 예상 손실 −20.00 USDT"를 적기 위한 것이다 — **그 숫자가
 * 없으면 2%가 무엇의 2%인지 알 수 없다.**
 */
export function lossPreview(args: {
  equity?: number | null;
  entryPrice?: number | null;
  qty?: number | null;
  side?: 'LONG' | 'SHORT' | null;
  pricePct?: number | null;
}): { stopPrice: number | null; loss: number | null; lossPctOfEquity: number | null; reason: string } {
  const equity = num(args.equity);
  const entry = num(args.entryPrice);
  const qty = num(args.qty);
  const pricePct = num(args.pricePct);
  const side: 'LONG' | 'SHORT' = args.side === 'SHORT' ? 'SHORT' : 'LONG';

  if (entry == null || entry <= 0 || pricePct == null || pricePct <= 0) {
    return { stopPrice: null, loss: null, lossPctOfEquity: null, reason: '손절 가격을 계산하지 못했습니다' };
  }
  const stopPrice = stopPriceOf(entry, side, pricePct);
  if (qty == null || qty <= 0) {
    return { stopPrice, loss: null, lossPctOfEquity: null, reason: '수량이 없어 손실을 계산하지 못했습니다' };
  }
  const loss = qty * Math.abs(entry - stopPrice);
  return {
    stopPrice, loss,
    // 잔고를 모르면 **비율을 지어내지 않는다.** 금액만 준다.
    lossPctOfEquity: equity != null && equity > 0 ? (loss / equity) * 100 : null,
    reason: equity != null && equity > 0 ? '' : '잔고를 몰라 계좌 대비 비율은 계산하지 못했습니다',
  };
}
