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
import {
  paperEquityOf, paperAccountStateOf,
  type PaperAccountRow, type PaperEquity, type PaperAccountCode,
} from './paperAccount';

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

/** `paperAccountStateOf`와 같은 코드를 쓴다 — 판정을 두 벌로 만들지 않는다 */
/**
 * 이 오류가 **"그 칸이 아직 없다"**인가.
 *
 * 배포와 마이그레이션의 순서는 보장되지 않는다. 새 칸을 쓰는 코드가
 * 먼저 떠 있는 창이 반드시 생기고, 그 창에서 PostgREST는 두 가지로
 * 답한다:
 *
 *   select  → 42703  `column paper_accounts.started_at does not exist`
 *   upsert  → PGRST204 `Could not find the 'started_at' column ... schema cache`
 *
 * **이 문자열들을 사용자 화면에 그대로 띄우지 않는다.** 판정에만 쓴다.
 */
export function missingColumnOf(err: any, column: string): boolean {
  if (!err || !column) return false;
  const code = String((err as any)?.code ?? '');
  const msg = String((err as any)?.message ?? err ?? '');
  if (!msg.includes(column)) return false;
  if (code === '42703' || code === 'PGRST204') return true;
  return /does not exist/i.test(msg) || /could not find/i.test(msg);
}

export type PaperReadCode = PaperAccountCode;

export interface PaperReadResult {
  ok: boolean;
  code: PaperReadCode;
  /** **원문 오류. 사용자 화면에 그대로 띄우지 않는다** — 진단용이다 */
  error: string | null;
  account: PaperAccountRow | null;
  positions: PaperPositionView[];
  equity: PaperEquity;
  /**
   * 이 DB가 코드가 기대하는 칸을 갖고 있는가.
   *
   * `startedAt: false`면 071이 아직 안 돌았다는 뜻이다. 그때도 **읽기는
   * 성공해야 한다** — 마이그레이션이 늦었다는 이유로 사용자의 계좌를
   * "없다"고 말하면 안 된다.
   */
  schema: { startedAt: boolean | null };
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
  const fail = (error: string): PaperReadResult => ({
    ok: false, code: 'UNREADABLE', error,
    account: null, positions: [], schema: { startedAt: null },
    // **원문 오류는 note에 넣지 않는다.** note는 사용자가 읽는 문장이고,
    // `column paper_accounts.started_at does not exist` 같은 문자열이
    // 지갑 메인에 그대로 뜬 적이 있다. 원문은 `error`에만 남는다.
    equity: paperEquityOf({ account: null, positions: [], ok: false }),
  });

  let account: PaperAccountRow | null = null;
  let hasStartedAt: boolean | null = null;
  try {
    // ── **칸 목록을 적지 않는다** ──
    //
    // 예전에는 `select('... started_at ...')`였다. 071이 아직 안 돈
    // DB에서는 그 select 자체가 실패하고, PostgREST가 돌려주는
    // `column paper_accounts.started_at does not exist`가 그대로
    // 지갑 화면에 떴다. **마이그레이션이 늦었다는 이유로 계좌를 못
    // 읽으면 안 된다** — 배포와 마이그레이션의 순서는 보장되지 않는다.
    //
    // `*`로 읽고, 칸이 실제로 왔는지를 값으로 확인한다.
    const { data, error } = await sb.from('paper_accounts')
      .select('*').eq('user_id', userId).maybeSingle();
    // **오류를 반드시 받아 본다.** 던지지 않는 실패가 '계좌 없음'이 되면
    // 화면이 "시작하기"를 보여 주고, 누르면 있던 장부가 초기화된다.
    if (error) return fail(String((error as any)?.message ?? error).slice(0, 200));
    account = (data ?? null) as PaperAccountRow | null;
    hasStartedAt = account == null
      ? null   // 줄이 없으면 칸 유무를 알 수 없다 — 모른다고 둔다
      : Object.prototype.hasOwnProperty.call(account, 'started_at');
  } catch (e: any) {
    return fail(String(e?.message || e).slice(0, 200));
  }

  const state = paperAccountStateOf({
    ok: true, row: account,
    hasStartedAtColumn: hasStartedAt == null ? undefined : hasStartedAt,
  });

  // 계좌가 없거나 · 빈 껍데기이거나 · 줄은 있는데 잔고를 못 읽었다.
  // 어느 쪽이든 포지션을 읽으러 가지 않는다.
  if (state.code !== 'READY') {
    return {
      ok: state.code !== 'UNREADABLE',
      code: state.code,
      error: state.code === 'UNREADABLE' ? state.reason : null,
      account, positions: [], schema: { startedAt: hasStartedAt },
      equity: paperEquityOf({
        account, positions: [],
        hasStartedAtColumn: hasStartedAt == null ? undefined : hasStartedAt,
      }),
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
  const equity = paperEquityOf({
    account, positions: positions as any,
    hasStartedAtColumn: hasStartedAt == null ? undefined : hasStartedAt,
  });
  return {
    ok: true, code: 'READY', error: null,
    account, positions, equity, schema: { startedAt: hasStartedAt },
  };
}
