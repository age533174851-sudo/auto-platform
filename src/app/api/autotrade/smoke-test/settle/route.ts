// /api/autotrade/smoke-test/settle
//
// **브라우저를 닫아도 여기서 닫는다.**
//
// 스모크 테스트는 "지금 진입하고 10분 뒤에 닫는다"이다. 그 10분 사이에
// 사람은 화면을 닫는다 — 실제로 그러라고 만든 기능이다. 화면 타이머로
// 닫으면 탭을 닫는 순간 100배 포지션이 그대로 남고, 그건 배관 확인이
// 아니라 사고다.
//
// 그래서 마감 시각은 DB에 있고, 24시간 도는 Fly Worker가 이 경로를
// 1분마다 부른다. GitHub 크론도 예비로 같은 경로를 부를 수 있다 —
// **둘이 같은 줄을 동시에 닫지 않게** 선점(claim)이 있다.
//
// 닫고 끝이 아니다
// ────────────────
// 청산 주문을 보낸 것과 포지션이 없어진 것은 다른 사실이고, 포지션이
// 0인 것과 조건부 주문이 0인 것도 다른 사실이다. 어제 Gate에 조건부
// 주문 4개가 쌓인 이유가 그 둘을 같이 본 것이다.
// **고아 주문이 남으면 이 테스트는 FAIL이다.**

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { closeDue, stepsOf, smokeVerdict, SMOKE_STRATEGY_ID } from '@/lib/smoke/smokePlan';
import { closeVerdict } from '@/lib/engine/closeEvidence';
import { orphanCleanupPlan, cleanupOutcome, residualVerdict } from '@/lib/engine/orderOwnership';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isMissing = (m: any) => /does not exist|schema cache|relation/i.test(String(m));

/** 두 실행기가 같은 순간에 같은 줄을 닫지 않게 하는 유예 */
const CLAIM_TTL_MS = 120_000;

