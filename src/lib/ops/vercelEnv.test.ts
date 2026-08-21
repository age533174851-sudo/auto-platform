// src/lib/ops/vercelEnv.test.ts
//
// **`syncPlan`은 Vercel을 목적지로 적어 두고 실제로는 아무것도 안 했다.**
// "관리 토큰이 없습니다"만 적었다 — 만들어 놓고 배선을 안 한 것이다.
import { test, eq, assert } from '../../test/harness';
import {
  vercelEnvListRequest, vercelEnvCreateRequest, vercelEnvUpdateRequest,
  vercelUpsertPlan, vercelRedeployRequest,
} from './vercelEnv';

const T = { projectId: 'prj_abc123', teamId: 'team_xyz' };

export function runVercelEnvTests() {
  console.log('[Vercel 환경변수 — 만들어 놓고 배선을 안 한 자리]');

  test('production 항목만 고친다', () => {
    // 같은 이름을 환경별로 따로 둘 수 있다. preview용을 고치면
    // 실서비스는 옛 값으로 돌고 로그에는 성공이 남는다.
    const p = vercelUpsertPlan({
      name: 'ADMIN_SECRET',
      existing: [
        { id: 'e1', key: 'ADMIN_SECRET', target: ['preview'] },
        { id: 'e2', key: 'ADMIN_SECRET', target: ['production'] },
      ],
    });
    eq(p.action, 'UPDATE'); eq(p.envId, 'e2');
  });

  test('없으면 만든다', () => {
    const p = vercelUpsertPlan({ name: 'ADMIN_SECRET', existing: [] });
    eq(p.action, 'CREATE');
  });

  test('목록을 못 읽었으면 "없다"로 읽지 않는다', () => {
    // 없다고 보고 만들면 같은 이름이 둘이 되고, 어느 쪽이 쓰이는지
    // 아무도 모른다.
    const p = vercelUpsertPlan({ name: 'ADMIN_SECRET', existing: null });
    eq(p.action, 'SKIP');
    assert(p.reason.includes('없다는 뜻이 아니므로'), p.reason);
  });

  test('있는데 id를 못 읽었으면 아무것도 고치지 않는다', () => {
    const p = vercelUpsertPlan({
      name: 'ADMIN_SECRET', existing: [{ key: 'ADMIN_SECRET', target: ['production'] }],
    });
    eq(p.action, 'SKIP');
  });

  console.log('[Vercel 환경변수 — 빈 값을 넣지 않는다]');

  test('빈 값은 지우는 것과 같으므로 거절한다', () => {
    let threw = false;
    try { vercelEnvCreateRequest({ target: T, name: 'ADMIN_SECRET', value: '' }); } catch { threw = true; }
    eq(threw, true);
    threw = false;
    try { vercelEnvUpdateRequest({ target: T, envId: 'e1', value: '' }); } catch { threw = true; }
    eq(threw, true);
  });

  test('기본 대상은 production 하나다', () => {
    // preview에 실계좌 값이 들어가면 PR 프리뷰가 실계좌를 만진다.
    const r = vercelEnvCreateRequest({ target: T, name: 'ADMIN_SECRET', value: 'v' });
    eq(JSON.parse(r.body!).target.join(','), 'production');
    eq(JSON.parse(r.body!).type, 'encrypted');
  });

  test('이름이 이상하면 요청을 만들지 않는다', () => {
    let threw = false;
    try { vercelEnvCreateRequest({ target: T, name: 'admin secret', value: 'v' }); } catch { threw = true; }
    eq(threw, true);
  });

  test('프로젝트 id가 없으면 요청을 만들지 않는다', () => {
    let threw = false;
    try { vercelEnvListRequest({ projectId: '' } as any); } catch { threw = true; }
    eq(threw, true);
  });

  test('팀 id가 있으면 질의에 붙는다', () => {
    const r = vercelEnvListRequest(T);
    assert(r.path.includes('teamId=team_xyz'), r.path);
    assert(r.path.includes('decrypt=false'), r.path);
  });

  test('팀이 없으면 붙지 않는다', () => {
    const r = vercelEnvListRequest({ projectId: 'prj_abc123' });
    assert(!r.path.includes('teamId'), r.path);
  });

  console.log('[Vercel 환경변수 — 밀어 넣기만 하면 옛 값으로 돈다]');

  test('재배포 요청을 만든다', () => {
    // Vercel은 빌드 시점에 환경변수를 굽는다. 재배포를 안 하면 지문이
    // 옛 값으로 나오고, 사람은 "밀어 넣기가 실패했다"고 읽는다.
    const r = vercelRedeployRequest({ target: T, deploymentId: 'dpl_1' });
    eq(r.method, 'POST');
    eq(JSON.parse(r.body!).deploymentId, 'dpl_1');
  });

  test('어느 배포를 다시 구울지 모르면 만들지 않는다', () => {
    let threw = false;
    try { vercelRedeployRequest({ target: T, deploymentId: '' }); } catch { threw = true; }
    eq(threw, true);
  });
}
