// /api/webhook/secret — 내 웹훅 시크릿 발급·조회·폐기
//
// GET    : 지금 걸려 있는 것들의 **지문만**. 값은 다시 안 보여 준다
// POST   : 새로 발급. **이때 한 번만** 평문을 돌려준다
// DELETE : 폐기
//
// 왜 한 번만 보여 주는가
// ──────────────────────
// 저장하는 것은 해시뿐이다. 데이터베이스가 새어도 그 값으로 주문을 낼 수
// 없어야 하기 때문이다. 그래서 나중에 다시 보여 줄 방법이 **없다** —
// 보여 줄 수 있다면 평문을 어딘가 들고 있다는 뜻이다.
//
// 잃어버리면 새로 발급하는 것이지 되찾는 것이 아니다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  generateWebhookSecret, hashSecret, fingerprint,
} from '@/lib/security/webhookAuth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function auth(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  return { uid, sb: getSupabaseAdmin() };
}

export async function GET(req: NextRequest) {
  const { uid, sb } = await auth(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const { data, error } = await (sb as any).from('webhook_secrets')
    .select('id, fingerprint, label, created_at, last_used_at, revoked_at')
    .eq('user_id', uid).order('created_at', { ascending: false }).limit(20);
  if (error) {
    return NextResponse.json({ ok: false, error: 'read_failed', message: error.message,
      hint: '마이그레이션 038_webhook_secrets.sql을 실행했는지 확인하세요' }, { status: 500 });
  }

  const rows = Array.isArray(data) ? data : [];
  return NextResponse.json({
    ok: true,
    // **secret_hash도 안 싣는다.** 화면이 쓸 일이 없고, 실을 이유가 없는
    // 값을 실으면 언젠가 로그나 캐시에 남는다.
    secrets: rows,
    active: rows.filter((r: any) => !r.revoked_at).length,
    note: '시크릿 값은 발급할 때 한 번만 보여 줍니다 — 저장하는 것은 해시뿐이라 되찾을 수 없습니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const { uid, sb } = await auth(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch { /* 본문 없이도 발급된다 */ }

  const secret = generateWebhookSecret();
  const hash = hashSecret(secret);

  const { error } = await (sb as any).from('webhook_secrets').insert({
    user_id: uid,
    secret_hash: hash,
    fingerprint: fingerprint(secret),
    label: String(body?.label || '').slice(0, 60),
  });
  if (error) {
    return NextResponse.json({ ok: false, error: 'write_failed', message: error.message,
      hint: '마이그레이션 038_webhook_secrets.sql을 실행했는지 확인하세요' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    // ── 평문을 돌려주는 **유일한** 자리 ──
    //
    // 이 값을 트레이딩뷰 알림 본문의 secret 칸에 넣어야 하므로 한 번은
    // 보여 줘야 한다. 다음부터는 지문만 나온다.
    secret,
    fingerprint: fingerprint(secret),
    note: '이 값은 지금 한 번만 보입니다. 트레이딩뷰 알림의 secret 칸에 넣고, '
        + '이 창을 닫으면 다시 볼 수 없습니다 — 잃어버리면 새로 발급하세요.',
    warning: '이 값이 있으면 당신 계좌로 주문을 낼 수 있습니다. 화면 공유·스크린샷에 주의하세요.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(req: NextRequest) {
  const { uid, sb } = await auth(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const id = String(req.nextUrl.searchParams.get('id') || '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });

  // **행을 지우지 않는다.** 언제 폐기했는지가 사고 조사에 필요하고,
  // 지워 버리면 "그때 그 시크릿이 살아 있었나"를 알 수 없다.
  const { error } = await (sb as any).from('webhook_secrets')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', uid);
  if (error) {
    return NextResponse.json({ ok: false, error: 'write_failed', message: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, revoked: id }, { headers: { 'Cache-Control': 'no-store' } });
}
