// src/lib/calendar/normalize.ts
//
// 여러 공급자의 경제 지표 일정을 하나의 모양으로.
//
// 여기서 틀리면 생기는 일
// ───────────────────────
// 1. 시간대를 잘못 읽으면 FOMC가 몇 시간 밀린다. 화면에는 그냥 '오후
//    2시'로 보이고, 사용자는 그 시각에 맞춰 포지션을 정리한다.
// 2. 발표 전 예상치를 실제치 자리에 넣으면 "CPI 3.2% 나왔다"가 된다.
//    아직 안 나온 숫자다. 이건 뉴스가 아니라 거짓말이다.
//
// 둘 다 화면에서는 정상으로 보인다. 그래서 테스트가 붙는 자리에 둔다.

export type Impact = 'high' | 'medium' | 'low' | 'unknown';

export interface RawEvent { [k: string]: any }

export interface CalendarEvent {
  /** 중복 판별용 지문 */
  key: string;
  title: string;
  country: string;
  /** 발표 시각. ISO UTC. 시간대를 모르면 이 값이 없다 */
  at: string | null;
  /** 시각을 모르는 경우의 날짜(YYYY-MM-DD). 하루 종일 일정일 수도 있다 */
  date: string;
  impact: Impact;
  /** 발표된 값. **아직 안 나왔으면 null이다** */
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  unit: string;
  provider: string;
}

/**
 * 중요도. 공급자마다 표기가 다르다 — 0/1/2, 1/2/3, low/medium/high,
 * Low/Moderate/High가 섞인다.
 *
 * 모르면 'unknown'이다. 'low'로 떨어뜨리면 중요한 일정이 조용히
 * 필터에서 빠진다.
 */
export function parseImpact(raw: unknown): Impact {
  if (raw == null || raw === '') return 'unknown';
  const s = String(raw).trim().toLowerCase();

  if (/^(3|high|주요|높음)$/.test(s)) return 'high';
  if (/^(2|medium|moderate|중간|보통)$/.test(s)) return 'medium';
  if (/^(1|low|낮음)$/.test(s)) return 'low';
  // 0을 low로 보는 공급자가 있고 '중요도 없음'으로 쓰는 곳도 있다.
  // 어느 쪽인지 모르므로 unknown이다.
  if (s === '0') return 'unknown';
  if (/high/.test(s)) return 'high';
  if (/med|mod/.test(s)) return 'medium';
  if (/low/.test(s)) return 'low';
  return 'unknown';
}

/**
 * 발표 시각을 ISO UTC로.
 *
 * 시간대 표시가 없는 문자열은 **받지 않는다**. '2026-07-28 14:00'은
 * 어느 나라 2시인지 알 수 없는데, JS의 Date는 그걸 조용히 실행 환경의
 * 시간대로 읽는다. 서버가 UTC면 UTC 2시, 개발자 노트북이 한국이면
 * 한국 2시가 되어 같은 코드가 다른 답을 낸다.
 */
