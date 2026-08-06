// src/lib/strategies/profilePreset.ts
//
// **기본값이 연구용이었다.**
//
// 무엇이 문제였나
// ───────────────
// 프로필 표에 적힌 숫자가 곧 화면의 기본값이었다. 10슬롯은 1회 위험
// 10%, 하루 손실 한도 30%, 배율 상한 100배다. 이 숫자들은 "이렇게
// 하면 어떻게 되는지 보자"는 **연구용 설정**이지 운용 설정이 아니다.
//
// 그런데 화면은 그 둘을 구분하지 않았다. 그래서 시뮬을 처음 여는
// 사람이 보는 것은 언제나 극단값이고, 거기서 나온 그림 — 25억이든
// 파산이든 — 을 "이 전략의 성격"으로 읽게 된다. 둘 다 아니다.
// 그건 그 파라미터의 성격이다.
//
// 무엇을 하는가
// ─────────────
// 프로필 표는 **그대로 둔다.** 대신 그 위에 얇은 층을 하나 얹어서
// 두 벌의 값을 준다:
//
//   · 안정화(STABILIZE) — 기본값. 실제로 굴려 볼 만한 범위
//   · 연구용(RESEARCH)  — 지금까지의 값. 극단에서 무슨 일이 나는지 보는 용도
//
// 그리고 **권장 범위를 같이 들고 다닌다.** "배율 5배"만 적으면 그게
// 왜 5인지 알 수 없지만, "권장 5~10배 · 지금 5배"라고 적으면 사용자가
// 어디를 만지고 있는지 안다.
//
// 왜 프로필 표를 직접 안 고치나
// ─────────────────────────────
// 고치면 지금까지 쌓인 회차 기록이 **다른 설정에서 나온 숫자와 한 표에
// 섞인다.** 어제의 10% 위험 결과와 오늘의 1% 위험 결과가 같은 '전체
// 순손익'에 더해지면, 그 합계는 아무 뜻도 없다. 프리셋을 따로 두면
// 어느 설정에서 나온 기록인지가 회차마다 남는다.

import type { StrategyProfile, StrategyType } from './profiles';

export type RiskPresetId = 'STABILIZE' | 'RESEARCH';

/**
 * **기본은 안정화다.**
 *
 * 여기를 연구용으로 두면, 아무것도 안 고른 사람이 곧 극단값으로
 * 돌리는 사람이 된다. 그리고 그 결과를 전략의 성격으로 읽는다.
 */
export const DEFAULT_PRESET: RiskPresetId = 'STABILIZE';

export const PRESET_INFO: Record<RiskPresetId, { label: string; desc: string }> = {
  STABILIZE: {
    label: '안정화',
    desc: '실제로 굴려 볼 만한 범위. 배율·1회 위험·하루 한도를 좁혔습니다',
  },
  RESEARCH: {
    label: '연구용',
    desc: '극단에서 무슨 일이 나는지 보는 값입니다 — 운용 설정이 아닙니다',
  },
};

/** 권장 범위. [낮은 쪽, 높은 쪽] */
export type Band = [number, number];

export interface PresetOverride {
  leverage?: number;
  maxLeverage?: number;
  riskPercentPerTrade?: number;
  dailyLossLimitPct?: number;
  /** 밴드는 화면에 "권장 5~10배 · 지금 5배"로 적기 위한 것이다 */
  leverageBand?: Band;
  riskBand?: Band;
  dailyLossBand?: Band;
  /**
   * 낙폭이 이만큼이면 그 회차를 **중단한다.**
   *
   * 하루 손실 한도는 '오늘'만 막는다. 며칠에 걸쳐 천천히 무너지는 것은
   * 하루 한도로 안 잡힌다 — 그건 다른 축이라 따로 있어야 한다.
   * null이면 이 프리셋에서는 낙폭으로 중단하지 않는다.
   */
  mddStopPct?: number | null;
  mddStopBand?: Band;
  /**
   * 기대값이 0 이하인데 실행하려 하면 경고한다.
   *
   * 막지는 않는다 — 음수 기대값이 어떻게 무너지는지 보는 것도 시뮬의
   * 용도다. 다만 **모르고 지나가면 안 된다.**
   */
  warnOnNegativeExpectancy?: boolean;
}

/**
 * 프리셋 표.
 *
 * RESEARCH는 비어 있다 — **프로필 표의 값이 곧 연구용 값**이기 때문이다.
 * 여기에 같은 숫자를 한 번 더 적으면 두 곳이 갈리고, 갈리면 한쪽만
 * 고쳐진다.
 */
