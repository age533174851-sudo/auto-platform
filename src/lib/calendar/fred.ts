// src/lib/calendar/fred.ts
//
// FRED(세인트루이스 연준) 발표 일정 — **무료 키로 받는 미국 공식 일정.**
//
// 왜 FRED인가
// ───────────
// TradingEconomics는 $149/월이고 FMP 무료 플랜은 경제 캘린더를 막는다.
// FRED는 연준이 운영하고 키가 무료다. 예상치·이전치는 안 주지만,
// **이 기능이 필요로 하는 것은 예상치가 아니라 '언제'다** — CPI·FOMC 앞에서
// 진입을 멈추는 것이 목적이고 그러려면 시점만 정확하면 된다.
//
// **시각을 지어내지 않는다**
// ─────────────────────────
// FRED는 날짜만 준다(2026-08-15). 시각이 없다.
//
// 여기서 "미국 지표는 보통 8시 30분 ET니까 그걸 쓰자"는 유혹이 있다.
// 하지만 그건 추측이고, 서머타임까지 얽히면 최대 한 시간이 어긋난다.
// 회피 창이 ±30분인데 시각이 한 시간 틀리면 **정확히 발표 순간에 진입이
// 열려 있다.** 그건 회피가 없는 것보다 나쁘다 — 있다고 믿기 때문이다.
//
// 그래서 시각을 비우고 `timeKnown: false`로 표시한다. 회피 판정은 그런
// 일정을 **그날 하루 전체**로 본다. 더 많이 막고, 덜 막는 일은 없다.
// 모르는 것을 유리하게 읽지 않는다는 이 저장소의 규칙 그대로다.

/** FRED 응답 한 줄 */
export interface FredReleaseDate {
  release_id?: number | string;
  release_name?: string;
  date?: string;      // 'YYYY-MM-DD'
}

export interface FredEvent {
  /** 같은 발표가 두 번 들어가지 않게 하는 열쇠 */
  key: string;
  title: string;
  date: string;
  impact: 'high' | 'medium';
  /** 항상 false — FRED는 시각을 주지 않는다 */
  timeKnown: false;
}

/**
 * 볼 발표와 그 중요도.
 *
 * FRED에는 하루에도 수십 개의 release가 있다. 전부 넣으면 '고영향'이라는
 * 구분이 무의미해지고, 회피가 상시 발동해 매매가 멈춘다. 그래서 **회피할
 * 가치가 있는 것만** 고른다.
 *
 * 이름 전체가 아니라 조각으로 맞춘다 — FRED가 표기를 바꿔도 계속 잡힌다.
 */
export const FRED_WATCH: Array<{ match: string; impact: 'high' | 'medium'; label: string }> = [
  { match: 'consumer price index',        impact: 'high',   label: '미국 소비자물가지수 (CPI)' },
  { match: 'employment situation',        impact: 'high',   label: '미국 고용상황 (NFP)' },
  { match: 'gross domestic product',      impact: 'high',   label: '미국 GDP' },
  { match: 'personal income and outlays', impact: 'high',   label: '미국 개인소비지출 (PCE)' },
  { match: 'fomc',                        impact: 'high',   label: 'FOMC' },
  { match: 'producer price index',        impact: 'medium', label: '미국 생산자물가지수 (PPI)' },
  { match: 'retail',                      impact: 'medium', label: '미국 소매판매' },
  { match: 'industrial production',       impact: 'medium', label: '미국 산업생산' },
  { match: 'consumer sentiment',          impact: 'medium', label: '미국 소비자심리' },
  { match: 'job openings',                impact: 'medium', label: '미국 구인건수 (JOLTS)' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * FRED 응답에서 **볼 만한 발표만** 골라 낸다.
 *
 * 순수 함수다 — 네트워크를 타지 않는다.
 */
export function pickFredEvents(rows: FredReleaseDate[] | null | undefined): FredEvent[] {
  const list = Array.isArray(rows) ? rows : [];
  const out: FredEvent[] = [];
  const seen = new Set<string>();

  for (const r of list) {
    const name = String(r?.release_name || '').trim();
    const date = String(r?.date || '').trim();
    // 날짜가 없거나 모양이 다르면 버린다. 추측해서 채우지 않는다.
    if (!name || !DATE_RE.test(date)) continue;

    const lower = name.toLowerCase();
    const hit = FRED_WATCH.find(w => lower.includes(w.match));
    if (!hit) continue;

    // 같은 날 같은 발표는 한 번만. FRED는 같은 release가 여러 줄로
    // 올 수 있다(정정·재발표).
    const key = `fred-${hit.match.replace(/\s+/g, '-')}-${date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ key, title: hit.label, date, impact: hit.impact, timeKnown: false });
  }

  // 날짜 순. 화면과 저장 양쪽이 같은 순서를 본다.
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 저장할 행으로 바꾼다.
 *
 * `timestamp_utc`는 그날 00:00 UTC다. **이건 발표 시각이 아니다** —
 * 시각을 모른다는 뜻이고, `time_known=false`가 그 사실을 들고 간다.
 * 회피 판정은 그 표시를 보고 하루 전체를 막는다.
 */
export function fredEventsToRows(events: FredEvent[]): Array<Record<string, any>> {
  return (Array.isArray(events) ? events : []).map(e => ({
    id: e.key,
    timestamp_utc: `${e.date}T00:00:00.000Z`,
    time_known: false,
    event: e.title,
    impact: e.impact,
    country: 'US',
    actual: null,
    forecast: null,
    previous: null,
    source: 'fred',
    updated_at: new Date().toISOString(),
  }));
}

/** FRED 조회 주소. 키는 부르는 쪽이 넣는다 */
export function fredReleaseDatesUrl(apiKey: string, from: string, to: string, limit = 1000): string {
  const q = new URLSearchParams({
    api_key: apiKey,
    file_type: 'json',
    realtime_start: from,
    realtime_end: to,
    include_release_dates_with_no_data: 'true',
    sort_order: 'asc',
    limit: String(limit),
  });
  return `https://api.stlouisfed.org/fred/releases/dates?${q.toString()}`;
}
