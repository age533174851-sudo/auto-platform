// src/app/api/health/env/route.ts
// 환경변수 설정 상태 점검 (값은 노출하지 않고 설정 여부·오류·경고만).
import { NextResponse } from 'next/server';
import { validateEnvOnce } from '@/lib/env/schema';

export const dynamic = 'force-dynamic';

export async function GET() {
  const r = validateEnvOnce();
  return NextResponse.json({
    ok: r.ok,
    status: r.ok ? (r.warnings.length ? 'degraded' : 'healthy') : 'error',
    errors: r.errors,
    warnings: r.warnings,
    configuredCount: r.configured.length,
    configured: r.configured,           // 키 이름만 (값 X)
    missingTrading: r.missingTrading,
  });
}
