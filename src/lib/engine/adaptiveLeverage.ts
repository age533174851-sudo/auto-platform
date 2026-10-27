// src/lib/engine/adaptiveLeverage.ts
//
// **10~75배 적응형 레버리지 — 그 판단이 사는 단 한 곳.**
//
// 전용 100배와 무엇이 다른가
// ──────────────────────────
// `MAX_LEV_100X`는 **요청이 정확히 100**이고 거래소에 되읽어 100이
// 확인될 때만 주문한다. 시장이 어떻든 숫자는 100이다. 그 계약에서
// 위험을 줄이는 수단은 증거금 배정 비율 하나뿐이다.
//
// 이 정책은 반대다. **배율 자체가 시장 위험의 함수**이고, 100은
// 아예 선택지에 없다(`ADAPTIVE_MAX_LEVERAGE = 75`).
//
// 다섯 가지를 보고 **각각 상한을 내놓는다.** 최종 배율은 그 상한들의
// 최솟값 이하에서 고른다 — 어떤 축도 혼자 배율을 **올리지 못한다.**
//
//   변동성    한 번의 ATR 움직임이 증거금의 얼마를 먹는가
//   청산 여유 몇 번의 ATR 움직임까지 청산이 오지 않는가
//   유동성    이 주문이 호가창의 몇 퍼센트인가
//   스프레드  지금 건너야 하는 호가 간격
//   거래 비용 왕복 수수료 + 스프레드가 증거금의 몇 퍼센트인가
//   거래소    그 종목·그 규모에서 거래소가 허용하는 상한
//
// **기대 수익은 입력이 아니다.**
// ──────────────────────────────
// 이 파일에는 "신호가 강하다" · "승률이 높다" · "기대값이 크다"를 받는
// 칸이 없다. 일부러 없다. 그런 칸이 하나라도 생기면 다음 수정에서
// 그것이 배율을 **올리는** 가지가 되고, 그 순간 이 정책은 "좋아 보이면
// 더 건다"가 된다. 높은 배율은 같은 움직임에서 더 큰 손익을 만들 뿐
// 우위를 만들지 않는다 — 비용과 청산 거리는 배율에 비례해 나빠진다.
//
// 그래서 구조로 못 박는다: **모든 축은 상한만 내놓는다.**
//
// 못 읽은 것은 낮은 배율이 아니라 **차단**이다
// ─────────────────────────────────────────────
// 위험 입력이 없거나 오래됐을 때 "그러면 10배로 하자"가 아니다. 10배도
// 주문이다. 변동성을 모르는 채로 연 포지션은 변동성을 모르는 채로
// 들고 있게 된다. 그래서 **진입 자체를 막는다**(`ok: false`).
//
// 75배는 아직 후보다
// ──────────────────
// 사다리의 맨 윗칸은 `highRiskApproved`가 참일 때만 열린다. 기본값은
// 거짓이고, 그때 상한은 `ADAPTIVE_DEFAULT_TOP_RUNG`(50)이다. 백테스트
// 결과로 75를 자동 선택해도 되는지가 확정되기 전에는, 코드가 그 칸을
// 고르지 않는다. **지금 열어 두고 나중에 확인하지 않는다.**

// **시계 오차 숫자를 여기서 정하지 않는다.**
//
// "지금과 얼마나 벌어지면 못 믿는가"는 이 저장소에 이미 정본이 있다
// (`preTradeChecklist.checkClockSkew` — recvWindow × safetyRatio).
// `marketFreshness`의 미래 시각 판정도 그것을 쓴다. 여기서 새 숫자를
// 만들면 같은 질문에 답이 셋이 되고, 언젠가 하나만 고쳐진다.
import { checkClockSkew } from './preTradeChecklist';

/** 사다리의 맨 아랫칸. 이보다 낮게는 주문하지 않는다 — 막는다 */
export const ADAPTIVE_MIN_LEVERAGE = 10;

/** 이 정책이 낼 수 있는 가장 높은 배율. **100은 이 정책에 없다** */
export const ADAPTIVE_MAX_LEVERAGE = 75;

/**
 * 고를 수 있는 칸.
 *
 * 연속값이 아니라 사다리인 이유: 23배와 24배의 차이는 아무도 설명하지
 * 못하는데, 거래소에 남는 숫자는 매번 다르다. 그러면 "왜 이 배율이었나"를
 * 사후에 재현할 때 비교할 기준이 없다. 칸이 다섯이면 **어느 칸이었는지와
 * 왜 그 칸이 막혔는지**를 말할 수 있다.
 */
