// /api/push/vapid-public-key
// 클라이언트가 푸시 구독 시 VAPID 공개키를 가져감.
// VAPID_PUBLIC_KEY 환경변수 미설정 시 null 반환 (푸시 비활성).

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || null;
  if (!publicKey) {
    return NextResponse.json(
      { publicKey: null, configured: false, message: '푸시 알림 미설정 (로컬 알림만 사용)' },
      { status: 200 }
    );
  }
  return NextResponse.json({ publicKey, configured: true });
}
