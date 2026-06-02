// /api/push/subscribe
// 클라이언트의 푸시 구독 정보를 Supabase에 저장.
// 서버에서 web-push로 알림 전송 시 사용.
//
// 정직: web-push 발송 로직 (cron/이벤트 트리거)은 별도 구현 필요.
// 이 endpoint는 구독 정보 저장만 담당.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let sub: any;
  try { sub = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!sub?.endpoint) {
    return NextResponse.json({ error: 'invalid_subscription' }, { status: 400 });
  }

  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );

  const sb = getSupabaseAdmin();
  if (!sb) {
    // Supabase 미설정 — 구독은 받았지만 저장 못 함
    return NextResponse.json({ ok: true, stored: false, reason: 'supabase_not_configured' });
  }

  try {
    const row = {
      user_id:   uid || null,
      endpoint:  sub.endpoint,
      keys:      sub.keys || {},
      expiration: sub.expirationTime || null,
      created_at: new Date().toISOString(),
    };
    // push_subscriptions 테이블 (없으면 best-effort 실패)
    const { error } = await (sb.from('push_subscriptions') as any)
      .upsert(row, { onConflict: 'endpoint' });
    if (error) return NextResponse.json({ ok: true, stored: false, reason: error.message });
    return NextResponse.json({ ok: true, stored: true });
  } catch (e) {
    return NextResponse.json({ ok: true, stored: false, reason: e instanceof Error ? e.message : 'unknown' });
  }
}
