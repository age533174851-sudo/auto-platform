// GET /api/cron/calendar-sync
//
// 경제 지표 일정을 외부 공급자에서 모아 econ_events에 넣는다.
//
// 이 테이블은 Risk Veto가 쓴다
// ────────────────────────────
// econ_events(015)는 FOMC·CPI 회피에 쓰이는 안전 필수 테이블이다.
// 그래서 새 테이블을 만들지 않고 기존 스키마에 맞춘다. 시각 필드가
// NOT NULL인 것도 의도된 설계다 — 마이그레이션 주석에 적혀 있듯
// "잘못된 FOMC 시각은 Veto가 없는 것보다 위험하다".
//
// 시간대를 확정 못 한 일정은 **넣지 않는다**
// ──────────────────────────────────────────
// 공급자가 '2026-07-28 08:30'처럼 시간대 없이 주면 그게 어느 나라
// 8시 30분인지 알 수 없다. 임의로 UTC라고 정하면 최대 9시간까지 어긋나고,
// 그 시각을 믿은 Veto는 엉뚱한 때에 발동하거나 발동하지 않는다.
// 그런 일정은 세어서 응답에 적되 저장하지 않는다.
//
// 기존 /api/calendar/sync 와의 관계
// ─────────────────────────────────
// 그쪽은 사람이 직접 넣거나 외부 결과를 주입하는 통로다. 여기는 예약
// 수집이다. 둘 다 같은 테이블에 같은 규칙으로 쓴다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { collectEvents } from '@/lib/calendar/normalize';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      || req.nextUrl.searchParams.get('secret') || '';
    if (given !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 지난 7일 ~ 앞으로 30일. 지난 것도 받는 이유는 발표된 실제치를
  // 채우기 위해서다 — 앞만 보면 예상치만 있는 달력이 된다.
  const from = ymd(new Date(Date.now() - 7 * 86_400_000));
  const to = ymd(new Date(Date.now() + 30 * 86_400_000));

  const batches: { provider: string; items: any[] | null }[] = [];
  const sourceStatus: Record<string, string> = {};

  const teKey = process.env.TRADING_ECONOMICS_API_KEY;
  if (teKey) {
    const d = await fetchJson(
      `https://api.tradingeconomics.com/calendar/country/all/${from}/${to}?c=${teKey}&f=json`);
    batches.push({ provider: 'tradingeconomics', items: Array.isArray(d) ? d : null });
    sourceStatus.tradingeconomics = Array.isArray(d) ? `${d.length}건` : '응답 없음';
  } else sourceStatus.tradingeconomics = 'TRADING_ECONOMICS_API_KEY 없음';

  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    const d = await fetchJson(
      `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${fmpKey}`);
    batches.push({ provider: 'fmp', items: Array.isArray(d) ? d : null });
    sourceStatus.fmp = Array.isArray(d) ? `${d.length}건` : '응답 없음';
  } else sourceStatus.fmp = 'FMP_API_KEY 없음';

  if (batches.length === 0) {
    // 키가 없는 것과 일정이 없는 것은 다르다. 화면에서는 둘 다 빈 달력이다.
    return NextResponse.json({
      ok: false,
      message: '경제 캘린더 공급자 키가 없습니다. TRADING_ECONOMICS_API_KEY 또는 FMP_API_KEY를 넣으세요.',
      sources: sourceStatus,
    }, { status: 503 });
  }

  const collected = collectEvents(batches);

  // 시각이 확정된 것만 저장 대상이다.
  const placeable = collected.events.filter(e => e.at != null);
  const noTime = collected.events.length - placeable.length;

  // 중요도를 모르는 일정 수. Risk Veto는 impact='high'만 보므로,
  // 'unknown'으로 들어간 일정은 회피 대상에서 빠진다. 그 사실을 응답에
  // 적어야 사람이 수동으로 채워 넣을지 판단할 수 있다.
  const unknownImpact = placeable.filter(e => e.impact === 'unknown').length;

  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json({
      ok: false, message: 'supabase_not_configured',
      collected: collected.events.length, sources: sourceStatus,
    }, { status: 503 });
  }

  let saved = 0;
  let storageWarning: string | null = null;

  if (placeable.length > 0) {
    const rows = placeable.map(e => ({
      id: e.key,
      timestamp_utc: e.at,
      event: e.title,
      // 015의 기본값은 'low'지만 모르는 것을 low로 적지 않는다.
      // 컬럼이 TEXT라 'unknown'이 그대로 들어간다.
      impact: e.impact,
      country: e.country || null,
      actual: e.actual,
      forecast: e.forecast,
      previous: e.previous,
      source: 'api',
      updated_at: new Date().toISOString(),
    }));
    try {
      // 지표는 바뀐다 — 발표 후 실제치가 채워지고 일정이 밀리기도 한다.
      // 뉴스 원문과 달리 덮어쓰는 게 맞다.
      const { error } = await (sb.from('econ_events') as any)
        .upsert(rows, { onConflict: 'id' });
      if (error) {
        const missing = String(error.code) === '42P01'
          || /does not exist|could not find the table/i.test(String(error.message));
        storageWarning = missing
          ? 'econ_events 테이블이 없습니다 — supabase/migrations/015_econ_events.sql을 실행하세요.'
          : `저장 실패: ${error.message}`;
      } else saved = rows.length;
    } catch (e: any) {
      storageWarning = `저장 중 오류: ${e?.message || e}`;
    }
  }

  return NextResponse.json({
    ok: !storageWarning,
    range: { from, to },
    sources: sourceStatus,
    collected: collected.events.length,
    duplicatesRemoved: collected.removed,
    skippedInvalid: collected.skipped,
    // 시간대를 확정 못 해 저장하지 않은 일정. 많으면 공급자가 시간대를
    // 안 주는 것이고, 그 일정들은 Risk Veto가 보지 못한다.
    skippedNoTimezone: noTime,
    unknownImpact,
    saved,
    storageWarning,
    note: noTime > 0
      ? `시간대를 확인할 수 없는 일정 ${noTime}건은 저장하지 않았습니다 — 잘못된 시각은 Veto가 없는 것보다 위험합니다.`
      : '발표 전 지표의 실제치는 비워 둡니다 — 예상치를 발표값으로 보여주지 않습니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
