// src/lib/portfolio/performance.ts
//
// **잔고가 늘었다고 번 것이 아니다.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// "지금까지 얼마 벌었냐"에 답하려면 셋을 갈라야 한다:
//
//   Equity      지금 계좌에 얼마 있는가
//   Trading PnL 매매로 얼마를 벌거나 잃었는가
//   Cash Flow   얼마를 넣고 뺐는가
//
// $1,000으로 시작해 $2,000이 됐다고 +100%가 아니다. $900을 입금했으면
// 매매로는 +$100이고, 그건 +10%다. **이 구분이 없으면 입금이 수익으로
// 보인다** — 자기 성과를 열 배 좋게 읽게 된다.
//
// 그리고 지금 잔고로 과거를 역산하지 않는다
// ─────────────────────────────────────────
// 곡선은 **찍어 둔 시점**에서만 나온다. 오늘 표를 만들어도 어제 값은
// 생기지 않는다. 스냅샷이 없으면 곡선도 없고, 그게 정직한 상태다.
// 현재 잔고에서 거꾸로 계산한 그래프는 실제로 그 시각에 그 값이었다는
// 뜻이 아니다 — 보기에는 그럴듯하고 전부 거짓이다.

/** `account_equity_snapshots` 한 줄 */
export interface EquitySnapshot {
  takenAt: number;            // ms
  totalEquity: number | null; // **못 읽었으면 null이다 — 0이 아니다**
  realizedPnl?: number | null;
  unrealizedPnl?: number | null;
  deposit?: number | null;
  withdrawal?: number | null;
  transfer?: number | null;
  fees?: number | null;
  funding?: number | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 값이 있는 것만 더한다. **하나도 없으면 null이지 0이 아니다** */
function sumKnown(rows: Array<number | null | undefined>): number | null {
  let total = 0; let seen = 0;
  for (const r of rows) {
    const n = num(r);
    if (n == null) continue;
    total += n; seen++;
  }
  return seen === 0 ? null : Number(total.toFixed(8));
}

/**
 * **최신부터 읽은 목록을 오래된 순으로 되돌린다.**
 *
 * 왜 함수로 두나
 * ──────────────
 * 지갑 개요가 스냅샷을 `ascending: true` + `limit(2000)`으로 읽고 있었다.
 * 15분마다 찍으면 하루 96개, 약 3주면 2000개를 넘는다. 그 뒤로는
 * **가장 오래된 2000개**만 계속 읽는다:
 *
 *   · `lastTakenMs`가 3주 전 시각에 고정된다
 *   · 그래서 "15분 지났다"가 매 요청마다 참이 되어 표가 부풀고
 *   · 성과 곡선과 현재 자산 기준점이 전부 옛 구간을 본다
 *
 * 나중에 조용히 터지는 종류라, 정렬을 코드가 아니라 **값으로** 확인한다.
 */
export function newestFirstToAsc<T extends { takenAt: number }>(rows: T[] | null | undefined): T[] {
  const list = Array.isArray(rows) ? [...rows] : [];
  // 이미 정렬돼 온다고 믿지 않는다 — DB 정렬이 바뀌어도 여기서 잡는다.
  return list.sort((a, b) => (Number(a?.takenAt) || 0) - (Number(b?.takenAt) || 0));
}

/** 목록에서 가장 최근에 찍힌 시각. **없으면 null이지 0이 아니다** */
export function latestTakenMs(rows: Array<{ takenAt: number }> | null | undefined): number | null {
  const list = Array.isArray(rows) ? rows : [];
  let best: number | null = null;
  for (const r of list) {
    const t = Number(r?.takenAt);
    if (!Number.isFinite(t)) continue;
    if (best == null || t > best) best = t;
  }
  return best;
}

export interface CashFlow {
  /** 입금 합계. **기간 전체를 다 읽었을 때만 숫자다** */
  deposit: number | null;
  withdrawal: number | null;
  /** 순입출금 = 입금 − 출금. 하나라도 모르면 null */
  net: number | null;
  /**
   * **기간 전체의 입출금을 빠짐없이 읽었는가.**
   *
   * 이게 없으면 매매 손익이 조용히 틀린다. 예전 `sumKnown`은 아는 것만
   * 더해서 숫자를 만들었다 — 첫날 입금 100, 둘째 날 입금 UNKNOWN이면
   * 합계가 **정확한 100**처럼 나왔다. 그 값으로
   * `매매손익 = 자산증가 − 순입출금`을 계산하면, 못 읽은 입금이 전부
   * 수익으로 둔갑한다. 통합 장부를 붙이기 시작하면 가장 위험해지는
   * 지점이라 여기서 막는다.
   */
  complete: boolean;
  /** 몇 개 구간을 못 읽었는가 */
  unknownRows: number;
  reason: string;
}

/**
 * 기간 전체의 입출금.
 *
 * **한 구간이라도 모르면 숫자를 만들지 않는다.** 부분합계는 입출금에서
 * 특히 위험하다 — 빠진 입금이 그대로 '번 돈'이 되기 때문이다.
 */
export function cashFlowOf(snaps: EquitySnapshot[]): CashFlow {
  const list = Array.isArray(snaps) ? snaps : [];
  const unknownRows = list.filter(s => num(s.deposit) == null || num(s.withdrawal) == null).length;
  const complete = list.length > 0 && unknownRows === 0;

  if (!complete) {
    return {
      deposit: null, withdrawal: null, net: null, complete: false, unknownRows,
      reason: list.length === 0
        ? '입출금 기록이 없습니다 — 0이 아니라 모르는 것입니다'
        : `${list.length}개 구간 중 ${unknownRows}개의 입출금을 읽지 못했습니다 — `
          + '부분 합계로 매매 손익을 계산하지 않습니다',
    };
  }

  const deposit = sumKnown(list.map(s => s.deposit));
  const withdrawal = sumKnown(list.map(s => s.withdrawal));
  const net = deposit == null || withdrawal == null ? null
    : Number((deposit - withdrawal).toFixed(8));
  return { deposit, withdrawal, net, complete: true, unknownRows: 0,
    reason: `${list.length}개 구간의 입출금을 모두 읽었습니다` };
}

export type PerfCode = 'OK' | 'NO_SNAPSHOTS' | 'ONE_SNAPSHOT' | 'EQUITY_UNKNOWN';

export interface EquityPerformance {
  code: PerfCode;
  /** 처음 찍힌 자산. **역산하지 않는다** */
  startEquity: number | null;
  currentEquity: number | null;
  /** 최고/최저 자산 (찍힌 시점 기준) */
  peakEquity: number | null;
  troughEquity: number | null;
  /** 자산 증가 = 현재 − 시작. **수익이 아니다** */
  equityChange: number | null;
  /** 매매 손익 = 자산 증가 − 순입출금. 이게 "번 것"이다 */
  tradingPnl: number | null;
  /** 매매 수익률(%). 분모는 시작 자산 + 순입금(넣은 돈 전부) */
  tradingReturnPct: number | null;
  /** 최대 낙폭(%) — 찍힌 곡선 기준 */
  maxDrawdownPct: number | null;
  startedAt: number | null;
  lastAt: number | null;
  /** 운용 경과(ms) */
  elapsedMs: number | null;
  cashFlow: CashFlow;
  /** 화면이 그대로 적을 한 줄 */
  note: string;
}

const EMPTY = (code: PerfCode, note: string, cash: CashFlow): EquityPerformance => ({
  code, startEquity: null, currentEquity: null, peakEquity: null, troughEquity: null,
  equityChange: null, tradingPnl: null, tradingReturnPct: null, maxDrawdownPct: null,
  startedAt: null, lastAt: null, elapsedMs: null, cashFlow: cash, note,
});

/**
 * 찍어 둔 스냅샷에서 성과를 낸다.
 *
 * **Equity · Trading PnL · Cash Flow를 분리한다.** 입금해서 늘어난 것을
 * 수익으로 읽지 않는다.
 *
 * 스냅샷이 없으면 아무 숫자도 만들지 않는다 — 그게 정직한 상태다.
 */
export function equityPerformanceOf(snaps: EquitySnapshot[]): EquityPerformance {
  const all = (Array.isArray(snaps) ? snaps : [])
    .filter(s => num(s?.takenAt) != null)
    .sort((a, b) => Number(a.takenAt) - Number(b.takenAt));
  const cash = cashFlowOf(all);

  if (all.length === 0) {
    return EMPTY('NO_SNAPSHOTS',
      '아직 찍어 둔 자산 기록이 없습니다 — 지금 잔고로 과거를 역산하지 않습니다', cash);
  }

  // 자산을 읽은 스냅샷만 곡선에 쓴다. **못 읽은 시점을 0으로 그리면
  // 그래프가 바닥으로 떨어지고, 사용자는 전액을 잃은 줄 안다.**
  const withEquity = all.filter(s => num(s.totalEquity) != null);
  if (withEquity.length === 0) {
    return EMPTY('EQUITY_UNKNOWN',
      `기록은 ${all.length}건 있지만 자산을 읽은 시점이 없습니다`, cash);
  }

  const first = withEquity[0];
  const last = withEquity[withEquity.length - 1];
  const startEquity = num(first.totalEquity)!;
  const currentEquity = num(last.totalEquity)!;
  const startedAt = Number(first.takenAt);
  const lastAt = Number(last.takenAt);

  let peak = -Infinity, trough = Infinity, maxDd = 0, runningPeak = -Infinity;
  for (const s of withEquity) {
    const v = num(s.totalEquity)!;
    if (v > peak) peak = v;
    if (v < trough) trough = v;
    if (v > runningPeak) runningPeak = v;
    if (runningPeak > 0) {
      const dd = ((runningPeak - v) / runningPeak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }

  const equityChange = Number((currentEquity - startEquity).toFixed(8));
  // **번 것 = 자산 증가 − 넣은 돈.** 순입출금을 모르면 매매 손익도 모른다.
  const tradingPnl = cash.net == null ? null : Number((equityChange - cash.net).toFixed(8));
  // 분모는 "내가 넣은 돈 전부"다. 시작 자산만 쓰면 중간에 입금했을 때
  // 수익률이 부풀려진다.
  const invested = cash.net == null ? null : startEquity + Math.max(0, cash.net);
  const tradingReturnPct = tradingPnl == null || invested == null || !(invested > 0)
    ? null : Number(((tradingPnl / invested) * 100).toFixed(4));

  const single = withEquity.length === 1;

  return {
    code: single ? 'ONE_SNAPSHOT' : 'OK',
    startEquity, currentEquity,
    peakEquity: peak, troughEquity: trough,
    equityChange,
    tradingPnl, tradingReturnPct,
    // 낙폭은 두 점 이상이어야 뜻이 있다.
    maxDrawdownPct: single ? null : Number(maxDd.toFixed(4)),
    startedAt, lastAt,
    elapsedMs: Math.max(0, lastAt - startedAt),
    cashFlow: cash,
    note: single
      ? '기록이 한 시점뿐입니다 — 곡선과 낙폭은 두 번째 기록부터 나옵니다'
      : cash.net == null
        ? `${withEquity.length}개 시점 · 입출금을 읽지 못해 매매 손익을 자산 증가와 구분하지 못했습니다`
        : `${withEquity.length}개 시점 기록`,
  };
}

// ── 거래 통계 ────────────────────────────────────────

export interface ClosedTrade {
  /** 실현 손익. **모르면 넣지 않는다** */
  pnl: number | null;
  closedAt?: number | null;
}

export interface TradeStats {
  /** 손익을 읽은 거래 수. **전체 거래 수와 다를 수 있다** */
  counted: number;
  /** 표에 있던 전체 거래 수 */
  total: number;
  wins: number;
  losses: number;
  /** 승률(%). 표본이 없으면 null */
  winRatePct: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** 총이익 ÷ 총손실. 손실이 0이면 null — Infinity를 화면에 적지 않는다 */
  profitFactor: number | null;
  /** 1회 기대값 */
  expectancy: number | null;
  /** 손익비 */
  payoffRatio: number | null;
  note: string;
}

/**
 * 닫힌 거래에서 통계를 낸다.
 *
 * **손익을 못 읽은 거래를 0으로 세지 않는다.** 0으로 세면 그 거래가
 * 본전인 것이 되어 승률과 기대값이 둘 다 틀린다. 대신 몇 건을 셌는지
 * 전체와 같이 적는다 — 화면이 "40건 중 37건 기준"이라고 말할 수 있어야 한다.
 */
export function tradeStatsOf(trades: ClosedTrade[]): TradeStats {
  const all = Array.isArray(trades) ? trades : [];
  const vals = all.map(t => num(t?.pnl)).filter((n): n is number => n != null);

  if (vals.length === 0) {
    return {
      counted: 0, total: all.length, wins: 0, losses: 0,
      winRatePct: null, avgWin: null, avgLoss: null,
      profitFactor: null, expectancy: null, payoffRatio: null,
      note: all.length === 0 ? '닫힌 거래가 없습니다'
        : `거래 ${all.length}건의 손익을 읽지 못했습니다 — 0으로 세지 않습니다`,
    };
  }

  const wins = vals.filter(v => v > 0);
  const losses = vals.filter(v => v < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const avgWin = wins.length ? Number((grossWin / wins.length).toFixed(8)) : null;
  const avgLoss = losses.length ? Number((grossLoss / losses.length).toFixed(8)) : null;

  return {
    counted: vals.length, total: all.length,
    wins: wins.length, losses: losses.length,
    winRatePct: Number(((wins.length / vals.length) * 100).toFixed(4)),
    avgWin, avgLoss,
    // **손실이 0이면 null이다.** Infinity를 "무한대 수익"으로 그리면
    // 표본 3건짜리 전략이 최고 성적으로 보인다.
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(4)) : null,
    expectancy: Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(8)),
    payoffRatio: avgWin != null && avgLoss != null && avgLoss > 0
      ? Number((avgWin / avgLoss).toFixed(4)) : null,
    note: vals.length === all.length
      ? `거래 ${all.length}건 기준`
      : `거래 ${all.length}건 중 손익을 읽은 ${vals.length}건 기준`,
  };
}

/** 운용 경과를 사람이 읽는 말로 */
export function elapsedText(ms: number | null | undefined): string {
  const n = num(ms);
  if (n == null || n < 0) return '확인하지 못했습니다';
  const d = Math.floor(n / 86_400_000);
  const h = Math.floor((n % 86_400_000) / 3_600_000);
  const m = Math.floor((n % 3_600_000) / 60_000);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}
