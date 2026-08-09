// src/lib/ci/autoMergeGate.ts
//
// **이 PR을 자동으로 합쳐도 되는가.**
//
// 왜 순수 함수인가
// ────────────────
// 이 판정이 틀리면 **검사가 빨간 채로 실주문 코드가 main에 들어간다.**
// 그래서 GitHub API 응답 뒤에 숨겨 두지 않고, 값으로 확인할 수 있는
// 자리에 둔다. 워크플로 스크립트는 API에서 값을 모아 오기만 하고
// 판단은 전부 여기서 한다.
//
// 설계 원칙 하나
// ──────────────
// **모르면 안 합친다.** 검사 결과를 못 읽었으면 '통과'가 아니다.
// 이 저장소의 다른 모든 판정과 같은 규칙이다 —
// 확인하지 못한 것은 통과가 아니다.
//
// 강제 머지는 만들지 않는다
// ─────────────────────────
// 검사가 실패한 상태에서 합치는 경로는 **아예 없다.** 옵션으로도 두지
// 않는다. 옵션은 언젠가 켜지고, 그때 켜는 사람은 왜 그 옵션이 있는지
// 모른다. 이 저장소에는 실제 주문을 내는 코드가 있다.

/** 자동 머지 후보가 되려면 이 라벨이 있어야 한다 */
export const AUTO_MERGE_LABEL = 'auto-merge';

/** 자동으로 합칠 수 있는 유일한 대상 브랜치 */
export const INTENDED_BASE = 'main';

/**
 * **이 판정 자신의 검사 이름.**
 *
 * 라벨을 붙이면 `pull_request_target`으로 이 워크플로가 깨어나고, 그
 * 실행은 PR head 커밋에 자기 이름의 check run을 하나 만든다. 그러면
 * 판정기는 "아직 도는 검사가 있다"며 **자기 자신을 기다린다.** 자기가
 * 끝나야 통과인데 통과를 판단하는 게 자기라서, 그 실행에서는 절대
 * 합쳐지지 않는다.
 *
 * 그래서 검사 목록에서 자기 것만 빼고 센다. **다른 검사는 하나도 빼지
 * 않는다** — 이름이 정확히 일치하는 것만이다.
 */
export const SELF_CHECK_NAME = 'auto-merge-gate';

export type CheckConclusion =
  | 'success' | 'neutral' | 'skipped'
  | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'stale'
  | string | null;

export interface CheckLike {
  name: string;
  /** 'queued' | 'in_progress' | 'completed' */
  status: string;
  conclusion: CheckConclusion;
  /** 이 검사가 어느 커밋에서 돌았는가 */
  headSha?: string | null;
}

/** commit status API(Vercel 등이 쓴다) */
export interface StatusLike {
  context: string;
  /** 'success' | 'pending' | 'failure' | 'error' */
  state: string;
}

export interface PrFacts {
  number: number;
  draft: boolean;
  labels: string[];
  baseRef: string;
  headSha: string;
  /** base의 현재 tip. head가 이것을 포함해야 '최신 base 위에서 검사됐다'가 된다 */
  baseSha: string;
  /** head가 baseSha를 조상으로 갖는가. **모르면 null** */
  headContainsBase: boolean | null;
  /** GitHub이 계산한 병합 가능 여부. **모르면 null** (아직 계산 중) */
  mergeable: boolean | null;
  /** 'clean' | 'dirty' | 'blocked' | 'behind' | 'unstable' | 'unknown' … */
  mergeableState: string;
  checks: CheckLike[];
  statuses: StatusLike[];
  /** 해결되지 않은 리뷰 스레드 수. **못 읽었으면 null** */
  unresolvedThreads: number | null;
  /** 변경을 요청한 리뷰 수. **못 읽었으면 null** */
  changesRequested: number | null;
}

export type GateCode =
  | 'OK'
  | 'NO_LABEL'
  | 'DRAFT'
  | 'WRONG_BASE'
  | 'STACKED'
  | 'CONFLICT'
  | 'MERGEABILITY_UNKNOWN'
  | 'BEHIND_BASE'
  | 'CHECKS_FAILED'
  | 'CHECKS_PENDING'
  | 'CHECKS_MISSING'
  | 'CHECKS_STALE'
  | 'REVIEW_UNRESOLVED'
  | 'CHANGES_REQUESTED'
  | 'REVIEW_UNKNOWN';

