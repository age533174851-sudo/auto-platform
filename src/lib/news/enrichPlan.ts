// src/lib/news/enrichPlan.ts
//
// 이번 크론에서 무엇을 몇 개나 분석할지 정한다.
//
// 왜 규칙을 따로 빼는가
// ─────────────────────
// 여기서 틀리면 요금이 샌다. 실패한 기사를 계속 다시 부르거나, 한 번에
// 너무 많이 돌려 한도를 넘거나, 오래된 기사를 새 기사보다 먼저 분석한다.
// 셋 다 응답만 봐서는 정상으로 보인다 — 숫자가 나오긴 하니까.

export interface Candidate {
  hash: string;
  publishedAt: string;
  /** 지금까지 분석을 시도한 횟수 */
  attempts?: number;
}

/**
 * 몇 번 실패하면 포기하는가.
 *
 * 3으로 둔 이유: 일시적 오류(429·타임아웃)는 보통 한두 번이면 지나간다.
 * 세 번 연속 실패하면 기사 쪽 문제(본문이 깨졌거나 언어가 이상하거나)일
 * 가능성이 높고, 그런 건 몇 번을 더 불러도 같은 결과다.
 */
export const MAX_ATTEMPTS = 3;

/** 한 번에 처리할 최대 개수. 크론 실행 시간과 요금 둘 다의 상한이다 */
export const DEFAULT_BATCH = 5;

export interface PlanResult<T extends Candidate = Candidate> {
  /** 이번에 분석할 것 (최신순). 입력 타입을 그대로 들고 나간다 —
   *  hash만 남기면 호출부가 본문을 다시 찾아야 한다 */
  take: T[];
  /** 시도 한도를 넘겨 건너뛴 것 */
  givenUp: T[];
  /** 이번 배치에 안 들어간 나머지 */
  deferred: number;
}

/**
 * 분석 대상을 고른다.
 *
 * 최신순인 이유: 뉴스는 시간이 지나면 값이 급격히 떨어진다. 밀린 게
 * 많을 때 오래된 것부터 처리하면, 정작 지금 중요한 기사가 계속 뒤로
 * 밀린다.
 */
export function planEnrichment<T extends Candidate>(
  candidates: T[],
  batchSize: number = DEFAULT_BATCH,
): PlanResult<T> {
  const size = Math.max(1, Math.min(50, Math.floor(batchSize) || DEFAULT_BATCH));

  const givenUp: T[] = [];
  const eligible: T[] = [];
  for (const c of candidates) {
    if ((c.attempts ?? 0) >= MAX_ATTEMPTS) givenUp.push(c);
    else eligible.push(c);
  }

  // 최신순. 발행 시각을 못 읽으면 맨 뒤로 — 앞에 두면 정렬이 흔들려
  // 매번 다른 기사가 뽑히고, 어떤 기사는 영영 분석되지 않는다.
  eligible.sort((a, b) => {
    const ta = Date.parse(a.publishedAt), tb = Date.parse(b.publishedAt);
    const va = Number.isFinite(ta) ? ta : -Infinity;
    const vb = Number.isFinite(tb) ? tb : -Infinity;
    return vb - va;
  });

  return {
    take: eligible.slice(0, size),
    givenUp,
    deferred: Math.max(0, eligible.length - size),
  };
}

/**
 * 실패가 다시 시도할 만한 것인가.
 *
 * 형식 오류는 다시 불러도 같은 답이 올 가능성이 높지만, 한도 초과나
 * 타임아웃은 시간이 지나면 풀린다. 둘을 같이 세면 일시적 오류 때문에
 * 멀쩡한 기사를 영영 포기하게 된다.
 */
export function isTransient(reason: string): boolean {
  return /429|rate.?limit|timeout|타임아웃|ETIMEDOUT|ECONNRESET|503|502|과부하|overload/i.test(reason);
}

/** 다음 시도 횟수. 일시적 오류는 세지 않는다 */
export function nextAttempts(current: number, reason: string): number {
  const n = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
  return isTransient(reason) ? n : n + 1;
}

/**
 * 이 실패를 만나면 남은 배치를 멈춰야 하는가.
 *
 * 한도 초과는 계정 단위로 걸린다. 다음 기사도 같은 결과가 나올 텐데
 * 계속 던지면 요금만 나가고, 한도가 풀리는 시각만 더 밀린다.
 *
 * 타임아웃은 멈추지 않는다 — 그 기사 하나가 유난히 길었을 수 있고,
 * 한 건 때문에 배치 전체를 버리면 밀린 기사가 계속 쌓인다.
 */
export function shouldStopBatch(reason: string): boolean {
  return /429|rate.?limit|quota|insufficient_quota|한도/i.test(reason);
}
