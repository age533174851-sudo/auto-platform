// /api/derivatives/history
// 펀딩비·OI 히스토리 수집 및 저장.
//
// GET  ?symbol=BTCUSDT&days=365        조회 (저장 안 함)
// POST { symbol, days, store: true }   수집 후 Supabase에 저장
//
// 주의: Binance OI 히스토리는 최근 30일치만 제공한다. 펀딩비는 전체 기간 가능.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
  const days = Math.min(Number(url.searchParams.get('days') || 365), 2000);
  const summaryOnly = url.searchParams.get('full') !== '1';

  try {
    const { fetchDerivativesHistory, buildDailyIndex, coverageReport } = await import('@/lib/derivatives/history');
    const start = Date.now() - days * 86400000;
    const hist = await fetchDerivativesHistory(symbol, start);
    const idx = buildDailyIndex(hist);
    const cov = coverageReport(idx, days);

    const body: any = {
      ok: hist.funding.length > 0,
      symbol,
      requestedDays: days,
      funding: {
        count: hist.funding.length,
        from: hist.fundingFrom ? new Date(hist.fundingFrom).toISOString().slice(0, 10) : null,
        to: hist.fundingTo ? new Date(hist.fundingTo).toISOString().slice(0, 10) : null,
      },
      openInterest: {
        count: hist.oi.length,
        from: hist.oiFrom ? new Date(hist.oiFrom).toISOString().slice(0, 10) : null,
        to: hist.oiTo ? new Date(hist.oiTo).toISOString().slice(0, 10) : null,
      },
      coverage: cov,
      warnings: hist.warnings,
    };

    if (!summaryOnly) {
      body.dailyIndex = Object.fromEntries(idx);
    }

    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '수집 실패' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // ── 인증 ──
  //
  // 이 경로는 거래소에서 최대 2000일치를 받아 와 DB에 upsert한다.
  // 인증이 없으면 아무나 반복 호출해서 외부 API 레이트리밋과 요금,
  // DB 쓰기를 소모시킬 수 있다. 값 자체는 거래소에서 오므로 위조는
  // 안 되지만, **비용은 위조 없이도 나간다.**
  const { resolveUserId } = await import('@/lib/supabase/admin');
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  const byAdmin = !!process.env.ADMIN_SECRET
    && req.headers.get('x-admin-secret') === process.env.ADMIN_SECRET;
  if (!uid && !byAdmin) {
    return NextResponse.json(
      { ok: false, error: 'auth_required', message: '로그인이 필요합니다' }, { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'JSON 파싱 실패' }, { status: 400 }); }

  const symbol = String(body?.symbol || 'BTCUSDT').toUpperCase();
  const days = Math.min(Number(body?.days || 365), 2000);

  try {
    const { fetchDerivativesHistory, buildDailyIndex, coverageReport } = await import('@/lib/derivatives/history');
    const start = Date.now() - days * 86400000;
    const hist = await fetchDerivativesHistory(symbol, start);
    const idx = buildDailyIndex(hist);
    const cov = coverageReport(idx, days);

    let stored = 0;
    if (body?.store) {
      try {
        const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
        const sb = getSupabaseAdmin();
        const rows = [...idx.entries()].map(([date, v]) => ({
          symbol, trade_date: date,
          funding_rate: v.fundingRate,
          oi_change_pct: v.oiChangePct,
          coverage: v.coverage,
        }));
        // 500건씩 나눠서 upsert
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          const { error } = await sb.from('derivatives_daily')
            .upsert(chunk, { onConflict: 'symbol,trade_date' });
          if (error) throw new Error(error.message);
          stored += chunk.length;
        }
      } catch (e: any) {
        return NextResponse.json({
          ok: false, error: `저장 실패: ${e?.message || e}`,
          hint: '014_derivatives_daily.sql 마이그레이션을 먼저 실행하세요',
          collected: idx.size,
        }, { status: 500 });
      }
    }

    return NextResponse.json({
      ok: true, symbol, days,
      collected: idx.size, stored,
      coverage: cov,
      warnings: hist.warnings,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '수집 실패' }, { status: 500 });
  }
}
