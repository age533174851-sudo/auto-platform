// /api/translate/status — Papago 키 설정 여부 진단 (값은 노출 안 함)
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

export async function GET() {
  const hasId = !!process.env.NAVER_CLIENT_ID;
  const hasSecret = !!process.env.NAVER_CLIENT_SECRET;
  return NextResponse.json({
    configured: hasId && hasSecret,
    hasId, hasSecret,
    message: hasId && hasSecret
      ? '✅ Papago 키 설정됨 — 번역 작동 가능'
      : '❌ 키 미설정 — Vercel 환경변수에 NAVER_CLIENT_ID/SECRET 추가 후 Redeploy 필요',
  });
}
