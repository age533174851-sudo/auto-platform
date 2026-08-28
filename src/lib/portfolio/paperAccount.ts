// src/lib/portfolio/paperAccount.ts
//
// **모의투자 계좌가 지금 얼마인가.**
//
// 조사에서 나온 것
// ────────────────
// 표는 이미 있다 — `paper_accounts`(010) · `paper_positions`(010) ·
// `account_equity_snapshots`(048, `env='MOCK'` 지원). 새로 만들 것이 없다.
//
// 없던 것은 셋이다:
//   · 시작하기 흐름 (초기자금을 고르는 자리)
//   · 오늘 손익 (일 경계 기준점)
//   · 지갑 MOCK 탭과의 배선 — **화면은 있는데 이 API를 읽지 않았다**
//
// 통화는 USDT다
// ─────────────
// `paper_positions`의 체결가·수수료가 전부 USDT이고, 모의로 돌릴 전략도
// 전부 USDT 선물이다. 장부 통화가 갈리면 손익이 두 벌이 된다.
//
// 원화는 **표시 계층에서만** 환산한다. 그리고 이 저장소에는 이미 그
// 사고 기록이 있다(`walletMoney.ts`): 공용 `cvt()`가 입력을 KRW로
// 가정해서 1,000배 확대됐다. **환율이 없으면 원화로 바꾸지 않는다.**

export interface PaperPositionLike {
  symbol?: string | null;
  side?: string | null;
  quantity?: number | string | null;
  fill_price?: number | string | null;
  entry_price?: number | string | null;
  margin?: number | string | null;
  /** 부르는 쪽이 현재가로 계산해 넣는다. **못 구했으면 null** */
  unrealizedPnl?: number | null;
}