export const PRESET_TABLE: Record<RiskPresetId, Partial<Record<StrategyType, PresetOverride>>> = {
  STABILIZE: {
    SCALP_HIGH_LEV: {
      // 배율 25~50배 → 5~10배. 손절 0.3%짜리에 50배를 쓰면 한 번의
      // 노이즈가 증거금의 15%다.
      leverage: 5, maxLeverage: 10, leverageBand: [5, 10],
      riskPercentPerTrade: 0.25, riskBand: [0.25, 0.5],
      dailyLossLimitPct: 2, dailyLossBand: [2, 3],
      mddStopPct: null,
      warnOnNegativeExpectancy: true,
    },
    SWING_LOW_LEV: {
      leverage: 2, maxLeverage: 5, leverageBand: [2, 5],
      // 1회 위험 2% → 0.5%. 손절이 6%로 넓어서 2%면 명목가가 계좌의
      // 3분의 1이다.
      riskPercentPerTrade: 0.5, riskBand: [0.5, 1],
      dailyLossLimitPct: 5, dailyLossBand: [4, 8],
      // 스윙은 며칠~몇 주를 들고 있어서 하루 한도로는 안 잡힌다.
      mddStopPct: 15, mddStopBand: [15, 20],
      warnOnNegativeExpectancy: true,
    },
    DAILY_HIGH_LEV: {
      // 상한 100배 → 20배. 100배는 손절이 0.26% 안쪽이어야 닿는 값이라
      // 사실상 선택되지 않으면서, 화면에는 '100배 가능'으로 남아 있었다.
      leverage: 10, maxLeverage: 20, leverageBand: [10, 20],
      // 슬롯 한 칸 = 자산의 10% → 1%. 열 번 지면 계좌가 없어지는 설정을
      // 기본으로 두면 안 된다.
      riskPercentPerTrade: 1, riskBand: [1, 2],
      dailyLossLimitPct: 5, dailyLossBand: [5, 10],
      mddStopPct: null,
      warnOnNegativeExpectancy: true,
    },
  },
  RESEARCH: {},
};

export function presetOf(raw: any): RiskPresetId {
  const s = String(raw ?? '').trim().toUpperCase();
  // **모르는 값은 기본값이다.** 여기서 연구용으로 떨어지면 오타 하나가
  // 100배가 된다.
  return s === 'RESEARCH' ? 'RESEARCH' : DEFAULT_PRESET;
}

export function overrideOf(id: StrategyType, preset: RiskPresetId): PresetOverride {
  return PRESET_TABLE[presetOf(preset)]?.[id] ?? {};
}

/**
 * 프리셋을 얹은 프로필.
 *
 * 원본을 고치지 않는다 — 복사본을 돌려준다. 원본을 고치면 다른 프로필의
 * 화면이 같이 바뀌고, 그건 아무도 의도하지 않은 일이다.
 */
export function applyPreset(p: StrategyProfile, preset: RiskPresetId): StrategyProfile {
  const o = overrideOf(p.id, preset);
  const out: StrategyProfile = { ...p };
  if (Number.isFinite(o.leverage as number)) out.leverage = o.leverage as number;
  if (Number.isFinite(o.maxLeverage as number)) out.maxLeverage = o.maxLeverage as number;
  if (Number.isFinite(o.riskPercentPerTrade as number)) out.riskPercentPerTrade = o.riskPercentPerTrade as number;
  if (Number.isFinite(o.dailyLossLimitPct as number)) out.dailyLossLimitPct = o.dailyLossLimitPct as number;
  // 기본 배율이 상한보다 커지면 규칙 엔진이 조용히 clamp해서, 화면의
  // 숫자와 실제로 쓰인 숫자가 달라진다.
  if (out.leverage > out.maxLeverage) out.leverage = out.maxLeverage;
  return out;
}

/** 이 프리셋에서 낙폭 중단선. 없으면 null. */
export function mddStopPctOf(id: StrategyType, preset: RiskPresetId): number | null {
  const v = overrideOf(id, preset).mddStopPct;
  return Number.isFinite(v as number) && (v as number) > 0 ? (v as number) : null;
}

/** 기대값이 음수일 때 경고를 띄우는 프리셋인가 */
export function warnsOnNegativeExpectancy(id: StrategyType, preset: RiskPresetId): boolean {
  return overrideOf(id, preset).warnOnNegativeExpectancy === true;
}

/** "권장 5~10배 · 지금 5배" — 밴드가 없으면 지금 값만 */
export function bandText(band: Band | undefined, now: number, unit: string): string {
  if (!band || band.length !== 2) return `${now}${unit}`;
  return `권장 ${band[0]}~${band[1]}${unit} · 지금 ${now}${unit}`;
}

/** 지금 값이 권장 범위 안인가. 밴드가 없으면 언제나 true(판정 안 함) */
export function withinBand(band: Band | undefined, now: number): boolean {
  if (!band || band.length !== 2) return true;
  return now >= band[0] && now <= band[1];
}
