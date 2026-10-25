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

// ─────────────────────────────────────────────────────────────────────
// 조회에서 본 것이 **집는 순간에도 그대로인가**
// ─────────────────────────────────────────────────────────────────────
//
// 조회에 `claimableFilter`를 걸어도 그것만으로는 원자적이지 않다.
// claim UPDATE가 `status = 'PENDING'`만 보면 이런 일이 생긴다:
//
//   ① A가 due한 잡을 읽는다 (attempts=0, locked_until=NULL)
//   ② A가 락 대기 등으로 지연된다
//   ③ B가 그 잡을 집어 실행하고 실패 → status=PENDING, attempts=1,
//      locked_until=now+60초로 **재시도 대기**를 적고 락을 놓는다
//   ④ A가 ①의 스냅샷으로 UPDATE한다. status가 다시 PENDING이라 **통과**
//
// 결과: backoff가 끝나기 전에 집히고, `attempts`가 0+1=1로 덮여 B의
// 증가가 사라진다. 상태만 보는 조건은 PENDING→PROCESSING→PENDING을
// 구분하지 못한다(ABA).
//
// 그래서 **조회에서 본 값을 UPDATE 조건에 같이 건다**(CAS). 그 사이
// 무엇이든 바뀌었으면 0행이 갱신되고, 그게 맞다.
//
// `attempts`를 쓰는 이유: 이 값은 claim할 때마다 **오르기만 한다.**
// 되돌아가지 않으므로 ABA를 구분하는 표식이 된다.

export type ClaimOutcomeCode =
  /** 내가 집었다 */
  | 'CLAIMED'
  /** 0행 — 그 사이 누가 집었거나 다시 쉬게 됐다. 정상이다 */
  | 'LOST'
  /** **갱신 자체가 실패했다.** 집었는지 못 집었는지 모른다 */
  | 'CLAIM_FAILED';

/**
 * claim UPDATE의 결과를 판정한다.
 *
 * **0행과 오류는 다르다.** 예전에는 `const { data: claimed } = …` 뒤에
 * `if (!claimed || claimed.length === 0) continue;`라, DB 오류가 "다른
 * 워커가 가져감"으로 조용히 넘어갔다. 경쟁에서 진 것과 DB가 흔들린 것은
 * 사람이 봐야 하는 정도가 다르다.
 */
export function claimOutcome(res: { data?: any; error?: any } | null | undefined): {
  code: ClaimOutcomeCode; reason: string;
} {
  if (!res) return { code: 'CLAIM_FAILED', reason: 'claim 갱신이 아무 응답도 돌려주지 않았습니다' };
  if (res.error) {
    return { code: 'CLAIM_FAILED', reason: `claim 갱신 실패 — ${String(res.error?.message ?? res.error)}` };
  }
  if (!Array.isArray(res.data)) {
    // 비배열은 "0행"이 아니라 모르는 것이다.
    return { code: 'CLAIM_FAILED', reason: 'claim 응답이 배열이 아닙니다 — 0행으로 읽지 않습니다' };
  }
  return res.data.length > 0
    ? { code: 'CLAIMED', reason: '이 워커가 집었습니다' }
    : { code: 'LOST', reason: '그 사이 다른 워커가 집었거나 다시 대기로 바뀌었습니다' };
}

/**
 * claim UPDATE가 걸어야 하는 조건이 **지금의 행에 대해** 맞는가.
 *
 * 워커는 이 함수를 부르지 않는다 — PostgREST가 같은 조건을 DB에서 건다.
 * 시험이 그 조건의 뜻을 고정하기 위해 쓴다. 조건이 하나라도 빠지면
 * 위 ①~④가 다시 열린다.
 */
export function claimMatches(rowNow: any, snapshot: any, nowMs: number): boolean {
  if (rowNow == null || snapshot == null) return false;
  if (String(rowNow.id) !== String(snapshot.id)) return false;
  if (rowNow.status !== 'PENDING') return false;
  // 조회 당시 본 attempts와 같아야 한다 (ABA 차단)
  const a = rowNow.attempts ?? null, b = snapshot.attempts ?? null;
  if (a !== b) return false;
  // 그리고 **지금도** 집을 수 있는 시각이어야 한다
  return isJobClaimable(rowNow, nowMs);
}
