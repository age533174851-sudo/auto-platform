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
// 확인 가능 · 실행기는 15분 주기지만 실제 실행 시각은 보장되지 않음"이라고 적는다.
// 모르는 것을 아는 것처럼 적으면 1분 늦은 것을 고장으로 읽는다.

/** 서버 실행기(autotrade-tick)가 예약을 확인하는 주기(분) */
export const RUNNER_INTERVAL_MIN = 15;

/** interval_min이 없을 때(마이그레이션 035 전) — 하루로 본다. 0으로 읽으면 간격이 사라진다 */
export const DEFAULT_INTERVAL_MIN = 1440;

/**
 * 실행기가 "늦었다"고 볼 배수.
 *
 * **여기에 둔 이유:** `evaluationLoop.ts`가 이 파일을 import하므로 반대
 * 방향은 순환이 된다. 그래서 상수를 이 파일에 두고 그쪽이 다시 내보낸다 —
 * 두 벌로 적으면 화면과 판정이 갈린다.
 */
export const RUNNER_LATE_FACTOR = 3;

// ── 주기를 약속하지 않는다 (#592 2번) ──────────────────────────────
//
// 화면 세 자리가 "서버가 **15분마다** 확인합니다"라고 적고 있었다.
// 그 15분은 위 `RUNNER_INTERVAL_MIN`, 즉 **워크플로에 선언된 값**이다.
//
// 2026-11-07 실측: GitHub Actions `schedule`은 선언과 무관하게 하루
// 4~5회만 돌았다(워크플로 8개, 선언 24~288회/일 → 실측 4.3~5.0회/일).
// `autotrade-tick`은 실측 4.9회/일 ≒ **294분 간격**이다. 즉 화면이
// 약속한 주기가 실제보다 약 20배 낙관적이었다.
//
// `TrailPanel`은 "청산 감시가 5분마다"라고 적었다. 그 5분은 Fly Worker의
// `pollExitMonitor` 주기이고, GitHub 대체의 실측은 ~320분이다 — **64배**.
// 손절·트레일링 문구라 이쪽이 더 무겁다: 사용자는 약속을 읽고 손절이 그
// 간격으로 확인된다고 믿는다.
//
// 이 저장소는 같은 자리에서 이미 한 번 틀렸다. `AutotradeControl.tsx:1275`의
// 주석이 적고 있다 — 예전에는 "크론은 매일 23:00 UTC"라는 고정 문구였고,
// 그것을 걷어낸 자리를 **또 다른 고정 주기 문구로 채웠다.**
//
// 고치는 방향은 "약속을 지우고 관측을 적는 것"이다. 다만
// `AutotradeControl`에는 관측값(`runnerLastSeenMs`)이 **아예 없다** —
// 없는 관측을 꾸며 낼 수는 없으므로, 관측이 주어지면 그것을 앞세우고
// 없으면 **선언값임을 밝히고 보장하지 않는다**고 적는다.
//
// 그리고 이 문구는 **한 곳**에만 둔다. 세 자리에 따로 적으면 언젠가
// 한쪽만 고쳐진다 — `CLAUDE.md`가 "자주 나는 고장 ②"로 적어 둔 그것이다.

export type CadenceCode =
  /** 마지막 확인 시각을 **관측했다** */
  | 'OBSERVED'
  /** 관측했는데 선언 주기를 크게 넘겼다 */
  | 'STALE'
  /** 관측이 없다 — 선언값만 적는다 */
  | 'DECLARED_ONLY'
  /** **모른다.** 0분도 아니고 정상도 아니다 */
  | 'UNKNOWN';

export interface CadenceNote {
  code: CadenceCode;
  /** 마지막 확인으로부터 지난 분. 관측이 없으면 null — 0이 아니다 */
  agoMin: number | null;
  /** 화면에 그대로 적을 문장. **절대 "N분마다"라고 쓰지 않는다** */
  text: string;
}

/**
 * 확인 주기를 화면에 어떻게 적을 것인가.
 *
 * 계약: 돌려주는 `text`에는 **`분마다`가 들어가지 않는다.** 그 형태가
 * 곧 약속이고, 이 저장소에서 실제로 20~64배 틀렸던 문장의 모양이다.
 * `nextRun.test.ts`가 모든 분기에서 그것을 못 박는다.
 */
