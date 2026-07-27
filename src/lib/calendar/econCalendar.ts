// src/lib/calendar/econCalendar.ts
// 경제 캘린더 — Risk Veto가 쓰는 실제 일정.
//
// ⚠️ 왜 별도 모듈인가:
//   기존 ECON_EVENTS는 'MM-DD' + 'HH:mm' 형식의 정적 데모 데이터다.
//   - 연도 정보가 없어 현재 연도를 강제로 붙이면 실제 일정과 어긋난다
//   - 시간대가 정의되지 않아 UTC로 해석하면 최대 9시간 오차가 난다
//   - 12월 말에 1월 이벤트를 보면 1년 전으로 계산된다
//
//   100배 레버리지에서 FOMC 회피가 9시간 어긋나면 Veto가 없는 것과 같다.
//   그래서 이 모듈은 UTC 타임스탬프만 받는다. 정적 데이터는 거부한다.

export type EventImpact = 'low' | 'medium' | 'high';

/** Risk Veto가 사용할 수 있는 유일한 형식 — UTC 타임스탬프 필수 */
export interface CalendarEvent {
  id: string;
  timestampUtc: number;      // ms, UTC 기준. 필수.
  event: string;
  impact: EventImpact;
  country?: string;
  affectedAssets?: string[];
  source: 'api' | 'manual';  // 'demo'는 허용하지 않는다
  updatedAt?: number;        // DB 갱신 시각 (freshness 판정용)
}

export interface CalendarStatus {
  available: boolean;
  eventCount: number;
  freshestAt: number | null;
  ageMinutes: number | null;
  source: string;
  reason?: string;
}

const MAX_AGE_MIN = 24 * 60;   // 24시간 넘으면 신선하지 않다고 본다

let cache: { events: CalendarEvent[]; at: number; lastUpdated: number | null } | null = null;
const TTL = 30 * 60 * 1000;

/**
 * Supabase에 저장된 경제 캘린더를 읽는다.
 * 없으면 available: false — 호출측이 판단하게 한다.
 */
