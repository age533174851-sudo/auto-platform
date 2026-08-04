// src/lib/engine/manualPlan.ts
//
// 수동 주문을 `executeOrder`가 받는 모양(PositionPlan)으로 바꾼다.
//
// 왜 필요한가
// ───────────
// `executeOrder`는 생명주기 기록·멱등 키·ISOLATED 강제·손절 부착·UNKNOWN
// 처리를 전부 갖고 있다. 수동 주문이 그걸 쓰지 않으면 그 로직이 두 벌이 되고,
// 실제로 그렇게 됐다 — 수동 경로는 jobs 큐로 빠져 워커에 절반만 있었다.
//
// 그런데 executeOrder는 riskManager가 만든 `PositionPlan`을 받는다. 수동
// 주문에는 그런 계획이 없다. 사용자가 수량과 배율을 직접 정한 것이다.
//
// ─────────────────────────────────────────────────────────────
// 이 파일에서 가장 위험한 것: approved를 그냥 true로 두는 것
// ─────────────────────────────────────────────────────────────
// `executeOrder`는 `plan.approved`가 false면 거부한다. 그 필드는 "riskManager를
// 통과했다"는 뜻이다. 수동 주문에 아무 조건 없이 true를 박으면, 위험 계층을
// 우회하는 통로가 생긴다 — 그리고 그 통로는 코드에서 보이지 않는다.
//
// 그래서 여기서는 **검사를 통과해야만** approved를 준다. 통과하지 못하면
// approved: false + 사유를 담아 돌려주고, executeOrder가 그걸로 거부한다.
// 수동 주문의 위험 판단은 이 파일과 preTradeChecklist 둘이 나눠 갖는다:
//   · 이 파일: 값 자체가 성립하는가 (수량·배율·방향·손절 방향)
//   · 체크리스트: 계좌·거래소 상태가 주문을 받을 수 있는가
//
// 포지션 크기를 여기서 다시 계산하지 않는다. 수동 주문은 사용자가 수량을
// 정한 것이고, 그걸 조용히 바꾸면 화면에 적은 숫자와 나간 주문이 달라진다.

import type { PositionPlan } from './riskManager';

export interface ManualOrderInput {
  symbol: string;
  /** 거래소로 보낼 방향 */
  side: 'BUY' | 'SELL';
  quantity: number;
  leverage: number;
  /** 청산 주문인가 */
  reduceOnly?: boolean;
  /** 거래소가 알려준 청산가. 없으면 0 (executeOrder의 손절 검사가 건너뛴다) */
  liquidationPrice?: number | null;
  /** 손절가. 진입인데 없으면 거부한다 — allowNoStop을 켜지 않는 한 */
  stopPrice?: number | null;
  /**
   * 손절 없는 진입을 허용하는가.
   *
   * **기본은 false다.** 화면이 "손절 없이 진입하는 위험을 이해했습니다"를
   * 받은 뒤에만 켠다. 자동매매는 절대 켜지 않는다 — 아무도 안 보는 시간에
   * 손절 없는 포지션이 열리면 그건 계좌 전체를 건 것이다.
   */
  allowNoStop?: boolean;
  /** 기준가 (지정가면 그 값, 아니면 마크가). 명목가 계산에 쓴다 */
  refPrice?: number | null;
}

export interface ManualPlanResult {
  plan: PositionPlan;
  /** 거부 사유. plan.approved가 false일 때만 채워진다 */
  reason: string;
  /** 손절 없이 나가는가. 화면·기록이 이걸 그대로 적어야 한다 */
  noStop?: boolean;
}

/** 최대 배율. 거래소가 더 높게 허용해도 이 경로에서는 막는다 */
export const MANUAL_MAX_LEVERAGE = 100;

/**
 * 수동 주문 입력을 검사하고 계획으로 만든다.
 *
 * 검사를 통과하지 못하면 `approved: false`다. 던지지 않는 이유: 호출자가
 * try/catch를 빼먹으면 검사가 조용히 사라지는데, approved:false는 executeOrder가
 * 반드시 걸러낸다.
 */