export function cadenceNote(i: {
  /** 선언된 주기(분). 모르면 null */
  declaredMin: number | null | undefined;
  /** 마지막으로 **실제로** 확인된 시각(ms). 없으면 null */
  lastSeenMs?: number | null;
  nowMs?: number | null;
  lateFactor?: number;
  /** 무엇의 주기인가 — '서버 실행기' · '청산 감시' */
  subject?: string;
}): CadenceNote {
  const who = String(i?.subject || '').trim() || '서버 실행기';
  const declared = num(i?.declaredMin);
  const hasDeclared = declared != null && declared > 0;
  const last = num(i?.lastSeenMs);
  const now = num(i?.nowMs);
  const factor = num(i?.lateFactor) ?? RUNNER_LATE_FACTOR;

  // ── 관측이 있으면 그것을 앞세운다 ──
  if (last != null && now != null) {
    const elapsed = now - last;
    if (elapsed < 0) {
      // 시계가 어긋났다. 그대로 믿고 "방금 확인했다"고 적지 않는다.
      return { code: 'UNKNOWN', agoMin: null,
        text: `${who}의 마지막 확인 시각이 현재보다 미래입니다 — 시계가 어긋나 알 수 없습니다` };
    }
    const agoMin = Math.round(elapsed / 60_000);
    if (hasDeclared && elapsed > (declared as number) * factor * 60_000) {
      return { code: 'STALE', agoMin,
        text: `${who} 마지막 확인 ${agoMin}분 전 — 선언 주기 ${declared}분을 크게 넘겼습니다 (지연 또는 중단)` };
    }
    return { code: 'OBSERVED', agoMin,
      text: hasDeclared
        ? `${who} 마지막 확인 ${agoMin}분 전 (선언 주기 ${declared}분 · 실제 확인 시각은 보장되지 않습니다)`
        : `${who} 마지막 확인 ${agoMin}분 전 (확인 주기는 알 수 없습니다)` };
  }

  // ── 관측이 없다 ──
  if (!hasDeclared) {
    return { code: 'UNKNOWN', agoMin: null,
      text: `${who}의 확인 주기를 알 수 없습니다 — 돌고 있다는 뜻도, 멈췄다는 뜻도 아닙니다` };
  }
  return { code: 'DECLARED_ONLY', agoMin: null,
    text: `${who} 선언 주기 ${declared}분 — 실제 확인 시각은 보장되지 않습니다` };
}

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
  /** 실제 점검 시각의 보장 상한. 예약 cron에는 보장 상한이 없으므로 null */
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
      latestCheckMs: null,
      intervalMin: interval, runnerIntervalMin: runner,
      summary: `아직 점검된 적 없습니다 — 실행기 확인 주기 ${runner}분, 실제 시각은 보장되지 않습니다`,
    };
  }

  const nextMs = last + gapMs;
  if (nextMs <= i.nowMs) {
    return {
      state: 'DUE', nextCheckMs: nextMs,
      // cron 지연에는 보장된 상한이 없다. 주기를 실제 완료의 상한으로 쓰지 않는다.
      latestCheckMs: null,
      intervalMin: interval, runnerIntervalMin: runner,
      summary: `간격이 지났습니다 — 실행기 확인 주기 ${runner}분, 실제 시각은 보장되지 않습니다`,
    };
  }

  const leftMin = Math.ceil((nextMs - i.nowMs) / 60_000);
  return {
    state: 'WAITING', nextCheckMs: nextMs,
    latestCheckMs: null,
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
    out.push({ label: '다음 확인 가능', value: `실행기가 오는 대로 (확인 주기 ${plan.runnerIntervalMin}분 · 지연 가능)`, unknown: true });
  } else if (plan.state === 'DUE') {
    out.push({ label: '다음 확인 가능', value: '지금 가능 — 실행기 대기 중' });
  } else if (plan.state === 'OFF') {
    out.push({ label: '다음 확인 가능', value: '꺼져 있음', unknown: true });
  } else {
    push('다음 확인 가능', plan.nextCheckMs, '—');
  }

  out.push({
    label: '실행기 확인 주기',
    value: `${plan.runnerIntervalMin}분마다 확인 예정 · 지연될 수 있으며 상한은 보장되지 않습니다`,
  });
  return out;
}