export interface PaperAccountRow {
  balance?: number | string | null;
  initial_balance?: number | string | null;
  total_pnl?: number | string | null;
  total_fees?: number | string | null;
  trade_count?: number | string | null;
  win_count?: number | string | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export type PaperState =
  /** 아직 시작하지 않았다 — 계좌 줄이 없다 */
  | 'NOT_STARTED'
  /** 돌고 있다 */
  | 'ACTIVE'
  /** 계좌는 읽었는데 값이 이상하다 */
  | 'UNREADABLE';

export interface PaperEquity {
  state: PaperState;
  /** 현금 (실현된 잔고) */
  cash: number | null;
  /** 포지션에 묶인 증거금 */
  usedMargin: number | null;
  /** 미실현손익. **한 포지션이라도 못 구했으면 null이다** */
  unrealizedPnl: number | null;
  /** 총자산 = 현금 + 미실현손익. 미실현을 모르면 null */
  totalEquity: number | null;
  /** 확인된 부분만의 합계 — 총자산이 null일 때 보여 줄 값 */
  knownCash: number | null;
  initialBalance: number | null;
  realizedPnl: number | null;
  totalFees: number | null;
  tradeCount: number | null;
  winCount: number | null;
  /** 시작 대비 수익률(%). 종잣돈이 없으면 null */
  returnPct: number | null;
  note: string;
}

/**
 * 계좌 + 포지션 → 지금 얼마인가.
 *
 * **미실현을 못 구한 포지션이 하나라도 있으면 총자산은 null이다.**
 * 부분합계를 총자산이라고 적으면 사용자는 그 숫자를 믿는다 —
 * 지갑에서 이미 같은 실수를 했고, 그때 고친 규칙을 여기서도 지킨다.
 */
export function paperEquityOf(i: {
  account: PaperAccountRow | null | undefined;
  positions: PaperPositionLike[] | null | undefined;
}): PaperEquity {
  const a = i?.account;
  if (!a) {
    return {
      state: 'NOT_STARTED',
      cash: null, usedMargin: null, unrealizedPnl: null, totalEquity: null,
      knownCash: null, initialBalance: null, realizedPnl: null, totalFees: null,
      tradeCount: null, winCount: null, returnPct: null,
      note: '아직 모의투자를 시작하지 않았습니다',
    };
  }

  const cash = num(a.balance);
  const initial = num(a.initial_balance);
  if (cash == null) {
    return {
      state: 'UNREADABLE',
      cash: null, usedMargin: null, unrealizedPnl: null, totalEquity: null,
      knownCash: null, initialBalance: initial, realizedPnl: num(a.total_pnl),
      totalFees: num(a.total_fees), tradeCount: num(a.trade_count), winCount: num(a.win_count),
      returnPct: null,
      note: '모의 계좌의 잔고를 읽지 못했습니다 — 0으로 적지 않습니다',
    };
  }

  const list = Array.isArray(i?.positions) ? i.positions : [];
  let usedMargin = 0;
  let unreal = 0;
  let unknownCount = 0;
  for (const p of list) {
    const m = num(p?.margin);
    if (m != null) usedMargin += m;
    const u = p?.unrealizedPnl;
    if (u == null || !Number.isFinite(Number(u))) unknownCount += 1;
    else unreal += Number(u);
  }

  // **못 구한 것이 있으면 총자산을 적지 않는다.**
  const unrealizedPnl = unknownCount > 0 ? null : unreal;
  const totalEquity = unrealizedPnl == null ? null : cash + unrealizedPnl;

  return {
    state: 'ACTIVE',
    cash, usedMargin,
    unrealizedPnl, totalEquity, knownCash: cash,
    initialBalance: initial,
    realizedPnl: num(a.total_pnl),
    totalFees: num(a.total_fees),
    tradeCount: num(a.trade_count),
    winCount: num(a.win_count),
    returnPct: initial != null && initial > 0 && totalEquity != null
      ? ((totalEquity - initial) / initial) * 100 : null,
    note: unknownCount > 0
      ? `포지션 ${unknownCount}건의 현재가를 못 읽어 총자산을 계산하지 않았습니다`
      : '',
  };
}

/**
 * 오늘 손익.
 *
 * **기준점이 없으면 계산하지 않는다.** 시작 잔고로 대신 재면 그건
 * '오늘'이 아니라 '누적'이고, 화면은 그걸 오늘 것으로 읽는다.
 */
export function paperTodayPnl(i: {
  /** 지금 총자산. 못 구했으면 null */
  totalEquity: number | null;
  /** 오늘 첫 스냅샷의 총자산. 없으면 null */
  dayStartEquity: number | null;
}): { pnl: number | null; pct: number | null; note: string } {
  const now = i?.totalEquity;
  const start = i?.dayStartEquity;
  if (now == null) return { pnl: null, pct: null, note: '총자산을 몰라 오늘 손익을 계산하지 않았습니다' };
  if (start == null) {
    return { pnl: null, pct: null,
      note: '오늘의 기준점이 없습니다 — 첫 기록이 남은 뒤부터 오늘 손익을 셉니다' };
  }
  const pnl = now - start;
  return { pnl, pct: start > 0 ? (pnl / start) * 100 : null, note: '' };
}

/** 시작 금액 선택지. **USDT 장부다** — 원화는 표시 계층에서 환산한다 */
export const PAPER_SEED_CHOICES = [10_000, 50_000, 100_000] as const;

export type SeedCode = 'OK' | 'TOO_SMALL' | 'TOO_LARGE' | 'INVALID';

/**
 * 시작 금액이 쓸 수 있는 값인가.
 *
 * 상한을 두는 이유는 화면 때문이 아니다 — 종잣돈이 비현실적으로 크면
 * 수익률이 전부 0에 붙어 **전략을 비교할 수 없다.**
 */
export function validateSeed(v: any): { code: SeedCode; value: number | null; reason: string } {
  const n = num(v);
  if (n == null || n <= 0) {
    return { code: 'INVALID', value: null, reason: '시작 금액을 숫자로 입력하세요' };
  }
  if (n < 100) {
    return { code: 'TOO_SMALL', value: null,
      reason: '최소 100 USDT부터 시작할 수 있습니다 — 그보다 작으면 최소 주문 수량에 걸려 아무 것도 체결되지 않습니다' };
  }
  if (n > 10_000_000) {
    return { code: 'TOO_LARGE', value: null,
      reason: '최대 10,000,000 USDT까지 넣을 수 있습니다' };
  }
  return { code: 'OK', value: n, reason: '' };
}
