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
    out.push({ id: e.id || '', title: e.title || '경제지표', impact: e.impact || 'medium', at });
  }
  return out;
}
