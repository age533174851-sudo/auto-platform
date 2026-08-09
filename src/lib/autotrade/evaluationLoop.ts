// src/lib/autotrade/evaluationLoop.ts
//
// **자동매매가 지금 돌고 있는가, 다음은 언제인가.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// 예약을 켜면 지금까지 이런 일이 일어났다:
//
//   스위치 ON → DB에 enabled=true → **아무 일도 안 일어남**
//   → 최대 15분 뒤 실행기가 와서 처음 본다
//
// 그 15분 동안 화면에는 근거가 없다. "켰는데 왜 아무것도 안 하지"의
// 답이 어디에도 없어서, 사용자는 스위치를 껐다 켰다 한다. 그러면 첫
// 평가가 여러 번 들어간다 — **평가가 두 번 도는 것은 주문이 두 번
// 나가는 것과 같다.** 조건이 맞았으면 둘 다 들어간다.
//
// 그래서 두 가지를 값으로 만든다:
//   1. 지금 평가할 차례인가 (`dueCheck`)
//   2. 지금 어떤 상태인가 · 다음은 언제인가 (`runtimeStateOf`)
//
// 왜 순수 함수인가
// ────────────────
// 이 판정이 틀리면 두 방향 모두 사고다. 너무 자주 due면 조건이 맞는
// 동안 매 분 진입하고, 너무 드물게 due면 켜 놓은 자동매매가 안 돈다.
// 거래소도 DB도 없이 값으로 확인할 수 있어야 한다.
//
// 없는 것을 0으로 읽지 않는다
// ───────────────────────────
// `Number(null)`은 0이다. 마지막 평가 시각을 0으로 읽으면 1970년이 되고,
// 0 + 간격은 언제나 과거라서 **한 번도 안 돈 예약이 매번 due**가 된다.
// 이 저장소에서 반복해 난 고장이라 파싱을 한 곳에 모은다.

import type { EvaluationOutcome } from '../strategies/runStrategy';
import type { DecisionVerdict } from '../ui/autoOverview';
import { intervalMinOf, RUNNER_INTERVAL_MIN } from './nextRun';

/** null·빈 문자열·boolean은 숫자가 아니다. **0으로 눕히지 않는다** */
const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** ISO 문자열이나 ms를 ms로. 못 읽으면 null */
export function msOf(v: any): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// ── 1. 지금 평가할 차례인가 ──────────────────────────────

export type DueCode =
  /** 꺼져 있다 */
  | 'OFF'
  /** 거래소 연결이 없다 — 평가해도 주문을 못 낸다 */
  | 'NO_CONNECTION'
  /** 켠 뒤 아직 한 번도 안 돌았다. **지금 돌린다** */
  | 'FIRST'
  /** 간격이 지났다 */
  | 'DUE'
  /** 간격이 아직 안 됐다 */
  | 'WAITING'
  /** 방금 돌았다 — 중복 호출 */
  | 'TOO_SOON';

export interface DueVerdict {
  due: boolean;
  code: DueCode;
  /** 다음까지 남은 분. 모르면 null */
  leftMin: number | null;
  reason: string;
}

/**
 * 같은 평가가 연달아 두 번 들어오는 것을 막는 최소 간격.
 *
 * 사용자가 스위치를 두 번 누르거나 화면이 재시도하면 몇 초 안에 같은
 * 요청이 두 번 온다. 간격(분) 검사만으로는 **간격이 지난 상태**에서
 * 둘 다 통과한다.
 */
export const MIN_GAP_MS = 60_000;

export function dueCheck(i: {
  nowMs: number;
  enabled: any;
  connectionId?: any;
  lastRunAtMs?: any;
  intervalMin?: any;
}): DueVerdict {
  if (i.enabled !== true) {
    return { due: false, code: 'OFF', leftMin: null, reason: '꺼져 있습니다' };
  }
  // 연결이 없으면 평가해도 주문을 낼 수 없다. 여기서 걸러야 "왜 안 됐나"가
  // 예약 줄에 남는다 — 실행기까지 보내면 그 답이 실행기 로그에 묻힌다.
  if (i.connectionId != null && String(i.connectionId).trim() === '') {
    return { due: false, code: 'NO_CONNECTION', leftMin: null,
      reason: '거래소 연결이 지정되지 않았습니다' };
  }

  const interval = intervalMinOf(i.intervalMin);
  const last = msOf(i.lastRunAtMs);

  // **한 번도 안 돈 것과 오래전에 돈 것은 다르다.** 전자는 지금 돌린다.
  if (last == null) {
    return { due: true, code: 'FIRST', leftMin: null,
      reason: '아직 한 번도 평가하지 않았습니다 — 지금 첫 평가를 합니다' };
  }

  const since = i.nowMs - last;
  if (since < MIN_GAP_MS) {
    return { due: false, code: 'TOO_SOON', leftMin: 0,
      reason: `${Math.max(0, Math.round(since / 1000))}초 전에 평가했습니다 — 중복 실행을 막습니다` };
  }

  const gapMs = interval * 60_000;
  if (since >= gapMs) {
    return { due: true, code: 'DUE', leftMin: 0,
      reason: `간격 ${interval}분이 지났습니다` };
  }
  const leftMin = Math.ceil((gapMs - since) / 60_000);
  return { due: false, code: 'WAITING', leftMin,
    reason: `다음 평가까지 ${leftMin}분 남았습니다` };
}

