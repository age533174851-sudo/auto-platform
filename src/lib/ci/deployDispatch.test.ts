// src/lib/ci/deployDispatch.test.ts
//
// **합쳤는데 배포가 안 되는 상태를 값으로 막는다.**
//
// 이 저장소에서 배포 자동화가 두 번 조용히 죽었다(8/9, 8/13). 두 번 다
// 조건이 YAML 안에 있어서 아무도 확인할 수 없었다.

import { test, eq, assert } from '../../test/harness';
import {
  deployDispatchPlan, deployDispatchRequest, dispatchResultNote,
  DEPLOY_WORKFLOW, DEPLOY_REF,
} from './deployDispatch';

export function runDeployDispatchTests() {
  console.log('[배포 호출 — 합쳤다고 배포된 것이 아니다]');

  test('한 건이라도 합쳤으면 배포를 부른다', () => {
    const p = deployDispatchPlan({ merged: 1, hasToken: true });
    eq(p.dispatch, true); eq(p.code, 'DISPATCH');
  });

  test('합친 것이 없으면 부르지 않는다', () => {
    eq(deployDispatchPlan({ merged: 0, hasToken: true }).dispatch, false);
    eq(deployDispatchPlan({ merged: 0, hasToken: true }).code, 'NOTHING_MERGED');
  });

  test('토큰이 없으면 조용히 넘기지 않는다 — 워커가 옛 코드로 돈다', () => {
    // 여기서 아무 말 없이 끝내면 이번 사고가 그대로 반복된다.
    const p = deployDispatchPlan({ merged: 2, hasToken: false });
    eq(p.dispatch, false); eq(p.code, 'NO_TOKEN');
    assert(p.reason.includes('옛 코드'), p.reason);
  });

  console.log('[배포 호출 — PR 브랜치를 프로덕션에 올리지 않는다]');

  test('기본 ref는 main이다', () => {
    const r = deployDispatchRequest('owner/repo');
    eq(r.method, 'POST');
    eq(r.path, `/repos/owner/repo/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`);
    eq(JSON.parse(r.body).ref, 'main');
    eq(DEPLOY_REF, 'main');
  });

  test('빈 ref가 와도 main으로 간다', () => {
    eq(JSON.parse(deployDispatchRequest('o/r', '').body).ref, 'main');
  });

  test('저장소 이름이 이상하면 만들지 않는다', () => {
    let threw = false;
    try { deployDispatchRequest('repo-only'); } catch { threw = true; }
    assert(threw, '이상한 저장소 이름으로 호출을 만들었다');
  });

  console.log('[배포 호출 — 204는 "배포됐다"가 아니다]');

  test('성공해도 "실행을 요청했다"까지만 적는다', () => {
    const s = dispatchResultNote({ ok: true, status: 204 });
    assert(s.includes('요청했습니다'), s);
    assert(!s.includes('배포 완료했습니다'), s);
  });

  test('실패는 무엇을 해야 하는지까지 적는다', () => {
    const s = dispatchResultNote({ ok: false, status: 403, message: 'Resource not accessible' });
    assert(s.includes('403'), s);
    assert(s.includes('손으로'), s);
  });
}
