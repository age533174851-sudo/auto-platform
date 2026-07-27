// /api/auth/me
// 클라이언트가 로그인 직후 호출 → 프로필 반환 + ADMIN_EMAILS 자동 승급
//
// GET (Authorization: Bearer <jwt>)
// 응답: { user: { id, email }, profile: { role, plan, status, ... }, promotedToAdmin: boolean }

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { ensureAdminFromEmails, isEmailInAdminList } from '@/lib/auth/ensureAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'no_token' }, { status: 401 });
  }
  const token = authHeader.slice(7);

  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json({ error: 'supabase_not_configured' }, { status: 500 });
  }

  // 1. JWT 검증
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData?.user) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
  const user = userData.user;
  const email = user.email ?? null;

  // 2. ADMIN_EMAILS 자동 승급 (해당되면)
  let promotedToAdmin = false;
  if (email && isEmailInAdminList(email)) {
    const r = await ensureAdminFromEmails(user.id, email);
    promotedToAdmin = r.promoted;
  }

  // 3. 프로필 조회
  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('id, email, display_name, avatar_url, role, plan, status, created_at')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) {
    // 프로필이 없으면 (트리거 누락) 생성 시도
    // (기존 코드와 동일하게 Database 타입 정의 미동기화 우회)
    const sbUntyped = sb as unknown as {
      from: (t: string) => {
        upsert: (v: Record<string, unknown>, o: Record<string, unknown>) => {
          select: (cols: string) => { single: () => Promise<{ data: unknown }> }
        }
      }
    };
    const insert = await sbUntyped.from('profiles').upsert({
      id: user.id,
      email: email ?? `${user.id}@unknown.local`,
      display_name: email ? email.split('@')[0] : null,
      role: promotedToAdmin ? 'admin' : 'user',
    }, { onConflict: 'id' }).select('id, email, display_name, avatar_url, role, plan, status, created_at').single();
    return NextResponse.json({
      user: { id: user.id, email },
      profile: insert.data ?? null,
      promotedToAdmin,
    });
  }

  return NextResponse.json({
    user: { id: user.id, email },
    profile,
    promotedToAdmin,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
