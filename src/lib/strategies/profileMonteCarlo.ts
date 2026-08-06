// src/lib/strategies/profileMonteCarlo.ts
//
// **엔진은 있는데 화면에 안 붙어 있었다.**
//
// monteCarlo.ts는 같은 설정을 수백 경로로 돌려 분포를 낸다. 그런데
// 전략 프로필 화면은 여전히 **한 번 돌린 경로 하나**의 끝 잔고를
// 성적표로 그리고 있었다. 엔진이 있다는 것과 그 엔진이 도는 것은
// 다른 이야기다 — 이 저장소에서 가장 자주 나는 고장이 이것이다.
//
// 이 파일이 하는 일은 하나뿐이다: **프로필의 숫자를 몬테카를로 입력으로
// 번역한다.** 화면 안에서 이 번역을 하면 테스트가 붙지 않고, 붙지 않으면
// "화면 값이 엔진 결과와 같은가"를 아무도 확인할 수 없다.

import type { StrategyProfile } from './profiles';
import { simSeedOf } from './profiles';
import type { RiskPresetId } from './profilePreset';
import { presetOf } from './profilePreset';
import { simTargetOf } from './profileRisk';
import { assumedWinRate, roundTripFeePct } from './simModel';
import type { MonteCarloInput, MonteCarloResult } from './monteCarlo';
import { runMonteCarlo } from './monteCarlo';

/**
 * 경로 수 기본값.
 *
 * 하나면 그건 분포가 아니라 일화다. 500이면 5% 분위가 25개 표본 위에
 * 서므로 화면에 적을 만하다.
 */
export const DEFAULT_PATHS = 600;
export const MIN_PATHS = 500;
export const MAX_PATHS = 1000;

/** 경로 하나당 거래 수 */
export const DEFAULT_TRADES = 1000;

/**
 * 시드.
 *
 * **벽시계를 쓰지 않는다.** 쓰면 같은 설정에서 매번 다른 숫자가 나오고,
 * 사용자는 "아까 그 결과"를 다시 볼 수 없다. 그리고 테스트도 못 붙는다.
 * 설정이 같으면 결과가 같아야 한다.
 */
export function seedFor(p: StrategyProfile, edgePp: number, preset: RiskPresetId): number {
  const s = `${p.id}|${presetOf(preset)}|${Number(edgePp) || 0}|${p.takeProfitPct}|${p.stopLossPct}|${p.riskPercentPerTrade}|${p.maxLeverage}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export interface ProfileMcOptions {
  edgePp?: number;
  preset?: RiskPresetId;
  /** 이 회차의 시작 잔고. 없으면 프로필 시드 */
  startEquity?: number;
  paths?: number;
  trades?: number;
  /** 목표를 무시하고 싶을 때 (목표 없는 프로필과 같게 본다) */
  ignoreTarget?: boolean;
}

/**
 * 프로필 → 몬테카를로 입력.
 *
 * **여기서 쓰는 프로필은 프리셋이 이미 얹힌 것이어야 한다.** 원본
 * 프로필을 넣으면 화면에는 '안정화 5배'라고 적혀 있는데 분포는 50배로
 * 계산된다 — 화면과 계산이 갈리는 쪽이 조용히 틀리는 쪽이다.
 */
export function monteCarloInputOf(p: StrategyProfile, opts: ProfileMcOptions = {}): MonteCarloInput {
  const preset = presetOf(opts.preset);
  const edge = Number(opts.edgePp) || 0;
  const fee = roundTripFeePct(p);
  const start = Number.isFinite(opts.startEquity as number) && (opts.startEquity as number) > 0
    ? (opts.startEquity as number)
    : simSeedOf(p);
  const target = opts.ignoreTarget ? null : simTargetOf(p);

  return {
    trades: Math.max(1, Math.floor(Number(opts.trades) || DEFAULT_TRADES)),
    // 500~1,000 사이로 묶는다. 아래로 내려가면 분위수가 흔들리고, 위로
    // 올라가면 브라우저가 눈에 띄게 멎는다.
    paths: Math.min(MAX_PATHS, Math.max(MIN_PATHS, Math.floor(Number(opts.paths) || DEFAULT_PATHS))),
    startEquity: start,
    riskPerTradePct: p.riskPercentPerTrade,
    winRate: assumedWinRate(p, edge),
    // **수수료는 이기든 지든 나간다.** 이기는 쪽에서만 빼면 기대값이
    // 왕복 수수료의 절반만큼 부풀려진다.
    winNetPct: p.takeProfitPct - fee,
    lossNetPct: p.stopLossPct + fee,
    stopLossPct: p.stopLossPct,
    maxLeverage: p.maxLeverage,
    maxNotional: null,
    targetEquity: target,
    // 시드의 5%. profileRisk의 파산선(0.5%)보다 높지만, 그쪽은 '더는
    // 못 돈다'는 실행 한계이고 이쪽은 '사실상 회복 불가'라는 판정이다.
    ruinEquity: start * 0.05,
    seed: seedFor(p, edge, preset),
  };
}

export function runProfileMonteCarlo(p: StrategyProfile, opts: ProfileMcOptions = {}): MonteCarloResult {
  return runMonteCarlo(monteCarloInputOf(p, opts));
}
