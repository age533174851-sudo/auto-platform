// src/lib/autotrade/nextRun.ts
//
// **"다음 실행 매일 23:00 UTC(한국 08:00)"는 사실이 아니었다.**
//
// 무엇이 틀렸나
// ─────────────
// 그 문구는 vercel.json의 daily-ladder 크론(하루 1회) 시절에 적은 것이다.
// 그런데 지금 실제 실행기는 `.github/workflows/autotrade-tick.yml`이고
// **15분마다** 예약을 확인한다. 실제로 진입할 수 있는 시각은 그 워크플로가
// 아니라 예약 줄의 `interval_min`과 `last_run_at`이 정한다.
//
// 그래서 화면은 아침 8시를 가리키는데 실제로는 15분 뒤에 한 번, 그다음
// 간격마다 계속 볼 수 있는 상태였다. 사용자는 켜 놓고 다음 날 아침까지
// 기다릴 이유가 없는데도 기다린다.
//
// **고정 시각을 적는 것 자체가 틀렸다.** 다음 확인 가능 시각은 예약마다
// 다르고, 마지막 점검이 언제였느냐로 움직인다.
//
// 여기서 안 하는 것
// ─────────────────
// 실행기가 정확히 언제 올지는 **모른다.** GitHub Actions는 부하에 따라
// 몇 분 늦는다. 그래서 "다음 실행 12:34"라고 단정하지 않고 "12:34부터
// 가능 · 실행기가 15분마다 보므로 몇 분 늦을 수 있음"이라고 적는다.
// 모르는 것을 아는 것처럼 적으면 1분 늦은 것을 고장으로 읽는다.

/** 서버 실행기(autotrade-tick)가 예약을 확인하는 주기(분) */
export const RUNNER_INTERVAL_MIN = 15;

/** interval_min이 없을 때(마이그레이션 035 전) — 하루로 본다. 0으로 읽으면 간격이 사라진다 */
export const DEFAULT_INTERVAL_MIN = 1440;

export interface NextRunInput {
  nowMs: number;
  /** 예약을 켠 시각 */
  enabledAtMs?: number | null;
  /** 마지막 **점검** 시각 (autotrade_schedules.last_run_at) */
  lastRunAtMs?: number | null;
  /** 마지막 **실제 진입** 시각. 점검과 다르다 — 대부분의 점검은 진입하지 않는다 */
  lastEntryAtMs?: number | null;
  intervalMin?: number | null;
  runnerIntervalMin?: number;
  /**
   * 방금 켜서 첫 점검이 도는 중인가.
   *
   * last_run_at이 아직 없는 것과 "영영 안 돌았다"는 다르다 — 켜는 순간
   * 즉시 한 번 돌리므로, 그 사이의 몇 초를 '실행된 적 없음'으로 적으면
   * 사용자는 켜기가 실패한 줄 안다.
   */
  firstCheckRunning?: boolean;
}

export type NextRunState =
  /** 예약이 꺼져 있다 */
  | 'OFF'
  /** 방금 켜서 첫 점검이 도는 중 */
  | 'FIRST_CHECK_RUNNING'
  /** 간격이 이미 지났다 — 실행기가 오는 대로 본다 */
  | 'DUE'
  /** 간격이 아직 안 됐다 */
  | 'WAITING'
  /** 켜져 있는데 점검 기록이 없다 (실행기가 아직 안 왔다) */
  | 'NEVER_RAN';

export interface NextRunPlan {
  state: NextRunState;
  /** 다음 확인 **가능** 시각(ms). 모르면 null */
  nextCheckMs: number | null;
  /** 실행기 지연까지 더한 현실적인 상한(ms). 모르면 null */
  latestCheckMs: number | null;
  intervalMin: number;
  runnerIntervalMin: number;
  /** 한 줄 요약 */
  summary: string;
}

/**
 * 숫자로 읽되 **없는 것을 0으로 읽지 않는다.**
 *
 * `Number(null)`은 0이다. 그래서 이 함수를 `Number.isFinite`만으로 쓰면
 * `lastRunAtMs: null`이 시각 0이 되고, 화면에는 **1970년 1월 1일**이
 * 마지막 점검 시각으로 뜬다. 그리고 0 + 간격은 언제나 과거이므로
 * "간격이 지났습니다"가 되어, 한 번도 안 돈 예약이 곧 실행될 것처럼 보인다.
 *
 * 이 저장소에서 반복해 난 고장이고, 이 파일도 처음엔 같은 실수를 했다.
 */
const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function intervalMinOf(v: any): number {
  const n = num(v);
  // **0을 유효한 간격으로 받지 않는다.** 0이면 간격이 통째로 사라져
  // 조건이 맞는 동안 매 분 진입한다.
  return n != null && n >= 1 ? n : DEFAULT_INTERVAL_MIN;
}