export const ADAPTIVE_LADDER: readonly number[] = [10, 20, 30, 50, 75];

/** 백테스트 확정 전까지 자동으로 고를 수 있는 맨 윗칸 */
export const ADAPTIVE_DEFAULT_TOP_RUNG = 50;

/** 이 정책에서 **금지된** 배율. 전용 100배 계약과 섞이지 않게 한다 */
export const FORBIDDEN_LEVERAGE = 100;

// ── 신선도 한도 ──
//
// 축마다 변하는 속도가 다르다. 호가는 초 단위로 변하고 일봉 ATR은
// 하루 단위다. 하나의 한도로 묶으면 둘 중 하나는 반드시 틀린다.

/** 일봉 ATR. 어제 봉이 기준이므로 하루 반까지 본다 */
export const MAX_VOLATILITY_AGE_MS = 36 * 60 * 60 * 1000;
/** 호가 깊이·스프레드. 10초 지난 호가는 지금 호가가 아니다 */
export const MAX_BOOK_AGE_MS = 10_000;
/** 거래소 배율 상한(구간표). 자주 바뀌지 않지만 무한정 믿지는 않는다 */
export const MAX_EXCHANGE_CAP_AGE_MS = 24 * 60 * 60 * 1000;

// ── 예산 상수 ──
//
// **측정값이 아니라 고른 값이다.** 백테스트로 확정하기 전까지의 기본값이고,
// 바꿀 때는 이 파일 하나만 고치면 모든 경로가 같이 바뀐다.

/** 한 번의 ATR 움직임이 먹어도 되는 증거금 비율(%) */
export const VOL_MARGIN_BUDGET_PCT = 60;
/** 청산은 최소 이만큼의 ATR 거리 밖에 있어야 한다 */
export const LIQ_BUFFER_ATR = 1.5;
/** 이 주문의 명목가는 보이는 깊이의 이 비율을 넘지 않는다 */
export const LIQUIDITY_SHARE = 0.10;
/** 이보다 넓은 스프레드에서는 아예 들어가지 않는다 (bps) */
export const MAX_SPREAD_BPS = 10;
/** 왕복 비용(수수료+스프레드)이 먹어도 되는 증거금 비율(%) */
export const COST_MARGIN_BUDGET_PCT = 5;

export type AdaptiveLeverageCode =
  | 'OK'
  /** 변동성을 못 읽었다 — 낮은 배율로 대신하지 않는다 */
  | 'VOLATILITY_UNKNOWN'
  | 'VOLATILITY_STALE'
  /** 호가 깊이를 못 읽었다 */
  | 'LIQUIDITY_UNKNOWN'
  | 'LIQUIDITY_STALE'
  /** 스프레드를 못 읽었거나 너무 넓다 */
  | 'SPREAD_UNKNOWN'
  | 'SPREAD_TOO_WIDE'
  /** 왕복 비용을 못 읽었다 */
  | 'COST_UNKNOWN'
  /** 유지증거금률을 못 읽었다 — 청산 거리를 계산할 수 없다 */
  | 'MAINTENANCE_UNKNOWN'
  /** 거래소 상한을 못 읽었다 */
  | 'EXCHANGE_CAP_UNKNOWN'
  | 'EXCHANGE_CAP_STALE'
  /** 배정 증거금을 못 읽었다 — 유동성·비용 상한을 만들 수 없다 */
  | 'MARGIN_UNKNOWN'
  /** 계산된 상한이 최소 배율보다 낮다 — 올려서 맞추지 않는다 */
  | 'BELOW_MIN_LEVERAGE'
  /**
   * 위험 데이터의 시각이 **미래**다.
   *
   * 신선도를 `지금 − 관측시각 > 한도`로만 보면 미래 시각은 전부
   * 통과한다 — 차가 음수라 어떤 한도보다도 작다. 피드가 시각을 잘못
   * 찍거나 서버 시계가 틀어지면 **가장 못 믿을 값이 가장 신선한 값**이
   * 된다. 작은 오차는 받아들이고 그 너머는 막는다.
   */
  | 'TIMESTAMP_IN_FUTURE';

