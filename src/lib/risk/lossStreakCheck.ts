// src/lib/risk/lossStreakCheck.ts
//
// 주간 한도·연패 잠금에 넣을 **실제 숫자**를 받아 온다.
//
// 판정은 `lossStreak.ts`(순수)가 하고 여기서는 읽기만 한다. 나눠 두는 이유는
// 판정에 테스트를 붙이기 위해서다 — 하루 한도에서 했던 것과 같다.
//
// 실패를 0으로 덮지 않는다
// ────────────────────────
// 원장 조회가 실패하면 `null`이다. 0으로 두면 '이번 주 손익 0' = '한도 안'이
// 되어 잠금이 조용히 풀린다.

import {
  judgeWeeklyLoss, judgeLossStreak,
  readWeeklyLossConfig, readStreakConfig,
  utcWeekStart, nextUtcWeekStart,
  type LockVerdict, type StreakVerdict, type StreakTrade,
} from './lossStreak';
import { sumTodayIncome } from './dailyLoss';

export interface StreakFacts {
  weekly: LockVerdict;
  streak: StreakVerdict;
  /** 이번 주 순손익(USDT). 모르면 null */
  weekNetUsd: number | null;
  /** 주 시작 자산 추정(USDT). 모르면 null */
  weekStartEquityUsd: number | null;
  /** 설정 오타 등 알려야 할 것 */
  note: string;
}

/** 원장 한 줄에서 '한 거래의 실현손익'만 뽑는다 */
function toStreakTrades(rows: any[] | null): StreakTrade[] | null {
  if (!Array.isArray(rows)) return null;   // null = 모른다 (빈 배열과 다르다)
  const out: StreakTrade[] = [];
  for (const r of rows) {
    // 수수료·펀딩은 거래가 아니다. 연패는 **거래 단위**로 세야 한다 —
    // 펀딩을 손실로 세면 포지션을 들고만 있어도 연패가 쌓인다.
    const type = String(r?.incomeType ?? r?.type ?? '').toUpperCase();
    const isRealized = type === 'REALIZED_PNL' || type === 'PNL';
    if (!isRealized) continue;
    const pnl = Number(r?.income ?? r?.change ?? r?.pnl);
    // Gate account_book은 초 단위, 바이낸스 income은 ms 단위다.
    const rawT = Number(r?.time ?? r?.time_ms ?? 0);
    const at = rawT > 1e11 ? rawT : rawT * 1000;
    if (!Number.isFinite(pnl) || !Number.isFinite(at) || at <= 0) continue;
    out.push({ realizedPnl: pnl, closedAtMs: at });
  }
  return out;
}

/** 실계좌·테스트넷의 주간 한도 + 연패 상태 */
export async function collectStreakLimits(args: {
  apiKey: string; apiSecret: string; testnet: boolean;
  exchange?: 'binance' | 'gate';
  currentEquityUsd: number | null;
  nowMs?: number;
  env?: (k: string) => string | undefined;
}): Promise<StreakFacts> {
  const now = args.nowMs ?? Date.now();
  const env = args.env ?? ((k: string) => process.env[k]);
  // **연습과 실전의 한도를 다르게 읽는다.** 실전은 예전 그대로다 —
  // 테스트넷 한도가 계좌의 7%면 손절 한 번에 닿아서 자동매매를 한 번도
  // 못 돌려 본다. 규칙을 없애는 것이 아니라 닿는 지점을 옮기는 것이다.
  const { scopeOf } = await import('./limitScope');
  const scope = scopeOf(args.testnet);
  const w = readWeeklyLossConfig(env, scope);
  const s = readStreakConfig(env, scope);
  const weekStart = utcWeekStart(now);

  let rows: any[] | null = null;
  try {
    if (args.exchange === 'gate') {
      const { getGateAccountBook } = await import('@/lib/exchanges/gateFutures');
      rows = await getGateAccountBook(args.apiKey, args.apiSecret, args.testnet, {
        fromSec: Math.floor(weekStart / 1000), limit: 1000,
      });
    } else {
      const { getFuturesIncome } = await import('@/lib/exchanges/binanceFutures');
      rows = await getFuturesIncome(args.apiKey, args.apiSecret, args.testnet, {
        startTime: weekStart, limit: 1000,
      });
    }
  } catch { rows = null; }

  const weekNetUsd = rows != null ? sumTodayIncome(rows, weekStart).net : null;
  const weekStartEquityUsd =
    args.currentEquityUsd != null && weekNetUsd != null
      ? args.currentEquityUsd - weekNetUsd
      : null;

  return {
    weekly: judgeWeeklyLoss({
      weekNetUsd, weekStartEquityUsd, cfg: w.cfg,
      nextWeekStartMs: nextUtcWeekStart(now),
    }),
    streak: judgeLossStreak({ trades: toStreakTrades(rows), nowMs: now, cfg: s.cfg }),
    weekNetUsd, weekStartEquityUsd,
    note: [w.note, s.note].filter(Boolean).join(' · '),
  };
}

