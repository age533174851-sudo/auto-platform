// src/lib/portfolio/paperRead.ts
//
// **모의 계좌를 읽는 곳 하나.**
//
// 같은 판단이 세 곳에 있었다
// ──────────────────────────
// `/api/paper/account` GET · `/api/wallets/snapshot`(MOCK) — 그리고 지금
// 배선하려는 `/api/wallets/overview`가 세 번째가 될 뻔했다. 셋이 하는
// 일은 같다: 계좌 줄을 읽고, 열린 포지션을 읽고, 현재가를 받아 평가손익을
// 붙이고, `paperEquityOf`에 넘긴다.
//
// 이 저장소의 단골 고장이 "경로가 둘인데 한쪽만 고침"이다. 세 벌이면
// 언젠가 한 벌만 고쳐진다 — 그래서 여기 한 곳에 둔다.
//
// **읽기는 계좌를 만들지 않는다**
// ───────────────────────────────
// `getPaperAccount()`는 줄이 없으면 10,000 USDT짜리 계좌를 **만든다.**
// 그 함수를 워커의 자산 기록기가 15분마다 전 사용자에 대해 불렀다.
// 그래서 모의투자를 시작한 적 없는 사람에게도 계좌가 생겼고, 지갑
// MOCK 탭을 배선하는 순간 **고른 적 없는 종잣돈이 총자산으로 뜬다.**
//
// 여기서는 select만 한다. 만드는 것은 사용자가 "시작하기"를 누를 때다.
//
// **조회 실패를 포지션 0건으로 읽지 않는다**
// ──────────────────────────────────────────
// 포지션 조회가 실패했는데 빈 배열로 두면 증거금이 0이 되고 총자산이
// 현금과 같아진다 — 숫자는 그럴듯하고 틀렸다. 지갑에서 이미 같은
// 실수를 했다(`positionsOk`). 여기서는 UNREADABLE로 끝낸다.
import { paperEquityOf, paperStartedOf, type PaperAccountRow, type PaperEquity } from './paperAccount';

export interface PaperPositionRow {
  id?: string | null;
  symbol?: string | null;
  side?: string | null;
  fill_price?: number | string | null;
  quantity?: number | string | null;
  notional?: number | string | null;
  leverage?: number | string | null;
  margin?: number | string | null;
  stop_loss?: number | string | null;
  take_profit?: number | string | null;
  liquidation_price?: number | string | null;
  opened_at?: string | null;
}

export interface PaperPositionView {
  id: string | null;
  symbol: string | null;
  side: string | null;
  fillPrice: number | null;
  quantity: number | null;
  notional: number | null;
  leverage: number | null;
  margin: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  liquidationPrice: number | null;
  /** 현재가. **못 받았으면 null이다** */
  markPrice: number | null;
  /** 평가손익. 현재가나 체결가·수량을 모르면 null */
  unrealizedPnl: number | null;
  roiPct: number | null;
  openedAt: string | null;
}

const n = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * 원본 줄 + 시세표 → 포지션.
 *
 * **순수 함수다.** 시세를 못 받은 심볼은 `markPrice`·`unrealizedPnl`이
 * null로 남는다 — 0으로 적으면 "손익이 없다"로 읽힌다.
 */
export function paperPositionViews(
  rows: PaperPositionRow[] | null | undefined,
  marks: Map<string, number> | null | undefined,
): PaperPositionView[] {
  const m = marks instanceof Map ? marks : new Map<string, number>();
  return (Array.isArray(rows) ? rows : []).map((p) => {
    const symbol = p?.symbol == null ? null : String(p.symbol);
    const raw = symbol == null ? undefined : m.get(symbol);
    const mark = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
    const fill = n(p?.fill_price);
    const qty = n(p?.quantity);
    const margin = n(p?.margin);
    const side = p?.side == null ? null : String(p.side);
    const pnl = mark == null || fill == null || qty == null
      ? null
      : (side === 'LONG' ? mark - fill : fill - mark) * qty;
    return {
      id: p?.id == null ? null : String(p.id),
      symbol, side,
      fillPrice: fill, quantity: qty,
      notional: n(p?.notional), leverage: n(p?.leverage), margin,
      stopLoss: n(p?.stop_loss), takeProfit: n(p?.take_profit),
      liquidationPrice: n(p?.liquidation_price),
      markPrice: mark,
      unrealizedPnl: pnl,
      roiPct: pnl != null && margin != null && margin > 0 ? (pnl / margin) * 100 : null,
      openedAt: p?.opened_at == null ? null : String(p.opened_at),
    };
  });
}

