import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "TRAIGO API Health",
    timestamp: new Date().toISOString(),
    env: {
      FMP_API_KEY: Boolean(process.env.FMP_API_KEY),
      EODHD_API_KEY: Boolean(process.env.EODHD_API_KEY),
      FINANCIALJUICE_API_KEY: Boolean(process.env.FINANCIALJUICE_API_KEY),
      NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
  });
}
