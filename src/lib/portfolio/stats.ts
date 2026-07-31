// src/lib/portfolio/stats.ts
//
// 청산된 거래 기록 → 전략별 통계 — **순수 함수**.
//
// `strategyScore.ts`가 먹을 숫자를 여기서 만든다. 나눠 둔 이유는 이 계산에
// 실수하기 쉬운 자리가 많아서다:
//
//   · 최대 낙폭은 **자산 곡선**에서 잰다. 거래별 손실 중 가장 큰 것이
//     아니다. −1%가 여덟 번 연달아 나면 낙폭은 8%지, 1%가 아니다.
//   · 손익비는 나눗셈이라 **지는 거래가 없으면 정의되지 않는다.** 이때
//     큰 수를 넣으면 그 전략이 점수판 1등이 된다.
//   · 샤프는 **날짜별** 수익률에서 나온다. 거래별로 재면 하루에 열 번
//     거래하는 전략과 열흘에 한 번 거래하는 전략이 같은 척도로 비교된다.
//
// 모르는 것은 null이다
// ────────────────────
// 자산 규모를 모르면 낙폭·수익률을 %로 바꿀 수 없다. 그때 0을 넣으면
// '낙폭 0%'가 되어 만점을 받는다 — 계산을 못 한 전략이 가장 좋은 전략이
// 된다. 그래서 null을 돌려주고, 점수 쪽이 그 항목을 제외한다.

import type { StrategyStats } from './strategyScore';

export interface ClosedTrade {
  strategyId: string | null | undefined;
  label?: string | null;
  /** 청산 시각 (ms) */
  closedAtMs: number;
  /** 수수료까지 반영한 순손익 (USDT) */
  realizedPnl: number;
}

export interface AggregateOptions {
  /** 지금 시각 (ms). 최근 30일 창을 자를 때 쓴다 */
  nowMs: number;
  /**
   * 현재 자산 (USDT). 낙폭·수익률을 %로 바꾸는 데 쓴다.
   *
   * 모르면 null — 그 두 항목은 null이 되고 점수에서 제외된다.
   */
  equityUsd?: number | null;
  /** 샤프를 내려면 최소 이만큼의 거래일이 필요하다 */
  minDaysForSharpe?: number;
  /** 라벨을 못 찾았을 때 쓸 이름 */
  labelOf?: (strategyId: string) => string | undefined;
}

export const MIN_DAYS_FOR_SHARPE = 20;
const DAY_MS = 86_400_000;

const isNum = (v: any): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 전략별로 묶어 통계를 낸다.
 *
 * 자산(`equityUsd`)은 **지금** 값이다. 낙폭을 재려면 각 시점의 자산이
 * 필요한데 과거 자산 기록이 없으므로, "지금 자산 − 이 기간의 누적손익"을
 * 기간 시작 자산으로 보고 곡선을 그린다. 근사지만 방향은 맞다 —
 * 그리고 이 근사를 쓴다는 사실이 낙폭이 null이 되는 것보다 낫다.
 *
 * 단, 그렇게 계산한 시작 자산이 0 이하가 되면 (누적손익이 지금 자산보다
 * 큰 경우 — 출금이 있었다는 뜻이다) 낙폭은 null이다. 음수 자산으로
 * 나눈 비율은 숫자는 나오지만 의미가 없다.
 */
export function aggregateStrategies(
  trades: ClosedTrade[] | null | undefined,
  opts: AggregateOptions,
): StrategyStats[] {
  const list = (Array.isArray(trades) ? trades : []).filter(
    t => t && isNum(t.closedAtMs) && isNum(t.realizedPnl),
  );

  const groups = new Map<string, ClosedTrade[]>();
  for (const t of list) {
    const id = String(t.strategyId || '').trim() || 'manual';
    if (!groups.has(id)) groups.set(id, []);
    (groups.get(id) as ClosedTrade[]).push(t);
  }

  const out: StrategyStats[] = [];
  for (const [id, rows] of groups) {
    rows.sort((a, b) => a.closedAtMs - b.closedAtMs);
    out.push(statsFor(id, rows, opts));
  }
  // 거래가 많은 전략부터. 점수 정렬은 scoreAll이 따로 한다.
  return out.sort((a, b) => b.trades - a.trades);
}

