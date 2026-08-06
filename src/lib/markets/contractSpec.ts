// src/lib/markets/contractSpec.ts
//
// **계약 명세 — 1계약이 얼마짜리인가.**
//
// 왜 코인 계산을 그대로 쓰면 안 되나
// ──────────────────────────────────
// 코인은 수량이 연속이다. 0.0137 BTC를 살 수 있으므로 "위험금액 ÷ 손절거리"가
// 그대로 수량이 된다. 금·원유·지수 선물은 다르다:
//
//   · 수량이 **정수 계약**이다. 1.7계약은 없다
//   · 1계약이 기초자산 여러 단위다 (금 1계약 = 100온스)
//   · 그래서 **1계약의 위험이 이미 계좌보다 클 수 있다**
//
// 금이 온스당 $2,000이고 손절이 $20이면, 1계약 손절 = 20 × 100 = **$2,000**이다.
// 계좌가 $1,000이고 1회 위험이 1%($10)라면 1계약도 못 산다. 코인에서는
// 이런 일이 없다 — 0.005계약을 사면 되니까.
//
// 그런데 지금 코드는 `수량 = 명목가 ÷ 가격`이다. 그 식에 금을 넣으면
// 0.005계약이라는 **존재하지 않는 수량**이 나오고, 거래소는 그걸 반올림하거나
// 거부한다. 반올림하면 위험이 200배가 된다.
//
// 이 파일이 지키는 규칙
// ─────────────────────
//  1. **배수를 모르면 수량을 만들지 않는다.** Gate에서 quanto_multiplier를
//     안 읽어 주문이 계속 실패했던 것과 같은 자리다. 1로 지어내면 조용히
//     100배 크기가 나간다
//  2. **정수로 내림한 뒤의 실제 위험을 함께 돌려준다.** 요청한 위험이 아니라
//     실제로 지는 위험이 성적표에 들어가야 한다
//  3. **최소 단위가 예산을 넘으면 거절한다.** 억지로 1계약을 넣으면
//     사용자가 정한 한도를 코드가 어기는 것이다

/** 이 상품의 수량이 어떻게 세어지는가 */
export type SizingStyle =
  /** 연속 수량 — 코인 현물·USDⓈ-M 선물. 0.0137처럼 쪼갤 수 있다 */
  | 'CONTINUOUS'
  /** 정수 계약 — 지수·금속·에너지 선물, Gate 선물. 1.7계약은 없다 */
  | 'CONTRACT';

