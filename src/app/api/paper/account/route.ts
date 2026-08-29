// /api/paper/account — 가상 계좌 조회 + 충전/초기화
//
// GET  → 잔고·열린 포지션(현재가 기준 평가손익 포함)
// POST → { action: 'deposit', amount } | { action: 'reset' }
//
// 왜 충전이 있는가
// ────────────────
// 모의는 연습이다. 한 번 날려 먹으면 연습을 못 하게 되는 연습은 의미가
// 없다. 다만 **충전은 기록으로 남는다** — 얼마를 넣어가며 만든 수익률인지
// 모르면 그 성적표는 아무것도 말해주지 않는다. 그래서 초기자본을 같이
// 올리고, 수익률은 '넣은 돈 대비'로 계산되게 한다.
//
// 사용자 확인
// ───────────
// 예전 `/api/paper/positions`는 쿼리스트링의 userId를 그대로 믿었다.
// 남의 가상 계좌를 URL만 바꿔 들여다볼 수 있었다는 뜻이다. 여기서는
// 인증 헤더에서만 사용자를 얻는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 한 번에 넣을 수 있는 금액 상한. 가상이라도 자릿수를 잘못 넣으면 장부가 무의미해진다 */
const MAX_DEPOSIT = 1_000_000;

async function uidOf(req: NextRequest) {
  return resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
}