export async function loadCalendar(sb: any): Promise<{ events: CalendarEvent[]; status: CalendarStatus }> {
  if (cache && Date.now() - cache.at < TTL) {
    // 캐시 히트여도 freshness는 DB 갱신 시각으로 판단한다
    return { events: cache.events, status: buildStatus(cache.events, cache.lastUpdated, 'cache') };
  }

  if (!sb) {
    return { events: [], status: { available: false, eventCount: 0, freshestAt: null, ageMinutes: null,
      source: 'none', reason: 'DB 연결 없음 — 경제 캘린더를 확인할 수 없습니다' } };
  }

  try {
    const from = Date.now() - 2 * 86400000;
    const to = Date.now() + 14 * 86400000;
    const { data, error } = await sb.from('econ_events')
      .select('*')
      .gte('timestamp_utc', new Date(from).toISOString())
      .lte('timestamp_utc', new Date(to).toISOString())
      .order('timestamp_utc', { ascending: true });

    if (error) throw new Error(error.message);
    const events: CalendarEvent[] = (Array.isArray(data) ? data : []).map((r: any) => ({
      id: r.id,
      timestampUtc: new Date(r.timestamp_utc).getTime(),
      event: r.event,
      impact: (['low', 'medium', 'high'].includes(r.impact) ? r.impact : 'low') as EventImpact,
      country: r.country || undefined,
      affectedAssets: r.affected_assets || undefined,
      source: r.source === 'manual' ? 'manual' : 'api',
      updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : undefined,
    }));

    // ⚠️ freshness는 "우리가 DB를 읽은 시각"이 아니라 "캘린더가 마지막으로 갱신된 시각" 기준이어야 한다.
    //    Date.now()를 쓰면 3일 전 캘린더도 방금 읽었다는 이유로 fresh가 되어 Veto가 무력해진다.
    let lastUpdated: number | null = null;
    try {
      const { data: u } = await sb.from('econ_events')
        .select('updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (u?.updated_at) lastUpdated = new Date(u.updated_at).getTime();
    } catch { /* 조회 실패 시 null — buildStatus가 unavailable로 처리 */ }

    cache = { events, at: Date.now(), lastUpdated };
    return { events, status: buildStatus(events, lastUpdated, 'supabase') };
  } catch (e: any) {
    return { events: [], status: { available: false, eventCount: 0, freshestAt: null, ageMinutes: null,
      source: 'error', reason: `캘린더 조회 실패: ${e?.message || e}` } };
  }
}

/**
 * @param lastUpdatedAt 캘린더가 마지막으로 갱신된 시각 (DB updated_at). 조회 시각이 아니다.
 */
function buildStatus(events: CalendarEvent[], lastUpdatedAt: number | null, source: string): CalendarStatus {
  if (!events.length) {
    return { available: false, eventCount: 0, freshestAt: null, ageMinutes: null, source,
      reason: '캘린더에 이벤트가 없습니다 — 수집이 필요합니다' };
  }
  if (lastUpdatedAt == null) {
    return { available: false, eventCount: events.length, freshestAt: null, ageMinutes: null, source,
      reason: '캘린더 갱신 시각을 확인할 수 없습니다 — 신선도를 보장할 수 없어 사용하지 않습니다' };
  }
  const ageMin = (Date.now() - lastUpdatedAt) / 60000;
  return {
    available: ageMin <= MAX_AGE_MIN,
    eventCount: events.length,
    freshestAt: lastUpdatedAt,
    ageMinutes: ageMin,
    source,
    reason: ageMin > MAX_AGE_MIN
      ? `캘린더가 ${(ageMin / 60).toFixed(0)}시간 전에 갱신되었습니다 (기준 ${MAX_AGE_MIN / 60}시간) — 최신 일정이 아닐 수 있습니다`
      : undefined,
  };
}

/**
 * 현재 시각 기준 임박 이벤트를 뽑는다.
 * UTC 타임스탬프만 쓰므로 시간대·연도 문제가 없다.
 */
export function upcomingFromCalendar(
  events: CalendarEvent[],
  now: number = Date.now(),
  windowHours = 24
): { event: string; impact: EventImpact; hoursUntil: number }[] {
  const win = windowHours * 3600000;
  return events
    .filter(e => Math.abs(e.timestampUtc - now) <= win)
    .map(e => ({ event: e.event, impact: e.impact, hoursUntil: (e.timestampUtc - now) / 3600000 }))
    .sort((a, b) => Math.abs(a.hoursUntil) - Math.abs(b.hoursUntil));
}

/**
 * 정적 데모 데이터를 캘린더 이벤트로 바꾸려는 시도를 막는다.
 *
 * 왜 함수로 두는가: 나중에 누군가 "ECON_EVENTS를 그냥 쓰면 되지 않나" 하고
 * 연결할 수 있다. 그때 이 함수가 이유를 알려주며 거부한다.
 */
export function rejectStaticEvents(): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      '정적 ECON_EVENTS는 Risk Veto에 사용할 수 없습니다. ' +
      '연도 정보가 없고 시간대가 정의되지 않아 실제 발표 시각과 최대 9시간, 최대 1년까지 어긋납니다. ' +
      'UTC 타임스탬프를 가진 실시간 캘린더를 연결하세요.',
  };
}

/**
 * 수동 입력용 — 사용자가 직접 FOMC 일정을 넣을 때.
 * 시간대를 명시하게 강제한다.
 */
export function makeManualEvent(args: {
  event: string;
  impact: EventImpact;
  localDateTime: string;     // 'YYYY-MM-DDTHH:mm'
  timezoneOffsetMinutes: number;  // KST면 540, UTC면 0
  country?: string;
}): CalendarEvent | { error: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(args.localDateTime);
  if (!m) return { error: 'localDateTime 형식은 YYYY-MM-DDTHH:mm 이어야 합니다' };
  if (!isFinite(args.timezoneOffsetMinutes)) return { error: 'timezoneOffsetMinutes가 필요합니다 (KST=540, UTC=0)' };

  const localMs = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])
  );
  const utcMs = localMs - args.timezoneOffsetMinutes * 60000;

  return {
    id: `manual_${utcMs}_${args.event.slice(0, 12).replace(/\s/g, '')}`,
    timestampUtc: utcMs,
    event: args.event,
    impact: args.impact,
    country: args.country,
    source: 'manual',
  };
}

export function clearCalendarCache() { cache = null; }
