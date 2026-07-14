// src/lib/autotrade/retrospect.ts
// AI 복기 — 실제 매매 기록에서 "이 조건에서 자주 졌다" 패턴을 찾아 경고.
export interface ClosedTrade {
  ts: number;
  symbol: string;
  realized: number;      // 실현손익
  realizedPct?: number;
}

export interface RetroWarning {
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  stat: string;          // 예: "승률 35% (7건 중 2승)"
}

export interface RetroResult {
  totalTrades: number;
  wins: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  warnings: RetroWarning[];
  strengths: string[];
}

const HOUR_BANDS: { label: string; lo: number; hi: number }[] = [
  { label: '새벽 (0–6시)', lo: 0, hi: 6 },
  { label: '오전 (6–12시)', lo: 6, hi: 12 },
  { label: '오후 (12–18시)', lo: 12, hi: 18 },
  { label: '야간 (18–24시)', lo: 18, hi: 24 },
];

function wr(trades: ClosedTrade[]): number {
  if (!trades.length) return 0;
  return (trades.filter(t => t.realized > 0).length / trades.length) * 100;
}

export function analyzeTrades(closed: ClosedTrade[]): RetroResult {
  // 시간순 정렬 (오래된 → 최근)
  const trades = [...closed].filter(t => Number.isFinite(t.realized)).sort((a, b) => a.ts - b.ts);
  const wins = trades.filter(t => t.realized > 0);
  const losses = trades.filter(t => t.realized <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.realized, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.realized, 0) / losses.length : 0;

  const warnings: RetroWarning[] = [];
  const strengths: string[] = [];

  if (trades.length < 5) {
    return { totalTrades: trades.length, wins: wins.length, winRate, avgWin, avgLoss,
      warnings: [], strengths: trades.length ? ['아직 표본이 적어요. 매매가 쌓이면 패턴을 분석해드려요.'] : ['매매 기록이 없어요.'] };
  }

  // ① 시간대별 승률
  for (const b of HOUR_BANDS) {
    const inBand = trades.filter(t => { const h = new Date(t.ts).getHours(); return h >= b.lo && h < b.hi; });
    if (inBand.length >= 4) {
      const r = wr(inBand);
      const w = inBand.filter(t => t.realized > 0).length;
      if (r < 40) warnings.push({ severity: r < 25 ? 'high' : 'medium', title: `${b.label} 매매 성적 저조`,
        detail: `이 시간대 매매를 줄이거나 신중하게 진입하세요.`, stat: `승률 ${r.toFixed(0)}% (${inBand.length}건 중 ${w}승)` });
      else if (r >= 65) strengths.push(`${b.label} 승률 ${r.toFixed(0)}% — 이 시간대에 강합니다`);
    }
  }

  // ② 손실 직후 매매 (복수 매매 경향)
  const afterLoss: ClosedTrade[] = [];
  for (let i = 1; i < trades.length; i++) if (trades[i - 1].realized <= 0) afterLoss.push(trades[i]);
  if (afterLoss.length >= 3) {
    const r = wr(afterLoss);
    const w = afterLoss.filter(t => t.realized > 0).length;
    if (r < 40) warnings.push({ severity: r < 25 ? 'high' : 'medium', title: '손실 직후 매매(복수 매매) 주의',
      detail: '손실 후 곧바로 진입하면 감정적 매매가 되기 쉬워요. 잠시 쉬어가세요.', stat: `승률 ${r.toFixed(0)}% (${afterLoss.length}건 중 ${w}승)` });
    else if (r >= 60) strengths.push('손실 후에도 침착하게 매매를 이어갑니다');
  }

  // ③ 종목별 최악 승률
  const bySym = new Map<string, ClosedTrade[]>();
  for (const t of trades) { const a = bySym.get(t.symbol) || []; a.push(t); bySym.set(t.symbol, a); }
  let worst: { sym: string; r: number; n: number; w: number } | null = null;
  for (const [sym, ts] of bySym) {
    if (ts.length < 4) continue;
    const r = wr(ts);
    if (!worst || r < worst.r) worst = { sym, r, n: ts.length, w: ts.filter(t => t.realized > 0).length };
  }
  if (worst && worst.r < 40) warnings.push({ severity: worst.r < 25 ? 'high' : 'medium', title: `${worst.sym} 매매 성적 저조`,
    detail: `${worst.sym}에서 자주 손실이 났어요. 이 종목의 진입 기준을 재점검하세요.`, stat: `승률 ${worst.r.toFixed(0)}% (${worst.n}건 중 ${worst.w}승)` });

  // ④ 손익비 (평균수익 vs 평균손실)
  if (avgWin > 0 && avgLoss < 0) {
    const ratio = avgWin / Math.abs(avgLoss);
    if (ratio < 1) warnings.push({ severity: 'medium', title: '손익비 불리 (버는 것보다 크게 잃음)',
      detail: '평균 수익보다 평균 손실이 큽니다. 손절을 더 짧게, 익절을 더 길게 가져가세요.', stat: `손익비 ${ratio.toFixed(2)} (평균수익 < 평균손실)` });
    else if (ratio >= 1.5) strengths.push(`손익비 ${ratio.toFixed(2)} — 잃을 땐 적게, 벌 땐 크게`);
  }

  // ⑤ 과매매 (하루 최다 거래일)
  const byDay = new Map<string, number>();
  for (const t of trades) { const d = new Date(t.ts).toISOString().slice(0, 10); byDay.set(d, (byDay.get(d) || 0) + 1); }
  const maxDay = Math.max(...byDay.values());
  if (maxDay >= 8) warnings.push({ severity: 'low', title: '과매매 경향',
    detail: '하루에 너무 많이 매매하면 수수료·감정 매매가 늘어요. 매매 횟수를 정해두세요.', stat: `하루 최다 ${maxDay}회 매매` });

  if (winRate >= 55) strengths.push(`전체 승률 ${winRate.toFixed(0)}% — 안정적입니다`);

  return { totalTrades: trades.length, wins: wins.length, winRate, avgWin, avgLoss, warnings, strengths };
}

// paper 계좌 orders(sell만 실현)를 ClosedTrade로 변환
export function ordersToClosedTrades(orders: any[]): ClosedTrade[] {
  return (Array.isArray(orders) ? orders : [])
    .filter(o => o && o.side === 'sell' && o.realized != null)
    .map(o => ({ ts: o.ts, symbol: o.symbol, realized: o.realized, realizedPct: o.realizedPct }));
}
