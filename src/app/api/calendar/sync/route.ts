// /api/calendar/sync
// 경제 캘린더 동기화.
//
// GET  상태 확인 (몇 건 있나, 얼마나 오래됐나)
// POST 이벤트 등록 — 두 가지 방식:
//   1) { events: [...] }  직접 주입 (외부 API 결과를 전달)
//   2) { manual: {...} }  수동 1건 (시간대 명시 필수)
//
// 왜 자동 크롤러가 아닌가:
//   무료 경제 캘린더 API는 대부분 인증이 필요하거나 이용약관 제약이 있다.
//   임의의 사이트를 스크래핑하면 형식이 바뀔 때 조용히 잘못된 일정이 들어간다.
//   100배 레버리지에서 잘못된 FOMC 시각은 Veto가 없는 것보다 위험하다.
//   따라서 데이터 출처는 사용자가 선택하고, 이 엔드포인트는 검증·저장만 담당한다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';


// ── 인증 ────────────────────────────────────────────────
// 이 엔드포인트는 service-role로 econ_events를 쓴다.
// 인증이 없으면 외부인이 가짜 FOMC를 넣어 고배율 거래를 임의로 차단할 수 있다.
const SYNC_SECRET = process.env.CALENDAR_SYNC_SECRET || '';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  try { return timingSafeEqual(ba, bb); } catch { return false; }
}

// 간단 레이트리밋 (인스턴스 단위 — 완전하진 않지만 무차별 시도를 늦춘다)
const hits = new Map<string, number[]>();
const RATE_WINDOW = 60_000, RATE_MAX = 10;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 500) hits.clear();   // 메모리 누수 방지
  return arr.length > RATE_MAX;
}

async function authorize(req: NextRequest): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';
  if (rateLimited(ip)) {
    return { ok: false, status: 429, error: '요청이 너무 많습니다 (분당 10회 제한)' };
  }

  // ① 전용 시크릿 — 서버 간 호출(cron 등)용
  const provided = req.headers.get('x-calendar-sync-secret') || '';
  if (SYNC_SECRET && safeEqual(provided, SYNC_SECRET)) return { ok: true };

  // ② Supabase JWT — 로그인 사용자
  try {
    const { getUserIdFromRequest } = await import('@/lib/supabase/admin');
    const uid = await getUserIdFromRequest(req.headers.get('authorization'));
    if (uid) return { ok: true };
  } catch { /* JWT 검증 실패 */ }

  if (!SYNC_SECRET) {
    return { ok: false, status: 503,
      error: 'CALENDAR_SYNC_SECRET이 설정되지 않았습니다. 인증 없이 캘린더를 수정할 수 없습니다.' };
  }
  return { ok: false, status: 401, error: '인증 필요 — x-calendar-sync-secret 헤더 또는 로그인 토큰' };
}

const VALID_IMPACT = ['low', 'medium', 'high'];
const MAX_FUTURE_DAYS = 400;
const MAX_PAST_DAYS = 30;

interface IncomingEvent {
  id?: string;
  timestampUtc?: number | string;
  event?: string;
  impact?: string;
  country?: string;
  affectedAssets?: string[];
  actual?: string; forecast?: string; previous?: string;
}

function validate(e: IncomingEvent): { ok: true; row: any } | { ok: false; error: string } {
  if (!e.event || typeof e.event !== 'string') return { ok: false, error: 'event 이름 필요' };
  if (!VALID_IMPACT.includes(String(e.impact))) return { ok: false, error: `impact는 ${VALID_IMPACT.join('|')} 중 하나` };

  // 타임스탬프 — 숫자(ms) 또는 ISO 문자열
  let ts: number;
  if (typeof e.timestampUtc === 'number') ts = e.timestampUtc;
  else if (typeof e.timestampUtc === 'string') ts = new Date(e.timestampUtc).getTime();
  else return { ok: false, error: 'timestampUtc 필요 (ms 숫자 또는 ISO 문자열)' };

  if (!isFinite(ts)) return { ok: false, error: 'timestampUtc 파싱 실패' };

  // 상식적 범위 검사 — 잘못된 연도가 들어오는 걸 막는다
  const now = Date.now();
  const daysDiff = (ts - now) / 86400000;
  if (daysDiff > MAX_FUTURE_DAYS) return { ok: false, error: `${daysDiff.toFixed(0)}일 후 이벤트 — 너무 먼 미래(최대 ${MAX_FUTURE_DAYS}일)` };
  if (daysDiff < -MAX_PAST_DAYS) return { ok: false, error: `${Math.abs(daysDiff).toFixed(0)}일 전 이벤트 — 너무 오래됨(최대 ${MAX_PAST_DAYS}일)` };

  const id = e.id || `evt_${ts}_${e.event.slice(0, 16).replace(/[^a-zA-Z0-9가-힣]/g, '')}`;
  return {
    ok: true,
    row: {
      id,
      timestamp_utc: new Date(ts).toISOString(),
      event: e.event,
      impact: e.impact,
      country: e.country || null,
      affected_assets: Array.isArray(e.affectedAssets) ? e.affectedAssets : null,
      actual: e.actual || null,
      forecast: e.forecast || null,
      previous: e.previous || null,
      source: 'api',
      updated_at: new Date().toISOString(),
    },
  };
}

