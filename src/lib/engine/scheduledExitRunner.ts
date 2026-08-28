// src/lib/engine/scheduledExitRunner.ts
//
// **"이 시각에 팔겠다"를 지킬 실행기가 실제로 있는가.**
//
// 화면이 근거 없이 약속하고 있었다
// ────────────────────────────────
//   const acc = accuracyNote({ appOpen: true, repoCron: true, dailyCron: true });
//
// 세 인자가 전부 **하드코딩 true**다. 아무것도 확인하지 않고 "앱을 닫아도
// 제 시각에 나갑니다"를 적었다. 확인하지 못한 것을 통과로 적지 않는다는
// 규칙이 정확히 여기서 깨져 있었다.
//
// 그리고 그 약속은 사실이 아니었다
// ────────────────────────────────
// 브라우저 없이 도는 실행기는 `scheduled-exit.yml`(GitHub Actions) 하나뿐이고
// `cron: '*/5 * * * *'`로 적혀 있다. 실제 실행 간격을 재 봤다 (29개 구간, 53시간):
//
//   5분 이내 : 0건 / 29건
//   중앙값   : 50분
//   최대     : 600분 (10시간)
//   30분 초과: 25건 / 29건
//
// 그런데 라우트는 `DEFAULT_GRACE_MS = 30분`을 넘긴 예약을 **stale로 닫고
// 주문하지 않는다.** 즉 29개 구간 중 25개에서, 그 사이에 걸린 예약은
// 유예를 넘겨 도착해 **영원히 나가지 않는다.**
//
// 못 여는 것은 불편이고 못 닫는 것은 사고다.
//
// 무엇을 근거로 삼는가
// ────────────────────
// **결과를 먼저 본다.** 유예를 넘겨 놓친 예약이 실제로 있으면, 실행기가
// 무엇이든 그 사실이 반박한다. 그다음에 실행기가 살아 있는지를 본다.

/** 워커가 이 시간 안에 신호를 보냈으면 살아 있다고 본다 */
export const WORKER_FRESH_MS = 2 * 60_000;

export type ExitRunnerCode =
  /** 워커 상태를 못 읽었다. **없다는 뜻이 아니다** */
  | 'UNKNOWN'
  /** 워커가 깨우고 있다 — 앱을 닫아도 나간다 */
  | 'WORKER'
  /** 워커 신호가 끊겼다 */
  | 'WORKER_STALE'
  /** 브라우저 타이머 말고는 아무것도 없다 */
  | 'BROWSER_ONLY'
  /** 아무도 없다 */
  | 'NONE';

export interface ExitRunnerVerdict {
  code: ExitRunnerCode;
  /** 브라우저를 닫아도 도는 실행기가 있는가 */
  browserFree: boolean;
  /** 제 시각에 나간다고 말해도 되는가 */
  canBeOnTime: boolean;
  /** 유예를 넘겨 이미 놓친 예약 수. **null은 못 셌다는 뜻** */
  overdue: number | null;
  /** 사용자가 읽을 문장 */
  text: string;
  /** 진단용 한 줄 */
  detail: string;
}

const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/**
 * 예약청산이 제 시각에 나갈 수 있는가.
 *
 * **놓친 예약이 있으면 그것이 최종 답이다.** 실행기가 살아 있다고
 * 보고돼도, 실제로 놓친 것이 있으면 "제 시각에 나간다"고 말할 수 없다.
 */