export type PaperReadCode =
  /** 계좌를 읽었고 시작돼 있다 */
  | 'OK'
  /** 줄이 없거나, 줄은 있어도 시작한 적이 없다 */
  | 'NOT_STARTED'
  /** 조회가 실패했다. **'없다'가 아니다** */
  | 'UNREADABLE';

export interface PaperReadResult {
  ok: boolean;
  code: PaperReadCode;
  error: string | null;
  account: PaperAccountRow | null;
  positions: PaperPositionView[];
  equity: PaperEquity;
}

/** 심볼 → 현재가. 부르는 쪽이 갈아 끼울 수 있게 밖으로 뺀다(테스트) */
export type MarkPriceFn = (symbol: string) => Promise<number | null>;

async function defaultMarkPrice(symbol: string): Promise<number | null> {
  try {
    const { getPremiumIndex } = await import('../exchanges/binanceFutures');
    const px = await getPremiumIndex(symbol, false);
    const v = Number(px?.markPrice);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    // 못 받으면 null이다. 여기서 0을 돌려주면 평가손익이 통째로 거짓이 된다.
    return null;
  }
}

/**
 * 모의 계좌 + 열린 포지션 + 지금 얼마인가.
 *
 * **계좌를 만들지 않는다.** 시작은 사용자가 누르는 것이다.
 */
export async function readPaperEquity(
  sb: any,
  userId: string,
  deps?: { markPrice?: MarkPriceFn },
): Promise<PaperReadResult> {
  const empty = paperEquityOf({ account: null, positions: [] });
  const fail = (error: string): PaperReadResult => ({
    ok: false, code: 'UNREADABLE', error,
    account: null, positions: [],
    equity: {
      ...empty, state: 'UNREADABLE',
      note: `모의 계좌를 읽지 못했습니다 — ${error}`,
    },
  });

  let account: PaperAccountRow | null = null;
  try {
    const { data, error } = await sb.from('paper_accounts')
      .select('user_id, balance, initial_balance, total_pnl, total_fees, trade_count, win_count, started_at, updated_at')
      .eq('user_id', userId).maybeSingle();
    // **오류를 반드시 받아 본다.** 던지지 않는 실패가 '계좌 없음'이 되면
    // 화면이 "시작하기"를 보여 주고, 누르면 있던 장부가 초기화된다.
    if (error) return fail(String((error as any)?.message ?? error).slice(0, 200));
    account = (data ?? null) as PaperAccountRow | null;
  } catch (e: any) {
    return fail(String(e?.message || e).slice(0, 200));
  }

  // 시작한 적이 없으면 포지션을 읽으러 가지 않는다 — 있을 수 없다.
  if (!paperStartedOf(account).started) {
    return {
      ok: true, code: 'NOT_STARTED', error: null,
      account, positions: [],
      equity: paperEquityOf({ account: null, positions: [] }),
    };
  }

  let rows: PaperPositionRow[] = [];
  try {
    const { data, error } = await sb.from('paper_positions')
      .select('id, symbol, side, fill_price, quantity, notional, leverage, margin, stop_loss, take_profit, liquidation_price, opened_at')
      .eq('user_id', userId).eq('status', 'open')
      .order('opened_at', { ascending: false });
    // **실패를 0건으로 읽지 않는다.**
    if (error) return fail(String((error as any)?.message ?? error).slice(0, 200));
    rows = Array.isArray(data) ? data : [];
  } catch (e: any) {
    return fail(String(e?.message || e).slice(0, 200));
  }

  // 현재가는 심볼당 한 번만 받는다.
  const markPrice = deps?.markPrice ?? defaultMarkPrice;
  const symbols = Array.from(new Set(rows.map(r => String(r?.symbol ?? '')).filter(Boolean)));
  const marks = new Map<string, number>();
  await Promise.all(symbols.map(async (sym) => {
    const v = await markPrice(sym).catch(() => null);
    if (v != null && Number.isFinite(v) && v > 0) marks.set(sym, v);
  }));

  const positions = paperPositionViews(rows, marks);
  const equity = paperEquityOf({ account, positions: positions as any });
  return { ok: true, code: 'OK', error: null, account, positions, equity };
}
