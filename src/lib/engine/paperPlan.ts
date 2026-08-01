// src/lib/engine/paperPlan.ts
//
// 모의투자 주문을 **실전과 같은 규칙으로** 검사한다.
//
// 왜 모의에도 같은 규칙을 거는가
// ──────────────────────────────
// 모의의 목적은 연습이다. 연습의 규칙이 실전과 다르면 그 연습은 쓸모가
// 없다 — 손절 없이 100배로 넣어도 되는 화면에서 익힌 습관이 실계좌에서
// 그대로 나온다. 그래서 손절 필수·배율 상한·증거금 확인을 똑같이 건다.
//
// 다른 것은 하나뿐이다: 돈이 가상이라 **충전할 수 있다**. 그건 잔고가
// 모자랄 때 "충전하세요"라고 말할 수 있다는 뜻이지, 잔고 검사를 건너뛴다는
// 뜻이 아니다. 잔고를 안 보면 증거금·청산이라는 개념 자체가 사라진다.

import type { PositionPlan } from './riskManager';

/** 배율 상한 — 수동 주문(manualPlan)과 같은 값을 쓴다 */
export const PAPER_MAX_LEVERAGE = 100;

/**
 * 선형(USDⓈ-M) 계약의 대략 청산가.
 *
 * 유지증거금률을 반영한 **근사치**다. 실제 거래소 청산은 구간별 유지증거금
 * 때문에 이보다 가깝다. 화면에도 그렇게 적어야 한다 — 이 값을 믿고 손절을
 * 그 너머에 두면 청산이 먼저 온다.
 *
 * 모르면 null이다. 0을 돌려주면 '0달러에 청산'이 되어 청산거리가 100%로
 * 계산되고, 그건 가장 위험한 주문이 가장 안전해 보이는 결과다.
 */
export function linearLiquidationPrice(
  entryPrice: number, leverage: number, side: 'LONG' | 'SHORT', mmrPct = 0.5,
): number | null {
  const p = Number(entryPrice), lev = Number(leverage);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (!Number.isFinite(lev) || lev < 1) return null;

  const im = 1 / lev;          // 초기증거금률
  const mm = mmrPct / 100;     // 유지증거금률
  const move = im - mm;        // 청산까지 허용되는 가격 변동 비율
  if (move <= 0) return null;  // 배율이 너무 높아 진입 즉시 청산 구간

  const liq = side === 'LONG' ? p * (1 - move) : p * (1 + move);
  return liq > 0 ? liq : null;
}

export interface PaperOrderInput {
  symbol: string;
  side: 'LONG' | 'SHORT';
  /**
   * 어느 시장인가. 안 주면 'USDM'(지금까지의 동작).
   *
   * 현물은 **선물의 특수한 경우가 아니다.** 배율이 없고, 청산이 없고,
   * 손절이 없다. 실전 현물 라우트도 `stopLossPct`·`leverage`를 아예
   * 거부한다(`/api/binance/spot/order`). 모의만 손절을 요구하면 규칙이
   * 실전과 달라지고, 그러면 그 연습은 연습이 아니다 — 이 파일이 지키려는
   * 것이 정확히 그 대칭이다.
   */
  market?: 'SPOT' | 'USDM' | 'COINM';
  quantity: number;
  leverage: number;
  /** 체결 기준가. 모르면 주문하지 않는다 */
  markPrice: number | null;
  stopPrice?: number | null;
  takeProfit?: number | null;
  /** 가상 잔고. **모르면 거부한다** — 0으로 두면 전부 막히고, 무시하면 개념이 사라진다 */
  availableBalance: number | null;
  /** 편도 수수료율(%) — 증거금 확인에 함께 센다 */
  feeRatePct?: number;
}

export interface PaperPlanResult {
  ok: boolean;
  reason: string;
  /** 화면에 그대로 쓸 수 있는 계산값 */
  notional: number;
  requiredMargin: number;
  entryFee: number;
  liquidationPrice: number | null;
  plan?: PositionPlan;
}

const no = (reason: string, partial: Partial<PaperPlanResult> = {}): PaperPlanResult => ({
  ok: false, reason, notional: 0, requiredMargin: 0, entryFee: 0, liquidationPrice: null, ...partial,
});

/**
 * 모의 주문 계획을 만든다. 통과하지 못하면 `plan`이 없다.
 *
 * 검사 순서는 **싼 것부터**다. 시세를 모르면 나머지 계산이 전부 의미가
 * 없으므로 먼저 본다.
 */
