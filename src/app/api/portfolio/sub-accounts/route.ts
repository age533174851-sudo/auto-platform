// /api/portfolio/sub-accounts — 가상 서브계좌 만들기·고치기·지우기
//
// 이 표의 값은 **주문을 실제로 막는다** (체크리스트 SUBACCOUNT_LIMIT).
// 배분표(/api/portfolio/allocation)가 "성장 600 · 안정 250"을 계산해 주지만
// 그건 계산일 뿐이고, 여기서 만든 바구니만이 한도로 작동한다.
//
// 검사는 여기서 하지 않는다
// ─────────────────────────
// 값 다듬기는 `lib/portfolio/subAccount.ts`의 normalizeSubAccountInput 하나가
// 한다. 라우트와 화면이 각자 검사하면 언젠가 서로 다른 것을 허용하고, 그때
// 통과하는 값은 **한도를 무르게 만드는 쪽으로만** 어긋난다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { normalizeSubAccountInput, SUB_ACCOUNT_MARKETS } from '@/lib/portfolio/subAccount';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const COLS = 'id, name, allocated_usd, markets, symbol_prefixes, note, sort_order, created_at';

/** 한 사람이 만들 수 있는 바구니 수. 이보다 많으면 우선순위를 사람이 못 읽는다 */
const MAX_ACCOUNTS = 20;

async function ctx(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return { err: NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 }) };
  const sb = getSupabaseAdmin();
  if (!sb) return { err: NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 }) };
  return { uid, sb };
}

/** 표가 아직 없을 때(마이그레이션 미적용) 무엇을 해야 하는지 알려 준다 */
function dbError(e: any, status = 500) {
  const msg = String(e?.message || e || '');
  const missing = /sub_accounts/i.test(msg) && /(does not exist|schema cache|relation)/i.test(msg);
  return NextResponse.json({
    ok: false,
    error: missing ? 'migration_required' : 'db_error',
    message: missing
      ? '서브계좌 표가 없습니다 — supabase/migrations/024_sub_accounts.sql을 자동으로 적용하는 중입니다'
      : msg,
  }, { status: missing ? 503 : status });
}

const rowOut = (r: any) => ({
  id: String(r.id),
  name: String(r.name ?? ''),
  // 빈 값을 0으로 만들지 않는다. '미설정'과 '한도 0'은 다른 뜻이고,
  // 판정 함수도 둘을 다르게 다룬다.
  allocatedUsd: r.allocated_usd == null ? null : Number(r.allocated_usd),
  markets: Array.isArray(r.markets) ? r.markets : [],
  symbolPrefixes: Array.isArray(r.symbol_prefixes) ? r.symbol_prefixes : [],
  note: r.note ?? null,
  sortOrder: Number(r.sort_order) || 0,
});

export async function GET(req: NextRequest) {
  const c = await ctx(req);
  if (c.err) return c.err;
  try {
    const { data, error } = await (c.sb as any).from('sub_accounts').select(COLS)
      .eq('user_id', c.uid)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return NextResponse.json({
      ok: true,
      accounts: (Array.isArray(data) ? data : []).map(rowOut),
      markets: SUB_ACCOUNT_MARKETS,
      maxAccounts: MAX_ACCOUNTS,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return dbError(e);
  }
}

export async function POST(req: NextRequest) {
  const c = await ctx(req);
  if (c.err) return c.err;

  let body: any = {};
  try { body = await req.json(); } catch { /* 빈 본문 → 이름 없음으로 걸린다 */ }

  const n = normalizeSubAccountInput(body);
  if (!n.value) return NextResponse.json({ ok: false, error: 'invalid', message: n.error }, { status: 400 });

  try {
    const { count, error: cErr } = await (c.sb as any).from('sub_accounts')
      .select('id', { count: 'exact', head: true }).eq('user_id', c.uid);
    if (cErr) throw new Error(cErr.message);
    if ((count ?? 0) >= MAX_ACCOUNTS) {
      return NextResponse.json({
        ok: false, error: 'too_many',
        message: `서브계좌는 ${MAX_ACCOUNTS}개까지입니다`,
      }, { status: 400 });
    }

    const { data, error } = await (c.sb as any).from('sub_accounts').insert({
      user_id: c.uid,
      name: n.value.name,
      allocated_usd: n.value.allocatedUsd,
      markets: n.value.markets,
      symbol_prefixes: n.value.symbolPrefixes,
      note: n.value.note,
      sort_order: n.value.sortOrder,
    }).select(COLS).single();
    if (error) {
      if (/duplicate key|sub_acct_name_uniq/i.test(error.message)) {
        return NextResponse.json({
          ok: false, error: 'duplicate_name',
          message: `'${n.value.name}'이라는 서브계좌가 이미 있습니다`,
        }, { status: 409 });
      }
      throw new Error(error.message);
    }
    return NextResponse.json({ ok: true, account: rowOut(data) });
  } catch (e: any) {
    return dbError(e);
  }
}

export async function PATCH(req: NextRequest) {
  const c = await ctx(req);
  if (c.err) return c.err;

  let body: any = {};
  try { body = await req.json(); } catch { /* 아래에서 id 없음으로 걸린다 */ }
  const id = String(body?.id ?? '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id_required' }, { status: 400 });

  const n = normalizeSubAccountInput(body);
  if (!n.value) return NextResponse.json({ ok: false, error: 'invalid', message: n.error }, { status: 400 });

  try {
    // user_id를 조건에 넣는다 — 서비스 키로 도는 라우트라 RLS가 걸리지 않는다.
    const { data, error } = await (c.sb as any).from('sub_accounts').update({
      name: n.value.name,
      allocated_usd: n.value.allocatedUsd,
      markets: n.value.markets,
      symbol_prefixes: n.value.symbolPrefixes,
      note: n.value.note,
      sort_order: n.value.sortOrder,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('user_id', c.uid).select(COLS).maybeSingle();
    if (error) {
      if (/duplicate key|sub_acct_name_uniq/i.test(error.message)) {
        return NextResponse.json({
          ok: false, error: 'duplicate_name',
          message: `'${n.value.name}'이라는 서브계좌가 이미 있습니다`,
        }, { status: 409 });
      }
      throw new Error(error.message);
    }
    // 0행이면 **성공이 아니다.** 남의 것이거나 이미 지워진 것이고, 여기서
    // ok를 주면 화면은 저장된 것처럼 그린다.
    if (!data) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, account: rowOut(data) });
  } catch (e: any) {
    return dbError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const c = await ctx(req);
  if (c.err) return c.err;

  const id = String(new URL(req.url).searchParams.get('id') ?? '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id_required' }, { status: 400 });

  try {
    const { data, error } = await (c.sb as any).from('sub_accounts')
      .delete().eq('id', id).eq('user_id', c.uid).select('id').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, id });
  } catch (e: any) {
    return dbError(e);
  }
}
