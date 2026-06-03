// src/lib/risk/sizing.ts
// 고정 리스크 모델 (Fixed Fractional Sizing)
// "내 시드의 N%만 리스크에 노출되도록 수량을 역산"
//
// 리스크금액 = 총자본 × riskPerTradePct
// 손절폭     = ATR × atrMultiplier  (변동성 기반, 꼬리 방어)
// 수량       = 리스크금액 / 손절폭
// 레버리지   = (수량 × 진입가) / 총자본  ← 역산 결과 (직접 지정 X)

export interface SizingInput {
  equity:          number;   // 총 계좌 자본 (USDT 기준)
  entryPrice:      number;   // 진입 가격 (USDT)
  atr:             number;   // ATR 값 (가격 단위)
  riskPerTradePct: number;   // 1회 리스크 % (예: 2)
  atrMultiplier:   number;   // ATR 배수 (예: 1.5)
  maxLeverage?:    number;   // 레버리지 상한 (예: 10)
}

export interface SizingResult {
  qty:           number;     // 진입 수량 (코인)
  notional:      number;     // 명목 가치 (수량 × 진입가)
  riskAmount:    number;     // 잃을 수 있는 금액
  stopDistance:  number;     // 손절 폭 (가격)
  stopPrice:     number;     // 손절가 (롱 기준)
  impliedLeverage: number;   // 역산된 레버리지
  capped:        boolean;    // 레버리지 상한에 걸렸는지
  reason?:       string;
}

export function calcFixedRiskSize(input: SizingInput): SizingResult | { error: string } {
  const { equity, entryPrice, atr, riskPerTradePct, atrMultiplier } = input;
  if (equity <= 0)     return { error: '자본 없음' };
  if (entryPrice <= 0) return { error: '진입가 오류' };
  if (atr <= 0)        return { error: 'ATR 값 없음 (변동성 계산 불가)' };

  const riskAmount   = equity * (riskPerTradePct / 100);
  const stopDistance = atr * atrMultiplier;
  if (stopDistance <= 0) return { error: '손절 폭 0' };

  let qty = riskAmount / stopDistance;
  let notional = qty * entryPrice;
  let impliedLeverage = notional / equity;
  let capped = false;

  // 레버리지 상한 적용 (안전)
  const maxLev = input.maxLeverage && input.maxLeverage > 0 ? input.maxLeverage : 10;
  if (impliedLeverage > maxLev) {
    capped = true;
    notional = equity * maxLev;
    qty = notional / entryPrice;
    impliedLeverage = maxLev;
  }

  const stopPrice = entryPrice - stopDistance;   // 롱 기준 (숏은 +)

  return {
    qty:             +qty.toFixed(6),
    notional:        +notional.toFixed(2),
    riskAmount:      +riskAmount.toFixed(2),
    stopDistance:    +stopDistance.toFixed(4),
    stopPrice:       +stopPrice.toFixed(4),
    impliedLeverage: +impliedLeverage.toFixed(2),
    capped,
    reason: capped ? `레버리지 ${maxLev}x 상한 적용됨` : undefined,
  };
}

// ATR을 손절% / 익절%로 환산 (SL/TP 주문용)
export function atrToPct(atr: number, entryPrice: number, multiplier: number): number {
  if (entryPrice <= 0) return 0;
  return +((atr * multiplier / entryPrice) * 100).toFixed(2);
}
