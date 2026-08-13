// src/lib/autotrade/schedulePoll.ts
//
// **24시간 도는 Worker가 예약을 직접 본다.**
//
// 왜 필요한가
// ───────────
// 지금 평가를 깨우는 것은 GitHub Actions(`autotrade-tick`, cron `*/15`)
// 하나뿐이다. 그런데 **실제 실행이 40~80분씩 밀린 기록이 있다.** 원본
// 전략의 판단 창은 09:10~09:30이고 유예를 더해도 10:00까지다 —
// 한 번 크게 밀리면 **그날이 통째로 사라진다.**
//
// 브라우저 타이머도 답이 아니다. 화면을 닫으면 멈춘다.
//
// Fly Worker는 이미 24시간 돌고 있다. 주문을 실행하려고 3초마다 깨어나는
// 그 루프가 예약도 같이 보면 된다. GitHub 쪽은 **없애지 않고 예비로**
// 남긴다 — 둘 중 하나가 죽어도 평가는 돈다.
//
// 두 개가 보면 두 번 들어가지 않나
// ────────────────────────────────
// 그래서 **선점(claim)**이 있다. 평가하기 전에 `last_run_at`을 지금으로
// 바꾸되, **읽었을 때와 값이 같을 때만** 바꾼다(compare-and-set).
// 바뀌었으면 다른 쪽이 이미 가져간 것이므로 건드리지 않는다.
//
// 이건 새 표도, 새 칸도 필요 없다. 이미 있는 `last_run_at`이 그대로
// 번호표 역할을 한다.
//
// 여기서 안 하는 것
// ─────────────────
// **실전(LIVE)은 건드리지 않는다.** 이 루프는 TESTNET 예약만 고른다.
// 실전 동작을 바꾸는 것은 이 변경의 범위가 아니고, 아무도 안 보는
// 시각에 도는 코드를 실계좌에 먼저 붙이지 않는다.

import { dueCheck, type DueVerdict } from './evaluationLoop';

/**
 * **누가 이 평가를 깨웠는가.**
 *
 * 2026-08-13에 판단 창을 133분 놓쳤다. 그때 "왜 아무도 안 왔나"의 답을
 * 찾으려면 로그를 뒤져야 했다 — 예약 줄에는 누가 깨웠는지가 없었다.
 * 이제 기록에 남는다.
 */
export type DispatchSource = 'FLY_WORKER' | 'GITHUB_FALLBACK' | 'MANUAL';

/**
 * Worker가 예약을 들여다보는 주기.
 *
 * 워커의 주 루프는 몇 초마다 깨어난다. 그때마다 DB를 두드릴 이유는
 * 없다 — 예약의 최소 간격은 분 단위다. 다만 **판단 창이 20분**이므로
 * 이보다 촘촘해야 한다. 1분이면 창 안에 최소 20번 본다.
 */
export const POLL_INTERVAL_MS = 60_000;

/**
 * 지금 예약을 볼 차례인가.
 *
 * **한 번도 안 봤으면 본다.** `lastPollMs`를 0으로 읽으면 1970년이 되어
 * 언제나 true가 되는데, 그건 우연히 맞는 것이고 다음 사람이 못 읽는다.
 */
export function shouldPollNow(lastPollMs: number | null, nowMs: number,
  intervalMs = POLL_INTERVAL_MS): boolean {
  if (lastPollMs == null || !Number.isFinite(lastPollMs)) return true;
  return nowMs - lastPollMs >= intervalMs;
}

export interface PollRow {
  id: string;
  user_id: string;
  symbol: string;
  connection_id: string | null;
  mode: string;
  enabled?: any;
  last_run_at?: any;
  interval_min?: any;
  strategy_id?: any;
  [k: string]: any;
}

export type PollSkipCode =
  /** 실전 예약 — 이 루프는 건드리지 않는다 */
  | 'NOT_TESTNET'
  /** 꺼져 있다 · 간격이 안 됐다 · 방금 돌았다 · 연결이 없다 */
  | 'OFF' | 'WAITING' | 'TOO_SOON' | 'NO_CONNECTION';