export function buildManualPlan(input: ManualOrderInput): ManualPlanResult {
  const inp = input;
  const {
    symbol, side, quantity, leverage, reduceOnly,
    liquidationPrice, stopPrice, refPrice,
  } = input;

  // plan.side는 '어느 방향 포지션인가'다. 청산 주문은 방향이 뒤집혀 오므로
  // 되돌려 적는다 — executeOrder가 reduceOnly를 보고 다시 뒤집어 보낸다.
  // 여기서 뒤집지 않으면 롱을 닫으려는 주문이 숏 진입으로 기록된다.
  const posSide: 'LONG' | 'SHORT' = reduceOnly
    ? (side === 'BUY' ? 'SHORT' : 'LONG')
    : (side === 'BUY' ? 'LONG' : 'SHORT');

  const notional = refPrice && refPrice > 0 ? quantity * refPrice : 0;
  const lev = Number(leverage);

  const base: PositionPlan = {
    approved: false,
    symbol: String(symbol || '').toUpperCase().replace('/', ''),
    side: posSide,
    // 수동 주문에는 '위험 금액' 개념이 없다. 0으로 두되, 이 값이 통계에
    // 섞이지 않도록 notes에 수동임을 적는다.
    riskAmount: 0,
    riskAmountWithCosts: 0,
    stopDistancePct: 0,
    effectiveStopPct: 0,
    positionSize: notional,
    quantity: Number(quantity),
    requiredMargin: lev > 0 ? notional / lev : 0,
    leverage: lev,
    liquidationPrice: Number(liquidationPrice ?? 0) || 0,
    liquidationDistancePct: 0,
    notes: ['수동 주문 — 수량·배율을 사용자가 지정했습니다 (riskManager 산출이 아닙니다)'],
  };

  const deny = (reason: string): ManualPlanResult => ({
    plan: { ...base, approved: false, rejectReason: reason },
    reason,
  });

  if (!base.symbol) return deny('심볼이 없습니다');
  if (!Number.isFinite(base.quantity) || base.quantity <= 0) {
    return deny(`수량이 유효하지 않습니다 (${quantity})`);
  }
  // ── 청산은 배율 검사보다 먼저 통과시킨다 ──
  //
  // 배율은 '얼마나 크게 들어가는가'의 값이다. **나가는 주문에는 그 질문이
  // 없다.** 그런데 예전에는 배율 검사가 위에 있어서, 거래소에서 배율을 못
  // 읽으면(0으로 내려오면) 청산 주문까지 `배율이 유효하지 않습니다 (0)`로
  // 막혔다. 청산 화면은 배율을 아예 보내지도 않으므로 이건 상시 위험이다.
  //
  // 못 여는 것은 불편이고, **못 닫는 것은 사고다.** 순서를 바꾼다.
  if (reduceOnly) {
    // 청산은 손절도 요구하지 않는다. 나가는 주문이다.
    const notes = lev >= 1
      ? base.notes
      : [...base.notes, '배율을 확인하지 못해 필요 증거금은 계산하지 않았습니다 (청산에는 쓰이지 않습니다)'];
    return { plan: { ...base, approved: true, notes }, reason: '' };
  }

  if (!Number.isFinite(lev) || lev < 1) {
    // 0·NaN·null이 오는 경우는 대개 '사용자가 0배를 골랐다'가 아니라
    // **거래소에서 배율을 못 읽어서 빈칸이 0으로 내려온 것**이다. 그런데
    // 예전 문구는 `(0)`만 적었고, 그러면 화면에는 "배율이 유효하지 않습니다
    // (0)"만 뜬다 — 무엇을 고쳐야 하는지가 빠져 있다.
    const missing = leverage == null || !Number.isFinite(lev) || lev === 0;
    return deny(missing
      ? '배율을 확인하지 못했습니다 — 화면에서 배율을 직접 고르거나, '
        + '거래소에서 이 심볼의 배율 설정을 확인하세요'
      : `배율 ${leverage}배는 최소값(1배)보다 낮습니다`);
  }
  if (lev > MANUAL_MAX_LEVERAGE) {
    return deny(`배율 ${lev}배는 이 경로의 상한(${MANUAL_MAX_LEVERAGE}배)을 넘습니다`);
  }

  // ── 진입에는 손절이 있어야 한다 ──
  // executeOrder는 stopLoss가 없어도 주문을 보낸다(자동매매는 exitPlan으로
  // 따로 건다). 수동 진입에 그 관용을 그대로 두면, 손절 없는 포지션이 이
  // 경로로만 열린다 — 그리고 그게 가장 흔한 계좌 소멸 경로다.
  if (stopPrice == null || !Number.isFinite(stopPrice) || stopPrice <= 0) {
    // ── 손절 없는 진입을 **사람에게는** 허용한다 ──
    //
    // 지금까지 무조건 막았다. 그런데 이 경로는 사람이 화면을 보며 누르는
    // 자리다. 자동매매(아무도 안 보는 새벽에 크론이 내는 것)와 같은 규칙을
    // 걸면, 사용자는 자기 계좌에서 자기가 정한 방식으로 거래할 수 없다.
    //
    // **다만 기본값은 여전히 막는 쪽이다.** 호출부가 명시적으로
    // `allowNoStop`을 켜야 열린다 — 화면이 "손절 없이 진입하는 위험을
    // 이해했습니다"를 받은 뒤에만 켜게 되어 있고, 그 확인이 없으면
    // 지금까지와 똑같이 거부된다.
    if (!inp.allowNoStop) {
      return deny('손절가가 없습니다. 손절 없는 진입은 이 경로에서 허용하지 않습니다');
    }
    return {
      plan: {
        ...base, approved: true,
        // 기록에 남긴다. 나중에 이 거래를 되짚을 때 "손절이 실패한 것"과
        // "처음부터 안 걸기로 한 것"은 완전히 다른 얘기다.
        notes: [...base.notes, '손절 없이 진입 — 사용자가 위험을 확인했습니다'],
      },
      reason: '손절 없이 진입합니다 — 청산가가 유일한 방어선입니다',
      noStop: true,
    };
  }

  // 손절 방향. executeOrder도 같은 검사를 하지만 거기는 청산가가 0이면
  // 건너뛴다. 청산가를 못 읽었을 때도 방향은 확인할 수 있다.
  if (refPrice && refPrice > 0) {
    const badLong = posSide === 'LONG' && stopPrice >= refPrice;
    const badShort = posSide === 'SHORT' && stopPrice <= refPrice;
    if (badLong || badShort) {
      return deny(
        `${posSide} 진입가 ${refPrice} / 손절 ${stopPrice} — 손절이 진입가의 `
        + `${posSide === 'LONG' ? '위' : '아래'}에 있습니다. 즉시 체결됩니다`);
    }
  }

  return { plan: { ...base, approved: true }, reason: '' };
}
