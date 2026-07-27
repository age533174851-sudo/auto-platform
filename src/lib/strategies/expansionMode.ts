// src/lib/strategies/expansionMode.ts
// Expansion Mode — 고배율을 "평소"가 아니라 "대변동성이 예상되는 날"에만 허용한다.
//
// 왜 필요한가:
//   100배는 청산거리가 0.5%다. 평범한 날에도 0.5%는 수시로 흔들린다.
//   그래서 매일 100배를 쓰면 최종 방향을 맞혀도 경로에서 청산된다.
//
//   반대로 큰 방향성 움직임(3~5%+)이 나오는 날은 1년에 몇 번뿐이고,
//   그런 날에는 MAE도 작은 경우가 있다(한 방향으로 쭉 가는 날).
//   그런 날만 골라 고배율을 허용하면 fat-tail 수익을 노릴 수 있다.
//
// 원칙:
//   1. 기본은 일반 모드. Expansion은 예외다.
//   2. Expansion 후보여도 예상 MAE가 청산거리를 넘으면 배율을 낮춘다.
//   3. 이 모듈은 배율 "상한"만 정한다. 실제 배율은 Risk Manager가 손절 거리로 역산한다.

import { computeAtrBaseline, median } from './volatilityBaseline';

export type TradeMode = 'NO_TRADE' | 'NORMAL' | 'EXPANSION';

export interface ExpansionInput {
  // 변동성 압축 → 확장 신호
  currentAtrPct: number;
  baselineAtrPct: number;
  atrPercentile?: number;        // 최근 N일 중 현재 ATR의 백분위 (낮을수록 압축)

  // 볼린저 밴드 폭 (압축 감지)
  bbWidthPct?: number;
  bbWidthBaseline?: number;

  // 거래량
  volumeRatio?: number;          // 현재 / 평균

  // 파생시장
  fundingRate?: number;
  oiChangePct?: number;

  // 예정된 촉매
  hasScheduledCatalyst?: boolean;  // 고영향 지표가 "있지만 이미 지난" 경우 등

  // 과거 MAE 통계 (같은 조건에서의)
  historicalMaeP90?: number;     // 이 조건에서 MAE 90분위
}