/**
 * 다음 평가가 **가능해지는** 시각.
 *
 * '실행되는 시각'이 아니다 — 실행기는 주기적으로 와서 보므로 몇 분
 * 늦을 수 있다. 단정해서 적으면 1분 늦은 것을 고장으로 읽는다.
 */
export function nextEvaluationAtMs(i: { lastRunAtMs?: any; intervalMin?: any }): number | null {
  const last = msOf(i.lastRunAtMs);
  if (last == null) return null;   // 안 돌았으면 '다음'이 아니라 '처음'이다
  return last + intervalMinOf(i.intervalMin) * 60_000;
}

// ── 2. 결과를 무엇으로 적는가 ────────────────────────────

/**
 * 평가 결과 → 기존 화면이 읽는 판정값.
 *
 * 화면(`autoOverview`)은 ENTERED·WATCHING·BLOCKED·ERROR를 읽는다.
 * 평가기(`runStrategy`)는 ENTERED·NO_SIGNAL·BLOCKED·FAILED를 만든다.
 * **둘 다 남긴다** — 새 값은 `outcome`에, 옛 값은 `verdict`에.
 *
 * 한쪽만 적으면 옛 화면이 조용히 '기록 없음'을 그리고, 그 화면을 보는
 * 사람은 자동매매가 안 돈 줄 안다.
 *
 * `NO_SIGNAL`은 `WATCHING`이다 — **정상이고 실패가 아니다.**
 */
export function verdictOfOutcome(outcome: EvaluationOutcome | string): DecisionVerdict {
  switch (outcome) {
    case 'ENTERED': return 'ENTERED';
    case 'NO_SIGNAL': return 'WATCHING';
    case 'BLOCKED': return 'BLOCKED';
    case 'FAILED': return 'ERROR';
    default: return 'UNKNOWN';
  }
}

/** `last_result` 한 줄. 사람이 목록에서 바로 읽는 문장이다 */
export function resultLineOf(outcome: EvaluationOutcome | string, summary: any): string {
  const label = outcome === 'ENTERED' ? '진입'
    : outcome === 'NO_SIGNAL' ? '진입 안 함'
    : outcome === 'BLOCKED' ? '차단됨'
    : outcome === 'FAILED' ? '실패'
    : '알 수 없음';
  const s = summary == null ? '' : String(summary).trim();
  return (s ? `${label}: ${s}` : label).slice(0, 300);
}

// ── 3. 지금 어떤 상태인가 ────────────────────────────────

export type RuntimeState =
  /** 꺼져 있다 */
  | 'OFF'
  /** 켜져 있는데 아직 한 번도 평가되지 않았다 */
  | 'NEVER_RAN'
  /** 마지막 평가가 진입이었다 */
  | 'ENTERED'
  /** 정상 평가 중 · 조건 대기 */
  | 'WATCHING'
  /** 안전장치가 막고 있다 */
  | 'BLOCKED'
  /** 마지막 평가가 실패했다 */
  | 'FAILED'
  /** 켜져 있는데 한참 평가되지 않았다 — 실행기가 안 오고 있다 */
  | 'STALE'
  /** 읽지 못했다. **꺼짐이 아니다** */
  | 'UNKNOWN';

export type RuntimeTone = 'good' | 'warn' | 'bad' | 'muted';

export const RUNTIME_LABEL: Record<RuntimeState, string> = {
  OFF: '꺼짐',
  NEVER_RAN: '첫 평가 대기',
  ENTERED: '진입함',
  WATCHING: '감시 중',
  BLOCKED: '차단됨',
  FAILED: '실패',
  STALE: '실행기 응답 없음',
  UNKNOWN: '확인 못 함',
};

export const RUNTIME_TONE: Record<RuntimeState, RuntimeTone> = {
  OFF: 'muted', NEVER_RAN: 'warn', ENTERED: 'good', WATCHING: 'good',
  BLOCKED: 'bad', FAILED: 'bad', STALE: 'bad', UNKNOWN: 'muted',
};

export interface RuntimeStatus {
  state: RuntimeState;
  tone: RuntimeTone;
  reason: string;
  lastEvaluationAtMs: number | null;
  nextEvaluationAtMs: number | null;
  /** 실행기가 마지막으로 온 시각. **못 읽으면 null** */
  runnerLastSeenMs: number | null;
  /** 실행기가 늦고 있는가. 못 읽었으면 null — false가 아니다 */
  runnerStale: boolean | null;
}