export function nextRunPlan(i: NextRunInput, enabled = true): NextRunPlan {
  const interval = intervalMinOf(i.intervalMin);
  const runner = num(i.runnerIntervalMin) ?? RUNNER_INTERVAL_MIN;
  const gapMs = interval * 60_000;

  if (!enabled) {
    return {
      state: 'OFF', nextCheckMs: null, latestCheckMs: null,
      intervalMin: interval, runnerIntervalMin: runner,
      summary: '꺼져 있습니다 — 확인하지 않습니다',
    };
  }

  if (i.firstCheckRunning) {
    return {
      state: 'FIRST_CHECK_RUNNING', nextCheckMs: null, latestCheckMs: null,
      intervalMin: interval, runnerIntervalMin: runner,
      summary: '지금 첫 점검 중',
    };
  }

  const last = num(i.lastRunAtMs);
  if (last == null) {
    // 켰는데 아직 한 번도 안 돌았다. 실행기가 오는 대로 본다.
    return {
      state: 'NEVER_RAN',
      nextCheckMs: null,
      latestCheckMs: (num(i.enabledAtMs) ?? i.nowMs) + runner * 60_000,
      intervalMin: interval, runnerIntervalMin: runner,
      summary: `아직 점검된 적 없습니다 — 실행기가 ${runner}분 안에 확인합니다`,
    };
  }

  const nextMs = last + gapMs;
  if (nextMs <= i.nowMs) {
    return {
      state: 'DUE', nextCheckMs: nextMs,
      // 이미 지났으므로 다음 실행기 방문까지가 상한이다.
      latestCheckMs: i.nowMs + runner * 60_000,
      intervalMin: interval, runnerIntervalMin: runner,
      summary: `간격이 지났습니다 — 실행기가 오는 대로(최대 ${runner}분) 확인합니다`,
    };
  }

  const leftMin = Math.ceil((nextMs - i.nowMs) / 60_000);
  return {
    state: 'WAITING', nextCheckMs: nextMs,
    latestCheckMs: nextMs + runner * 60_000,
    intervalMin: interval, runnerIntervalMin: runner,
    summary: `다음 진입 확인까지 ${leftMin}분 남았습니다`,
  };
}

// ── 시각 표기 ────────────────────────────────────────────

export const KST = 'Asia/Seoul';

/**
 * 한국 시각으로 적는다.
 *
 * UTC 원문은 **기본으로 안 보여준다.** 한국 사용자가 매번 9시간을 더해
 * 읽어야 하는 화면은 읽히지 않는 화면이다. 필요하면 자세히 보기에서 본다.
 */
export function fmtKst(ms: number | null | undefined, opts: { withDate?: boolean } = {}): string {
  const n = num(ms);
  if (n == null) return '—';
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: KST,
      ...(opts.withDate === false ? {} : { dateStyle: 'medium' }),
      timeStyle: 'short',
    }).format(new Date(n));
  } catch { return '—'; }
}

/**
 * 그 시각의 **한국 시계**(시·분).
 *
 * 표시 문자열이 아니라 숫자로 준다. 표시 문자열은 실행 환경의 ICU에 따라
 * 달라져서 "한국 시각이 맞는가"를 확인할 수 없다 — 확인할 수 없으면
 * 어느 날 조용히 서버 현지시각으로 바뀌어도 아무도 모른다.
 *
 * 숫자 표기는 en-US로 뽑는다. 로케일에 따라 아라비아 숫자가 아닌
 * 환경에서도 파싱이 깨지지 않는다.
 */
export function kstClock(ms: number | null | undefined): { hh: number; mm: number } | null {
  const n = num(ms);
  if (n == null) return null;
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: KST, hour12: false, hour: '2-digit', minute: '2-digit',
    });
    const got: Record<string, string> = {};
    for (const p of f.formatToParts(new Date(n))) got[p.type] = p.value;
    // 자정을 '24'로 주는 환경이 있다 (marketHours.zonedParts와 같은 이유).
    const hh = Number(got.hour) % 24;
    const mm = Number(got.minute);
    return Number.isFinite(hh) && Number.isFinite(mm) ? { hh, mm } : null;
  } catch { return null; }
}

/** 자세히 보기용 UTC 원문 */
export function fmtUtc(ms: number | null | undefined): string {
  const n = num(ms);
  if (n == null) return '—';
  try { return new Date(n).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
  catch { return '—'; }
}

export interface NextRunLine {
  label: string;
  value: string;
  /** UTC 원문. 자세히 보기에서만 쓴다 */
  utc?: string;
  /** 이 줄이 '모름'인가 — 모름을 값처럼 적지 않기 위해 */
  unknown?: boolean;
}

/**
 * 화면에 그대로 그릴 줄들.
 *
 * **없는 것을 지어내지 않는다.** 마지막 진입이 없으면 '없음'이지
 * 마지막 점검 시각이 아니다 — 그 둘을 섞으면 "오늘 이미 들어갔나?"에
 * 틀린 답을 준다.
 */
export function nextRunLines(i: NextRunInput, plan: NextRunPlan): NextRunLine[] {
  const out: NextRunLine[] = [];
  const push = (label: string, ms: number | null | undefined, fallback: string) => {
    const n = num(ms);
    if (n == null) out.push({ label, value: fallback, unknown: true });
    else out.push({ label, value: fmtKst(n), utc: fmtUtc(n) });
  };

  push('켠 시각', i.enabledAtMs, '기록 없음');
  push('마지막 점검', i.lastRunAtMs, '아직 없음');
  push('마지막 실제 진입', i.lastEntryAtMs, '없음');
  out.push({ label: '진입 확인 간격', value: `${plan.intervalMin}분` });

  if (plan.state === 'FIRST_CHECK_RUNNING') {
    out.push({ label: '다음 확인 가능', value: '지금 첫 점검 중', unknown: true });
  } else if (plan.state === 'NEVER_RAN') {
    out.push({ label: '다음 확인 가능', value: `실행기가 오는 대로 (최대 ${plan.runnerIntervalMin}분)`, unknown: true });
  } else if (plan.state === 'DUE') {
    out.push({ label: '다음 확인 가능', value: '지금 가능 — 실행기 대기 중' });
  } else if (plan.state === 'OFF') {
    out.push({ label: '다음 확인 가능', value: '꺼져 있음', unknown: true });
  } else {
    push('다음 확인 가능', plan.nextCheckMs, '—');
  }

  out.push({
    label: '실행기 확인 주기',
    value: `${plan.runnerIntervalMin}분마다 · 부하에 따라 몇 분 늦을 수 있습니다`,
  });
  return out;
}
