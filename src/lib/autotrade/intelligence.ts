// src/lib/autotrade/intelligence.ts
// 전략 지능 — ① 건강도 점수(자동 off 판단) ② 우선순위 충돌 해결.

export interface StrategyLike {
  id: string; name: string; type: string; asset: string;
  winRate: number; totalPnl: number; trades: number; enabled?: boolean;
}

// ── ① 전략 건강도 ─────────────────────────────────────────────
export type HealthTier = 'excellent' | 'good' | 'caution' | 'danger' | 'unknown';

export interface StrategyHealth {
  score: number;        // 0~100
  tier: HealthTier;
  label: string;
  color: string;
  shouldDisable: boolean;   // 자동 off 권고
  reasons: string[];
}

const TIER_META: Record<HealthTier, { label: string; color: string }> = {
  excellent: { label: '우수', color: '#22C55E' },
  good:      { label: '양호', color: '#10B981' },
  caution:   { label: '주의', color: '#F59E0B' },
  danger:    { label: '위험', color: '#EF4444' },
  unknown:   { label: '데이터 부족', color: '#64748B' },
};

export function strategyHealth(s: StrategyLike): StrategyHealth {
  const reasons: string[] = [];
  if (!s.trades || s.trades === 0) {
    return { score: 50, tier: 'unknown', ...TIER_META.unknown, shouldDisable: false, reasons: ['거래 기록 없음 — 평가 불가'] };
  }
  // 승률(0~100) 60% + 손익방향(승25/패75 반영) 40%
  const winScore = Math.max(0, Math.min(100, s.winRate));
  const pnlScore = s.totalPnl > 0 ? 75 : s.totalPnl < 0 ? 25 : 50;
  let score = winScore * 0.6 + pnlScore * 0.4;
  // 표본 신뢰도: 거래 10회 미만이면 50(중립)으로 수렴
  const conf = Math.min(1, s.trades / 10);
  score = 50 + (score - 50) * conf;
  score = Math.round(Math.max(0, Math.min(100, score)));

  if (s.winRate >= 60) reasons.push(`승률 ${s.winRate}% (양호)`);
  else if (s.winRate < 45) reasons.push(`승률 ${s.winRate}% (저조)`);
  if (s.totalPnl < 0) reasons.push('누적 손실 상태');
  else if (s.totalPnl > 0) reasons.push('누적 수익 상태');
  if (s.trades < 10) reasons.push(`표본 부족 (${s.trades}회) — 신뢰도 낮음`);

  const tier: HealthTier = score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'caution' : 'danger';
  // 자동 off 권고: 위험 등급 + 충분한 표본
  const shouldDisable = tier === 'danger' && s.trades >= 5;
  if (shouldDisable) reasons.push('건강도 40 미만 — 자동 정지 권고');

  return { score, tier, ...TIER_META[tier], shouldDisable, reasons };
}

// ── ② 전략 우선순위 (충돌 해결) ───────────────────────────────
// 추세 > 브레이크아웃 > 모멘텀(펀딩/AI) > RSI 역추세 > DCA
export const TYPE_PRIORITY: Record<string, number> = {
  ema_cross: 5,      // 추세 추종 (최우선)
  breakout: 4,       // 브레이크아웃
  ai_strategy: 4,    // AI 국면
  funding_rate: 3,   // 모멘텀
  rsi_reversal: 2,   // 역추세
  dca: 1,            // 정기적립 (최하 — 신호 충돌 시 양보)
};

export const TYPE_LABEL: Record<string, string> = {
  ema_cross: '추세추종', breakout: '브레이크아웃', ai_strategy: 'AI국면',
  funding_rate: '모멘텀', rsi_reversal: '역추세', dca: '정기적립',
};

export interface Signal { stratId: string; stratName: string; type: string; asset: string; side: 'buy' | 'sell' }

export interface ConflictResult {
  asset: string;
  signals: Signal[];
  winner: Signal;
  overridden: Signal[];
  explanation: string;
}

// 같은 종목에서 매수 vs 매도 충돌 시 우선순위 높은 전략 채택
export function resolveConflicts(signals: Signal[]): ConflictResult[] {
  const byAsset = new Map<string, Signal[]>();
  for (const s of signals) {
    const arr = byAsset.get(s.asset) || [];
    arr.push(s); byAsset.set(s.asset, arr);
  }
  const results: ConflictResult[] = [];
  for (const [asset, sigs] of byAsset) {
    const hasBuy = sigs.some(s => s.side === 'buy');
    const hasSell = sigs.some(s => s.side === 'sell');
    if (!(hasBuy && hasSell)) continue;   // 충돌 아님
    const sorted = [...sigs].sort((a, b) => (TYPE_PRIORITY[b.type] || 0) - (TYPE_PRIORITY[a.type] || 0));
    const winner = sorted[0];
    const overridden = sorted.slice(1).filter(s => s.side !== winner.side);
    results.push({
      asset, signals: sigs, winner, overridden,
      explanation: `${TYPE_LABEL[winner.type] || winner.type}(우선순위 ${TYPE_PRIORITY[winner.type] || 0}) 전략의 ${winner.side === 'buy' ? '매수' : '매도'} 신호 채택 — ${overridden.map(o => TYPE_LABEL[o.type] || o.type).join(', ')} 신호 보류`,
    });
  }
  return results;
}
