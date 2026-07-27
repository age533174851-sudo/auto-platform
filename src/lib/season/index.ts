// ─────────────────────────────────────────────────────────────
// TRAIGO Season Strategy Engine
// Invest Mode (Mar–Sep) vs Trading Mode (Oct–Feb)
// ─────────────────────────────────────────────────────────────
import type { MarketCondition, VolatilityLevel, TrendStrength } from '../market';

export type SeasonMode = 'INVEST' | 'TRADING';

export interface SeasonConfig {
  mode:              SeasonMode;
  name:              string;
  description:       string;
  months:            number[];    // 1-12
  defaultLeverage:   number;
  maxLeverage:       number;
  holdingBars:       number;      // typical holding in 4h bars
  tradeFrequency:    'LOW' | 'MEDIUM' | 'HIGH';
  stopLossWidth:     number;      // percentage
  allowShort:        boolean;
  dcaEnabled:        boolean;
  spotAllocation:    number;      // 0-100%
  focus:             string[];
}

export const SEASON_CONFIGS: Record<SeasonMode, SeasonConfig> = {
  INVEST: {
    mode: 'INVEST',
    name: '인베스트 모드',
    description: '스윙·중장기 투자 중심 (3월~9월)',
    months: [3, 4, 5, 6, 7, 8, 9],
    defaultLeverage: 2,
    maxLeverage: 5,
    holdingBars: 60,      // ~10 days @ 4h
    tradeFrequency: 'LOW',
    stopLossWidth: 0.05,  // 5%
    allowShort: false,
    dcaEnabled: true,
    spotAllocation: 70,
    focus: ['추세 추종', 'DCA 매집', '스윙 트레이딩', '알트코인 시즌', '장기 홀딩'],
  },
  TRADING: {
    mode: 'TRADING',
    name: '트레이딩 모드',
    description: '단기·선물 거래 중심 (10월~2월)',
    months: [10, 11, 12, 1, 2],
    defaultLeverage: 5,
    maxLeverage: 15,
    holdingBars: 12,      // ~2 days @ 4h
    tradeFrequency: 'HIGH',
    stopLossWidth: 0.025, // 2.5%
    allowShort: true,
    dcaEnabled: false,
    spotAllocation: 30,
    focus: ['스캘핑', '선물 거래', '변동성 브레이크아웃', '청산맵 분석', '펀딩비 활용'],
  },
};

// ── Get current season mode ────────────────────────────────────
export function getCurrentSeasonMode(date = new Date()): SeasonMode {
  const month = date.getMonth() + 1; // 1-12
  return SEASON_CONFIGS.INVEST.months.includes(month) ? 'INVEST' : 'TRADING';
}

// ── Dynamic parameter adjustment based on market ──────────────
export interface AdjustedParams {
  leverage:         number;
  stopLossWidth:    number;
  takeProfitWidth:  number;
  holdingBars:      number;
  tradeFrequency:   string;
  allowShort:       boolean;
  dcaEnabled:       boolean;
  strategy:         string;
  riskMultiplier:   number;   // 0.5 = half risk, 1 = normal, 1.5 = higher
  rationale:        string[];
}

export function getAdjustedParams(
  season:     SeasonMode,
  condition:  MarketCondition,
  volatility: VolatilityLevel,
  trend:      TrendStrength,
): AdjustedParams {
  const base = SEASON_CONFIGS[season];
  const rationale: string[] = [`${base.name} 적용`];
  let lev       = base.defaultLeverage;
  let slWidth   = base.stopLossWidth;
  let tpWidth   = slWidth * 2;
  let holding   = base.holdingBars;
  let allowShort = base.allowShort;
  let dca       = base.dcaEnabled;
  let riskMult  = 1.0;
  let strategy  = '추세 추종';

  // ── Market condition adjustments ─────────────────────────────
  switch (condition) {
    case 'STRONG_BULLISH':
      lev       = Math.min(lev * 1.3, base.maxLeverage);
      tpWidth   = slWidth * 3;
      strategy  = season === 'INVEST' ? 'DCA + 풀백 롱' : '브레이크아웃 롱';
      riskMult  = 1.2;
      rationale.push('강한 상승세 → 레버리지↑, 목표가↑');
      break;
    case 'WEAK_BULLISH':
      strategy  = '풀백 롱 + 추세 추종';
      rationale.push('약한 상승세 → 기본 파라미터 유지');
      break;
    case 'SIDEWAYS':
      lev       = Math.max(1, lev * 0.7);
      slWidth   = slWidth * 0.8;
      strategy  = '레인지 거래 + 평균 회귀';
      riskMult  = 0.7;
      dca       = false;
      rationale.push('횡보장 → 레버리지↓, 레인지 전략');
      break;
    case 'WEAK_BEARISH':
      lev       = Math.max(1, lev * 0.6);
      allowShort = true;
      strategy  = season === 'TRADING' ? '숏 바이어스 + 반등 매도' : '방어 모드';
      riskMult  = 0.6;
      dca       = false;
      rationale.push('약한 하락세 → 방어 포지션');
      break;
    case 'STRONG_BEARISH':
      lev       = 1;
      allowShort = true;
      strategy  = '숏 + 현금 보유';
      riskMult  = 0.3;
      dca       = false;
      slWidth   = slWidth * 0.6;
      rationale.push('강한 하락세 → 최소 레버리지, 방어 최우선');
      break;
  }

  // ── Volatility adjustments ───────────────────────────────────
  switch (volatility) {
    case 'EXTREME':
      lev       = Math.max(1, lev * 0.5);
      slWidth   = slWidth * 1.5;
      holding   = Math.round(holding * 0.5);
      riskMult *= 0.5;
      rationale.push('극단적 변동성 → 레버리지 절반, 손절폭↑');
      break;
    case 'HIGH':
      lev       = Math.min(lev, lev * 0.8);
      slWidth   = slWidth * 1.2;
      rationale.push('높은 변동성 → 손절폭 확대');
      break;
    case 'LOW':
      if (season === 'TRADING') {
        holding = Math.round(holding * 1.5);
        rationale.push('낮은 변동성 → 홀딩 시간 연장');
      }
      break;
  }

  // ── Trend strength ────────────────────────────────────────────
  if (trend === 'STRONG') {
    holding  = Math.round(holding * 1.3);
    tpWidth  = tpWidth * 1.2;
    rationale.push('강한 추세 → 홀딩 연장');
  } else if (trend === 'NONE') {
    lev      = Math.max(1, lev * 0.8);
    riskMult *= 0.8;
    rationale.push('추세 없음 → 리스크 축소');
  }

  return {
    leverage:        Math.round(Math.min(lev, base.maxLeverage) * 10) / 10,
    stopLossWidth:   Math.round(slWidth * 1000) / 1000,
    takeProfitWidth: Math.round(tpWidth * 1000) / 1000,
    holdingBars:     Math.max(1, holding),
    tradeFrequency:  base.tradeFrequency,
    allowShort,
    dcaEnabled:      dca,
    strategy,
    riskMultiplier:  Math.round(riskMult * 100) / 100,
    rationale,
  };
}

// ── Format season info ────────────────────────────────────────
export function formatSeasonMode(mode: SeasonMode) {
  const cfg = SEASON_CONFIGS[mode];
  return {
    emoji: mode === 'INVEST' ? '🌱' : '⚡',
    color: mode === 'INVEST' ? '#10B981' : '#F59E0B',
    ...cfg,
  };
}
