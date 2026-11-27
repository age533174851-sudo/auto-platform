// /api/paper/run — 데모(모의) 자동매매 **한 사이클**
//
// POST  실제로 청산·진입을 실행한다
// GET   같은 판정을 하되 **아무것도 실행하지 않는다** (왜 안 들어가는지 보기)
//
// 한 사이클이 하는 일
// ───────────────────
//   1. 열린 모의 포지션을 지금 마크가로 점검 → 청산가/손절/익절/보유시간
//   2. 오늘 손실 한도 확인 (닿았으면 진입만 잠근다. 청산은 위에서 이미 끝났다)
//   3. 국면 판정 → 진입 전략이 방향을 정한다 (기본은 추세 추종)
//
// 전략은 `signal`로 고른다 (기본 `trend-follow` — 지금까지 돌던 그 규칙).
// GET은 고르지 않아도 **전략 전부의 판정을 나란히** 돌려준다. 같은 국면
// 데이터로 돌리므로, 어느 전략이 지금 무엇을 보고 있는지 비교할 수 있다.
// 아무것도 실행하지 않으니 비교에 돈이 들지 않는다.
//
// **청산이 먼저다.** 진입부터 하면 자리가 없어 못 들어가고, 무엇보다
// 손절은 미룰 수 없다.
//
// 왜 daily-ladder를 안 쓰는가
// ───────────────────────────
// daily-ladder는 `ladder_cycles`·`ladder_daily_trades`(마이그레이션 017)를
// 쓴다. 그게 적용되기 전에는 아예 못 돈다. 데모는 지금 바로 돌아야 하므로
// 010(paper_accounts·paper_positions)만 있으면 되는 경로를 따로 둔다.
//
// 왜 진입은 /api/paper/order를 다시 부르는가
// ──────────────────────────────────────────
// 여기서 직접 openPaperPosition을 부르면 손절 필수·배율 상한·증거금·중복
// 방지·일일 한도 검사가 **두 곳에 생긴다.** 둘은 반드시 어긋난다. 주문이
// 나가는 길은 하나로 둔다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { planExits, planEntry, readRunnerConfig, type OpenPaperPos } from '@/lib/engine/paperRunner';
import {
  ENTRY_SIGNAL_IDS, ENTRY_SIGNAL_LABEL, DEFAULT_ENTRY_SIGNAL,
  parseEntrySignal, type EntrySignalId,
} from '@/lib/engine/entrySignals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 쓸 진입 전략. 없으면 기본값(추세 추종).
 *
 * 모르는 이름은 **기본값으로 대신하지 않는다.** 대신하면 오타 하나로
 * 다른 전략이 돌면서 그 전략의 기록에 남는다.
 */
function signalFrom(body: any): { signal: EntrySignalId; bad: string | null } {
  const raw = body?.signal ?? body?.strategy;
  if (raw == null || String(raw).trim() === '') return { signal: DEFAULT_ENTRY_SIGNAL, bad: null };
  const got = parseEntrySignal(raw);
  return got
    ? { signal: got, bad: null }
    : { signal: DEFAULT_ENTRY_SIGNAL,
        bad: `알 수 없는 진입 전략입니다: ${String(raw).slice(0, 40)} `
           + `(가능: ${ENTRY_SIGNAL_IDS.join(' · ')})` };
}

/** 데모가 볼 종목. PAPER_SYMBOLS로 바꾼다 */
function symbolsFrom(body: any): string[] {
  const raw = body?.symbols ?? body?.symbol ?? process.env.PAPER_SYMBOLS ?? 'BTCUSDT';
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/);
  const out = list.map(s => String(s || '').toUpperCase().replace('/', '').trim()).filter(Boolean);
  return out.length ? Array.from(new Set(out)) : ['BTCUSDT'];
}

