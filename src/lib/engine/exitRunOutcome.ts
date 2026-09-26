// src/lib/engine/exitRunOutcome.ts
//
// **한 회차가 성공인가 — 그 판정을 한 곳에서만 한다.**
//
// 무엇이 어긋나 있었나
// ────────────────────
// 청산 감시 회차는 결과를 두 군데에 적는다:
//
//   exit_monitor_runs.status   운영 기록
//   HTTP 응답의 ok             부르는 쪽(워커·화면·사람)이 보는 값
//
// 이 둘이 **다른 식으로 계산되고 있었다.** 기록 쪽은
// `[...results 실패, ...lifecycleFailed]`를 합쳐 FAILED를 적는데,
// actionable이 1건 이상인 최종 응답은 `ok: true`가 박혀 있었다. 그래서
// 같은 실행에서:
//
//   exit_monitor_runs = FAILED
//   HTTP body         = ok: true
//
// 가 동시에 나올 수 있었다. 부르는 쪽은 초록을 보고 넘어가고, 실패는
// 표에만 남는다 — 아무도 안 보는 자리다.
//
// `strategy_id` projection 장애가 25일간 숨어 있던 것이 정확히 이 모양이다.
// 그래서 값을 **하나로** 만든다. 같은 판정이 두 곳에 있으면 언젠가 갈리고,
// 이번에는 이미 갈려 있었다.

export interface ExitRunFailure {
  symbol: string;
  error: string;
}

/**
 * generic lifecycle의 실패를 모은다.
 *
 * 두 가지를 다 본다:
 *   `lifecycle.error`   조회 자체가 실패했다 (projection 오류 등)
 *   `results[].ok:false` 개별 포지션 처리가 실패했다
 *
 * **`error`를 빼먹으면 조회가 통째로 죽은 회차가 "후보 0건"으로 읽힌다.**
 */
export function collectLifecycleFailures(lifecycle: any): ExitRunFailure[] {
  return [
    ...(lifecycle?.error
      ? [{ symbol: 'lifecycle', error: String(lifecycle.error) }]
      : []),
    ...(Array.isArray(lifecycle?.results)
      ? lifecycle.results
          .filter((r: any) => r && r.ok === false)
          .map((r: any) => ({
            symbol: String(r.symbol || 'lifecycle'),
            error: String(r.error || r.reason || r.code || 'lifecycle_failed'),
          }))
      : []),
  ];
}

export interface ExitRunOutcome {
  /** 기록과 응답이 함께 쓰는 실패 목록 */
  failed: ExitRunFailure[];
  /** 응답의 top-level ok. **`status`와 언제나 같은 진실이다** */
  ok: boolean;
  /** exit_monitor_runs.status */
  status: 'OK' | 'FAILED';
  /** exit_monitor_runs.errors. 실패가 없으면 null */
  errors: string | null;
}

/**
 * 회차 결과를 하나의 진실로 만든다.
 *
 * 계단식 처리 실패(`results`)와 전략 무관 생명주기 실패(`lifecycleFailed`)를
 * 합쳐서 본다. **둘 중 하나라도 실패면 회차는 실패다** — 한쪽만 보면 다른
 * 쪽 장애가 정상 회차로 지나간다.
 */
export function exitRunOutcome(i: {
  results?: any[] | null;
  lifecycleFailed?: ExitRunFailure[] | null;
}): ExitRunOutcome {
  const fromResults = (Array.isArray(i?.results) ? i.results : [])
    .filter((r: any) => r && r.ok === false)
    .map((r: any) => ({
      symbol: String(r.symbol || 'unknown'),
      error: String(r.error || r.reason || r.code || 'failed'),
    }));
  const failed = [...fromResults, ...(Array.isArray(i?.lifecycleFailed) ? i.lifecycleFailed : [])];
  const ok = failed.length === 0;
  return {
    failed,
    ok,
    status: ok ? 'OK' : 'FAILED',
    errors: ok
      ? null
      : failed.map(r => `${r.symbol}: ${String(r.error || '').slice(0, 120)}`)
          .join(' · ').slice(0, 1000),
  };
}