export interface PollSelection {
  /** 지금 평가해야 하는 줄 */
  due: Array<{ row: PollRow; verdict: DueVerdict }>;
  /** 건너뛴 줄과 그 이유. **조용히 버리지 않는다** */
  skipped: Array<{ id: string; symbol: string; code: PollSkipCode; reason: string }>;
}

/** `mode`가 실전 계열인가. 저장소 전체와 같은 판정이다 */
export function isLiveMode(mode: any): boolean {
  const m = String(mode || '').toUpperCase();
  return m.startsWith('LIVE') || m === 'SHADOW_LIVE';
}

/**
 * 지금 평가할 예약을 고른다.
 *
 * **순수 함수다.** Worker 루프가 무엇을 고르는지는 값으로 확인할 수 있어야
 * 한다 — 여기가 틀리면 안 돌거나(그날을 잃거나) 너무 자주 돈다(중복 주문).
 */
export function selectDueSchedules(rows: PollRow[], nowMs: number): PollSelection {
  const due: PollSelection['due'] = [];
  const skipped: PollSelection['skipped'] = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id ?? '');
    const symbol = String(row?.symbol ?? '');

    // **실전은 이 루프가 보지 않는다.** 먼저 거른다 — 뒤에서 걸러도
    // 되지만, 앞에 두면 "이 루프는 실전을 만지지 않는다"가 코드에서 바로 읽힌다.
    if (isLiveMode(row?.mode)) {
      skipped.push({ id, symbol, code: 'NOT_TESTNET',
        reason: `실전 예약(${row?.mode})은 이 루프가 평가하지 않습니다` });
      continue;
    }

    const v = dueCheck({
      nowMs, enabled: row?.enabled, connectionId: row?.connection_id ?? '',
      lastRunAtMs: row?.last_run_at, intervalMin: row?.interval_min,
    });
    if (v.due) { due.push({ row, verdict: v }); continue; }

    const code: PollSkipCode =
      v.code === 'OFF' ? 'OFF'
        : v.code === 'NO_CONNECTION' ? 'NO_CONNECTION'
          : v.code === 'TOO_SOON' ? 'TOO_SOON' : 'WAITING';
    skipped.push({ id, symbol, code, reason: v.reason });
  }
  return { due, skipped };
}

// ── 선점 ─────────────────────────────────────────────

export type ClaimCode =
  /** 내가 가져왔다 — 평가해도 된다 */
  | 'CLAIMED'
  /** 다른 쪽(GitHub 실행기·다른 워커)이 이미 가져갔다 */
  | 'LOST'
  /** 선점 자체가 실패했다. **가져온 것으로 치지 않는다** */
  | 'FAILED';

export interface ClaimVerdict {
  ok: boolean;
  code: ClaimCode;
  reason: string;
}

/**
 * compare-and-set 결과 → 선점 판정.
 *
 * `updated`는 조건부 UPDATE가 실제로 바꾼 줄 수다.
 *   1  내가 가져왔다
 *   0  그 사이에 다른 쪽이 `last_run_at`을 바꿨다 — 이미 가져갔다는 뜻
 *
 * **에러는 0과 다르다.** 조회가 실패한 것을 '남이 가져갔다'로 읽으면
 * 그 예약은 아무도 안 도는데 로그에는 정상으로 보인다.
 */
export function claimVerdict(updated: number | null, error?: any): ClaimVerdict {
  if (error) {
    return { ok: false, code: 'FAILED',
      reason: `선점에 실패했습니다: ${String((error as any)?.message ?? error)}` };
  }
  if (updated == null) {
    return { ok: false, code: 'FAILED',
      reason: '선점 결과를 읽지 못했습니다 — 가져온 것으로 치지 않습니다' };
  }
  if (updated <= 0) {
    return { ok: false, code: 'LOST',
      reason: '다른 실행기가 이미 이 예약을 가져갔습니다 — 두 번 평가하지 않습니다' };
  }
  return { ok: true, code: 'CLAIMED', reason: '이 예약을 선점했습니다' };
}