export interface ContractSpec {
  symbol: string;
  /** 어떻게 세는가 */
  style: SizingStyle;
  /**
   * 1계약이 기초자산 몇 단위인가.
   *
   * 금 선물 100(온스), 원유 1000(배럴), Gate BTC_USDT 0.0001(BTC).
   * CONTINUOUS면 1이다.
   *
   * **못 읽으면 null.** 1로 채우면 금 1계약을 1온스로 계산하고,
   * 실제 위험은 100배가 된다.
   */
  multiplier: number | null;
  /** 최소 호가 단위(가격). 못 읽으면 null */
  tickSize: number | null;
  /**
   * 1틱이 움직일 때 1계약의 손익(견적통화).
   *
   * 보통 tickSize × multiplier와 같지만, 거래소가 따로 고시하는 상품이
   * 있어 별도로 둔다. 없으면 tickSize × multiplier로 계산한다.
   */
  tickValue: number | null;
  /** 최소 주문 수량 (계약 또는 기초자산 단위) */
  minQty: number | null;
  /** 수량 증분. CONTRACT면 보통 1 */
  qtyStep: number | null;
  /** 견적통화 */
  currency: string;
  /** 거래 시간대 (IANA). 코인은 24시간이라 빈 문자열 */
  timezone: string;
  /** 만기가 있는 상품이면 그 날짜(YYYY-MM-DD). 없으면 null */
  expiry: string | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 1틱당 1계약의 손익.
 *
 * 고시된 값이 있으면 그것을 쓰고, 없으면 tickSize × multiplier다.
 * **둘 다 없으면 null이다** — 여기서 1로 떨어뜨리면 그 뒤의 위험 계산이
 * 전부 틀리는데, 숫자는 그럴듯하게 나온다.
 */
export function tickValueOf(spec: ContractSpec | null | undefined): number | null {
  if (!spec) return null;
  const tv = num(spec.tickValue);
  if (tv != null && tv > 0) return tv;
  const ts = num(spec.tickSize), m = num(spec.multiplier);
  if (ts != null && ts > 0 && m != null && m > 0) return ts * m;
  return null;
}

/**
 * 이 상품 1계약을 손절까지 들고 있으면 얼마를 잃는가.
 *
 * 코인처럼 연속 수량이면 "1단위"의 손실이고, 계약이면 1계약의 손실이다.
 * **배수를 모르면 null이다.**
 */
export function riskPerUnit(
  spec: ContractSpec | null | undefined, stopDistance: number,
): number | null {
  const d = num(stopDistance);
  if (d == null || d <= 0) return null;
  const m = num(spec?.multiplier);
  if (m == null || m <= 0) return null;
  return d * m;
}

export type SizeStatus =
  | 'OK'
  /** 명세를 못 읽어 계산하지 않았다 */
  | 'SPEC_UNKNOWN'
  /** 최소 단위 하나가 이미 예산을 넘는다 */
  | 'MIN_SIZE_EXCEEDS_RISK'
  /** 내림했더니 0이 됐다 */
  | 'ROUNDS_TO_ZERO'
  /** 입력이 잘못됐다 */
  | 'BAD_INPUT';

export interface SizeResult {
  status: SizeStatus;
  /** 낼 수량. 못 내면 null — **0이 아니다** */
  qty: number | null;
  /**
   * 내림한 뒤 **실제로** 지는 위험(견적통화).
   *
   * 요청한 위험과 다르다. 정수로 내리면 대개 더 작고, 최소 단위에
   * 걸리면 더 클 수 있다. 성적표에는 실제 값이 들어가야 한다.
   */
  actualRisk: number | null;
  /** 요청한 위험 */
  requestedRisk: number;
  /** 명목가 */
  notional: number | null;
  reason: string;
}

/**
 * 위험에서 수량을 역산한다 — **계약 단위를 지켜서.**
 *
 * 기존 `calcFixedRiskSize`(risk/sizing.ts)와 뼈대가 같다: 위험금액 ÷
 * 손절거리. 다른 것은 그 뒤다 — 계약 배수로 나누고, 정수로 내리고,
 * 내린 뒤의 실제 위험을 다시 계산한다.
 *
 * **거절하는 쪽이 기본이다.** 계약 상품은 최소 단위가 크기 때문에
 * "조금 넘지만 1계약은 넣자"가 계좌를 날린다. 사용자가 정한 한도를
 * 코드가 임의로 넘기지 않는다.
 */
export function sizeByRisk(args: {
  spec: ContractSpec | null | undefined;
  /** 이 거래에서 잃어도 되는 금액(견적통화) */
  riskBudget: number;
  /** 진입가와 손절가의 거리(가격 단위). 부호 없음 */
  stopDistance: number;
  entryPrice: number;
  /**
   * 예산을 조금 넘는 최소 단위를 허용할 것인가. 기본 false.
   *
   * true로 켜면 1계약이 예산의 몇 배여도 나간다. 켜는 쪽이 필요한 경우가
   * 있지만(어차피 최소 1계약뿐인 상품), **기본값이 되면 안 된다** —
   * 한도를 정한 의미가 사라진다.
   */
  allowMinOverBudget?: boolean;
}): SizeResult {
  const budget = num(args.riskBudget);
  const dist = num(args.stopDistance);
  const px = num(args.entryPrice);

  const bad = (reason: string, status: SizeStatus = 'BAD_INPUT'): SizeResult =>
    ({ status, qty: null, actualRisk: null, requestedRisk: budget ?? 0, notional: null, reason });

  if (budget == null || budget <= 0) return bad('허용 손실 금액이 없습니다');
  if (dist == null || dist <= 0) return bad('손절 거리가 없습니다 — 손절 없이는 크기를 정할 수 없습니다');
  if (px == null || px <= 0) return bad('진입가가 없습니다');

  const spec = args.spec;
  const m = num(spec?.multiplier);
  if (!spec || m == null || m <= 0) {
    // **1로 지어내지 않는다.** Gate에서 배수를 못 읽고 계약 수를 그대로
    // 보내 주문이 계속 실패했던 자리와 같다. 그때는 실패해서 다행이었다.
    return bad(
      `1계약이 몇 단위인지(배수) 모릅니다 — 지어내면 실제 위험이 몇 배가 됩니다`,
      'SPEC_UNKNOWN');
  }

  // 1단위(또는 1계약)를 손절까지 들고 있을 때의 손실.
  const perUnit = dist * m;
  if (!(perUnit > 0)) return bad('1계약 위험이 0입니다');

  const raw = budget / perUnit;

  const step = spec.style === 'CONTRACT'
    ? (num(spec.qtyStep) ?? 1)
    : (num(spec.qtyStep) ?? 0);

  // 계약은 정수로 내린다. 연속이면 step이 있을 때만 내린다.
  let qty: number;
  if (spec.style === 'CONTRACT') {
    const s = step > 0 ? step : 1;
    qty = Math.floor(raw / s + 1e-9) * s;
  } else if (step > 0) {
    qty = Math.floor(raw / step + 1e-9) * step;
  } else {
    qty = raw;
  }

  const minQty = num(spec.minQty);

  if (!(qty > 0)) {
    // 내렸더니 0이다. 최소 단위를 넣으면 예산을 얼마나 넘는지 적어 준다 —
    // "안 됩니다"만 적으면 사용자는 무엇을 바꿔야 하는지 모른다.
    const one = minQty != null && minQty > 0 ? minQty : (step > 0 ? step : 1);
    const oneRisk = one * perUnit;
    if (args.allowMinOverBudget) {
      return {
        status: 'OK', qty: one, actualRisk: oneRisk, requestedRisk: budget,
        notional: one * m * px,
        reason: `최소 ${one}계약의 위험이 ${oneRisk.toFixed(2)}로 예산 ${budget.toFixed(2)}을 `
              + `${(oneRisk / budget).toFixed(1)}배 넘습니다 — 사용자가 허용해서 그대로 냅니다`,
      };
    }
    return {
      status: 'MIN_SIZE_EXCEEDS_RISK', qty: null, actualRisk: null,
      requestedRisk: budget, notional: null,
      reason: `최소 ${one}계약도 위험이 ${oneRisk.toFixed(2)}이라 예산 ${budget.toFixed(2)}을 `
            + `${(oneRisk / budget).toFixed(1)}배 넘습니다 — 손절을 좁히거나 예산을 늘리거나 `
            + '이 상품을 거래하지 마세요',
    };
  }

  // 내렸는데 최소 수량보다 작다.
  if (minQty != null && minQty > 0 && qty < minQty) {
    const minRisk = minQty * perUnit;
    if (args.allowMinOverBudget) {
      return {
        status: 'OK', qty: minQty, actualRisk: minRisk, requestedRisk: budget,
        notional: minQty * m * px,
        reason: `최소 수량 ${minQty}로 올렸습니다 — 위험이 ${minRisk.toFixed(2)}로 예산을 넘습니다`,
      };
    }
    return {
      status: 'MIN_SIZE_EXCEEDS_RISK', qty: null, actualRisk: null,
      requestedRisk: budget, notional: null,
      reason: `계산된 수량 ${qty}가 최소 ${minQty}보다 작습니다. 최소로 올리면 위험이 `
            + `${minRisk.toFixed(2)}이라 예산 ${budget.toFixed(2)}을 넘습니다`,
    };
  }

  const actualRisk = qty * perUnit;
  return {
    status: 'OK', qty, actualRisk, requestedRisk: budget,
    notional: qty * m * px,
    // **실제 위험이 요청과 얼마나 다른지 적는다.** 계약 상품은 내림 때문에
    // 실제 위험이 예산의 절반이 되는 일이 흔하고, 그걸 모르면 "1% 위험으로
    // 돌렸는데 왜 수익이 이것뿐이냐"가 된다.
    reason: Math.abs(actualRisk - budget) / budget > 0.05
      ? `정수 단위로 내려 실제 위험은 ${actualRisk.toFixed(2)}입니다 (요청 ${budget.toFixed(2)})`
      : '',
  };
}

/**
 * 코인 USDⓈ-M처럼 연속 수량인 상품의 명세를 만든다.
 *
 * 기존 경로가 이 파일을 쓰기 시작할 때, 코인이 특별 취급을 받지 않게
 * 하려고 둔다 — 계약 상품만 이 파일을 쓰면 두 경로가 다시 갈린다.
 */
export function continuousSpec(
  symbol: string, opts?: { tickSize?: number | null; qtyStep?: number | null; minQty?: number | null },
): ContractSpec {
  return {
    symbol,
    style: 'CONTINUOUS',
    multiplier: 1,
    tickSize: opts?.tickSize ?? null,
    tickValue: null,
    minQty: opts?.minQty ?? null,
    qtyStep: opts?.qtyStep ?? null,
    currency: 'USDT',
    timezone: '',
    expiry: null,
  };
}
