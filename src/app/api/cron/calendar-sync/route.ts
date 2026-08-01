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
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import { collectEvents, syncCooldown } from '@/lib/calendar/normalize';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 마지막 수동 동기화 시각.
 *
 * 인스턴스 안에서만 산다(서버리스라 재시작되면 잊는다). 그래도 두는 이유는
 * 화면에서 버튼을 연타할 때를 막기 위해서다 — 공급자 호출은 유료 쿼터이고,
 * 같은 데이터를 1분에 열 번 받아도 달라지는 게 없다. 완벽한 잠금이 필요한
 * 자리가 아니다(잘못 돌아도 upsert라 데이터가 상하지 않는다).
 */
let lastManualAt = 0;

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 지금 바로 한 번 받아온다 — 화면의 '일정 동기화' 버튼용.
 *
 * 왜 POST를 따로 여는가
 * ─────────────────────
 * 크론은 **하루에 한 번**만 돈다(Vercel Hobby는 일 단위 크론만 허용한다).
 * 그러면 처음 켠 사람은 최대 하루를 빈 달력으로 기다려야 하고, 키를 잘못
 * 넣었는지 데이터가 원래 없는 건지도 그때까지 알 수 없다.
 *
 * GET(크론)은 CRON_SECRET으로 잠겨 있는데, 그 비밀을 화면에 둘 수는 없다 —
 * 브라우저로 보내는 순간 비밀이 아니다. 그래서 로그인한 사용자면 되게 하고,
 * 대신 연타를 쿨다운으로 막는다. 이 표는 사용자별 데이터가 아니라 공용
 * 일정이라 누가 갱신하든 결과가 같다.
 */
export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const cool = syncCooldown(lastManualAt, Date.now());
  if (!cool.allowed) {
    return NextResponse.json({
      ok: false, error: 'cooldown',
      message: `방금 받아왔습니다. ${cool.waitSec}초 뒤에 다시 시도하세요.`,
    }, { status: 429 });
  }
  lastManualAt = Date.now();
  return runSync();
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      || req.nextUrl.searchParams.get('secret') || '';
    if (given !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return runSync();
}

/** 크론과 수동 버튼이 **같은 코드**를 쓴다. 두 벌이면 한쪽만 고쳐진다 */
async function runSync() {

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

  // FRED — 무료 키. **날짜만 주고 시각은 안 준다.**
  //
  // 그래서 아래 collectEvents(시간대를 확정 못 하면 버리는 경로)로 보내지
  // 않는다. 거기 넣으면 전부 버려진다 — 시각이 없으니까. 대신 시각을
  // '모른다'로 표시해 따로 저장한다. 회피 판정이 그 표시를 보고 그날
  // 하루 전체를 막는다(lib/risk/eventGuard).
  //
  // 시각을 지어내지 않는 이유는 fred.ts 맨 위에 적어 뒀다.
  let fredRows: Array<Record<string, any>> = [];
  const fredKey = process.env.FRED_API_KEY;
  if (fredKey) {
    const { pickFredEvents, fredEventsToRows, fredReleaseDatesUrl } = await import('@/lib/calendar/fred');
    const d = await fetchJson(fredReleaseDatesUrl(fredKey, from, to));
    const picked = pickFredEvents(d?.release_dates);
    fredRows = fredEventsToRows(picked);
    sourceStatus.fred = d
      ? `${picked.length}건 (시각 없음 — 하루 단위 회피)`
      : '응답 없음';
  } else sourceStatus.fred = 'FRED_API_KEY 없음';

  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    const d = await fetchJson(
      `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${fmpKey}`);
    batches.push({ provider: 'fmp', items: Array.isArray(d) ? d : null });
    sourceStatus.fmp = Array.isArray(d) ? `${d.length}건` : '응답 없음';
  } else sourceStatus.fmp = 'FMP_API_KEY 없음';

  if (batches.length === 0 && fredRows.length === 0) {
    // 키가 없는 것과 일정이 없는 것은 다르다. 화면에서는 둘 다 빈 달력이다.
    return NextResponse.json({
      ok: false,
      message: '경제 캘린더 공급자 키가 없습니다. FRED_API_KEY(무료) 또는 TRADING_ECONOMICS_API_KEY / FMP_API_KEY를 넣으세요.',
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

  // FRED는 시각을 모르는 채로 따로 저장한다. 다른 공급자와 같은 표에
  // 들어가되 time_known=false가 그 차이를 들고 간다.
  if (fredRows.length > 0) {
    try {
      const { error } = await (sb.from('econ_events') as any)
        .upsert(fredRows, { onConflict: 'id' });
      if (error) throw new Error(error.message);
      saved += fredRows.length;
    } catch (e: any) {
      const msg = String(e?.message || e);
      storageWarning = /time_known/i.test(msg)
        ? 'time_known 칸이 없습니다 — 마이그레이션 027을 적용하세요.'
        : `FRED 저장 실패: ${msg}`;
    }
  }

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
      } else saved += rows.length;
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
