// src/lib/trading/positionSizing.ts
//
// **슬라이더 한 칸이 무엇의 비율인지 — 여기서만 정한다.**
//
// 왜 이것이 위험한가
// ──────────────────
// "50%"는 두 가지로 읽힐 수 있다:
//
//   ① 가용 잔고의 50%를 **증거금**으로 쓴다
//   ② 가용 잔고의 50%를 **명목가(notional)**로 쓴다
//
// 1배에서는 둘이 같다. 그래서 개발 중에는 아무 차이가 없어 보인다.
// **100배에서 갈린다.** 가용 1,000일 때:
//
//   ①  증거금 500 → 명목가 50,000   (레버리지가 곱해진다)
//   ②  명목가 500 → 증거금 5        (레버리지가 나뉜다)
//
// 100배짜리 차이다. 어느 쪽이든 "50%"라고 적혀 있고 화면은 똑같이 보인다.
// 그래서 **①로 못박는다** — 가용 잔고 중 이번 주문의 **필요 증거금**에
// 배정할 비율이다. 명목가는 그다음 단계이고, 슬라이더가 정하는 값이 아니다.
//
// 이 파일이 정하지 않는 것
// ────────────────────────
// **최종 허용 여부는 서버가 정한다.** 여기 계산은 화면이 숫자를 보여 주기
// 위한 것이고, 실제 판정은 계좌를 잠그는 `paper_open_position`과
// `buildPaperPlan`이 한다. 값이 갈리면 서버가 맞다.
//
// 어느 잔고인가
// ─────────────
// **선택된 모의 계좌의 가용 잔고**다. 챌린지를 고르고 있으면 그 전용 계좌의
// 가용 잔고뿐이고, 기본 계좌와 합치지 않는다. 합치면 챌린지 예산으로
// 기본 계좌 돈을 쓰게 된다 — 계좌를 나눈 이유가 사라진다.

export interface SizingInput {
  /** **선택된 계좌**의 가용 잔고. 못 읽었으면 null — 0으로 접지 않는다 */
  availableBalance: number | null | undefined;
  /** 0~100 */
  percent: number | null | undefined;
  /** 체결 기준가. 없으면 수량을 만들 수 없다 */
  price: number | null | undefined;
  /** 현물은 1이다 */
  leverage: number | null | undefined;
}

export type SizingCode =
  | 'OK'
  /** 가용 잔고를 못 읽었다. **0으로 읽지 않는다** */
  | 'BALANCE_UNKNOWN'
  /** 시세를 못 읽었다 */
  | 'PRICE_UNKNOWN'
  | 'LEVERAGE_INVALID'
  | 'PERCENT_INVALID'
  /** 비율이 0이다 — 잘못이 아니라 아직 안 고른 것이다 */
  | 'ZERO';

export interface SizingResult {
  code: SizingCode;
  /** 이번 주문에 배정할 **증거금**. 슬라이더가 정하는 값이 이것이다 */
  marginBudget: number | null;
  /** 증거금 × 배율. **슬라이더가 정하는 값이 아니라 계산 결과다** */
  notional: number | null;
  /** 명목가 ÷ 가격 */
  quantity: number | null;
  /** 화면에 그대로 적을 한 줄 */
  reason: string;
}

const fail = (code: SizingCode, reason: string): SizingResult =>
  ({ code, marginBudget: null, notional: null, quantity: null, reason });

/** `Number(null)`은 0이다. 못 읽은 것을 0으로 세지 않으려면 먼저 걸러야 한다. */
function num(v: any): number {
  return v == null || v === '' ? NaN : Number(v);
}

