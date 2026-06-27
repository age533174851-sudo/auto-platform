// POST /api/alert/telegram
// 클라이언트 감지 이벤트(Ghost Sync, API 실패, EMERGENCY) + 테스트 알림 발송
// body: { level, title, message?, fields?, mode?, exchange?, symbol?, eventType, test? }

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { sendTelegramAlert } from '@/lib/notify/telegram';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return NextResponse.json({ error: 'telegram_not_configured', message: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — Vercel 환경변수 추가 후 Redeploy' }, { status: 503 });
  }

  const sb = getSupabaseAdmin();

  if (body.test) {
    const res = await sendTelegramAlert({
      level: 'info', eventType: 'test', title: 'Telegram 테스트 알림',
      message: '✅ TRAIGO 알림 연결이 정상입니다.', fields: { Time: new Date().toLocaleString('ko-KR') },
    }, sb);
    return NextResponse.json({ ok: res.ok, throttled: res.throttled, error: res.error });
  }

  const { level = 'warning', title, message, fields, mode, exchange, symbol, eventType = 'client', dedupKey } = body;
  if (!title) return NextResponse.json({ error: 'missing_title' }, { status: 400 });

  const res = await sendTelegramAlert({ level, title, message, fields, mode, exchange, symbol, eventType, dedupKey }, sb);
  return NextResponse.json({ ok: res.ok, throttled: res.throttled, error: res.error });
}