export async function GET(req: NextRequest) {
  const uid = await uidOf(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // **읽기는 계좌를 만들지 않는다.**
  //
  // 예전에는 `getPaperAccount()`였다. 그 함수는 줄이 없으면 10,000
  // USDT짜리 계좌를 **만든다** — 화면을 여는 것만으로 시작된 계좌가
  // 생겼고, 그래서 "모의투자 시작하기"는 영영 뜰 수 없었다.
  //
  // 읽고 계산하는 일은 `readPaperEquity` 한 곳에 있다 — 이 라우트와
  // `/api/wallets/overview`, `/api/wallets/snapshot`이 같은 답을 낸다.
  const { readPaperEquity } = await import('@/lib/portfolio/paperRead');
  const pr = await readPaperEquity(sb, uid);

  // **못 읽은 것을 '계좌 없음'으로 적지 않는다.** 화면이 시작하기를
  // 그리고 사용자가 누르면 있던 장부가 초기화된다.
  if (!pr.ok) {
    return NextResponse.json({
      ok: false, error: 'paper_unreadable',
      message: `모의 계좌를 읽지 못했습니다 (${String(pr.error ?? '').slice(0, 160)}) — `
        + '계좌가 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const positions = pr.positions;
  const eq = pr.equity;
  const acct: any = pr.account ?? {};
  const started = pr.code === 'READY';

  // **시작하지 않았으면 숫자를 만들지 않는다.** 0을 적으면 "다 잃었다"로
  // 읽히고, 자동 생성된 10,000을 적으면 고른 적 없는 종잣돈이 된다.
  const balance = started ? (Number(acct.balance) || 0) : null;
  const initial = started ? (Number(acct.initial_balance) || 0) : null;
  // 증거금은 열린 포지션이 물고 있다. 가용은 그만큼 뺀 값이다 —
  // 이걸 빼먹으면 같은 돈으로 몇 번이고 진입할 수 있게 된다.
  const usedMargin = positions.reduce((a, p) => a + (Number(p.margin) || 0), 0);

  // ── 오늘 손익 ──
  //
  // 오늘의 기준점. **없으면 오늘 손익을 계산하지 않는다** — 시작 잔고로
  // 대신 재면 그건 '오늘'이 아니라 '누적'이다.
  const { paperTodayPnl } = await import('@/lib/portfolio/paperAccount');
  let dayStartEquity: number | null = null;
  try {
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const { data: snap } = await (sb as any).from('account_equity_snapshots')
      .select('total_equity, taken_at')
      .eq('user_id', uid).eq('env', 'MOCK')
      .gte('taken_at', dayStart.toISOString())
      .order('taken_at', { ascending: true }).limit(1);
    const first = Array.isArray(snap) && snap.length ? snap[0] : null;
    const v = first == null ? null : Number((first as any).total_equity);
    dayStartEquity = v != null && Number.isFinite(v) ? v : null;
  } catch {
    // **못 읽은 것을 0으로 두지 않는다.** null이면 아래에서 "기준점 없음"이 된다.
    dayStartEquity = null;
  }
  const today = paperTodayPnl({ totalEquity: eq.totalEquity, dayStartEquity });

  return NextResponse.json({
    ok: true,
    // **시작 전에는 전부 null이다.** 0은 '없다'이고 시작 전은 '아직'이다.
    started,
    account: {
      balance,
      available: balance == null ? null : Math.max(0, balance - usedMargin),
      usedMargin: started ? usedMargin : null,
      initialBalance: initial,
      totalPnl: started ? (Number(acct.total_pnl) || 0) : null,
      totalFees: started ? (Number(acct.total_fees) || 0) : null,
      tradeCount: started ? (Number(acct.trade_count) || 0) : null,
      winCount: started ? (Number(acct.win_count) || 0) : null,
      returnPct: started && initial != null && initial > 0 && balance != null
        ? ((balance - initial) / initial) * 100 : null,
    },
    // ── 화면이 읽을 canonical 값 ──
    //
    // `account.balance`는 **현금**이지 총자산이 아니다. 지갑이 예전에
    // 선물 지갑잔고 하나를 '내 총자산'이라 적었던 것과 같은 함정이다.
    equity: {
      state: eq.state,
      cash: eq.cash, usedMargin: eq.usedMargin,
      unrealizedPnl: eq.unrealizedPnl,
      // **못 구했으면 null이다.** 화면이 0으로 그리면 안 된다.
      totalEquity: eq.totalEquity,
      knownCash: eq.knownCash,
      initialBalance: eq.initialBalance,
      realizedPnl: eq.realizedPnl,
      totalFees: eq.totalFees,
      returnPct: eq.returnPct,
      currency: 'USDT',
      note: eq.note,
    },
    today: { pnl: today.pnl, pct: today.pct, note: today.note, dayStartEquity },
    positions,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const uid = await uidOf(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const action = String(body?.action || 'deposit');

  if (action === 'reset') {
    // 열린 포지션이 있으면 초기화하지 않는다. 잔고만 되돌리면 포지션의
    // 증거금이 공중에 뜨고, 그 뒤의 손익은 아무 의미가 없다.
    const { count } = await sb.from('paper_positions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', uid).eq('status', 'open');
    if ((count ?? 0) > 0) {
      return NextResponse.json({
        ok: false, error: 'has_open_positions',
        message: `열린 모의 포지션이 ${count}건 있습니다. 먼저 정리한 뒤 초기화하세요.`,
      }, { status: 409 });
    }

    // ── 시작 금액을 고를 수 있다 ──
    //
    // 예전에는 10,000 USDT 고정이었다. 그러면 "모의투자 시작하기"가
    // 사실상 없는 것과 같다 — 얼마로 시작할지가 곧 전략 비교의 기준이다.
    //
    // **장부 통화는 USDT다.** `paper_positions`의 체결가·수수료가 전부
    // USDT이고 모의로 돌릴 전략도 USDT 선물이라, 장부 통화가 갈리면
    // 손익이 두 벌이 된다. 원화는 화면에서 환율로 환산해 **표시만** 한다.
    const { validateSeed } = await import('@/lib/portfolio/paperAccount');
    const { missingColumnOf } = await import('@/lib/portfolio/paperRead');
    const seed = body?.seed == null ? { code: 'OK' as const, value: 10_000, reason: '' }
      : validateSeed(body.seed);
    if (seed.code !== 'OK' || seed.value == null) {
      return NextResponse.json({
        ok: false, error: 'invalid_seed', code: seed.code, message: seed.reason,
      }, { status: 400 });
    }
    const start = seed.value;

    // ── 시작을 기록으로 남긴다 ──
    //
    // `started_at`(071)이 있어야 **사용자가 고른 계좌**와 읽기 경로가
    // 자동으로 만들어 둔 빈 계좌를 가를 수 있다.
    //
    // upsert인 이유: 예전 코드는 `update ... eq(user_id)`였고, 그 앞에
    // `getPaperAccount()`가 줄을 만들어 줬기 때문에만 동작했다. 읽기
    // 경로에서 생성을 걷어낸 지금은 **줄이 없는 것이 정상**이다.
    // 그리고 update는 줄이 없어도 오류가 아니다 — 0줄을 고치고 성공을
    // 돌려준다(RLS에 막혀도 같다). 그러면 화면은 시작됐다고 믿는다.
    //
    // `.select()`로 **실제로 돌아온 줄을 본다.** 0줄이면 실패다.
    const base = {
      user_id: uid,
      balance: start, initial_balance: start,
      total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0,
      updated_at: new Date().toISOString(),
    };
    const save = (row: any, cols: string) => (sb as any).from('paper_accounts')
      .upsert(row, { onConflict: 'user_id' }).select(cols);

    let { data: upRows, error: upErr } = await save(
      { ...base, started_at: new Date().toISOString() }, 'user_id, balance, started_at');

    // ── 마이그레이션이 아직 안 돌았을 수 있다 ──
    //
    // 배포와 마이그레이션의 순서는 보장되지 않는다. 071이 아직 안 돈
    // DB에서는 `started_at`을 쓰는 순간 PGRST204로 끝나고, **사용자는
    // 모의투자를 시작할 수 없다.** 그 칸은 시작 여부를 더 정확히 알기
    // 위한 것이지, 시작을 막으라고 만든 것이 아니다.
    //
    // 칸이 없으면 그 칸 없이 저장한다. 이때도 계좌는 제대로 만들어지고,
    // `paperStartedOf`가 잔고 변화로 시작을 알아본다.
    let startedAtRecorded = true;
    if (upErr && missingColumnOf(upErr, 'started_at')) {
      startedAtRecorded = false;
      ({ data: upRows, error: upErr } = await save(base, 'user_id, balance'));
    }

    // **실패를 성공으로 적지 않는다.** 화면이 시작됐다고 믿으면
    // 그 뒤의 모든 숫자가 남의 계좌 값이다.
    if (upErr) {
      return NextResponse.json({
        ok: false, error: 'reset_failed',
        message: `모의 계좌를 시작하지 못했습니다 — ${String(upErr.message).slice(0, 160)}`,
      }, { status: 500 });
    }
    if (!Array.isArray(upRows) || upRows.length === 0) {
      return NextResponse.json({
        ok: false, error: 'reset_no_row',
        message: '모의 계좌를 시작하지 못했습니다 — 저장된 줄이 없습니다 (권한 문제일 수 있습니다)',
      }, { status: 500 });
    }

    return NextResponse.json({
      ok: true, action: 'reset', balance: start, currency: 'USDT',
      // 진단용. **화면에 띄우는 문장이 아니다.**
      startedAtRecorded,
      message: `모의 계좌를 ${start.toLocaleString()} USDT로 시작했습니다`,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({
      ok: false, error: 'invalid_amount', message: `충전 금액이 유효하지 않습니다 (${body?.amount})`,
    }, { status: 400 });
  }
  if (amount > MAX_DEPOSIT) {
    return NextResponse.json({
      ok: false, error: 'amount_too_large',
      message: `한 번에 ${MAX_DEPOSIT.toLocaleString()} USDT까지 넣을 수 있습니다. `
             + '자릿수를 잘못 넣으면 이후 수익률이 아무 의미가 없어집니다.',
    }, { status: 400 });
  }

  // ── 충전은 시작한 계좌에만 ──
  //
  // 여기서도 계좌를 만들지 않는다. 시작하지 않았는데 충전이 계좌를
  // 만들면, 사용자가 고른 적 없는 종잣돈이 다시 생긴다.
  const { readPaperEquity } = await import('@/lib/portfolio/paperRead');
  const pr = await readPaperEquity(sb, uid);
  if (!pr.ok) {
    return NextResponse.json({
      ok: false, error: 'paper_unreadable',
      message: `모의 계좌를 읽지 못했습니다 (${String(pr.error ?? '').slice(0, 160)}) — `
        + '계좌가 없다는 뜻이 아닙니다',
    }, { status: 503 });
  }
  if (pr.code !== 'READY') {
    return NextResponse.json({
      ok: false, error: 'not_started',
      message: '모의투자를 아직 시작하지 않았습니다 — 시작 금액을 고른 뒤에 충전할 수 있습니다',
    }, { status: 409 });
  }
  // **읽은 잔고에 더해서 덮어쓰지 않는다.**
  //
  // 워커는 60초마다 모의 청산을 돈다. 충전과 청산이 겹치면 둘 다 옛
  // balance를 읽고 각자 쓴다 — 한쪽이 조용히 사라진다. 그래서 증가
  // 연산으로 민다(마이그레이션 072). 초기자본도 같이 올린다: 안 올리면
  // 넣은 돈이 수익으로 잡혀 수익률이 부풀려진다.
  let balance: number; let initial: number;
  try {
    const { data, error } = await (sb as any).rpc('paper_deposit', { p_user_id: uid, p_amount: amount });
    if (error) throw new Error(String((error as any).message ?? error));
    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row || row.applied !== true) {
      return NextResponse.json({
        ok: false, error: 'not_started',
        message: '모의투자를 아직 시작하지 않았습니다 — 시작 금액을 고른 뒤에 충전할 수 있습니다',
      }, { status: 409 });
    }
    balance = Number(row.new_balance);
    initial = Number(row.new_initial);
  } catch (e: any) {
    return NextResponse.json({
      ok: false, error: 'update_failed',
      message: `충전을 기록하지 못했습니다 (${String(e?.message ?? e).slice(0, 160)})`,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true, action: 'deposit', amount, balance, initialBalance: initial,
    message: `${amount.toLocaleString()} USDT를 넣었습니다 (가상) · 잔고 ${balance.toLocaleString()}`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