function safeEqual(a: any, b: any): boolean {
  const x = String(a ?? ''); const y = String(b ?? '');
  if (!x || !y || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

const step = (state: string, note: string) => ({ state, note: String(note ?? '').slice(0, 400) });

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET || '';
  const byAdmin = !!adminSecret && safeEqual(req.headers.get('x-admin-secret'), adminSecret);

  let body: any = {};
  try { body = await req.json(); } catch { /* 워커는 본문 없이 부를 수 있다 */ }

  // 실행기가 부를 때는 admin 시크릿, 사람이 부를 때는 로그인 토큰.
  let userId: string | null = byAdmin ? (String(body?.userId || '') || null) : null;
  if (!byAdmin) {
    userId = await resolveUserId(
      req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
    if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const nowMs = Date.now();

  // ── 닫을 때가 된 줄을 고른다 ──
  //
  // **`state`와 마감 시각을 둘 다 본다.** 시각만 보면 아직 진입 중인
  // 줄이나 이미 끝난 줄까지 닫으러 간다.
  let rows: any[] = [];
  try {
    let q = (sb as any).from('smoke_tests').select('*').eq('state', 'HOLDING');
    if (userId) q = q.eq('user_id', userId);
    if (body?.id) q = q.eq('id', String(body.id));
    const { data, error } = await q.order('hold_until', { ascending: true }).limit(20);
    if (error) throw new Error(error.message);
    rows = data || [];
  } catch (e: any) {
    if (isMissing(e?.message)) {
      return NextResponse.json({
        ok: false, error: 'table_missing',
        message: 'smoke_tests 표가 없습니다 — 마이그레이션 052를 적용하세요',
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: 'query_failed', message: String(e?.message || e) }, { status: 500 });
  }

  const settled: any[] = [];
  const skipped: any[] = [];

  for (const row of rows) {
    const due = closeDue({ nowMs, state: row.state, holdUntil: row.hold_until });
    if (!due.due) { skipped.push({ id: row.id, code: due.code, reason: due.reason }); continue; }

    // ── 선점 ──
    //
    // 워커와 예비 실행기가 동시에 깨어날 수 있다. 둘이 같은 줄에
    // reduceOnly 청산을 각각 보내면 하나는 반대 방향 신규 진입이 된다.
    // **읽었을 때와 값이 같을 때만** 바꾼다(compare-and-set).
    const claimCutoff = new Date(nowMs - CLAIM_TTL_MS).toISOString();
    let claim = (sb as any).from('smoke_tests')
      .update({ settle_claimed_at: new Date(nowMs).toISOString(), state: 'CLOSING' })
      .eq('id', row.id).eq('state', 'HOLDING');
    claim = row.settle_claimed_at == null
      ? claim.is('settle_claimed_at', null)
      : claim.lt('settle_claimed_at', claimCutoff);
    const { data: claimed, error: claimErr } = await claim.select('id');

    if (claimErr) {
      // **선점 실패를 '남이 가져갔다'로 읽지 않는다.** 그러면 이 줄은
      // 아무도 안 닫는데 로그에는 정상으로 보인다.
      skipped.push({ id: row.id, code: 'CLAIM_FAILED', reason: String(claimErr.message) });
      continue;
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      skipped.push({ id: row.id, code: 'CLAIM_LOST', reason: '다른 실행기가 이미 이 테스트를 닫고 있습니다' });
      continue;
    }

    settled.push(await settleOne(sb, row));
  }

  return NextResponse.json({
    ok: true, settled, skipped, checked: rows.length,
    source: byAdmin ? 'RUNNER' : 'USER',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/** 한 줄을 닫고 판정까지 적는다 */
async function settleOne(sb: any, row: any): Promise<any> {
  const steps: Record<string, any> = { ...(row.steps && typeof row.steps === 'object' ? row.steps : {}) };
  steps.HOLD = step('PASS', `${row.hold_min}분 유지 완료`);

  const patch: Record<string, any> = {};
  try {
    const { loadFuturesCreds } = await import('@/lib/exchanges/loadCreds');
    const ops = await import('@/lib/engine/venuePositionOps');

    const creds = await loadFuturesCreds(sb, row.user_id, row.connection_id);
    if (!creds.ok) {
      // **자격증명을 못 읽으면 닫을 수가 없다.** 이건 UNKNOWN이지
      // "닫았다"가 아니다. HOLDING으로 되돌려 다음 주기에 다시 시도한다.
      steps.CLOSE = step('UNKNOWN', `거래소 자격증명을 읽지 못했습니다: ${(creds as any).message}`);
      await save(sb, row.id, { state: 'HOLDING', steps, settle_claimed_at: null });
      return { id: row.id, verdict: 'RETRY', reason: (creds as any).message };
    }
    const venue = {
      exchange: (creds as any).exchange as 'binance' | 'gate',
      apiKey: (creds as any).key, apiSecret: (creds as any).secret,
      testnet: (creds as any).testnet as boolean,
    };

    // ── 청산 ──
    //
    // reduceOnly 전량청산이다. **진입 관문이 막혀 있어도 이건 나간다** —
    // 못 여는 것은 불편이고 못 닫는 것은 사고다.
    //
    // 청산 지연을 잰다: 마감 시각과 실제로 닫힌 순간 사이. 10회를
    // 돌리는 이유의 절반은 "되는가"이고 나머지 절반은 "얼마나 걸리는가"다.
    const closeT0 = Date.now();
    const before = await ops.readOpenPosition(venue, row.symbol);
    const closeRes = await ops.closeSymbolPosition(venue, row.symbol, before.side ?? row.side);
    const after = await ops.readOpenPosition(venue, row.symbol);
    const closeMs = Date.now() - closeT0;
    // 마감 시각으로부터 얼마나 늦게 닫혔는가. **못 읽으면 null이다.**
    const dueMs = row.hold_until ? Date.parse(String(row.hold_until)) : NaN;
    patch.exit_latency_ms = Number.isFinite(dueMs) ? Math.max(0, Math.round(closeT0 - dueMs)) : null;
    patch.api_latency_ms_max = Math.max(Number(row.api_latency_ms_max) || 0, closeMs);

    const cv = closeVerdict({
      before: { ok: before.ok, found: before.found, amount: before.qty ?? null, error: before.error },
      order: { attempted: closeRes.attempted, ok: closeRes.ok, error: closeRes.error },
      after: { ok: after.ok, found: after.found, amount: after.qty ?? null, error: after.error },
    });

    steps.CLOSE = closeRes.attempted && closeRes.ok
      ? step('PASS', '전량 청산 주문 접수')
      : step(closeRes.attempted ? 'FAIL' : 'UNKNOWN', closeRes.error || '청산 주문을 보내지 못했습니다');

    // **접수와 0은 다른 사실이다.** 재조회가 판정한다.
    steps.POSITION_ZERO = cv.closed
      ? step('PASS', cv.reason)
      : step(cv.needsReconcile ? 'UNKNOWN' : 'FAIL', cv.reason);

    // ── 남은 보호주문 ──
    //
    // 여기가 어제 Gate에 조건부 주문 4개가 쌓인 자리다. **내 것만**
    // 취소한다 — 같은 계좌의 다른 전략이 걸어 둔 손절을 지우지 않는다.
    const orders = await ops.readProtectiveOrders(venue, row.symbol);

    // **걸 때 받아 적어 둔 주문 번호를 쓴다.** 식별자(text)가 깨져도 이
    // 번호로는 내 것을 확정할 수 있다. 실제로 스모크 SL/TP의
    // clientOrderId 형식이 깨져 UNKNOWN이 되면서 Gate에 2건이 남았다.
    const ownedIds = [row.sl_order_id, row.tp_order_id].filter(Boolean).map(String);

    const plan = orphanCleanupPlan({
      position: { ok: after.ok, found: after.found, qty: after.qty },
      orders, myStrategyId: SMOKE_STRATEGY_ID, ownedIds,
    });
    const cancelRes = plan.cancel.length
      ? await ops.cancelProtectiveOrders(venue, row.symbol, plan.cancel)
      : { cancelled: [] as string[], failed: [] as any[] };
    const cleaned = cleanupOutcome({ plan, cancelled: plan.ok ? cancelRes.cancelled : null });

    // ── 취소한 뒤 **다시 읽어서** 정말 0인지 확인한다 ──
    //
    // 취소 응답은 접수다. 그리고 판정은 `residualVerdict`가 한다 —
    // 예전에는 여기서 "내 것으로 판별된 개수"만 셌고, 그래서 **판별하지
    // 못한 주문 2건이 남아 있는데 0으로 읽혀 PASS가 찍혔다.**
    const leftover = plan.ok ? await ops.readProtectiveOrders(venue, row.symbol) : orders;
    const rv = residualVerdict({
      position: { ok: after.ok, found: after.found, qty: after.qty },
      orders: leftover, myStrategyId: SMOKE_STRATEGY_ID, ownedIds,
    });

    // 취소가 실제로 됐는지도 SL·TP **각각** 적는다. 하나로 뭉치면
    // "무엇이 안 지워졌는지"가 사라진다.
    const gone = (id: any) => id && !rv.knownStillPresent.includes(String(id));
    const slNote = row.sl_order_id ? (gone(row.sl_order_id) ? `손절 ${row.sl_order_id} 취소 확인` : `손절 ${row.sl_order_id} 남음`) : '손절 번호 없음';
    const tpNote = row.tp_order_id ? (gone(row.tp_order_id) ? `익절 ${row.tp_order_id} 취소 확인` : `익절 ${row.tp_order_id} 남음`) : '익절 번호 없음';

    steps.ORDERS_ZERO = rv.ok
      ? step('PASS', `${slNote} · ${tpNote} · ${rv.reason}`)
      : rv.code === 'ORDERS_UNKNOWN'
        ? step('UNKNOWN', `${rv.reason} — ${cleaned.reason}`)
        // **남으면 FAIL이다.** 그 주문이 다음 진입을 친다.
        : step('FAIL', `${slNote} · ${tpNote} · ${rv.reason}`);

    // ── 대조 ──
    //
    // 장부(이 줄)와 거래소가 같은 말을 하는가. **네 가지가 전부 증명돼야
    // 한다:** 손절 취소 · 익절 취소 · 포지션 0 · 이 테스트 소유 잔여 0.
    steps.RECONCILE = (cv.closed && rv.ok)
      ? step('PASS', '장부와 거래소가 일치합니다 — 손절/익절 취소 확인 · 포지션 0 · 잔여 0')
      : step(cv.closed === false && !cv.needsReconcile ? 'FAIL' : rv.ok === false && rv.code !== 'ORDERS_UNKNOWN' ? 'FAIL' : 'UNKNOWN',
        `대조하지 못했습니다 — 포지션 ${cv.code} · 잔여 ${rv.code}`);

    patch.closed_at = new Date().toISOString();
    // 남은 주문의 자세한 내역. **`steps` 안에 둔다** — 새 칸을 만들면
    // 052를 다시 적용해야 하고, 그 사이에 이 갱신이 통째로 실패한다.
    // `stepsOf`는 정해진 단계 이름만 읽으므로 이 키는 화면에 안 나온다.
    steps._residual = { code: rv.code, mine: rv.mine, unknown: rv.unknown,
      foreign: rv.foreign, knownStillPresent: rv.knownStillPresent };
  } catch (e: any) {
    steps.CLOSE = steps.CLOSE ?? step('UNKNOWN', `청산 경로에서 예외: ${e?.message || e}`);
    steps.RECONCILE = step('UNKNOWN', String(e?.message || e));
  }

  const list = stepsOf(steps);
  const v = smokeVerdict(list);
  // RUNNING으로 끝나면 안 된다 — 여기까지 왔으면 더 진행할 단계가 없다.
  const state = v.code === 'PASS' ? 'PASS' : v.code === 'RUNNING' ? 'FAIL' : v.code === 'UNKNOWN' ? 'FAIL' : v.code;
  await save(sb, row.id, { ...patch, state, steps, verdict: v.code, reason: v.reason });
  return { id: row.id, symbol: row.symbol, verdict: v.code, reason: v.reason };
}

async function save(sb: any, id: string, patch: Record<string, any>): Promise<void> {
  try {
    await sb.from('smoke_tests').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  } catch { /* 다음 주기에 다시 적힌다 */ }
}