/** 어느 축이 상한을 몇으로 잡았는가. 사후에 "왜 이 배율이었나"를 답한다 */
export interface AdaptiveLeverageCaps {
  volatility: number;
  liquidation: number;
  liquidity: number;
  cost: number;
  exchange: number;
  /** 정책 자체의 상한 (75, 또는 백테스트 전이면 50) */
  policy: number;
}

export interface AdaptiveLeverageInput {
  nowMs: number;
  /** 완성된 일봉에서 만든 ATR의 가격 대비 비율(%) */
  atrPct: number | null;
  /** 그 ATR이 언제 기준인가 */
  volatilityAsOfMs: number | null;
  /** 양쪽 호가의 합산 깊이(USD) */
  depthUsd: number | null;
  /** 호가(깊이·스프레드)를 읽은 시각 */
  bookAsOfMs: number | null;
  /** 지금 스프레드(bps) */
  spreadBps: number | null;
  /** 왕복 수수료(bps). 스프레드는 여기 포함하지 않는다 — 따로 더한다 */
  roundTripFeeBps: number | null;
  /** 이 주문에 배정된 증거금(USD) */
  allocatedMarginUsd: number | null;
  /** 거래소 유지증거금률 (0.004 = 0.4%) */
  maintenanceMarginRate: number | null;
  /** 그 종목·그 규모에서 거래소가 허용하는 최대 배율 */
  exchangeMaxLeverage: number | null;
  exchangeMaxAsOfMs: number | null;
  /** 백테스트로 75배 자동 선택이 확정됐는가. **기본 거짓** */
  highRiskApproved?: boolean;
}

export interface AdaptiveLeverageVerdict {
  ok: boolean;
  code: AdaptiveLeverageCode;
  /** 막혔으면 null이다. **0을 적지 않는다** */
  leverage: number | null;
  /** 사다리를 고르기 전의 연속 상한 (설명용) */
  cap: number | null;
  caps: AdaptiveLeverageCaps | null;
  /** 상한을 가장 낮게 잡은 축 */
  binding: keyof AdaptiveLeverageCaps | null;
  message: string;
}

/**
 * 숫자로 **읽힌** 값, 아니면 null.
 *
 * `Number(null)`은 0이다. `Number('')`도 0이고 `Number(true)`는 1이다.
 * 그래서 `Number.isFinite(Number(x))`로 거르면 **못 읽은 값이 전부
 * 0으로 통과한다** — 이 저장소가 반복해서 잡아 온 바로 그 형태다.
 * 여기서는 0이 뜻을 가진다(수수료 0, 유지증거금률 0, 스프레드 0)므로
 * "없음"과 "0"을 반드시 갈라야 한다.
 *
 * 이 함수의 첫 판은 실제로 이 덫에 걸렸고, 같은 파일의 시험이 잡았다.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const pos = (v: unknown): boolean => { const n = num(v); return n != null && n > 0; };
const nonNeg = (v: unknown): boolean => { const n = num(v); return n != null && n >= 0; };

/**
 * 이 시각이 **지금보다 미래**인가. 받아들일 수 있으면 null.
 *
 * 허용 폭은 시계 오차 정본이 정한다 — 이 파일은 묻기만 한다.
 */
function futureBlock(label: string, at: number, now: number): AdaptiveLeverageVerdict | null {
  if (!(at > now)) return null;
  const v = checkClockSkew(at, now);
  if (!v.blocks) return null;
  return block('TIMESTAMP_IN_FUTURE',
    `${label} 시각이 지금보다 ${at - now}ms 미래입니다 — ${v.detail}`);
}

function block(code: AdaptiveLeverageCode, message: string): AdaptiveLeverageVerdict {
  return { ok: false, code, leverage: null, cap: null, caps: null, binding: null, message };
}

/**
 * 이 배율을 **이 정책이** 쓸 수 있는가.
 *
 * 전용 100배 계약과 같은 숫자 공간을 쓰기 때문에, "100이 들어올 수
 * 없다"를 값으로만 두면 어딘가에서 100이 흘러든다. 경로마다 다시
 * 적지 않도록 여기 한 번 둔다.
 */