export interface ExpansionResult {
  mode: TradeMode;
  maxLeverageAllowed: number;
  expansionScore: number;        // 0~100
  signals: { name: string; hit: boolean; detail: string }[];
  maeConstraint: {
    expectedMaeP90: number | null;
    liquidationDistAt: Record<number, number>;
    cappedBy: 'mae' | 'score' | 'none';
  };
  reason: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const liqDist = (lev: number, mmr = 0.005) => (1 / lev - mmr) * 100;

// Expansion 판정 임계값
const EXPANSION_SCORE_THRESHOLD = 65;
const MAE_SAFETY_FACTOR = 1.5;   // 청산거리는 예상 MAE의 1.5배 이상이어야

export function evaluateExpansion(
  input: ExpansionInput,
  opts: { userMaxLeverage?: number; normalMaxLeverage?: number } = {}
): ExpansionResult {
  const userMax = opts.userMaxLeverage ?? 100;
  const normalMax = opts.normalMaxLeverage ?? 10;

  const signals: ExpansionResult['signals'] = [];
  let score = 0;

  // ① 변동성 압축 — 압축 후 확장이 큰 움직임의 전조
  const atrRatio = input.baselineAtrPct > 0 ? input.currentAtrPct / input.baselineAtrPct : 1;
  const compressed = atrRatio < 0.75;
  signals.push({
    name: '변동성 압축', hit: compressed,
    detail: `현재 ATR이 기준선의 ${(atrRatio * 100).toFixed(0)}%${compressed ? ' — 압축 상태' : ''}`,
  });
  if (compressed) score += 25;

  // ② 볼린저 밴드 스퀴즈
  if (input.bbWidthPct != null && input.bbWidthBaseline != null && input.bbWidthBaseline > 0) {
    const bbRatio = input.bbWidthPct / input.bbWidthBaseline;
    const squeeze = bbRatio < 0.7;
    signals.push({
      name: '밴드 스퀴즈', hit: squeeze,
      detail: `밴드폭이 평소의 ${(bbRatio * 100).toFixed(0)}%${squeeze ? ' — 스퀴즈' : ''}`,
    });
    if (squeeze) score += 20;
  }

  // ③ 거래량 증가 — 방향성 자금 유입
  if (input.volumeRatio != null) {
    const surge = input.volumeRatio >= 1.5;
    signals.push({
      name: '거래량 급증', hit: surge,
      detail: `평균의 ${(input.volumeRatio * 100).toFixed(0)}%${surge ? ' — 자금 유입' : ''}`,
    });
    if (surge) score += 20;
  }

  // ④ OI 증가 — 신규 포지션 유입
  if (input.oiChangePct != null) {
    const oiUp = input.oiChangePct >= 3;
    signals.push({
      name: 'OI 증가', hit: oiUp,
      detail: `OI ${input.oiChangePct >= 0 ? '+' : ''}${input.oiChangePct.toFixed(1)}%${oiUp ? ' — 신규 진입' : ''}`,
    });
    if (oiUp) score += 15;
  }

  // ⑤ 펀딩 극단 — 스퀴즈 연료
  if (input.fundingRate != null) {
    const extreme = Math.abs(input.fundingRate) >= 0.05;
    signals.push({
      name: '펀딩 쏠림', hit: extreme,
      detail: `펀딩 ${input.fundingRate >= 0 ? '+' : ''}${input.fundingRate.toFixed(4)}%${extreme ? ' — 스퀴즈 연료' : ''}`,
    });
    if (extreme) score += 20;
  }

  score = clamp(score, 0, 100);

  // ── MAE 제약: Expansion이어도 예상 MAE가 크면 배율을 낮춘다 ──
  const liqTable: Record<number, number> = {};
  for (const lev of [100, 75, 50, 25, 10, 5]) liqTable[lev] = liqDist(lev);

  let maeCapLeverage = userMax;
  let cappedBy: 'mae' | 'score' | 'none' = 'none';

  if (input.historicalMaeP90 != null && input.historicalMaeP90 > 0) {
    // 청산거리 >= MAE_P90 × 안전계수 를 만족하는 최대 배율
    const requiredLiq = input.historicalMaeP90 * MAE_SAFETY_FACTOR;
    maeCapLeverage = Math.max(1, Math.floor(1 / (requiredLiq / 100 + 0.005)));
    if (maeCapLeverage < userMax) cappedBy = 'mae';
  }

  // ── 최종 판정 ──
  let mode: TradeMode;
  let maxLeverageAllowed: number;
  let reason: string;

  if (score >= EXPANSION_SCORE_THRESHOLD) {
    mode = 'EXPANSION';
    maxLeverageAllowed = Math.min(userMax, maeCapLeverage);
    if (maxLeverageAllowed < userMax && cappedBy === 'mae') {
      reason = `대변동성 조건 충족(${score}점)이지만 과거 MAE 90분위 ${input.historicalMaeP90!.toFixed(2)}%를 고려해 ${maxLeverageAllowed}배로 제한합니다`;
    } else {
      reason = `대변동성 조건 충족(${score}점) — 최대 ${maxLeverageAllowed}배까지 허용`;
    }
  } else {
    mode = 'NORMAL';
    maxLeverageAllowed = Math.min(normalMax, maeCapLeverage);
    cappedBy = cappedBy === 'mae' ? 'mae' : 'score';
    reason = `일반 국면(${score}점 < ${EXPANSION_SCORE_THRESHOLD}점) — 최대 ${maxLeverageAllowed}배`;
  }

  return {
    mode, maxLeverageAllowed, expansionScore: score, signals,
    maeConstraint: {
      expectedMaeP90: input.historicalMaeP90 ?? null,
      liquidationDistAt: liqTable,
      cappedBy,
    },
    reason,
  };
}

/** 볼린저 밴드 폭 계산 (스퀴즈 감지용) */
export function bollingerWidthPct(closes: number[], period = 20, stdMult = 2): number | null {
  if (closes.length < period) return null;
  const w = closes.slice(-period);
  const mean = w.reduce((a, b) => a + b, 0) / period;
  const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return mean > 0 ? ((sd * stdMult * 2) / mean) * 100 : null;
}

/** 밴드폭 시계열 — 스퀴즈 판정의 기준선을 만들기 위해 필요하다 */
export function bollingerWidthSeries(closes: number[], period = 20, stdMult = 2): number[] {
  const out: number[] = [];
  for (let i = period; i <= closes.length; i++) {
    const w = bollingerWidthPct(closes.slice(0, i), period, stdMult);
    if (w != null) out.push(w);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 주문 경로용 게이트 빌더
// ─────────────────────────────────────────────────────────────
// evaluateExpansion()은 순수 계산 함수라 입력을 직접 만들어 줘야 한다.
// 이 함수가 그 조립을 맡아, 주문 경로 여러 곳이 같은 방식으로 평가하게 한다.
//
// 데이터가 모자라면 result를 null로 돌려준다. Risk Manager는 expansion이
// 없으면 일반 모드 상한을 적용하므로(fail-closed), 판단 근거가 없는 주문에
// 고배율이 허용되는 일은 생기지 않는다.

export interface ExpansionMarketData {
  /** ATR을 이미 계산해 뒀다면 그대로 넘긴다 (중복 계산 회피) */
  currentAtrPct?: number;
  baselineAtrPct?: number;
  /** 위 두 값이 없을 때 여기서 계산한다 */
  dailyHighs?: number[];
  dailyLows?: number[];
  dailyCloses?: number[];

  currentVolume?: number;
  avgVolume?: number;
  fundingRate?: number;
  oiChangePct?: number;
  historicalMaeP90?: number;
}

export interface ExpansionGateOutcome {
  /** null이면 평가 불가 — 호출자는 그대로 넘기고 Risk Manager가 fail-closed 처리한다 */
  result: ExpansionResult | null;
  /** result가 null인 이유 (로그·응답용) */
  skipReason?: string;
}

export function buildExpansionGate(
  md: ExpansionMarketData,
  opts: { userMaxLeverage?: number; normalMaxLeverage?: number } = {},
): ExpansionGateOutcome {
  // ① ATR — evaluateExpansion의 필수 입력
  let currentAtrPct = md.currentAtrPct;
  let baselineAtrPct = md.baselineAtrPct;

  if (!(currentAtrPct && baselineAtrPct && baselineAtrPct > 0)) {
    const { dailyHighs, dailyLows, dailyCloses } = md;
    if (!dailyHighs?.length || !dailyLows?.length || !dailyCloses?.length) {
      return { result: null, skipReason: '일봉 데이터가 없어 변동성 기준선을 만들 수 없습니다' };
    }
    // 순환 import를 피하려고 지연 로드하지 않는다 — volatilityBaseline은
    // expansionMode를 import하지 않으므로 정적 import로 안전하다.
    const vol = computeAtrBaseline(dailyHighs, dailyLows, dailyCloses, { lookbackDays: 40 });
    if (vol.method === 'insufficient' || vol.baselineAtrPct <= 0) {
      return { result: null, skipReason: `변동성 기준선 표본 부족 — ${vol.note}` };
    }
    currentAtrPct = vol.currentAtrPct;
    baselineAtrPct = vol.baselineAtrPct;
  }

  // ② 선택 입력 — 없으면 해당 신호는 점수에서 빠진다
  const input: ExpansionInput = { currentAtrPct, baselineAtrPct };

  if (md.dailyCloses && md.dailyCloses.length >= 40) {
    const series = bollingerWidthSeries(md.dailyCloses);
    if (series.length >= 20) {
      input.bbWidthPct = series[series.length - 1];
      // 현재 값은 기준선에서 제외한다 — 자기 자신이 기준이면 비율이 항상 1이 된다
      input.bbWidthBaseline = median(series.slice(0, -1));
    }
  }

  if (md.currentVolume != null && md.avgVolume != null && md.avgVolume > 0) {
    input.volumeRatio = md.currentVolume / md.avgVolume;
  }
  if (md.fundingRate != null) input.fundingRate = md.fundingRate;
  if (md.oiChangePct != null) input.oiChangePct = md.oiChangePct;
  if (md.historicalMaeP90 != null) input.historicalMaeP90 = md.historicalMaeP90;

  return { result: evaluateExpansion(input, opts) };
}