/**
 * 모의 계좌의 주간 한도 + 연패 상태.
 *
 * 모의에도 같은 잠금을 건다. 규칙이 실전과 다르면 그 연습은 쓸모가 없다 —
 * 연패해도 계속 넣어도 되는 화면에서 익힌 습관이 실계좌에서 그대로 나온다.
 */
export async function collectPaperStreakLimits(args: {
  sb: any; userId: string; nowMs?: number;
  env?: (k: string) => string | undefined;
}): Promise<StreakFacts> {
  const now = args.nowMs ?? Date.now();
  const env = args.env ?? ((k: string) => process.env[k]);
  // 모의도 연습이다.
  const { scopeOf: scopeOfPaper } = await import('./limitScope');
  const w = readWeeklyLossConfig(env, scopeOfPaper(true));
  const s = readStreakConfig(env, scopeOfPaper(true));
  const weekStart = utcWeekStart(now);

  let trades: StreakTrade[] | null = null;
  let weekNetUsd: number | null = null;
  try {
    // 연패는 최근 거래를 봐야 하므로 주 경계와 무관하게 넉넉히 읽는다.
    // 주간 손익은 그중 이번 주 것만 더한다.
    const { data, error } = await args.sb.from('paper_positions')
      .select('realized_pnl, closed_at')
      .eq('user_id', args.userId).eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const rows = (Array.isArray(data) ? data : [])
      .map((r: any) => ({
        realizedPnl: Number(r?.realized_pnl),
        closedAtMs: r?.closed_at ? new Date(r.closed_at).getTime() : NaN,
      }))
      .filter((r: StreakTrade) => Number.isFinite(r.realizedPnl) && Number.isFinite(r.closedAtMs));

    trades = rows;
    weekNetUsd = rows
      .filter((r: StreakTrade) => r.closedAtMs >= weekStart)
      .reduce((a: number, r: StreakTrade) => a + r.realizedPnl, 0);
  } catch {
    // 조회 실패는 '거래 없음'이 아니다. null로 남겨 unknown → 막힘.
    trades = null;
    weekNetUsd = null;
  }

  let weekStartEquityUsd: number | null = null;
  try {
    const { data } = await args.sb.from('paper_accounts')
      .select('balance').eq('user_id', args.userId).maybeSingle();
    const bal = Number(data?.balance);
    weekStartEquityUsd = Number.isFinite(bal) && weekNetUsd != null ? bal - weekNetUsd : null;
  } catch { weekStartEquityUsd = null; }

  return {
    weekly: judgeWeeklyLoss({
      weekNetUsd, weekStartEquityUsd, cfg: w.cfg,
      nextWeekStartMs: nextUtcWeekStart(now),
    }),
    streak: judgeLossStreak({ trades, nowMs: now, cfg: s.cfg }),
    weekNetUsd, weekStartEquityUsd,
    note: [w.note, s.note].filter(Boolean).join(' · '),
  };
}
