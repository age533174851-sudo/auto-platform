// /api/health — overall health endpoint
// Returns env var presence as true/false ONLY — never exposes actual values.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const env = {
    FMP_API_KEY:                   !!process.env.FMP_API_KEY,
    EODHD_API_KEY:                 !!process.env.EODHD_API_KEY,
    FINANCIALJUICE_API_KEY:        !!process.env.FINANCIALJUICE_API_KEY,
    NEXT_PUBLIC_SUPABASE_URL:      !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY:     !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const configured = Object.values(env).filter(Boolean).length;
  const total      = Object.keys(env).length;

  return NextResponse.json({
    ok: true,
    status: configured === total ? 'fully_configured'
          : configured > 0       ? 'partially_configured'
                                 : 'unconfigured',
    configured,
    total,
    env,
    checkedAt: new Date().toISOString(),
  });
}
