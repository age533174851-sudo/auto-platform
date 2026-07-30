// src/lib/jobs/queueGuard.ts
//
// 큐에 넣기 전에 "실행할 사람이 있는가"를 확인한다.
//
// 판정은 executorHealth.ts(순수 함수)에 있고 여기서는 조회만 한다. 적재하는
// 곳이 셋이라(수동 선물 주문 · 웹훅 signal · 웹훅 tradingview) 조회 코드를
// 복사하면 한 곳만 고쳐졌을 때 그 경로만 조용히 다시 새게 된다.
import { judgeExecutor, orderExpiryIso, type ExecutorVerdict } from './executorHealth';

/**
 * 지금 주문을 적재해도 되는가.
 *
 * 실패해도 던지지 않는다 — 조회 실패는 `unknown`이 되고, `unknown`은
 * `canQueue: false`다. 즉 확인하지 못하면 넣지 않는다.
 */
export async function checkExecutorBeforeQueue(sb: any): Promise<ExecutorVerdict> {
  let row: any = null;
  let readFailed = false;
  try {
    const { data, error } = await (sb.from('worker_heartbeat') as any)
      .select('worker_id, last_seen, status, current_task, error_count')
      .order('last_seen', { ascending: false }).limit(1).maybeSingle();
    if (error) readFailed = true;
    else row = data ?? null;
  } catch {
    readFailed = true;
  }
  return judgeExecutor(row, Date.now(), readFailed);
}

/**
 * 실행자가 없을 때 돌려줄 응답 본문.
 *
 * 503을 쓴다 — 요청이 잘못된 것이 아니라(400) 지금 처리할 수 없는 것이다.
 * 그리고 **큐에 넣지 않았다는 사실을 명시한다.** 예전에는 넣고 `ok: true`를
 * 돌려줬고, 화면은 그것을 "주문됨"으로 그렸다. 사용자는 포지션이 열렸다고
 * 믿고 손을 뗐다.
 */
export function executorUnavailableBody(v: ExecutorVerdict) {
  return {
    ok: false,
    error: 'executor_unavailable',
    queued: false,
    executor: { status: v.status, label: v.label, ageSec: v.ageSec },
    message:
      `${v.reason} `
      + '주문을 큐에 넣지 않았습니다 — 넣어두면 나중에 실행기가 살아났을 때 '
      + '지금이 아닌 시세로 주문이 나갑니다.',
  };
}

/**
 * 적재할 payload에 만료 시각을 새긴다.
 *
 * jobs 테이블에 컬럼을 추가하지 않고 payload(JSON)에 담는 이유: 이 저장소에는
 * 아직 적용되지 않은 마이그레이션이 세 개(018·019·020) 있다. 네 번째를 더하면
 * 그것이 적용될 때까지 이 보호가 동작하지 않는다.
 */
export function withExpiry(
  payload: Record<string, any> | undefined,
  nowMs = Date.now(),
): Record<string, any> {
  return { ...(payload ?? {}), expiresAt: orderExpiryIso(nowMs) };
}