/**
 * 실행기가 늦었다고 볼 때까지 몇 배를 기다리는가.
 *
 * 실행기는 부하에 따라 몇 분 늦는다. 한 주기 놓쳤다고 '멈췄다'고 적으면
 * 경고가 상시로 켜져 있고, 그러면 진짜 멈췄을 때 아무도 안 본다.
 */
export const RUNNER_LATE_FACTOR = 3;

/**
 * 이 예약이 지금 어떤 상태인가.
 *
 * **`enabled`는 `running`이 아니다.** DB에 켜져 있다고 실제로 돌고 있는
 * 것이 아니다. 실행기가 죽어 있으면 그건 '설정이 켜져 있다'일 뿐이고,
 * 화면이 그것을 '감시 중'이라고 적으면 거짓말이 된다 — 사용자는
 * 자동매매가 자기 돈을 지키고 있다고 믿는다.
 *
 * 판정 순서가 곧 의미다:
 *   1. 꺼져 있으면 끝 — 나머지는 볼 필요가 없다
 *   2. 실행기가 안 오고 있으면 **그것이 먼저다.** 마지막 결과가
 *      무엇이었든 지금은 아무도 안 보고 있다
 *   3. 그 뒤에 마지막 평가 결과를 말한다
 */
export function runtimeStateOf(i: {
  nowMs: number;
  enabled: any;
  lastRunAtMs?: any;
  lastOutcome?: any;
  lastReason?: any;
  intervalMin?: any;
  /** 실행기(cron)가 마지막으로 돈 시각. **못 읽었으면 undefined/null** */
  runnerLastSeenMs?: any;
  runnerIntervalMin?: any;
}): RuntimeStatus {
  const last = msOf(i.lastRunAtMs);
  const next = nextEvaluationAtMs({ lastRunAtMs: i.lastRunAtMs, intervalMin: i.intervalMin });
  const runnerSeen = msOf(i.runnerLastSeenMs);
  const runnerInterval = num(i.runnerIntervalMin) ?? RUNNER_INTERVAL_MIN;
  // **못 읽은 것을 '정상'으로 적지 않는다.** null이면 모르는 것이다.
  const runnerStale = runnerSeen == null
    ? null
    : i.nowMs - runnerSeen > runnerInterval * RUNNER_LATE_FACTOR * 60_000;

  const base = {
    lastEvaluationAtMs: last, nextEvaluationAtMs: next,
    runnerLastSeenMs: runnerSeen, runnerStale,
  };
  const done = (state: RuntimeState, reason: string): RuntimeStatus =>
    ({ state, tone: RUNTIME_TONE[state], reason, ...base });

  if (i.enabled !== true) return done('OFF', '꺼져 있습니다 — 평가하지 않습니다');

  const interval = intervalMinOf(i.intervalMin);

  // 켜져 있는데 한 번도 안 돌았다.
  if (last == null) {
    if (runnerStale === true) {
      return done('STALE',
        `켜져 있지만 실행기가 ${Math.round((i.nowMs - (runnerSeen as number)) / 60_000)}분째 오지 않았습니다 — `
        + '아직 한 번도 평가되지 않았습니다');
    }
    return done('NEVER_RAN',
      runnerStale == null
        ? '켜져 있지만 아직 평가 기록이 없습니다 — 실행기 상태를 확인하지 못했습니다'
        : `켜져 있고 아직 평가 전입니다 — 실행기가 ${runnerInterval}분 안에 확인합니다`);
  }

  // ── 실행기가 안 오고 있으면 그것이 먼저다 ──
  //
  // 마지막 결과가 '감시 중'이어도, 그 판단이 간격의 몇 배 전 것이라면
  // 지금 감시되고 있지 않다. 옛 결과를 현재 상태로 적으면 안 된다.
  const staleAfterMs = (interval + runnerInterval * RUNNER_LATE_FACTOR) * 60_000;
  if (i.nowMs - last > staleAfterMs) {
    const lateMin = Math.round((i.nowMs - last) / 60_000);
    return done('STALE',
      `마지막 평가가 ${lateMin}분 전입니다 (간격 ${interval}분) — 실행기가 오지 않고 있습니다`);
  }

  const reason = i.lastReason == null ? '' : String(i.lastReason);
  switch (String(i.lastOutcome || '')) {
    case 'ENTERED':
      return done('ENTERED', reason || '마지막 평가에서 진입했습니다');
    case 'NO_SIGNAL':
    case 'WATCHING':
      return done('WATCHING', reason || '정상 평가 중 · 진입 조건 대기');
    case 'BLOCKED':
      return done('BLOCKED', reason || '안전장치가 막고 있습니다');
    case 'FAILED':
    case 'ERROR':
      return done('FAILED', reason || '마지막 평가가 실패했습니다');
    default:
      // 기록은 있는데 결과값이 없다. **감시 중이라고 적지 않는다** —
      // 무엇을 했는지 모르는 것과 조건을 기다리는 것은 다르다.
      return done('UNKNOWN',
        reason || '평가 기록은 있지만 결과가 남아 있지 않습니다');
  }
}