export function buildPaperPlan(i: PaperOrderInput): PaperPlanResult {
  const price = Number(i.markPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return no('시세를 확인하지 못해 체결가를 만들 수 없습니다. 잠시 후 다시 시도하세요.');
  }

  const qty = Number(i.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return no(`수량이 유효하지 않습니다 (${i.quantity})`);
  }

  const spot = i.market === 'SPOT';

  // 현물은 배율이 없다. 1이 아닌 값이 오면 **조용히 1로 바꾸지 않는다** —
  // 화면이 3배를 보여주고 있는데 장부에 1배로 적히면 둘이 갈린다.
  const lev = spot ? 1 : Number(i.leverage);
  if (spot) {
    if (i.leverage != null && Number(i.leverage) !== 1) {
      return no(`현물에는 배율이 없습니다 (받은 값 ${i.leverage})`);
    }
    // 현물 매도는 **가진 것을 파는 것**이라 새 포지션이 아니다.
    // 여기서 열 수 있는 것은 매수뿐이고, 매도는 청산 경로로 간다.
    if (i.side !== 'LONG') {
      return no('현물은 숏으로 열 수 없습니다. 매도는 보유분 청산으로 처리하세요.');
    }
  } else if (!Number.isFinite(lev) || lev < 1 || lev > PAPER_MAX_LEVERAGE) {
    return no(`배율은 1~${PAPER_MAX_LEVERAGE} 사이여야 합니다 (받은 값 ${i.leverage})`);
  }

  if (i.side !== 'LONG' && i.side !== 'SHORT') {
    return no(`방향이 유효하지 않습니다 (${i.side})`);
  }

  // 손절: 선물은 필수, **현물은 없는 개념이다.**
  //
  // 실전 현물 라우트가 stopLossPct를 거부한다. 모의만 요구하면 규칙이
  // 실전과 달라진다 — 그러면 연습이 아니다.
  const sp = Number(i.stopPrice);
  const hasStop = Number.isFinite(sp) && sp > 0;
  if (!spot && !hasStop) {
    return no('손절가가 없습니다. 모의에서도 손절 없는 진입은 받지 않습니다 — '
            + '규칙이 실전과 다르면 연습이 되지 않습니다.');
  }
  if (hasStop) {
    const wrongLong = i.side === 'LONG' && sp >= price;
    const wrongShort = i.side === 'SHORT' && sp <= price;
    if (wrongLong || wrongShort) {
      return no(`${i.side} 기준가 ${price} / 손절 ${sp} — 손절이 `
              + `${i.side === 'LONG' ? '위' : '아래'}에 있어 즉시 발동합니다`);
    }
  }

  const notional = qty * price;
  const requiredMargin = notional / lev;
  const feeRate = (Number.isFinite(Number(i.feeRatePct)) ? Number(i.feeRatePct) : 0.05) / 100;
  const entryFee = notional * feeRate;
  // 현물에는 청산이 없다. 0이 아니라 **null**이다 — 0으로 두면 화면이
  // "청산가 0"을 그리고, 그건 "곧 청산된다"로 읽힌다.
  const liq = spot ? null : linearLiquidationPrice(price, lev, i.side);

  const shaped = { notional, requiredMargin, entryFee, liquidationPrice: liq };

  // 손절이 청산 너머면 손절은 작동할 기회가 없다. 배율이 높을수록 자주 나온다.
  if (liq != null && hasStop) {
    const beyond = i.side === 'LONG' ? sp <= liq : sp >= liq;
    if (beyond) {
      return no(
        `손절 ${sp} / 청산(근사) ${liq.toFixed(2)} — 청산이 먼저 닿아 손절이 작동하지 못합니다. `
        + '배율을 낮추거나 손절을 진입가에 붙이세요.', shaped);
    }
  }

  // 잔고. 모르면 거부한다 — 0으로 가정하면 전부 막히고, 무시하면
  // 증거금이라는 개념 자체가 사라진다.
  const bal = i.availableBalance;
  if (bal == null || !Number.isFinite(Number(bal))) {
    return no('가상 잔고를 확인하지 못했습니다. 잔고를 모르면 증거금을 판단할 수 없습니다.', shaped);
  }
  const need = requiredMargin + entryFee;
  if (Number(bal) < need) {
    return no(
      `가상 잔고가 부족합니다 — 필요 ${need.toFixed(2)} / 보유 ${Number(bal).toFixed(2)} USDT. `
      + `${(need - Number(bal)).toFixed(2)} USDT를 충전하거나 수량을 줄이세요.`, shaped);
  }

  const plan: PositionPlan = {
    approved: true,
    symbol: i.symbol,
    side: i.side,
    // 손절이 없으면 '한 거래에 거는 위험'을 낼 수 없다. 0으로 적으면
    // "위험 0"이 되어 위험 없는 거래처럼 보인다 — 현물은 산 금액 전부가
    // 위험이므로 명목가를 그대로 쓴다.
    riskAmount: hasStop ? Math.abs(price - sp) * qty : notional,
    riskAmountWithCosts: (hasStop ? Math.abs(price - sp) * qty : notional) + entryFee,
    stopDistancePct: hasStop ? Math.abs(price - sp) / price * 100 : 100,
    effectiveStopPct: hasStop ? Math.abs(price - sp) / price * 100 : 100,
    positionSize: notional,
    quantity: qty,
    requiredMargin,
    leverage: lev,
    liquidationPrice: liq ?? 0,
    liquidationDistancePct: liq != null ? Math.abs(price - liq) / price * 100 : 0,
    notes: spot
      ? ['모의투자 — 거래소로 주문이 나가지 않습니다', '현물 — 배율·청산 없음']
      : ['모의투자 — 거래소로 주문이 나가지 않습니다'],
  };

  return { ok: true, reason: '', ...shaped, plan };
}