async function markPriceOf(symbol: string): Promise<number | null> {
  try {
    const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
    const px = await getPremiumIndex(symbol, false);
    const v = Number(px?.markPrice);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

function toOpenPos(r: any): OpenPaperPos {
  const n = (v: any) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    id: String(r.id),
    symbol: String(r.symbol || '').toUpperCase(),
    side: String(r.side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG',
    fillPrice: Number(r.fill_price) || Number(r.entry_price) || 0,
    quantity: Number(r.quantity) || 0,
    stopLoss: n(r.stop_loss),
    takeProfit: n(r.take_profit),
    liquidationPrice: n(r.liquidation_price),
    openedAt: r.opened_at ? new Date(r.opened_at).getTime() : Date.now(),
  };
}

async function cycle(req: NextRequest, uid: string, sb: any, body: any, dryRun: boolean) {
  const cfg = readRunnerConfig((k) => process.env[k]);
  const symbols = symbolsFrom(body);
  const now = Date.now();
  const steps: any[] = [];

  // ── 1. 열린 포지션 점검 ────────────────────────────────────────
  //
  // **기본 계좌의 포지션만.** 이 러너는 기본 계좌 장부로 돌고, 새 진입도
  // 기본 계좌로 들어간다. 전용 계좌(챌린지 등) 포지션을 여기서 함께 보면
  // 그 계좌의 포지션을 이 러너가 청산하게 된다.
  //
  // 전용 계좌 포지션의 손절·청산가 감시는 **exit-monitor가 전 계좌를 보며**
  // 맡는다 — 안전망을 좁히지 않았다.
  const { resolvePaperScope, paperScopeFailed } = await import('@/lib/engine/paperScope');
  const scope = await resolvePaperScope(sb, uid);
  if (paperScopeFailed(scope)) {
    return {
      ok: false, error: 'positions_unreadable',
      message: `모의 계좌를 정하지 못했습니다 — ${scope.reason}`,
    } as any;
  }
  const { data: rows, error: readErr } = await sb.from('paper_positions')
    .select('id, symbol, side, fill_price, entry_price, quantity, stop_loss, take_profit, liquidation_price, opened_at, margin')
    .eq('user_id', uid).eq('paper_account_id', scope.accountId).eq('status', 'open');

  if (readErr) {
    // 무엇이 열려 있는지 모르는 채로 새로 넣지 않는다. 중복 진입이 되고,
    // 손절이 걸려야 할 포지션을 그냥 두는 것이기도 하다.
    return {
      ok: false, error: 'positions_unreadable',
      message: '열린 모의 포지션을 읽지 못해 이번 사이클을 건너뜁니다',
      steps,
    };
  }

  const open = (Array.isArray(rows) ? rows : []).map(toOpenPos);
  const marks: Record<string, number | null> = {};
  for (const s of Array.from(new Set([...open.map(p => p.symbol), ...symbols]))) {
    marks[s] = await markPriceOf(s);
  }

  const closed: any[] = [];
  for (const s of Array.from(new Set(open.map(p => p.symbol)))) {
    const group = open.filter(p => p.symbol === s);
    const actions = planExits(group, marks[s], now, cfg);
    for (const a of actions) {
      if (dryRun) { closed.push({ ...a, symbol: s, dryRun: true }); continue; }
      const { closePaperPosition } = await import('@/lib/engine/paperStore');
      const r = await closePaperPosition(sb, a.positionId as string, marks[s] as number, a.exitReason as any);
      closed.push({
        positionId: a.positionId, symbol: s, exitReason: a.exitReason, reason: a.reason,
        ok: r.ok, realizedPnl: r.realizedPnl, pnlPct: r.pnlPct, error: r.error,
      });
    }
    if (marks[s] == null && group.length) {
      steps.push({ step: 'exit', symbol: s, skipped: true,
        reason: '시세를 받지 못해 이 종목의 청산 판정을 건너뛰었습니다' });
    }
  }
  steps.push({ step: 'exit', checked: open.length, closed: closed.length, actions: closed });

  // 방금 닫힌 것은 자리에서 빠진다
  const stillOpen = open.filter(p => !closed.some(c => c.positionId === p.id && c.ok !== false));

  // ── 2. 오늘 손실 한도 ──────────────────────────────────────────
  // 청산 뒤에 본다. 한도에 닿았어도 나가는 길은 막지 않는다.
  try {
    const { collectPaperDailyLoss } = await import('@/lib/risk/dailyLossCheck');
    const dl = await collectPaperDailyLoss({ sb, userId: uid });
    if (dl.verdict.blockEntries) {
      steps.push({ step: 'entry', entered: false, reason: `[일일 한도] ${dl.verdict.reason}` });
      return { ok: true, dryRun, cfg, symbols, closed, entered: null,
        message: `청산 ${closed.length}건 · 진입 없음 — ${dl.verdict.reason}`, steps };
    }
  } catch {
    steps.push({ step: 'entry', entered: false,
      reason: '오늘 손실 한도를 확인하지 못해 진입하지 않았습니다' });
    return { ok: true, dryRun, cfg, symbols, closed, entered: null,
      message: `청산 ${closed.length}건 · 진입 없음 — 손실 한도 확인 실패`, steps };
  }

  // ── 3. 진입 ───────────────────────────────────────────────────
  // 가용 잔고 = 잔고 − 열린 포지션이 물고 있는 증거금.
  //
  // 계산은 `paperAvailable` 한 곳에 있다 — `/api/paper/account` ·
  // `/api/paper/positions` · `/api/paper/order`와 같은 함수다. 예전 이 자리는
  // `Number(p.margin) || 0`이었다. 못 읽은 증거금을 0으로, 음수 증거금은
  // 더해서 세어 **가용 잔고가 부푼 채로 진입 수량을 계획했다.**
  // 못 읽었으면 `null`이고, `planEntry`가 진입하지 않는다.
  let available: number | null = null;
  try {
    const { getPaperAccount } = await import('@/lib/engine/paperStore');
    const { availableView } = await import('@/lib/engine/paperAvailable');
    const acct = await getPaperAccount(sb, uid);
    const openRows = (Array.isArray(rows) ? rows : [])
      .filter((r: any) => stillOpen.some(p => p.id === String(r.id)));
    available = availableView(acct?.balance, openRows).available;
  } catch { available = null; }

  const { collectRegime } = await import('@/lib/risk/regimeCheck');
  let entered: any = null;
  const tried: any[] = [];
  const { signal, bad: badSignal } = signalFrom(body);

  for (const symbol of symbols) {
    if (stillOpen.length >= cfg.maxOpenPositions) {
      tried.push({ symbol, kind: 'NONE',
        reason: `이미 ${stillOpen.length}개 열려 있습니다 (최대 ${cfg.maxOpenPositions})` });
      break;
    }
    if (stillOpen.some(p => p.symbol === symbol)) {
      tried.push({ symbol, kind: 'NONE', reason: '이 종목은 이미 열려 있습니다' });
      continue;
    }

    // 방향을 정하기 전에 국면을 본다. 국면이 알려주는 추세가 곧 방향이다.
    // side를 넣어야 하는 API라 임시로 LONG을 넣고, 실제 방향은 아래에서
    // regime.trend로 정한다 — 판정에 쓰는 것은 trend뿐이다.
    const rg = await collectRegime({ symbol, side: 'LONG' });
    const dataOk = !!rg.verdict.regime?.dataOk;
    const status: 'ok' | 'blocked' | 'unknown' =
      !dataOk ? 'unknown' : (rg.verdict.blockEntries ? 'blocked' : 'ok');

    const common = {
      symbol, regimeStatus: status,
      regimeReason: rg.verdict.reason,
      trend: dataOk ? (rg.verdict.regime?.trend ?? null) : null,
      // 국면이 이미 계산해 둔 관측값을 그대로 전략에 넘긴다. 전에는
      // 여기까지 와 놓고 추세 세 값만 넘겨서, 역추세·돌파는 쓸 재료가
      // 아예 도착하지 않았다.
      view: dataOk ? (rg.verdict.regime?.view ?? null) : null,
      markPrice: marks[symbol] ?? null,
      availableUsd: available,
      openCount: stillOpen.length,
      cfg,
    };
    const plan = planEntry({ ...common, signal });

    // 아무것도 실행하지 않는 조회에서는 **전략 전부**를 같은 데이터로
    // 돌려 나란히 보여 준다. 어느 전략이 지금 무엇을 보고 있는지 비교하는
    // 데 돈이 들지 않아야 한다.
    const signals = dryRun
      ? ENTRY_SIGNAL_IDS.map(id => {
          const p = planEntry({ ...common, signal: id });
          return { signal: id, label: ENTRY_SIGNAL_LABEL[id], kind: p.kind,
            side: p.side ?? null, reason: p.reason };
        })
      : undefined;

    tried.push({ symbol, ...plan, signal, regime: rg.verdict.regime?.label ?? null,
      view: dryRun ? (rg.verdict.regime?.view ?? null) : undefined,
      ...(signals ? { signals } : {}) });
    if (plan.kind !== 'OPEN') continue;

    if (dryRun) { entered = { symbol, ...plan, dryRun: true }; break; }

    // 주문은 **기존 경로로** 나간다 (파일 상단 주석 참조).
    const { POST: placePaper } = await import('../order/route');
    const headers = new Headers();
    for (const k of ['authorization', 'x-user-id', 'x-dev-token', 'content-type']) {
      const v = req.headers.get(k);
      if (v) headers.set(k, v);
    }
    headers.set('content-type', 'application/json');
    const orderReq = new NextRequest(new URL('/api/paper/order', req.url), {
      method: 'POST', headers,
      body: JSON.stringify({
        symbol, side: plan.side, quantity: plan.quantity,
        leverage: cfg.leverage, stopPrice: plan.stopPrice,
        takeProfit: plan.takeProfit ?? null,
        strategyId: 'demo-runner',
      }),
    });
    const res = await placePaper(orderReq);
    const out = await res.json().catch(() => ({}));
    entered = { symbol, side: plan.side, quantity: plan.quantity,
      stopPrice: plan.stopPrice, takeProfit: plan.takeProfit,
      reason: plan.reason, ok: !!out?.ok,
      message: out?.message || out?.error, status: res.status };
    break;   // 한 사이클에 하나만 넣는다
  }

  steps.push({ step: 'entry', tried, entered });

  const msg = `청산 ${closed.filter(c => c.ok !== false).length}건 · `
    + (entered
        ? (entered.ok === false
            ? `진입 실패 (${entered.message ?? ''})`
            : `${entered.side} 진입 ${entered.symbol}`)
        : `진입 없음 — ${tried[0]?.reason ?? '조건 미충족'}`);

  return { ok: true, dryRun, cfg, symbols, available, closed, entered, tried,
    signal, signalLabel: ENTRY_SIGNAL_LABEL[signal],
    // 오타를 조용히 삼키지 않는다 — 기본값으로 돌았음을 적어 둔다.
    ...(badSignal ? { signalWarning: badSignal } : {}),
    message: badSignal ? `${msg} · ${badSignal} — 기본 전략으로 판정했습니다` : msg,
    steps };
}

async function handle(req: NextRequest, dryRun: boolean) {
  let body: any = {};
  if (!dryRun) { try { body = await req.json(); } catch { body = {}; } }
  else {
    const sp = req.nextUrl.searchParams;
    body = {
      ...(sp.get('symbols') || sp.get('symbol')
        ? { symbols: sp.get('symbols') || sp.get('symbol') } : {}),
      ...(sp.get('signal') || sp.get('strategy')
        ? { signal: sp.get('signal') || sp.get('strategy') } : {}),
    };
  }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  try {
    const r = await cycle(req, uid, sb, body, dryRun);
    return NextResponse.json(r, {
      status: r.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    // 사이클이 터졌으면 터졌다고 말한다. 조용히 200을 주면 화면에는
    // "돌고 있음"으로 남고 실제로는 아무것도 안 도는 상태가 된다.
    return NextResponse.json({
      ok: false, error: 'cycle_failed', message: String(e?.message || e),
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(req: NextRequest) { return handle(req, false); }
export async function GET(req: NextRequest)  { return handle(req, true);  }
