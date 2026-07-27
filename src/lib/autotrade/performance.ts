// src/lib/autotrade/performance.ts
// 자동매매 실시간 성과 지표 집계
import type { ExecutionLog } from './types';

export interface PerfMetrics {
  totalTrades: number; wins: number; losses: number; winRate: number;
  totalPnl: number; avgWin: number; avgLoss: number; profitFactor: number;
  maxDrawdown: number; maxDrawdownPct: number;
  maxConsecLoss: number; curConsecLoss: number; expectancy: number;
}

function extractPnl(log: ExecutionLog): number | null {
  if (log.status !== 'triggered') return null;
  const r = log.reason || '';
  const m = r.match(/PnL\s*([+-]?[\d,]+)/);
  if (m) { const n = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(n)) return n; }
  return null;
}

export function calcPerformance(logs: ExecutionLog[]): PerfMetrics {
  const sorted = [...logs].sort((a, b) => a.at - b.at);
  const pnls: number[] = [];
  for (const log of sorted) { const p = extractPnl(log); if (p !== null) pnls.push(p); }

  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));

  let peak = 0, cum = 0, maxDD = 0;
  for (const p of pnls) { cum += p; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; }

  let maxConsec = 0, runningConsec = 0, curConsec = 0;
  for (const p of pnls) { if (p < 0) { runningConsec++; if (runningConsec > maxConsec) maxConsec = runningConsec; } else runningConsec = 0; }
  for (let i = pnls.length - 1; i >= 0; i--) { if (pnls[i] < 0) curConsec++; else break; }

  const n = pnls.length;
  return {
    totalTrades: n, wins: wins.length, losses: losses.length,
    winRate: n > 0 ? +((wins.length / n) * 100).toFixed(1) : 0,
    totalPnl: Math.round(totalPnl),
    avgWin: wins.length > 0 ? Math.round(grossWin / wins.length) : 0,
    avgLoss: losses.length > 0 ? Math.round(grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 999 : 0),
    maxDrawdown: Math.round(maxDD),
    maxDrawdownPct: peak > 0 ? +((maxDD / peak) * 100).toFixed(1) : 0,
    maxConsecLoss: maxConsec, curConsecLoss: curConsec,
    expectancy: n > 0 ? Math.round(totalPnl / n) : 0,
  };
}

// ─── 전략별 성과 (포트폴리오 분석) ────────────────────────────
import type { UserStrategy } from '@/lib/strategies/types';

export interface StrategyPerf {
  strategyId: string;
  strategyName: string;
  enabled: boolean;
  metrics: PerfMetrics;
  health: 'healthy' | 'watch' | 'poor';
  healthReason: string;
  shouldDisable: boolean;
}

export function calcStrategyPerformance(logs: ExecutionLog[], strategies: UserStrategy[]): StrategyPerf[] {
  const byStrat: Record<string, ExecutionLog[]> = {};
  for (const log of logs) { if (!log.strategyId) continue; (byStrat[log.strategyId] ||= []).push(log); }

  const out: StrategyPerf[] = [];
  for (const strat of strategies) {
    const sLogs = byStrat[strat.id] || [];
    const metrics = calcPerformance(sLogs);
    let health: 'healthy' | 'watch' | 'poor' = 'healthy';
    let healthReason = '정상', shouldDisable = false;

    if (metrics.totalTrades >= 5) {
      if (metrics.profitFactor < 0.8 || metrics.curConsecLoss >= 4) {
        health = 'poor';
        healthReason = metrics.profitFactor < 0.8 ? `손익비 ${metrics.profitFactor} (손실)` : `연속손실 ${metrics.curConsecLoss}회`;
        shouldDisable = true;
      } else if (metrics.profitFactor < 1.1 || metrics.winRate < 35 || metrics.curConsecLoss >= 3) {
        health = 'watch'; healthReason = '성과 부진 — 관찰';
      } else {
        health = 'healthy'; healthReason = `손익비 ${metrics.profitFactor} · 승률 ${metrics.winRate}%`;
      }
    } else { healthReason = `표본 부족 (${metrics.totalTrades}건)`; }

    out.push({ strategyId: strat.id, strategyName: strat.name, enabled: strat.enabled, metrics, health, healthReason, shouldDisable });
  }
  return out.sort((a, b) => b.metrics.totalPnl - a.metrics.totalPnl);
}
