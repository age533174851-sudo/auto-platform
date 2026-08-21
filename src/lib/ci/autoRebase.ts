// src/lib/ci/autoRebase.ts
//
// **main이 움직일 때마다 사람이 재배치를 눌러 주는 구조를 없앤다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// `auto-merge` 라벨이 붙은 PR이 여럿 열려 있으면, 하나가 합쳐질 때마다
// 나머지 전부가 옛 main 위에 남는다. 그중 파일이 겹치는 것은 곧바로
// 충돌 상태가 되고, 그때부터 **자동 머지 판정은 영원히 "병합 충돌이
// 있습니다"만 적는다.** 라벨은 붙어 있고, 검사도 초록이고, 아무 일도
// 일어나지 않는다.
//
// 그 상태를 푸는 유일한 방법이 사람이 로컬에서 재배치해 다시 올리는
// 것이었다. 한 번 합칠 때마다 남은 PR 수만큼 반복된다.
//
// **체크리스트를 자동으로 눌러 주는 것보다 체크리스트를 없애는 것이
// 낫다.** 그래서 재배치를 자동화하는 것이 아니라, "재배치가 필요한
// 상태로 남아 있는 것" 자체를 없앤다.
//
// 어디까지 자동으로 하는가
// ────────────────────────
// **깨끗하게 재배치되는 것만.** 충돌이 나면 손을 떼고 그 사실을 적는다.
//
// 충돌은 대개 두 변경이 같은 줄을 다르게 바꿨다는 뜻이고, 그건 기계가
// 고를 수 없는 판단이다. 실제로 이 저장소에서 한 번 났다 — 한쪽은
// 지갑의 오류 문자열을 판정 객체로 바꾸고, 다른 쪽은 같은 자리의 토큰
// 읽기를 바꿨다. 양쪽을 기계적으로 남기면 **타입은 통과하는데 지갑
// 판정만 죽는** 상태가 된다. 검사도 초록이다.
//
// 그래서 이 판정기의 답은 셋뿐이다: 재배치한다 / 이미 최신이다 /
// 사람이 봐야 한다.

export const AUTO_MERGE_LABEL = 'auto-merge';
/** 이 라벨이 붙으면 자동 재배치를 하지 않는다 — 손으로 쥐고 있는 PR */
export const OPT_OUT_LABEL = 'no-auto-rebase';

export type RebaseAction =
  /** 깨끗하게 재배치해서 올린다 */
  | 'REBASE'
  /** 이미 base 위에 있다 — 할 일 없음 */
  | 'UP_TO_DATE'
  /** 라벨이 없거나 초안이다 — 이 워크플로의 대상이 아니다 */
  | 'SKIP'
  /** 충돌이다. **기계가 고르지 않는다** */
  | 'NEEDS_HUMAN';

export interface RebaseVerdict {
  action: RebaseAction;
  reason: string;
}

export interface PrFacts {
  number: number;
  draft: boolean;
  labels: string[];
  /** PR이 다른 저장소(fork)에서 왔는가 */
  fromFork: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** base(main) 기준으로 이 PR이 몇 커밋 뒤처져 있는가. **모르면 null** */
  behindBy: number | null;
  /** 깨끗하게 재배치되는가. **아직 안 해 봤으면 null** */
  cleanRebase?: boolean | null;
}

/**
 * 이 PR을 자동으로 재배치할 것인가.
 *
 * **모르는 것을 진행으로 읽지 않는다.** `behindBy`가 null이면 얼마나
 * 뒤처졌는지 모른다는 뜻이고, 그때 재배치를 강행하면 이미 최신인 PR을
 * 이유 없이 force-push하게 된다.
 */
export function rebaseVerdict(pr: PrFacts, defaultBranch: string): RebaseVerdict {
  if (!pr || typeof pr.number !== 'number') {
    return { action: 'SKIP', reason: 'PR 정보를 읽지 못했습니다' };
  }
  if (pr.draft) {
    return { action: 'SKIP', reason: '초안입니다 — 아직 합칠 대상이 아닙니다' };
  }
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  if (!labels.includes(AUTO_MERGE_LABEL)) {
    // 자동 머지 스위치와 **같은 스위치**를 쓴다. 재배치만 따로 켜지는
    // 경로를 만들면, 합칠 생각이 없는 PR의 커밋이 조용히 바뀐다.
    return { action: 'SKIP', reason: `${AUTO_MERGE_LABEL} 라벨이 없습니다` };
  }
  if (labels.includes(OPT_OUT_LABEL)) {
    return { action: 'SKIP', reason: `${OPT_OUT_LABEL} 라벨이 붙어 있습니다 — 손대지 않습니다` };
  }
  if (pr.fromFork) {
    // fork 브랜치에 force-push하려면 더 넓은 권한이 필요하고, 남의
    // 브랜치 이력을 고쳐 쓰는 일이다. **하지 않는다.**
    return { action: 'SKIP', reason: '다른 저장소에서 온 PR입니다 — 남의 브랜치 이력을 고쳐 쓰지 않습니다' };
  }
  if (pr.baseRef !== defaultBranch) {
    // 다른 PR 위에 쌓인 PR이다. main으로 끌어오면 아래 PR의 커밋이
    // 통째로 딸려 들어간다.
    return { action: 'SKIP', reason: `base가 ${pr.baseRef}입니다 — ${defaultBranch} 위의 PR만 재배치합니다` };
  }
  if (pr.behindBy == null) {
    return { action: 'SKIP', reason: '얼마나 뒤처졌는지 읽지 못했습니다 — 모르는 채로 이력을 고치지 않습니다' };
  }
  if (pr.behindBy === 0) {
    return { action: 'UP_TO_DATE', reason: `이미 ${defaultBranch} 위에 있습니다` };
  }
  if (pr.cleanRebase === false) {
    return {
      action: 'NEEDS_HUMAN',
      reason: `${defaultBranch}가 ${pr.behindBy}커밋 앞서 있고 재배치에 충돌이 납니다 — `
        + '충돌은 두 변경이 같은 자리를 다르게 바꿨다는 뜻이라 기계가 고르지 않습니다',
    };
  }
  if (pr.cleanRebase == null) {
    return { action: 'SKIP', reason: '재배치를 시도해 보지 않았습니다' };
  }
  return {
    action: 'REBASE',
    reason: `${defaultBranch}가 ${pr.behindBy}커밋 앞서 있고 깨끗하게 재배치됩니다`,
  };
}

