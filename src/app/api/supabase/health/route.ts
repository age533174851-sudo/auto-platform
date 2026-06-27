// /api/supabase/health
// Returns env var presence (true/false only — never actual values)
// and a live DB connectivity check.
import { NextResponse } from 'next/server';
import { getSupabaseAdmin, serviceRoleKeyRole } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Check env vars — report existence only, never values
  const hasUrl     = !!process.env.NEXT_PUBLIC_SUPABASE_URL;
  const hasAnon    = !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const hasSrvKey  = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const allPresent = hasUrl && hasAnon && hasSrvKey;

  // service_role 키가 진짜 service_role인지 진단 (anon/publishable 키 오삽입 탐지)
  const keyRole = serviceRoleKeyRole();
  const keyRoleOk = keyRole === 'service_role';

  const envStatus = {
    NEXT_PUBLIC_SUPABASE_URL:      hasUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: hasAnon,
    SUPABASE_SERVICE_ROLE_KEY:     hasSrvKey,
    SERVICE_ROLE_KEY_역할:         keyRole,    // service_role | anon | unknown | missing
    SERVICE_ROLE_KEY_정상:         keyRoleOk,
  };

  if (!allPresent) {
    return NextResponse.json({
      status: 'unconfigured',
      connected: false,
      message: '필수 환경 변수가 누락되었습니다.',
      env: envStatus,
      latencyMs: null,
    });
  }

  // Attempt a lightweight DB query with the admin client
  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json({
      status: 'error',
      connected: false,
      message: 'Supabase 클라이언트 초기화 실패',
      env: envStatus,
      latencyMs: null,
    }, { status: 503 });
  }

  const t0 = Date.now();
  try {
    const { error } = await sb
      .from('profiles')
      .select('id')
      .limit(1);
    const latencyMs = Date.now() - t0;

    // PGRST116 = no rows — perfectly fine
    if (error && error.code !== 'PGRST116') {
      return NextResponse.json({
        status: 'degraded',
        connected: false,
        message: `DB 오류: ${error.message}`,
        env: envStatus,
        latencyMs,
      }, { status: 503 });
    }

    return NextResponse.json({
      status: 'ok',
      connected: true,
      message: 'Supabase 연결 정상',
      env: envStatus,
      latencyMs,
    });
  } catch (err: unknown) {
    return NextResponse.json({
      status: 'error',
      connected: false,
      message: err instanceof Error ? err.message : '알 수 없는 오류',
      env: envStatus,
      latencyMs: Date.now() - t0,
    }, { status: 503 });
  }
}
