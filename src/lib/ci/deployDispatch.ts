// src/lib/ci/deployDispatch.ts
//
// **합쳤다고 배포된 것이 아니다.**
//
// 오늘 확인된 것 (증거)
// ─────────────────────
// GitHub Actions의 fly-deploy 실행 목록:
//
//   2026-08-15T13:07Z  bbbfc3e  workflow_run  skipped
//   2026-08-15T12:51Z  bb63074  workflow_run  skipped
//   2026-08-15T12:16Z  63a8a9c  workflow_run  skipped   ← #129
//   2026-08-15T11:24Z  4ca49bf  workflow_run  skipped   ← #128
//   2026-08-15T10:23Z  470d8db  workflow_dispatch  success  ← 마지막 실제 배포
//
// 즉 **Fly Worker는 #127(470d8db)에서 멈춰 있다.** #128의 고아주문
// 수정도, #129의 반복 스모크도 워커에는 들어간 적이 없다.
//
// 왜 전부 skipped인가
// ───────────────────
// #124에서 이 문제를 한 번 고치려고 fly-deploy에 `workflow_run`을 달았다.
// 근거는 맞았다 — `secrets.GITHUB_TOKEN`으로 만든 push는 워크플로를
// 발동시키지 않으므로, 자동 머지가 합친 커밋으로는 `push: main`이 안 온다.
//
// 그런데 `workflow_run`도 오지 않는다. 이유가 하나 더 있었다:
//
//   `workflow_run`은 **ci가 끝났을 때** 온다. 그런데 자동 머지가 합친
//   뒤 main에서는 ci가 **아예 돌지 않는다**(같은 GITHUB_TOKEN 제약).
//   그래서 실제로 도착하는 `workflow_run`은 전부 **PR 브랜치의 ci**이고,
//   가드(`head_branch == 'main'`)가 그걸 정확히 걸러 낸다.
//
// 결과: 이벤트는 오는데 job은 항상 skipped. 로그에는 실행이 남아 있어서
// **배포가 도는 것처럼 보인다.** 조용히 틀리는 쪽이 언제나 더 나쁘다.
//
// 그래서 어떻게 고치나
// ────────────────────
// GITHUB_TOKEN 재귀 방지에는 **명시적 예외가 둘** 있다:
// `workflow_dispatch`와 `repository_dispatch`. 이 둘은 GITHUB_TOKEN으로
// 보내도 새 실행이 만들어진다.
//
// 그러니 **합친 쪽이 직접 배포를 부른다.** 머지에 성공한 그 순간,
// 그 스크립트가 fly-deploy를 `workflow_dispatch`로 깨운다. 이벤트가
// 오기를 기다리지 않으므로 경합도 없다 — 머지가 끝난 뒤에 부르니
// checkout이 잡는 main은 반드시 합쳐진 코드다.
//
// 판정을 왜 순수 함수로 빼나
// ──────────────────────────
// 이 저장소에서 배포 자동화가 **두 번** 조용히 죽었다(8/9, 8/13). 두 번
// 다 YAML 안의 조건이라 값으로 확인할 방법이 없었다. 조건을 여기로
// 옮기면 테스트가 지켜본다.

/** 깨울 워크플로 파일. fly-deploy.yml의 이름과 같아야 한다 */
export const DEPLOY_WORKFLOW = 'fly-deploy.yml';

/** 배포는 언제나 main을 올린다 — PR 브랜치를 프로덕션에 올리지 않는다 */
export const DEPLOY_REF = 'main';

export type DispatchCode =
  /** 부른다 */
  | 'DISPATCH'
  /** 합친 것이 없다. 부를 이유가 없다 */
  | 'NOTHING_MERGED'
  /** 토큰이 없어 부를 수 없다. **조용히 넘기지 않는다** */
  | 'NO_TOKEN';

export interface DispatchPlan {
  dispatch: boolean;
  code: DispatchCode;
  reason: string;
}

/**
 * 방금 머지한 뒤 배포를 불러야 하는가.
 *
 * **한 건이라도 합쳤으면 부른다.** "워커 파일이 바뀌었을 때만"으로
 * 좁히고 싶지만, 워커 이미지는 `worker/`뿐 아니라 `src/lib/exchanges/`와
 * `Dockerfile`·`fly.toml`에서도 만들어진다. 무엇이 이미지에 들어가는지를
 * 이 스크립트가 다시 판단하면 **한쪽만 고쳐진다** — 이 저장소에서 가장
 * 자주 난 고장이다. 같은 코드를 다시 올리는 것은 무해하다.
 */
export function deployDispatchPlan(i: {
  merged: number;
  hasToken?: boolean;
}): DispatchPlan {
  const merged = Math.max(0, Math.round(Number(i?.merged) || 0));
  if (merged === 0) {
    return { dispatch: false, code: 'NOTHING_MERGED',
      reason: '합친 PR이 없습니다 — 배포를 부르지 않습니다' };
  }
  if (i?.hasToken === false) {
    return { dispatch: false, code: 'NO_TOKEN',
      reason: `${merged}건을 합쳤지만 토큰이 없어 배포를 부르지 못했습니다 — `
        + 'Fly Worker는 옛 코드로 계속 돕니다. 손으로 fly-deploy를 실행하세요' };
  }
  return { dispatch: true, code: 'DISPATCH',
    reason: `${merged}건을 합쳤습니다 — main을 Fly에 배포합니다 `
      + '(자동 머지 push로는 workflow_run이 오지 않습니다)' };
}

export interface DispatchRequest {
  path: string;
  method: 'POST';
  body: string;
}

/**
 * `workflow_dispatch` 호출 한 건.
 *
 * **ref는 언제나 main이다.** 여기에 PR 브랜치가 들어가면 검사되지 않은
 * 코드가 24시간 도는 워커로 올라간다.
 */
export function deployDispatchRequest(repo: string, ref: string = DEPLOY_REF): DispatchRequest {
  const r = String(repo ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(r)) {
    throw new Error(`저장소 이름이 올바르지 않습니다 (${repo})`);
  }
  const branch = String(ref ?? '').trim() || DEPLOY_REF;
  return {
    path: `/repos/${r}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`,
    method: 'POST',
    body: JSON.stringify({ ref: branch }),
  };
}

/**
 * 배포 호출 결과를 사람이 읽는 한 줄로.
 *
 * **204를 받은 것은 "실행을 만들었다"이지 "배포됐다"가 아니다.** 그
 * 구분이 무너지면 이번과 똑같은 일이 다시 난다 — 로그에는 성공이
 * 남고 워커는 옛 코드로 돈다. 실제 확인은 `/api/system/deployment`가 한다.
 */
export function dispatchResultNote(i: { ok: boolean; status: number; message?: string | null }): string {
  if (i?.ok) {
    return 'fly-deploy 실행을 요청했습니다 — 배포 완료 여부는 '
      + '/api/system/deployment 의 Fly SHA로 확인하세요';
  }
  return `⚠ fly-deploy를 부르지 못했습니다 (HTTP ${i?.status}${i?.message ? `: ${i.message}` : ''}) — `
    + 'Fly Worker가 옛 코드로 계속 돕니다. Actions에서 fly-deploy를 손으로 실행하세요';
}
