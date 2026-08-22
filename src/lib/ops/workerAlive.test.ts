// src/lib/ops/workerAlive.test.ts
//
// **이 판정이 YAML 안에 있었기 때문에 배포가 통째로 멈췄다.**
//
// 워크플로의 `run: |` 안에 여러 줄짜리 `python3 -c`를 넣었더니 그
// 여러 줄이 블록 스칼라를 벗어나 `try:`·`except Exception:`이 워크플로의
// 최상위 키가 됐다. GitHub은 그 파일을 Startup failure로 거절했고,
// fly-deploy는 실행되지 않았으며 `workflow_dispatch`는 422를 돌려줬다.
//
// 판정이 여기 있으면 그 사고가 다시 날 수 없다.
import { test, eq, assert } from '../../test/harness';
import { workerAliveVerdict, ALIVE_BUDGET_MS } from './workerAlive';

const B = ALIVE_BUDGET_MS;

export function runWorkerAliveTests() {
  console.log('[워커 생존 — 떠 있는 것과 돌고 있는 것은 다르다]');

  test('워커가 한 줄 썼으면 성공이다', () => {
    const v = workerAliveVerdict({ body: { fly: { alive: true, ageSec: 4 } }, elapsedMs: 9_000, budgetMs: B });
    eq(v.code, 'ALIVE'); eq(v.ok, true); eq(v.done, true); eq(v.ageSec, 4);
  });

  test('아직 안 썼으면 더 기다린다 — 재배포 직후를 실패로 적지 않는다', () => {
    const v = workerAliveVerdict({ body: { fly: { alive: false, ageSec: 99412 } }, elapsedMs: 6_000, budgetMs: B });
    eq(v.code, 'WAITING'); eq(v.done, false);
  });

  test('끝내 안 썼으면 실패다 — 배포 로그만 초록인 상태를 잡는다', () => {
    // 2026-08-21에 실제로 이 상태였다: flyctl status는 started,
    // heartbeat는 27.6시간 전.
    const v = workerAliveVerdict({ body: { fly: { alive: false, ageSec: 99412 } }, elapsedMs: B, budgetMs: B });
    eq(v.code, 'TIMEOUT'); eq(v.ok, false); eq(v.done, true);
    assert(v.reason.includes('청산 감시'), v.reason);
  });

  test('못 읽은 것을 살아 있다고 하지 않는다', () => {
    const v = workerAliveVerdict({ body: null, elapsedMs: B, budgetMs: B });
    eq(v.code, 'UNREADABLE'); eq(v.ok, false);
    assert(v.reason.includes('살아 있다는 뜻이 아닙니다'), v.reason);
  });

  test('못 읽었어도 시간이 남았으면 아직 결론이 아니다', () => {
    const v = workerAliveVerdict({ body: null, elapsedMs: 3_000, budgetMs: B });
    eq(v.code, 'WAITING'); eq(v.done, false);
  });

  test('alive가 없거나 true가 아니면 살아 있다고 하지 않는다', () => {
    // 'true' 문자열이나 1을 참으로 읽으면 죽은 워커가 통과한다.
    eq(workerAliveVerdict({ body: { fly: { alive: 'true' } }, elapsedMs: B, budgetMs: B }).ok, false);
    eq(workerAliveVerdict({ body: { fly: { alive: 1 } }, elapsedMs: B, budgetMs: B }).ok, false);
    eq(workerAliveVerdict({ body: { fly: {} }, elapsedMs: B, budgetMs: B }).ok, false);
  });
}