export function scheduledExitRunnerOf(i: {
  /** `worker_heartbeat.last_seen`. **못 읽었으면 null** */
  workerLastSeenMs: number | null | undefined;
  nowMs: number;
  /** 이 화면이 열려 있는가 (30초 타이머) */
  appOpen?: boolean;
  /** 유예를 넘겨 아직 안 나간 예약 수. **못 셌으면 null** */
  overdue: number | null | undefined;
  freshMs?: number;
}): ExitRunnerVerdict {
  const appOpen = i?.appOpen === true;
  const overdue = i?.overdue == null ? null : Number(i.overdue);
  const fresh = i?.freshMs ?? WORKER_FRESH_MS;
  const seen = i?.workerLastSeenMs;

  const workerKnown = seen != null && Number.isFinite(seen);
  const lag = workerKnown ? Math.max(0, i.nowMs - (seen as number)) : null;
  const workerAlive = workerKnown && (lag as number) <= fresh;

  const code: ExitRunnerCode = !workerKnown ? 'UNKNOWN'
    : workerAlive ? 'WORKER'
      : (appOpen ? 'BROWSER_ONLY' : 'WORKER_STALE');

  const browserFree = code === 'WORKER';
  const detail = !workerKnown
    ? '워커 신호를 읽지 못했습니다'
    : `워커 신호 ${mins(lag as number)}분 전`;

  // ── 놓친 예약이 있으면 그게 답이다 ──
  //
  // 실행기가 살아 있다고 보고돼도, 유예를 넘긴 예약이 남아 있다는 것은
  // **그 시각에 아무 일도 안 일어났다는 증거**다. 증거가 보고를 이긴다.
  if (overdue != null && overdue > 0) {
    return {
      code, browserFree, canBeOnTime: false, overdue,
      text: `제 시각을 넘긴 예약이 ${overdue}건 있습니다 — 그 예약은 자동으로 나가지 않습니다. `
        + '직접 정리하거나 예약을 다시 잡아야 합니다.',
      detail,
    };
  }

  if (code === 'WORKER') {
    return {
      code, browserFree: true, canBeOnTime: true, overdue,
      text: '서버가 계속 지켜봅니다 — 앱을 닫아도 제 시각에 나갑니다.'
        + (appOpen ? ' 앱이 열려 있는 동안은 함께 확인합니다.' : ''),
      detail,
    };
  }
  if (code === 'UNKNOWN') {
    // **모르는 것을 "나간다"로도 "안 나간다"로도 적지 않는다.**
    return {
      code, browserFree: false, canBeOnTime: false, overdue,
      text: '서버 실행기 상태를 확인하지 못했습니다 — 제 시각에 나간다고 보장할 수 없습니다.',
      detail,
    };
  }
  if (code === 'BROWSER_ONLY') {
    return {
      code, browserFree: false, canBeOnTime: false, overdue,
      text: '서버 신호가 끊겼습니다. 지금은 이 화면이 열려 있는 동안에만 확인합니다 — '
        + '**앱을 닫거나 화면이 잠기면 그 시각에 안 나갑니다.**',
      detail,
    };
  }
  return {
    code: 'WORKER_STALE', browserFree: false, canBeOnTime: false, overdue,
    text: '서버 신호가 끊겼습니다 — 지금 걸린 예약은 제 시각에 나가지 않을 수 있습니다.',
    detail,
  };
}

/**
 * 유예를 넘겨 놓친 예약을 센다.
 *
 * **살아 있는 예약만 센다** — 이미 쐈거나(fired_at) 취소한(cancelled_at)
 * 줄은 놓친 것이 아니다. 그리고 목록을 못 읽었으면 `null`이다: 0으로
 * 세면 "놓친 것이 없다"가 되어, 실행기가 죽어 있어도 화면이 초록이 된다.
 */
export function overdueExitsOf(
  rows: Array<{ run_at?: any; fired_at?: any; cancelled_at?: any; enabled?: any }> | null | undefined,
  nowMs: number,
  graceMs: number,
): number | null {
  if (!Array.isArray(rows)) return null;
  let n = 0;
  for (const r of rows) {
    if (r?.fired_at != null) continue;
    if (r?.cancelled_at != null) continue;
    if (r?.enabled === false) continue;
    const at = Date.parse(String(r?.run_at ?? ''));
    if (!Number.isFinite(at)) continue;
    if (nowMs - at > graceMs) n += 1;
  }
  return n;
}
