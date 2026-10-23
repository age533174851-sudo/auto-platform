// src/lib/supabase/jobClaimWindow.ts
//
// **지금 집어도 되는 잡인가** — 그 판단을 DB 조회 안으로 밀어 넣는다.
//
// 무엇이 있었나
// ─────────────
// 잡 조회는 이렇게 생겼다:
//
//   .eq('status', 'PENDING')
//   .order('priority').order('created_at')
//   .limit(10)
//
// 그리고 **가져온 뒤에** 건너뛸 잡을 걸렀다. 순서가 반대다.
//
//   우선순위 0짜리 오래된 잡 10개가 전부 backoff 중이면, 같은 우선순위의
//   새 `KILL_SWITCH_EXECUTE`가 **11번째**에 들어온다. DB는 매 틱 앞의
//   10개만 돌려주므로 그 킬스위치는 **조회조차 되지 않는다.**
//   `processPendingJobs`는 멀쩡히 도는데 보호 작업만 굶는다.
//
// 거르는 일을 `limit` **앞**으로 옮기면 사라지는 문제다.
//
// 왜 메모리가 아니라 `locked_until`인가
// ──────────────────────────────────────
// 처음에는 프로세스 안의 Map에 다음 시각을 적었다. 그건 **워커가
// 재시작하면 비고, 다른 인스턴스에는 아예 안 보인다.** 되돌린 잡은
// PENDING이므로 새 인스턴스가 즉시 다시 집는다 — 한도(402) 때문에 쉬게
// 하려던 것이 오히려 재시도를 늘린다.
//
// `locked_until`은 **이미 있는 칸**이고(076_jobs_queue.sql), 이미 같은
// 뜻으로 쓰이고 있었다 — `runAction` 실패 재시도가 `status: 'PENDING'`과
// 함께 `locked_until: now + 5초`를 적는다. 다만 **조회가 그 칸을 보지
// 않아서 그 5초도 여태 지켜지지 않았다.** 여기서 같이 고쳐진다.
//
// `PROCESSING`의 `locked_until`과 뜻이 겹치지 않는다: stale 회수는
// `status = 'PROCESSING'`인 줄만 본다. `PENDING`의 이 칸은 지금까지
// 아무도 읽지 않았다.
//
// 마이그레이션은 필요 없다.

/** PENDING 잡을 고를 때 `limit` **앞에** 거는 조건. */
export function claimableFilter(nowIso: string): string {
  return `locked_until.is.null,locked_until.lte.${nowIso}`;
}

/**
 * 이 잡을 지금 집어도 되는가.
 *
 * 시각을 **못 읽으면 집지 않는다.** 모르는 값을 "지났다"로 읽으면
 * 쉬게 하려던 잡이 매 틱 다시 돈다.
 */
export function isJobClaimable(job: any, nowMs: number): boolean {
  if (job == null || typeof job !== 'object') return false;
  const raw = (job as any).locked_until;
  if (raw == null || raw === '') return true;
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t)) return false;
  return t <= nowMs;
}

/**
 * DB가 하는 일의 모형 — **거르고 나서 자른다.**
 *
 * 워커는 이 함수를 부르지 않는다(조회가 직접 한다). 시험이 순서를
 * 고정하기 위해 쓴다. 순서가 뒤집히면 긴급 잡이 가려진다.
 */
export function selectClaimable(rows: any[], nowMs: number, limit: number): any[] {
  const ok = (Array.isArray(rows) ? rows : []).filter((r) => isJobClaimable(r, nowMs));
  ok.sort((a, b) => {
    const pa = Number(a?.priority ?? 0), pb = Number(b?.priority ?? 0);
    if (pa !== pb) return pa - pb;                      // priority ASC
    return String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? ''));  // FIFO
  });
  return ok.slice(0, Math.max(0, limit));
}
