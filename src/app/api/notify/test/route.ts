// /api/notify/test — 텔레그램 설정 확인 + 테스트 발송
import { NextResponse } from 'next/server';
import { sendTelegram } from '@/lib/notify/telegram';
export const dynamic = 'force-dynamic';

export async function GET() {
  const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const hasChat = !!process.env.TELEGRAM_CHAT_ID;
  if (!hasToken || !hasChat) {
    return NextResponse.json({
      configured: false, hasToken, hasChat,
      message: '❌ 텔레그램 미설정 — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 추가 후 Redeploy',
    });
  }
  const r = await sendTelegram('🔔 TRAIGO 텔레그램 연결 테스트 — 정상 작동합니다!');
  return NextResponse.json({
    configured: true,
    sent: r.ok,
    message: r.ok ? '✅ 텔레그램 전송 성공 — 폰을 확인하세요' : `⚠️ 전송 실패: ${r.error}`,
  });
}
