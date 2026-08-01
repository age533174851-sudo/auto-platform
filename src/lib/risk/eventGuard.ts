// src/lib/risk/eventGuard.ts
// 경제지표 회피 — CPI/FOMC/NFP 등 고영향 지표 발표 전후 거래 중지
//
// 발표 시각 기준 ±윈도우(기본 발표 전 30분 ~ 발표 후 60분) 동안 진입 차단

export interface EconEvent {
  id: string;
  title: string;
  impact: 'high' | 'medium' | 'low';
  // 발표 시각 (epoch ms). 캘린더 API가 date+time 주면 변환
  at: number;
  /**
   * **시각을 모르고 날짜만 아는 일정.**
   *
   * FRED(연준)는 무료지만 날짜만 준다. 그때 '보통 8시 30분 ET'를 넣고 싶어
   * 지는데, 그건 추측이고 서머타임까지 얽히면 한 시간이 어긋난다. 회피 창이
   * ±30분이면 **정확히 발표 순간에 진입이 열려 있다** — 회피가 없는 것보다
   * 나쁘다. 있다고 믿기 때문이다.
   *
   * 그래서 시각을 지어내지 않고 이 표시를 단다. 아래 판정은 이런 일정을
   * **그날(UTC) 전체**로 본다. 더 많이 막고, 덜 막는 일은 없다.
   */
  dayOnly?: boolean;
}

export interface EventGuardResult {
  blocked: boolean;
  reason: string;
  event?: { title: string; minutesUntil: number };
}

// 고영향 지표 발표 윈도우 안에 있는지 체크
export function checkEventWindow(
  events: EconEvent[],
  opts?: { beforeMin?: number; afterMin?: number; minImpact?: 'high' | 'medium' },
): EventGuardResult {
  const now = Date.now();
  const beforeMin = opts?.beforeMin ?? 30;
  const afterMin  = opts?.afterMin ?? 60;
  const minImpact = opts?.minImpact ?? 'high';

  const impactRank = { high: 3, medium: 2, low: 1 };
  const threshold = impactRank[minImpact];

  for (const ev of events) {
    if (impactRank[ev.impact] < threshold) continue;

    // 시각을 모르는 일정은 **그날 하루 전체**가 회피 구간이다.
    // ±윈도우를 쓰면 0시 기준이 되어 정작 발표 시각에는 안 막힌다.
    if (ev.dayOnly) {
      const d0 = Date.UTC(
        new Date(ev.at).getUTCFullYear(),
        new Date(ev.at).getUTCMonth(),
        new Date(ev.at).getUTCDate());
      if (now >= d0 && now < d0 + 86_400_000) {
        return {
          blocked: true,
          reason: `${ev.title} 발표일 — 시각을 몰라 하루 전체를 회피합니다`,
          event: { title: ev.title, minutesUntil: 0 },
        };
      }
      continue;
    }

    const diffMin = (ev.at - now) / 60000;   // 양수=발표 전, 음수=발표 후
    // 발표 전 beforeMin 이내 OR 발표 후 afterMin 이내
    if (diffMin <= beforeMin && diffMin >= -afterMin) {
      return {
        blocked: true,
        reason: diffMin >= 0
          ? `${ev.title} 발표 ${Math.round(diffMin)}분 전 — 거래 중지`
          : `${ev.title} 발표 후 ${Math.round(-diffMin)}분 — 거래 중지`,
        event: { title: ev.title, minutesUntil: Math.round(diffMin) },
      };
    }
  }
  return { blocked: false, reason: '회피 대상 지표 없음' };
}

// 캘린더 API 응답 → EconEvent[] 변환
export function parseCalendarEvents(raw: any[]): EconEvent[] {
  const out: EconEvent[] = [];
  for (const e of raw || []) {
    // date(YYYY-MM-DD) + time(HH:MM) → epoch
    let at = 0;
    if (e.at) at = e.at;
    else if (e.date && e.time) {
      const dt = new Date(`${e.date}T${e.time}:00`);
      at = dt.getTime();
    } else if (e.date) {
      at = new Date(e.date).getTime();
    }
    if (!at || isNaN(at)) continue;
    // `time_known === false`만 하루 종일로 본다. 값이 없으면(옛 행·다른
    // 공급자) 시각을 아는 것으로 둔다 — 없는 값을 '모른다'로 읽으면
    // 기존 일정이 전부 하루 종일 회피가 되어 매매가 통째로 멈춘다.
    const dayOnly = e.dayOnly === true || e.time_known === false;
    out.push({
      id: e.id || '', title: e.title || '경제지표',
      impact: e.impact || 'medium', at, dayOnly,
    });
  }
  return out;
}
