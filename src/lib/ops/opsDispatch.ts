// src/lib/ops/opsDispatch.ts
//
// **"말에서 dispatch까지 테스트했다"고 적었는데 실제로는 아니었다.**
//
// 붙어 있던 회귀 테스트는 `"시크릿 동기화해" → SYNC_SECRETS → CLAIM`
// 까지였다. 그 뒤 — 실행기가 어느 워크플로를 어떤 입력으로 깨우는지 —
// 는 `ops-runner.mjs` 안에 문자열로 박혀 있었고, 아무것도 그걸 고정하지
// 않았다. `check-ops-commands`가 정규식으로 "분기가 있는가"만 봤을
// 뿐이다. **분기가 있는 것과 올바른 요청을 만드는 것은 다르다.**
//
// `apply: 'true'`가 빠지면 sync-secrets는 확인 모드로 돌고 아무것도
// 반영하지 않는다. 그런데 실행기 로그에는 "실행 요청됨"이 남고,
// 화면에는 DONE이 뜬다 — 이 저장소가 반복해서 잡아 온 모양이다.
//
// 그래서 어느 워크플로를 무엇으로 깨우는지를 값으로 만든다. 네트워크
// 없이 테스트할 수 있고, 실행기는 이 값을 그대로 쓴다.
//
// 여기 없는 것
// ────────────
// `RECOVER`는 없다. 그건 워크플로 하나를 부르는 일이 아니라 열린 주문
// 수·시도 횟수·마이그레이션 상태를 보고 행동을 고르는 일이고, 그 판정은
// 이미 `selfHeal.ts`에 있다. 억지로 표에 끼워 넣으면 판단이 두 곳으로
// 갈린다 — 이 파일이 막으려는 바로 그 고장이다.

import type { OpsCommand } from './opsCommand';

export interface DispatchStep {
  /** 사람이 읽을 단계 이름 */
  label: string;
  /** `.github/workflows/` 아래 파일 이름 */
  workflow: string;
  /** **언제나 main이다.** PR 브랜치를 운영에 올리지 않는다 */
  ref: 'main';
  /** `workflow_dispatch` 입력. 없으면 undefined */
  inputs?: Record<string, string>;
}

/**
 * 이 명령이 깨울 워크플로들. **순서가 뜻을 가진다.**
 *
 * `DEPLOY`는 마이그레이션이 먼저다 — 코드만 앞서 나가면 새 코드가
 * 없는 칸을 읽고 조용히 틀린다.
 *
 * **표에 없는 명령은 null이다.** 빈 배열로 돌려주면 "부를 것이 없다"와
 * "이 명령을 모른다"가 같아지고, 그러면 오타 하나가 조용히 아무것도
 * 안 하는 실행이 된다.
 */
export function dispatchStepsFor(command: OpsCommand | string | null | undefined): DispatchStep[] | null {
  switch (command) {
    case 'SYNC_SECRETS':
      return [{
        label: '시크릿 동기화',
        workflow: 'sync-secrets.yml',
        ref: 'main',
        // **`apply`가 빠지면 확인만 하고 아무것도 반영하지 않는다.**
        // 그런데 로그에는 "실행 요청됨"이 남는다.
        inputs: { apply: 'true' },
      }];
    case 'DEPLOY':
    case 'APPROVE_LIVE_SMALL':
      return [
        { label: '마이그레이션', workflow: 'migrate.yml', ref: 'main' },
        { label: '워커 배포', workflow: 'fly-deploy.yml', ref: 'main' },
      ];
    default:
      return null;
  }
}

/**
 * `workflow_dispatch` 호출 한 건을 만든다.
 *
 * **입력이 없으면 `inputs` 칸을 아예 넣지 않는다.** 빈 객체를 보내면
 * GitHub이 거부하는 워크플로가 있다.
 */
export function dispatchRequest(repo: string, step: DispatchStep): {
  path: string; method: 'POST'; body: string;
} {
  const r = String(repo ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(r)) {
    throw new Error(`저장소 이름이 올바르지 않습니다 (${repo})`);
  }
  const wf = String(step?.workflow ?? '').trim();
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(wf)) {
    throw new Error(`워크플로 파일 이름이 올바르지 않습니다 (${step?.workflow})`);
  }
  const hasInputs = step?.inputs && Object.keys(step.inputs).length > 0;
  return {
    path: `/repos/${r}/actions/workflows/${wf}/dispatches`,
    method: 'POST',
    body: JSON.stringify({ ref: step.ref, ...(hasInputs ? { inputs: step.inputs } : {}) }),
  };
}

/**
 * 호출 결과.
 *
 * **204만 성공이다.** GitHub의 `workflow_dispatch`는 성공하면 본문 없이
 * 204를 준다. 2xx를 다 성공으로 보면 202(수락했지만 아직)나 200(다른
 * 응답)을 성공으로 적게 되고, 그러면 "요청됨"이 거짓이 된다.
 *
 * 그리고 **204는 "실행을 만들었다"이지 "그 일이 됐다"가 아니다.**
 */
export function dispatchOutcome(i: { status: number; workflow: string }): {
  ok: boolean; reason: string;
} {
  if (Number(i?.status) === 204) {
    return { ok: true, reason: `${i.workflow} 실행을 요청했습니다 — 결과는 그 워크플로가 판정합니다` };
  }
  if (Number(i?.status) === 422) {
    // 이 저장소에서 실제로 났다: 워크플로 파일이 문법 오류라 GitHub이
    // 그 파일을 거절하고 있으면 422가 온다.
    return { ok: false, reason: `${i.workflow}를 부르지 못했습니다 (HTTP 422) — `
      + '워크플로 파일이 기본 브랜치에서 유효하지 않을 수 있습니다' };
  }
  return { ok: false, reason: `${i.workflow}를 부르지 못했습니다 (HTTP ${i?.status})` };
}