export interface GateVerdict {
  /** 지금 합쳐도 되는가 */
  merge: boolean;
  code: GateCode;
  /** PR에 그대로 적을 한 줄 */
  reason: string;
  /** 사람이 볼 상세 — 무엇이 왜 막았는지 */
  details: string[];
}

/** 실패로 취급하는 결론. **성공이 아닌 것은 성공이 아니다** */
const BAD_CONCLUSIONS = new Set([
  'failure', 'cancelled', 'timed_out', 'action_required', 'stale',
]);
/** 통과로 볼 수 있는 결론. neutral·skipped는 '안 돌았지만 막지 않는다'는 뜻이다 */
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * 이 PR을 지금 합쳐도 되는가.
 *
 * 순서가 곧 의미다 — 라벨이 없으면 나머지는 볼 필요가 없고, 대상 브랜치가
 * 다르면 검사 결과가 무엇이든 합치면 안 된다.
 */
export function autoMergeGate(pr: PrFacts): GateVerdict {
  const d: string[] = [];

  // 1. 라벨. **이것이 유일한 스위치다.**
  //    라벨 없는 PR은 어떤 조건에서도 자동으로 안 합친다.
  if (!pr.labels.includes(AUTO_MERGE_LABEL)) {
    return { merge: false, code: 'NO_LABEL', details: d,
      reason: `'${AUTO_MERGE_LABEL}' 라벨이 없습니다 — 자동 머지 대상이 아닙니다` };
  }

  if (pr.draft) {
    return { merge: false, code: 'DRAFT', details: d,
      reason: '초안(draft) PR입니다' };
  }

  // 2. 대상 브랜치. main이 아니면 **stacked PR**이다.
  //    앞 PR이 먼저 들어가야 하고, 그 뒤에는 base가 바뀌므로 검사도 다시 돌아야 한다.
  if (pr.baseRef !== INTENDED_BASE) {
    return {
      merge: false, code: 'STACKED', details: d,
      reason: `base가 '${pr.baseRef}'입니다 — 앞 PR이 ${INTENDED_BASE}에 먼저 들어가야 합니다. `
            + '그때 base를 바꾸고 검사를 다시 돌린 뒤에 합칩니다',
    };
  }

  // 3. 충돌. **모르면 안 한다** — 계산 중일 수 있고, 그때 합치면 도박이다.
  if (pr.mergeable === false || pr.mergeableState === 'dirty') {
    return { merge: false, code: 'CONFLICT', details: d,
      reason: '병합 충돌이 있습니다 — 먼저 해결해야 합니다' };
  }
  if (pr.mergeable == null) {
    return { merge: false, code: 'MERGEABILITY_UNKNOWN', details: d,
      reason: 'GitHub이 아직 병합 가능 여부를 계산 중입니다 — 다음 신호에서 다시 봅니다' };
  }

  // 4. **검사가 최신 base 위에서 돌았는가.**
  //
  //    이게 이 파일에서 가장 중요한 규칙이다. stacked PR의 base가 바뀌면
  //    GitHub은 이전 검사 결과를 그대로 남겨 둔다. 그걸 재사용하면
  //    "합쳐진 적 없는 조합"을 검사 없이 main에 넣게 된다.
  //
  //    head가 base tip을 조상으로 갖고 있어야, 그 head에서 돈 검사가
  //    지금의 main과 합쳐진 상태를 실제로 본 것이다.
  if (pr.headContainsBase === false) {
    return {
      merge: false, code: 'BEHIND_BASE', details: d,
      reason: `${INTENDED_BASE}가 앞서 있습니다 — 브랜치를 최신 ${INTENDED_BASE} 위로 갱신하면 `
            + '검사가 다시 돌고, 그 결과로 판단합니다. 이전 base의 성공은 쓰지 않습니다',
    };
  }
  if (pr.headContainsBase == null) {
    return { merge: false, code: 'MERGEABILITY_UNKNOWN', details: d,
      reason: '브랜치가 최신 base를 포함하는지 확인하지 못했습니다' };
  }

  // 5. 검사. **최신 head SHA의 것만 본다.**
  //
  //    그리고 자기 자신은 세지 않는다. 자기가 도는 중에 자기를 기다리면
  //    끝나지 않는다 — 위 SELF_CHECK_NAME 설명 참고.
  const others = pr.checks.filter(c => c.name !== SELF_CHECK_NAME);
  const self = pr.checks.length - others.length;
  if (self > 0) d.push(`자동 머지 판정 자신의 검사 ${self}건은 세지 않았습니다`);

  const mine = others.filter(c => !c.headSha || c.headSha === pr.headSha);
  const stale = others.length - mine.length;
  if (mine.length === 0 && pr.statuses.length === 0) {
    return {
      merge: false, code: 'CHECKS_MISSING', details: d,
      reason: `이 커밋(${pr.headSha.slice(0, 7)})에서 돈 검사가 하나도 없습니다 — `
            + '검사 없이 합치지 않습니다',
    };
  }
  if (stale > 0) {
    d.push(`이전 커밋의 검사 ${stale}건은 세지 않았습니다`);
  }

  const bad = mine.filter(c =>
    c.status === 'completed' && BAD_CONCLUSIONS.has(String(c.conclusion)));
  const badStatuses = pr.statuses.filter(s =>
    s.state === 'failure' || s.state === 'error');
  if (bad.length > 0 || badStatuses.length > 0) {
    const names = [...bad.map(c => `${c.name}(${c.conclusion})`),
                   ...badStatuses.map(s => `${s.context}(${s.state})`)];
    return {
      merge: false, code: 'CHECKS_FAILED', details: d,
      reason: `실패한 검사가 있습니다: ${names.join(' · ')}`,
    };
  }

  const pending = mine.filter(c => c.status !== 'completed');
  const pendingStatuses = pr.statuses.filter(s => s.state === 'pending');
  if (pending.length > 0 || pendingStatuses.length > 0) {
    const names = [...pending.map(c => c.name), ...pendingStatuses.map(s => s.context)];
    return {
      merge: false, code: 'CHECKS_PENDING', details: d,
      reason: `아직 도는 검사가 있습니다: ${names.join(' · ')}`,
    };
  }

  // 끝났는데 결론이 성공 계열이 아닌 것 — 모르는 값도 여기서 걸린다.
  const unknown = mine.filter(c =>
    c.status === 'completed' && !OK_CONCLUSIONS.has(String(c.conclusion)));
  if (unknown.length > 0) {
    return {
      merge: false, code: 'CHECKS_FAILED', details: d,
      reason: `결론을 알 수 없는 검사가 있습니다: `
            + unknown.map(c => `${c.name}(${c.conclusion ?? 'null'})`).join(' · '),
    };
  }

  // 6. 리뷰. **못 읽었으면 안 합친다.**
  if (pr.changesRequested == null || pr.unresolvedThreads == null) {
    return { merge: false, code: 'REVIEW_UNKNOWN', details: d,
      reason: '리뷰 상태를 읽지 못했습니다 — 확인하지 못한 것은 통과가 아닙니다' };
  }
  if (pr.changesRequested > 0) {
    return { merge: false, code: 'CHANGES_REQUESTED', details: d,
      reason: `변경 요청 리뷰가 ${pr.changesRequested}건 있습니다` };
  }
  if (pr.unresolvedThreads > 0) {
    return { merge: false, code: 'REVIEW_UNRESOLVED', details: d,
      reason: `해결되지 않은 리뷰 스레드가 ${pr.unresolvedThreads}건 있습니다` };
  }

  d.push(`검사 ${mine.length}건 + 상태 ${pr.statuses.length}건 전부 통과`);
  return {
    merge: true, code: 'OK', details: d,
    reason: `모든 조건을 만족합니다 — squash로 합칩니다 (${pr.headSha.slice(0, 7)})`,
  };
}

/**
 * PR에 남길 한 덩어리.
 *
 * **왜 안 합쳤는지가 PR에 남아야 한다.** 워크플로 로그에만 있으면
 * 아무도 안 본다 — 그러면 "라벨을 붙였는데 왜 안 합쳐지지"가 된다.
 */
export function gateComment(pr: { number: number; headSha: string }, v: GateVerdict): string {
  const head = `<!-- traigo-auto-merge -->`;
  const icon = v.merge ? '✅' : '⏸';
  const lines = [
    head,
    `${icon} **자동 머지 판정** · \`${pr.headSha.slice(0, 7)}\``,
    '',
    v.reason,
  ];
  if (v.details.length > 0) {
    lines.push('', ...v.details.map(x => `- ${x}`));
  }
  if (!v.merge) {
    lines.push('',
      '조건이 갖춰지면 다음 검사 완료 신호에서 다시 판단합니다. '
      + '검사를 우회하거나 강제로 합치는 경로는 없습니다.');
  }
  return lines.join('\n');
}