function statsFor(id: string, rows: ClosedTrade[], opts: AggregateOptions): StrategyStats {
  const label = rows.find(r => r.label)?.label
    ?? opts.labelOf?.(id)
    ?? (id === 'manual' ? '수동 주문' : id);

  const pnls = rows.map(r => r.realizedPnl);
  const wins = pnls.filter(v => v > 0);
  const losses = pnls.filter(v => v < 0);
  // 정확히 0인 거래는 승도 패도 아니다. 승률의 분모에서 뺀다 —
  // 넣으면 본전 거래가 많은 전략의 승률이 조용히 내려간다.
  const decided = wins.length + losses.length;

  const winRatePct = decided > 0 ? (wins.length / decided) * 100 : null;

  // 지는 거래가 없으면 손익비는 **정의되지 않는다.** 큰 수를 넣으면
  // 그 전략이 점수판 1등이 된다 (파일 상단 주석 참조).
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : null;
  const payoffRatio = avgWin != null && avgLoss != null && avgLoss > 0
    ? avgWin / avgLoss : null;

  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  // ── 기간 시작 자산 ──
  const equityNow = isNum(opts.equityUsd as any) ? (opts.equityUsd as number) : null;
  const startEquity = equityNow == null ? null : equityNow - totalPnl;
  const equityUsable = startEquity != null && startEquity > 0;

  // ── 최대 낙폭 — 자산 곡선에서 잰다 ──
  let maxDrawdownPct: number | null = null;
  if (equityUsable) {
    let eq = startEquity as number;
    let peak = eq;
    let worst = 0;
    for (const p of pnls) {
      eq += p;
      if (eq > peak) peak = eq;
      if (peak > 0) {
        const dd = (peak - eq) / peak;
        if (dd > worst) worst = dd;
      }
    }
    maxDrawdownPct = worst * 100;
  }

  // ── 최근 30일 수익률 ──
  let return30dPct: number | null = null;
  if (equityUsable) {
    const from = opts.nowMs - 30 * DAY_MS;
    const recent = rows.filter(r => r.closedAtMs >= from);
    if (recent.length > 0) {
      const recentPnl = recent.reduce((a, r) => a + r.realizedPnl, 0);
      // 30일 전 자산 = 지금 자산 − 그 30일 동안의 손익
      const base = (equityNow as number) - recentPnl;
      return30dPct = base > 0 ? (recentPnl / base) * 100 : null;
    } else {
      // 30일간 거래가 없었다 → 수익률 0%. 이건 '모름'이 아니라 관측이다.
      return30dPct = 0;
    }
  }

  return {
    id, label,
    trades: rows.length,
    winRatePct,
    payoffRatio,
    maxDrawdownPct,
    sharpe: sharpeOf(rows, startEquity, opts.minDaysForSharpe ?? MIN_DAYS_FOR_SHARPE),
    return30dPct,
  };
}

/**
 * 샤프지수 — **날짜별** 수익률에서.
 *
 * 거래별로 재면 하루에 열 번 거래하는 전략과 열흘에 한 번 거래하는 전략이
 * 같은 척도로 비교된다. 날짜로 묶으면 그 차이가 자연히 반영된다.
 *
 * 거래가 없던 날은 수익률 0인 날로 채운다. 빼고 세면 "쉬는 날이 많은
 * 전략"의 변동성이 실제보다 크게 나온다.
 *
 * 무위험수익률은 0으로 둔다. 그리고 연율화는 √365 — 24시간 시장이다.
 * 주식까지 붙이면 시장별로 갈라야 한다 (아직 안 했다).
 */
export function sharpeOf(
  rows: ClosedTrade[], startEquity: number | null, minDays: number,
): number | null {
  if (startEquity == null || !(startEquity > 0) || rows.length === 0) return null;

  const byDay = new Map<number, number>();
  for (const r of rows) {
    const day = Math.floor(r.closedAtMs / DAY_MS);
    byDay.set(day, (byDay.get(day) ?? 0) + r.realizedPnl);
  }

  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  const first = days[0];
  const last = days[days.length - 1];
  const span = last - first + 1;
  if (span < minDays) return null;   // 표본이 모자라면 숫자를 만들지 않는다

  let eq = startEquity;
  const rets: number[] = [];
  for (let d = first; d <= last; d++) {
    const pnl = byDay.get(d) ?? 0;
    if (eq <= 0) return null;       // 자산이 0 이하로 내려가면 비율이 무의미하다
    rets.push(pnl / eq);
    eq += pnl;
  }

  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
  const sd = Math.sqrt(varr);
  if (!(sd > 0)) return null;       // 변동이 0이면 샤프가 무한대가 된다

  return (mean / sd) * Math.sqrt(365);
}

/** paper_positions 행 → ClosedTrade. 컬럼 이름이 바뀌면 여기 한 곳만 고친다 */
export function paperRowToTrade(r: any): ClosedTrade | null {
  const pnl = Number(r?.realized_pnl);
  const at = r?.closed_at ? new Date(r.closed_at).getTime() : NaN;
  if (!Number.isFinite(pnl) || !Number.isFinite(at)) return null;
  return {
    strategyId: r?.strategy_id ?? null,
    closedAtMs: at,
    realizedPnl: pnl,
  };
}
