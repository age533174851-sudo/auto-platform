// src/lib/season/equitySeason.ts
// 미국 주식 계절성 — 전체시장 vs 섹터 분리 판단
export type SeasonStance = 'bullish' | 'neutral' | 'caution' | 'defensive';

export interface SeasonSignal {
  scope: 'market' | 'sector' | 'stock';
  label: string;
  stance: SeasonStance;
  reason: string;
}

export function getMarketSeason(date = new Date()): SeasonSignal {
  const m = date.getMonth() + 1;
  const strong = [11, 12, 1, 2, 3, 4];
  if (strong.includes(m)) {
    return { scope: 'market', label: 'S&P500 강세 시즌 (11~4월)', stance: 'bullish',
      reason: '역사적으로 11~4월은 미국 증시 강세 우위 (Halloween indicator)' };
  }
  return { scope: 'market', label: 'S&P500 보수 시즌 (5~10월)', stance: 'caution',
    reason: 'Sell in May — 5~10월은 상대적으로 약세·변동성 구간' };
}

export function getSectorSeason(
  date = new Date(),
  opts?: { sector?: string; overheated?: boolean; recentGainPct?: number },
): SeasonSignal {
  const m = date.getMonth() + 1;
  const profitTakingWindow = [11, 12, 1, 2];
  const isAiSemi = opts?.sector ? /ai|반도체|semi|tech|성장|growth/i.test(opts.sector) : true;
  const overheated = opts?.overheated || (opts?.recentGainPct != null && opts.recentGainPct > 60);

  if (isAiSemi && overheated && profitTakingWindow.includes(m)) {
    return { scope: 'sector', label: 'AI·반도체 차익실현 경고', stance: 'caution',
      reason: '급등 성장주는 11~2월 차익실현·실적·FOMC·리밸런싱 조정 리스크' };
  }
  if (isAiSemi && profitTakingWindow.includes(m)) {
    return { scope: 'sector', label: 'AI·반도체 변동성 주의', stance: 'neutral',
      reason: '1~2월 실적·가이던스·FOMC 기대감으로 변동성 확대 가능' };
  }
  const market = getMarketSeason(date);
  return { scope: 'sector', label: isAiSemi ? 'AI·반도체 ' + market.label : market.label,
    stance: market.stance, reason: market.reason };
}

export function getSeasonSignals(
  date = new Date(),
  opts?: { sector?: string; overheated?: boolean; recentGainPct?: number },
): { market: SeasonSignal; sector: SeasonSignal; advice: string } {
  const market = getMarketSeason(date);
  const sector = getSectorSeason(date, opts);
  let advice = '';
  if (market.stance === 'bullish' && sector.stance === 'caution') {
    advice = '전체 시장은 강세 시즌이나, 급등한 성장주는 차익실현 조정 가능성. 분할·과열도 확인 후 진입.';
  } else if (market.stance === 'bullish') {
    advice = '계절성 우호적. 단, 계절성만 믿지 말고 추세·실적·금리·VIX 함께 판단.';
  } else {
    advice = '보수 시즌. 포지션 축소·방어적 운용 권장. 강한 추세 확인 시에만 진입.';
  }
  return { market, sector, advice };
}

export const SEASON_STANCE_COLOR: Record<SeasonStance, string> = {
  bullish: '#10B981', neutral: '#60A5FA', caution: '#F59E0B', defensive: '#EF4444',
};
export const SEASON_STANCE_LABEL: Record<SeasonStance, string> = {
  bullish: '강세', neutral: '중립', caution: '주의', defensive: '방어',
};