export function adaptiveLeverageAllows(leverage: unknown): boolean {
  const n = Number(leverage);
  if (!Number.isFinite(n)) return false;
  if (n >= FORBIDDEN_LEVERAGE) return false;
  if (n < ADAPTIVE_MIN_LEVERAGE || n > ADAPTIVE_MAX_LEVERAGE) return false;
  return ADAPTIVE_LADDER.includes(n);
}

/** 상한 이하의 가장 높은 칸. 없으면 null */
export function rungAtOrBelow(cap: number): number | null {
  let best: number | null = null;
  for (const rung of ADAPTIVE_LADDER) {
    if (rung <= cap) best = rung;
  }
  return best;
}

/**
 * 이 회차의 배율.
 *
 * 순서가 정책의 일부다.
 *
 *   ① 신선도 — 없거나 오래된 입력이 하나라도 있으면 **차단**
 *   ② 축마다 상한 하나
 *   ③ 상한들의 최솟값
 *   ④ 그 이하의 가장 높은 사다리 칸
 *   ⑤ 100 이상은 어떤 경로로도 나오지 않는다
 */
export function planAdaptiveLeverage(i: AdaptiveLeverageInput): AdaptiveLeverageVerdict {
  const now = num(i?.nowMs) as number;
  if (now == null || !Number.isFinite(now)) {
    return block('VOLATILITY_UNKNOWN', '현재 시각을 모르면 신선도를 판단할 수 없습니다');
  }

  // ── ① 신선도 ──
  if (!pos(i.atrPct)) {
    return block('VOLATILITY_UNKNOWN',
      '변동성(ATR)을 읽지 못했습니다 — 낮은 배율로 대신하지 않고 진입하지 않습니다');
  }
  const volAt = num(i.volatilityAsOfMs);
  if (volAt == null) {
    return block('VOLATILITY_UNKNOWN', '변동성이 언제 기준인지 모릅니다');
  }
  { const f = futureBlock('변동성', volAt, now); if (f) return f; }
  if (now - volAt > MAX_VOLATILITY_AGE_MS) {
    return block('VOLATILITY_STALE',
      `변동성이 ${Math.round((now - volAt) / 3_600_000)}시간 전 값입니다`
      + ' — 오래된 위험 값으로 높은 배율을 허용하지 않습니다');
  }

  if (!pos(i.depthUsd)) {
    return block('LIQUIDITY_UNKNOWN', '호가 깊이를 읽지 못했습니다');
  }
  const bookAt = num(i.bookAsOfMs);
  if (bookAt == null) {
    return block('LIQUIDITY_UNKNOWN', '호가를 언제 읽었는지 모릅니다');
  }
  { const f = futureBlock('호가', bookAt, now); if (f) return f; }
  if (now - bookAt > MAX_BOOK_AGE_MS) {
    return block('LIQUIDITY_STALE',
      `호가가 ${Math.round((now - bookAt) / 1000)}초 전 값입니다 — 지금 호가가 아닙니다`);
  }

  if (!nonNeg(i.spreadBps)) {
    return block('SPREAD_UNKNOWN', '스프레드를 읽지 못했습니다');
  }
  if (Number(i.spreadBps) > MAX_SPREAD_BPS) {
    return block('SPREAD_TOO_WIDE',
      `스프레드가 ${i.spreadBps}bps입니다 (한도 ${MAX_SPREAD_BPS}bps) — 배율을 낮춰도 건너야 하는 간격은 그대로입니다`);
  }

  if (!nonNeg(i.roundTripFeeBps)) {
    return block('COST_UNKNOWN', '왕복 수수료를 읽지 못했습니다 — 비용 상한을 만들 수 없습니다');
  }
  if (!nonNeg(i.maintenanceMarginRate)) {
    return block('MAINTENANCE_UNKNOWN', '유지증거금률을 읽지 못했습니다 — 청산 거리를 계산할 수 없습니다');
  }
  if (!pos(i.allocatedMarginUsd)) {
    return block('MARGIN_UNKNOWN', '배정 증거금을 읽지 못했습니다 — 유동성·비용 상한을 만들 수 없습니다');
  }
  if (!pos(i.exchangeMaxLeverage)) {
    return block('EXCHANGE_CAP_UNKNOWN',
      '거래소가 허용하는 배율 상한을 읽지 못했습니다 — 넘겨짚고 주문하지 않습니다');
  }
  const capAt = num(i.exchangeMaxAsOfMs);
  if (capAt == null) {
    return block('EXCHANGE_CAP_UNKNOWN', '거래소 상한을 언제 읽었는지 모릅니다');
  }
  { const f = futureBlock('거래소 상한', capAt, now); if (f) return f; }
  if (now - capAt > MAX_EXCHANGE_CAP_AGE_MS) {
    return block('EXCHANGE_CAP_STALE', '거래소 배율 상한이 하루 넘게 지난 값입니다');
  }

  // ── ② 축마다 상한 하나 ──
  const atr = Number(i.atrPct);
  const mmr = Number(i.maintenanceMarginRate);
  const margin = Number(i.allocatedMarginUsd);
  const spread = Number(i.spreadBps);

  // 변동성: 배율 L에서 ATR 한 번의 움직임은 증거금의 L × atr(%)를 먹는다.
  const volatilityCap = VOL_MARGIN_BUDGET_PCT / atr;

  // 청산 여유: 격리에서 청산까지의 거리는 대략 (1/L − 유지증거금률)이다.
  // 그 거리가 LIQ_BUFFER_ATR 번의 ATR보다 멀어야 한다.
  //   1/L − mmr ≥ buffer × atr/100
  const liqDenom = LIQ_BUFFER_ATR * (atr / 100) + mmr;
  const liquidationCap = liqDenom > 0 ? 1 / liqDenom : 0;

  // 유동성: 명목가(증거금 × L)가 보이는 깊이의 LIQUIDITY_SHARE를 넘지 않는다.
  const liquidityCap = (Number(i.depthUsd) * LIQUIDITY_SHARE) / margin;

  // 거래 비용: 왕복 수수료 + 스프레드를 명목가에 물고, 그것이 증거금의
  // COST_MARGIN_BUDGET_PCT를 넘지 않아야 한다.
  //   L × costBps / 100 ≤ budget(%)
  const costBps = Number(i.roundTripFeeBps) + spread;
  const costCap = costBps > 0 ? (COST_MARGIN_BUDGET_PCT * 100) / costBps : Infinity;

  const exchangeCap = Number(i.exchangeMaxLeverage);

  // 정책 상한: 75는 백테스트 확정 전까지 자동으로 고르지 않는다.
  const policyCap = i.highRiskApproved === true
    ? ADAPTIVE_MAX_LEVERAGE : ADAPTIVE_DEFAULT_TOP_RUNG;

  const caps: AdaptiveLeverageCaps = {
    volatility: volatilityCap,
    liquidation: liquidationCap,
    liquidity: liquidityCap,
    cost: costCap,
    exchange: exchangeCap,
    policy: policyCap,
  };

  // ── ③ 최솟값과 그것을 잡은 축 ──
  let binding: keyof AdaptiveLeverageCaps = 'policy';
  let cap = Infinity;
  for (const key of Object.keys(caps) as (keyof AdaptiveLeverageCaps)[]) {
    const v = caps[key];
    if (v < cap) { cap = v; binding = key; }
  }

  // ── ④ 사다리 ──
  const rung = rungAtOrBelow(cap);
  if (rung == null) {
    return {
      ok: false, code: 'BELOW_MIN_LEVERAGE', leverage: null, cap, caps, binding,
      message: `계산된 상한이 ${cap.toFixed(1)}배입니다 — 최소 ${ADAPTIVE_MIN_LEVERAGE}배에 못 미쳐`
        + ` 진입하지 않습니다 (가장 낮게 잡은 축: ${binding})`,
    };
  }

  // ── ⑤ 100은 어떤 경로로도 나오지 않는다 ──
  //
  // 사다리의 최댓값이 75라 구조적으로 불가능하지만, 사다리를 고치는
  // 사람이 이 줄을 같이 보게 둔다. 여기서 터지면 사다리가 잘못된 것이다.
  if (!adaptiveLeverageAllows(rung)) {
    return block('BELOW_MIN_LEVERAGE',
      `사다리가 이 정책이 허용하지 않는 값(${rung})을 냈습니다 — 주문하지 않습니다`);
  }

  return {
    ok: true, code: 'OK', leverage: rung, cap, caps, binding,
    message: `${rung}배 — 상한 ${cap.toFixed(1)}배를 ${binding}가 잡았습니다`
      + ` (ATR ${atr}% · 스프레드 ${spread}bps · 비용 ${costBps}bps)`,
  };
}