export function toUtc(raw: unknown): string | null {
  if (raw == null || raw === '') return null;

  // 유닉스 초/밀리초
  if (typeof raw === 'number' || /^\d{9,13}$/.test(String(raw))) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date(n >= 1e11 ? n : n * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const s = String(raw).trim();
  // Z 또는 ±HH:MM 이 있어야 시각을 확정할 수 있다
  const hasZone = /(z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (!hasZone) return null;

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 날짜만 뽑는다. 시각이 없어도 일정 자체는 보여줘야 한다 */
export function toDate(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const iso = toUtc(raw);
  return iso ? iso.slice(0, 10) : null;
}

/**
 * 값 정리. 빈 문자열·'-'·'N/A'는 null이다.
 *
 * 빈 문자열을 그대로 두면 화면에 '실제: ' 처럼 빈칸이 뜨는데,
 * 그건 '0으로 나왔다'로도 '아직이다'로도 읽힌다.
 */
export function cleanValue(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || /^(-|—|n\/?a|null|undefined)$/i.test(s)) return null;
  return s;
}

const first = (o: RawEvent, keys: string[]): string => {
  for (const k of keys) {
    const v = o?.[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
};

/** 지문. 같은 지표가 여러 공급자에서 와도 한 번만 남긴다 */
export function eventKey(country: string, title: string, date: string): string {
  const t = title.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  return `${country.toUpperCase()}|${t}|${date}`;
}

export function normalizeEvent(raw: RawEvent, provider: string): CalendarEvent | null {
  if (!raw || typeof raw !== 'object') return null;

  const title = first(raw, ['event', 'title', 'name', 'indicator', 'Event', 'Category']);
  if (!title) return null;

  const country = (first(raw, ['country', 'Country', 'region', 'zone']) || '').toUpperCase().slice(0, 8);
  const at = toUtc(raw.date ?? raw.datetime ?? raw.time ?? raw.Date ?? raw.timestamp);
  const date = toDate(raw.date ?? raw.Date ?? raw.datetime ?? at);
  if (!date) return null;   // 날짜가 없으면 달력에 놓을 자리가 없다

  // 발표 전이면 actual은 null이어야 한다. 공급자가 예상치를 actual
  // 자리에 채워 보내는 경우가 있어, 값이 같으면 의심하지 않고 그대로
  // 두되 **미래 일정이면 actual을 비운다.**
  let actual = cleanValue(raw.actual ?? raw.Actual);
  const forecast = cleanValue(raw.estimate ?? raw.forecast ?? raw.Forecast ?? raw.consensus);
  const previous = cleanValue(raw.previous ?? raw.Previous ?? raw.prior);

  const releaseMs = at ? Date.parse(at) : Date.parse(`${date}T23:59:59Z`);
  if (Number.isFinite(releaseMs) && releaseMs > Date.now() && actual != null) {
    // 아직 발표되지 않은 지표에 실제치가 있을 수 없다.
    // 그대로 두면 "CPI 3.2% 나왔다"가 되는데 안 나온 숫자다.
    actual = null;
  }

  return {
    key: eventKey(country, title, date),
    title, country, at, date,
    impact: parseImpact(raw.impact ?? raw.importance ?? raw.Importance),
    actual, forecast, previous,
    unit: first(raw, ['unit', 'Unit']) || '',
    provider,
  };
}

export interface CollectResult {
  events: CalendarEvent[];
  removed: number;
  skipped: number;
}

/** 같은 지문이면 정보가 더 많은 쪽을 남긴다 */
function richer(a: CalendarEvent, b: CalendarEvent): CalendarEvent {
  const score = (e: CalendarEvent) =>
    (e.at ? 2 : 0) + (e.actual ? 1 : 0) + (e.forecast ? 1 : 0) +
    (e.previous ? 1 : 0) + (e.impact !== 'unknown' ? 1 : 0);
  return score(b) > score(a) ? b : a;
}

export function collectEvents(
  batches: { provider: string; items: RawEvent[] | null | undefined }[],
): CollectResult {
  const byKey = new Map<string, CalendarEvent>();
  let removed = 0, skipped = 0;

  for (const b of batches) {
    if (!Array.isArray(b.items)) continue;
    for (const raw of b.items) {
      const e = normalizeEvent(raw, b.provider);
      if (!e) { skipped++; continue; }
      const prev = byKey.get(e.key);
      if (prev) { removed++; byKey.set(e.key, richer(prev, e)); }
      else byKey.set(e.key, e);
    }
  }

  const events = [...byKey.values()].sort((x, y) => {
    const tx = x.at ? Date.parse(x.at) : Date.parse(`${x.date}T00:00:00Z`);
    const ty = y.at ? Date.parse(y.at) : Date.parse(`${y.date}T00:00:00Z`);
    return tx - ty;
  });

  return { events, removed, skipped };
}

/**
 * 응답 한 줄에 **이름을 두 이름으로** 싣는다.
 *
 * 왜 이런 일을 하는가
 * ───────────────────
 * `/api/calendar`는 지표 이름을 `title`로 내보내는데, 경제 캘린더 화면은
 * `event`를 읽는다. 둘이 안 맞아서 **카드에 이름이 통째로 비어 있었다** —
 * 날짜·예측·이전·중요도는 다 뜨는데 "무슨 발표인지"만 없다.
 *
 * 그리고 이런 어긋남은 조용하다. 빈 문자열은 렌더링에서 그냥 안 보이고,
 * 타입도 안 잡아 준다(응답이 any로 흐른다). 자동매매의 경제지표 회피
 * 게이트는 같은 이유로 `cd.events`를 읽고 있었는데 라우트는 `data`를 준다 —
 * 그쪽은 **항상 빈 배열**이라 지표 회피가 한 번도 걸린 적이 없다.
 *
 * 한쪽 이름만 남기고 소비자를 고치는 게 정석이지만, 이 응답을 읽는 곳을
 * 전부 찾았다고 확신할 수 없다. 못 찾은 곳은 다시 조용히 비어 있게 된다.
 * 그래서 **둘 다 싣고 항상 같은 값이게** 만든다.
 */
export function withEventName<T extends Record<string, any>>(row: T): T & { event: string; title: string } {
  const name = String(row?.event ?? row?.title ?? '');
  return { ...row, event: name, title: name };
}

/** 수동 동기화 최소 간격(ms). 같은 데이터를 1분에 열 번 받아도 달라지는 게 없다 */
export const SYNC_COOLDOWN_MS = 10 * 60_000;

/**
 * 지금 다시 받아와도 되는가.
 *
 * 순수 함수로 두는 이유: "몇 초 남았다"를 화면이 그대로 쓰기 때문이다.
 * 라우트가 직접 계산하면 남은 시간이 음수로 나오거나(시계가 뒤로 간 경우)
 * 0초인데 못 누르는 상태가 조용히 생긴다.
 */
export function syncCooldown(lastAt: number, nowMs: number): { allowed: boolean; waitSec: number } {
  const last = Number(lastAt);
  // 한 번도 안 했으면 바로 된다. 시계가 뒤로 갔을 때(미래의 lastAt)도
  // 영원히 잠기지 않게 막는다.
  if (!Number.isFinite(last) || last <= 0 || last > nowMs) return { allowed: true, waitSec: 0 };
  const left = SYNC_COOLDOWN_MS - (nowMs - last);
  if (left <= 0) return { allowed: true, waitSec: 0 };
  return { allowed: false, waitSec: Math.ceil(left / 1000) };
}
