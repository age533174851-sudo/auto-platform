// src/lib/ops/opsDispatch.test.ts
//
// **"말에서 dispatch까지 테스트했다"고 적었는데 실제로는 CLAIM까지였다.**
//
// 실행기가 어느 워크플로를 어떤 입력으로 깨우는지는 `ops-runner.mjs`
// 안에 문자열로 박혀 있었고, 아무것도 그걸 고정하지 않았다.
// `check-ops-commands`는 정규식으로 "분기가 있는가"만 본다 —
// **분기가 있는 것과 올바른 요청을 만드는 것은 다르다.**
//
// `apply: 'true'`가 빠지면 sync-secrets는 확인 모드로 돌고 아무것도
// 반영하지 않는다. 그런데 로그에는 "실행 요청됨"이 남고 화면에는 DONE이
// 뜬다. 여기서 그 값을 고정한다.
import { test, eq, assert } from '../../test/harness';
import { dispatchStepsFor, dispatchRequest, dispatchOutcome } from './opsDispatch';
import { OPS_COMMANDS } from './opsCommand';

export function runOpsDispatchTests() {
  console.log('[운영 dispatch — 무엇을 어떤 입력으로 깨우는가]');

  test('시크릿 동기화는 sync-secrets.yml을 apply:true로 깨운다', () => {
    // **apply가 빠지면 확인만 하고 아무것도 반영하지 않는다.**
    const steps = dispatchStepsFor('SYNC_SECRETS')!;
    eq(steps.length, 1);
    eq(steps[0].workflow, 'sync-secrets.yml');
    eq(steps[0].ref, 'main');
    eq(steps[0].inputs?.apply, 'true');
  });

  test('그 요청 본문이 실제로 ref=main · inputs.apply=true다', () => {
    const req = dispatchRequest('o/r', dispatchStepsFor('SYNC_SECRETS')![0]);
    eq(req.method, 'POST');
    eq(req.path, '/repos/o/r/actions/workflows/sync-secrets.yml/dispatches');
    const body = JSON.parse(req.body);
    eq(body.ref, 'main');
    eq(body.inputs.apply, 'true');
  });

  test('배포는 마이그레이션이 먼저다 — 순서가 뜻을 가진다', () => {
    // 코드만 앞서 나가면 새 코드가 없는 칸을 읽고 조용히 틀린다.
    const steps = dispatchStepsFor('DEPLOY')!;
    eq(steps.map(s => s.workflow).join(','), 'migrate.yml,fly-deploy.yml');
    eq(dispatchStepsFor('APPROVE_LIVE_SMALL')!.map(s => s.workflow).join(','),
      'migrate.yml,fly-deploy.yml');
  });

  test('입력이 없으면 inputs 칸을 아예 넣지 않는다', () => {
    // 빈 객체를 보내면 거부하는 워크플로가 있다.
    const req = dispatchRequest('o/r', dispatchStepsFor('DEPLOY')![0]);
    eq('inputs' in JSON.parse(req.body), false);
  });

  test('ref는 언제나 main이다 — PR 브랜치를 운영에 올리지 않는다', () => {
    for (const c of ['SYNC_SECRETS', 'DEPLOY', 'APPROVE_LIVE_SMALL']) {
      for (const s of dispatchStepsFor(c)!) eq(s.ref, 'main');
    }
  });

  test('표에 없는 명령은 null이다 — 빈 배열로 돌려주지 않는다', () => {
    // 빈 배열이면 "부를 것이 없다"와 "이 명령을 모른다"가 같아지고,
    // 오타 하나가 조용히 아무것도 안 하는 실행이 된다.
    eq(dispatchStepsFor('RECOVER'), null);   // selfHeal이 판단한다
    eq(dispatchStepsFor('STOP_NOW'), null);
    eq(dispatchStepsFor('NOPE'), null);
    eq(dispatchStepsFor(null), null);
  });

  console.log('[운영 dispatch — 204만 성공이다]');

  test('204는 성공', () => {
    const o = dispatchOutcome({ status: 204, workflow: 'sync-secrets.yml' });
    eq(o.ok, true);
    assert(o.reason.includes('실행을 요청했습니다'), o.reason);
  });

  test('204가 아니면 전부 실패 — 202·200도 성공으로 적지 않는다', () => {
    for (const st of [200, 201, 202, 400, 401, 403, 404, 500]) {
      eq(dispatchOutcome({ status: st, workflow: 'x.yml' }).ok, false, `HTTP ${st}`);
    }
  });

  test('422는 워크플로 파일이 유효하지 않을 수 있다고 적는다', () => {
    // 이 저장소에서 실제로 났다 — YAML이 깨져 GitHub이 파일을 거절했다.
    const o = dispatchOutcome({ status: 422, workflow: 'fly-deploy.yml' });
    eq(o.ok, false);
    assert(o.reason.includes('유효하지 않을 수 있습니다'), o.reason);
  });

  test('저장소나 워크플로 이름이 이상하면 요청을 만들지 않는다', () => {
    const step = dispatchStepsFor('SYNC_SECRETS')![0];
    let threw = false;
    try { dispatchRequest('nope', step); } catch { threw = true; }
    eq(threw, true, '저장소 이름');
    threw = false;
    try { dispatchRequest('o/r', { ...step, workflow: '../../etc/passwd' }); } catch { threw = true; }
    eq(threw, true, '워크플로 이름');
  });

  test('QUEUE 명령은 dispatch 표에 있거나 selfHeal이 맡는다', () => {
    // 둘 다 아니면 큐에는 들어가는데 아무도 실행하지 않는다.
    for (const c of OPS_COMMANDS.filter(x => x.runBy === 'QUEUE')) {
      const has = dispatchStepsFor(c.command) != null;
      assert(has || c.command === 'RECOVER',
        `${c.command}: dispatch 표에도 없고 RECOVER도 아닙니다`);
    }
  });
}