/**
 * 재배치 결과를 PR에 적을 한 줄.
 *
 * **검사를 건너뛴다는 말은 어디에도 없다.** 재배치는 새 커밋을 만들고,
 * 그 커밋에서 CI가 처음부터 다시 돈다. 자동 머지는 그 뒤의 이야기다.
 */
export function rebaseComment(i: {
  action: RebaseAction; reason: string; defaultBranch: string; newSha?: string;
}): string | null {
  // 아무 일도 안 한 것을 PR에 적지 않는다 — 댓글이 쌓이면 진짜 신호가 묻힌다.
  if (i.action === 'SKIP' || i.action === 'UP_TO_DATE') return null;
  if (i.action === 'NEEDS_HUMAN') {
    return '<!-- traigo-auto-rebase -->\n'
      + `⚠ **자동 재배치 실패** · \`${i.defaultBranch}\`\n\n${i.reason}\n\n`
      + '충돌을 손으로 해소한 뒤 다시 올려야 합니다. '
      + '검사를 우회하거나 강제로 합치는 경로는 없습니다.';
  }
  return '<!-- traigo-auto-rebase -->\n'
    + `🔄 **자동 재배치** · \`${i.defaultBranch}\`${i.newSha ? ` → \`${i.newSha.slice(0, 7)}\`` : ''}\n\n`
    + `${i.reason}\n\n`
    + '새 커밋이므로 모든 검사가 처음부터 다시 돕니다.';
}

// ── 머지 직후에 곧바로 부른다 ──
//
// **`secrets.GITHUB_TOKEN`으로 만든 push는 워크플로를 발동시키지 않는다**
// (재귀 방지). 그래서 자동 머지가 main을 움직여도 `auto-rebase`의
// `push: branches: [main]` 신호는 **오지 않는다.** 남는 것은 30분마다
// 도는 안전망뿐이고, 그 사이 남은 PR들은 충돌 상태로 앉아 있다.
//
// `workflow_dispatch`는 그 재귀 방지의 명시적 예외다. 그래서 머지가
// 끝난 뒤 auto-merge가 직접 부른다 — fly-deploy를 부르는 것과 같은 구조다.
//
// 이 저장소가 겪은 고장이 정확히 그 모양이었다(#128·#129가 main에만
// 있고 Fly에는 없었다) — **만들어 놓고 배선을 안 함.**

export const REBASE_WORKFLOW = 'auto-rebase.yml';
export const REBASE_REF = 'main';

export interface RebaseDispatchPlan {
  dispatch: boolean;
  code: 'DISPATCH' | 'NOTHING_MERGED' | 'NO_TOKEN';
  reason: string;
}

/**
 * 머지 뒤에 재배치를 부를 것인가.
 *
 * **아무것도 안 합쳤으면 부르지 않는다.** main이 안 움직였으면 뒤처진
 * PR도 그대로다 — 헛돌면 force-push 경쟁만 늘어난다.
 */
export function rebaseDispatchPlan(i: { merged: number; hasToken: boolean }): RebaseDispatchPlan {
  if (!i?.hasToken) {
    return { dispatch: false, code: 'NO_TOKEN', reason: '토큰이 없어 재배치를 부를 수 없습니다' };
  }
  if (!(Number(i?.merged) > 0)) {
    return { dispatch: false, code: 'NOTHING_MERGED',
      reason: '합친 것이 없습니다 — main이 안 움직였으므로 뒤처진 PR도 그대로입니다' };
  }
  return { dispatch: true, code: 'DISPATCH',
    reason: `${i.merged}건 합쳤습니다 — 남은 PR을 곧바로 끌어올립니다` };
}

export function rebaseDispatchRequest(repo: string, ref: string = REBASE_REF): {
  path: string; method: 'POST'; body: string;
} {
  const r = String(repo ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(r)) {
    throw new Error(`저장소 이름이 올바르지 않습니다 (${repo})`);
  }
  return {
    path: `/repos/${r}/actions/workflows/${REBASE_WORKFLOW}/dispatches`,
    method: 'POST',
    // **ref는 언제나 main이다.** 판정기는 base 브랜치 코드로 돌아야 한다.
    body: JSON.stringify({ ref: String(ref ?? '').trim() || REBASE_REF }),
  };
}