/** 0~100으로 가둔다. **벗어난 값을 조용히 고치지 않고** 잘못으로 읽는다. */
export function isValidPercent(v: any): boolean {
  const n = num(v);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

/**
 * 슬라이더 → 증거금 → 명목가 → 수량.
 *
 * **순서가 계약이다.** 명목가에서 거꾸로 증거금을 구하지 않는다 — 그렇게
 * 하면 100배에서 슬라이더의 뜻이 뒤집힌다.
 */
export function planSizing(i: SizingInput): SizingResult {
  const bal = num(i?.availableBalance);
  if (!Number.isFinite(bal)) {
    return fail('BALANCE_UNKNOWN',
      '가용 잔고를 확인하지 못해 수량을 계산하지 않았습니다 — 0으로 읽지 않습니다');
  }
  if (bal < 0) {
    return fail('BALANCE_UNKNOWN', '가용 잔고가 음수입니다 — 수량을 계산하지 않았습니다');
  }

  if (!isValidPercent(i?.percent)) {
    return fail('PERCENT_INVALID', '비율은 0~100 사이여야 합니다');
  }
  const pct = num(i.percent);

  const lev = num(i?.leverage);
  if (!Number.isFinite(lev) || lev < 1) {
    return fail('LEVERAGE_INVALID', '배율은 1 이상이어야 합니다');
  }

  const price = num(i?.price);
  if (!Number.isFinite(price) || price <= 0) {
    return fail('PRICE_UNKNOWN', '시세를 확인하지 못해 수량을 계산하지 않았습니다');
  }

  // ★ ① 슬라이더가 정하는 것은 **증거금 예산**이다.
  const marginBudget = bal * (pct / 100);

  if (!(marginBudget > 0)) {
    return {
      code: 'ZERO', marginBudget: 0, notional: 0, quantity: 0,
      reason: pct === 0 ? '비율이 0입니다' : '배정할 증거금이 없습니다',
    };
  }

  // ② 명목가는 그다음이다. 레버리지는 **여기서** 곱해진다.
  const notional = marginBudget * lev;
  // ③ 수량은 마지막이다.
  const quantity = notional / price;

  return {
    code: 'OK', marginBudget, notional, quantity,
    reason: `가용 잔고의 ${pct}%를 증거금으로 씁니다`,
  };
}

/**
 * 수량 → 비율. 사용자가 수량을 직접 적었을 때 슬라이더를 맞춰 주는 역방향.
 *
 * **여기서도 기준은 증거금이다.** 수량에서 명목가를 구하고, 명목가를
 * 레버리지로 나눠 증거금을 얻은 뒤, 그것을 잔고로 나눈다.
 *
 * 읽을 수 없으면 null — 슬라이더를 0으로 끌어다 놓지 않는다. 0은 "사용자가
 * 0을 골랐다"는 뜻이고, 그건 확인된 사실이 아니다.
 */
export function percentFromQuantity(i: {
  quantity: number | null | undefined;
  availableBalance: number | null | undefined;
  price: number | null | undefined;
  leverage: number | null | undefined;
}): number | null {
  const qty = num(i?.quantity);
  const bal = num(i?.availableBalance);
  const price = num(i?.price);
  const lev = num(i?.leverage);
  if (!Number.isFinite(qty) || qty < 0) return null;
  if (!Number.isFinite(bal) || !(bal > 0)) return null;
  if (!Number.isFinite(price) || !(price > 0)) return null;
  if (!Number.isFinite(lev) || lev < 1) return null;

  const margin = (qty * price) / lev;
  const pct = (margin / bal) * 100;
  if (!Number.isFinite(pct)) return null;
  // 100을 넘겨도 100으로 적는다 — 슬라이더가 표현할 수 있는 범위다.
  // 넘쳤다는 사실은 증거금 표시와 서버 판정이 말한다.
  return Math.max(0, Math.min(100, pct));
}

// ── 빠른 버튼은 없다 ──
//
// 한동안 `QUICK_PERCENTS = [25, 50, 75, 100]`을 여기서 내보냈고 슬라이더
// 아래에 버튼으로 그렸다. 비율을 정하는 방법이 둘이면 "지금 몇 %인가"를
// 말하는 곳도 둘이 된다. 끌어서 정하고 숫자로 읽는 한 벌만 남긴다.
//
// 상수를 지운 이유: 아무도 안 쓰는 export는 언젠가 다시 화면에 붙는다.

/**
 * **금액(명목가) → 비율.** 초보 화면의 "얼마어치 살까요?"가 이 함수를 쓴다.
 *
 * `percentFromQuantity`와 같은 기준을 쓴다 — 명목가를 레버리지로 나눠
 * 증거금을 얻고, 그것을 잔고로 나눈다. 두 역함수가 다른 기준을 쓰면
 * 수량 칸과 금액 칸이 같은 주문을 다르게 적는다.
 *
 * **가격을 받지 않는다.** 명목가는 이미 돈이라 가격을 거칠 필요가 없고,
 * 여기서 또 나누면 `planSizing`이 다시 곱할 때 값이 어긋난다.
 *
 * 읽을 수 없으면 null — 0으로 접지 않는다. 0은 "사용자가 0을 골랐다"이고
 * 그건 확인된 사실이 아니다.
 */
export function percentFromNotional(i: {
  notional: number | null | undefined;
  availableBalance: number | null | undefined;
  leverage: number | null | undefined;
}): number | null {
  const notional = num(i?.notional);
  const bal = num(i?.availableBalance);
  const lev = num(i?.leverage);
  if (!Number.isFinite(notional) || notional < 0) return null;
  if (!Number.isFinite(bal) || !(bal > 0)) return null;
  if (!Number.isFinite(lev) || lev < 1) return null;

  const margin = notional / lev;
  const pct = (margin / bal) * 100;
  if (!Number.isFinite(pct)) return null;
  // `percentFromQuantity`와 **같은 자르기**다. 두 칸이 다른 상한을 쓰면
  // 같은 주문이 칸에 따라 다른 비율로 보인다.
  return Math.max(0, Math.min(100, pct));
}

// ── 빠른 비율 버튼 ──
//
// 위에서 `QUICK_PERCENTS`를 지웠던 이유는 **"지금 몇 %인가"를 말하는 곳이
// 둘이 되는 것**이었지, 버튼 자체가 아니었다. 아래 상수는 값을 읽지 않는다 —
// 누르면 `useTradeForm`의 `setPercent` 하나로 들어가고, 현재 비율을 말하는
// 곳은 여전히 `percent` 한 곳뿐이다.
//
// 초보 화면에는 슬라이더가 없다. 그래서 이 버튼이 **유일한** 비율 입력이다.
export const BUY_PERCENTS = [10, 25, 50, 100] as const;

/**
 * 매도 비율. **전량이 100으로 들어간다** — `paper_sell_holding`이
 * `percent = 100`일 때만 나눗셈을 건너뛰고 남은 전부를 가져간다(088).
 * 여기서 99.99 같은 근사를 쓰면 영원히 안 풀리는 잔량이 생긴다.
 */
export const SELL_PERCENTS = [25, 50, 75, 100] as const;