export async function GET() {
  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    const sb = getSupabaseAdmin();
    const { clearCalendarCache, loadCalendar } = await import('@/lib/calendar/econCalendar');
    clearCalendarCache();
    const { events, status } = await loadCalendar(sb);

    const now = Date.now();
    const upcoming = events.filter(e => e.timestampUtc > now).slice(0, 10);
    const highSoon = events.filter(e => e.impact === 'high' && e.timestampUtc > now && e.timestampUtc - now < 7 * 86400000);

    // 가장 최근 갱신 시각
    let lastUpdated: string | null = null;
    try {
      const { data } = await sb.from('econ_events').select('updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle();
      lastUpdated = data?.updated_at ?? null;
    } catch {}

    const ageHours = lastUpdated ? (now - new Date(lastUpdated).getTime()) / 3600000 : null;
    const stale = ageHours == null || ageHours > 24;

    return NextResponse.json({
      ok: status.available,
      status,
      lastUpdated,
      ageHours: ageHours != null ? Number(ageHours.toFixed(1)) : null,
      stale,
      // stale이면 Risk Veto가 고배율을 차단한다는 걸 명시
      effect: stale
        ? '캘린더가 오래되었거나 비어 있어 5배 이상 진입이 차단됩니다 (fail-closed)'
        : '캘린더 정상 — Risk Veto가 실제 일정으로 판단합니다',
      upcomingCount: upcoming.length,
      highImpactWithin7Days: highSoon.map(e => ({
        event: e.event,
        at: new Date(e.timestampUtc).toISOString(),
        hoursUntil: Number(((e.timestampUtc - now) / 3600000).toFixed(1)),
      })),
      hint: stale ? 'POST /api/calendar/sync 로 이벤트를 등록하세요' : undefined,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '조회 실패' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await authorize(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'JSON 파싱 실패' }, { status: 400 }); }

  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    const sb = getSupabaseAdmin();

    // ── 수동 1건 (시간대 명시 필수) ──
    if (body?.manual) {
      const { makeManualEvent } = await import('@/lib/calendar/econCalendar');
      const made = makeManualEvent(body.manual);
      if ('error' in made) return NextResponse.json({ ok: false, error: made.error }, { status: 400 });

      const { error } = await sb.from('econ_events').upsert({
        id: made.id,
        timestamp_utc: new Date(made.timestampUtc).toISOString(),
        event: made.event, impact: made.impact,
        country: made.country || null,
        source: 'manual', updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);

      const { clearCalendarCache } = await import('@/lib/calendar/econCalendar');
      clearCalendarCache();
      return NextResponse.json({
        ok: true, mode: 'manual', stored: 1,
        event: made.event,
        utcTime: new Date(made.timestampUtc).toISOString(),
        note: `입력한 로컬 시각이 UTC ${new Date(made.timestampUtc).toISOString()}로 변환되었습니다`,
      });
    }

    // ── 일괄 등록 ──
    const incoming: IncomingEvent[] = Array.isArray(body?.events) ? body.events : [];
    if (!incoming.length) {
      return NextResponse.json({
        ok: false,
        error: 'events 배열 또는 manual 객체가 필요합니다',
        example: {
          events: [{ timestampUtc: '2026-08-15T18:00:00Z', event: 'FOMC 금리 결정', impact: 'high', country: 'US' }],
          manual: { event: 'FOMC', impact: 'high', localDateTime: '2026-08-16T03:00', timezoneOffsetMinutes: 540 },
        },
      }, { status: 400 });
    }

    const rows: any[] = [];
    const rejected: { event: string; error: string }[] = [];
    for (const e of incoming) {
      const v = validate(e);
      if (v.ok) rows.push(v.row);
      else rejected.push({ event: String(e.event ?? '?'), error: v.error });
    }

    let stored = 0;
    if (rows.length) {
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await sb.from('econ_events').upsert(chunk, { onConflict: 'id' });
        if (error) throw new Error(error.message);
        stored += chunk.length;
      }
    }

    const { clearCalendarCache } = await import('@/lib/calendar/econCalendar');
    clearCalendarCache();

    return NextResponse.json({
      ok: stored > 0,
      stored, rejected: rejected.length,
      rejectedDetails: rejected.slice(0, 10),
      note: rejected.length
        ? `${rejected.length}건이 검증에 실패했습니다 — 형식을 확인하세요`
        : '모든 이벤트가 등록되었습니다',
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false, error: e?.message || '저장 실패',
      hint: '015_econ_events.sql 마이그레이션을 먼저 실행하세요',
    }, { status: 500 });
  }
}
