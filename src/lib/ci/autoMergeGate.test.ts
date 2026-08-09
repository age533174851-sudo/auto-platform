// src/lib/ci/autoMergeGate.test.ts
//
// **이 판정이 틀리면 빨간 검사 위로 실주문 코드가 main에 들어간다.**
//
// 자동 머지는 편해지자고 만드는 것인데, 편해지는 대가로 "검사가 실제로
// 통과했는가"를 아무도 안 보게 되면 안 만든 것만 못하다. 그래서 이
// 파일은 **통과하는 경로가 하나뿐**이라는 것을 값으로 못 박는다.

import { test, eq, assert } from '../../test/harness';
import { autoMergeGate, gateComment, AUTO_MERGE_LABEL, type PrFacts } from './autoMergeGate';

/** 모든 조건을 만족하는 상태. 각 테스트는 여기서 하나씩만 망가뜨린다 */
const good = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1,
  draft: false,
  labels: [AUTO_MERGE_LABEL],
  baseRef: 'main',
  headSha: 'abc1234def5678',
  baseSha: 'base999',
  headContainsBase: true,
  mergeable: true,
  mergeableState: 'clean',
  checks: [
    { name: 'verify', status: 'completed', conclusion: 'success', headSha: 'abc1234def5678' },
  ],
  statuses: [{ context: 'Vercel', state: 'success' }],
  unresolvedThreads: 0,
  changesRequested: 0,
  ...over,
});

export function runAutoMergeGateTests() {
  console.log('[자동 머지 — 통과하는 길은 하나뿐이다]');

  test('모든 조건을 만족하면 합친다', () => {
    const v = autoMergeGate(good());
    eq(v.merge, true, v.reason);
    eq(v.code, 'OK');
  });

  console.log('[자동 머지 — 라벨이 유일한 스위치다]');

  test('라벨이 없으면 다른 조건이 아무리 좋아도 안 합친다', () => {
    const v = autoMergeGate(good({ labels: [] }));
    eq(v.merge, false); eq(v.code, 'NO_LABEL');
  });

  test('비슷한 라벨로는 안 된다', () => {
    for (const l of ['automerge', 'auto merge', 'Auto-Merge', 'auto-merge-please']) {
      eq(autoMergeGate(good({ labels: [l] })).merge, false, `${l}가 통과했다`);
    }
  });

  test('초안은 안 합친다', () => {
    eq(autoMergeGate(good({ draft: true })).code, 'DRAFT');
  });

  console.log('[자동 머지 — stacked PR은 순서를 지킨다]');

  test('base가 main이 아니면 안 합친다', () => {
    const v = autoMergeGate(good({ baseRef: 'claude/other-branch' }));
    eq(v.merge, false); eq(v.code, 'STACKED');
    assert(v.reason.includes('먼저'), v.reason);
  });

  test('base가 main이어도 브랜치가 뒤처져 있으면 안 합친다 — 이전 base의 성공을 재사용하지 않는다', () => {
    // stacked PR의 base가 바뀌면 GitHub은 이전 검사 결과를 그대로 남긴다.
    // 그걸 쓰면 "합쳐진 적 없는 조합"을 검사 없이 main에 넣게 된다.
    const v = autoMergeGate(good({ headContainsBase: false }));
    eq(v.merge, false); eq(v.code, 'BEHIND_BASE');
    assert(v.reason.includes('이전 base의 성공은 쓰지 않습니다'), v.reason);
  });

  test('포함 여부를 못 읽었으면 안 합친다', () => {
    eq(autoMergeGate(good({ headContainsBase: null })).merge, false);
  });

  console.log('[자동 머지 — 충돌과 모름]');

  test('충돌이 있으면 안 합친다', () => {
    eq(autoMergeGate(good({ mergeable: false })).code, 'CONFLICT');
    eq(autoMergeGate(good({ mergeableState: 'dirty' })).code, 'CONFLICT');
  });

  test('병합 가능 여부를 계산 중이면 안 합친다 — 모르면 안 한다', () => {
    const v = autoMergeGate(good({ mergeable: null }));
    eq(v.merge, false); eq(v.code, 'MERGEABILITY_UNKNOWN');
  });

  console.log('[자동 머지 — 검사]');

  test('실패·취소·타임아웃·조치필요는 전부 막는다', () => {
    for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale']) {
      const v = autoMergeGate(good({
        checks: [{ name: 'verify', status: 'completed', conclusion: c, headSha: 'abc1234def5678' }],
      }));
      eq(v.merge, false, `${c}가 통과했다`);
      eq(v.code, 'CHECKS_FAILED');
      assert(v.reason.includes(c), v.reason);
    }
  });

  test('성공 하나 + 실패 하나면 막는다 — 하나라도 빨가면 끝이다', () => {
    const v = autoMergeGate(good({
      checks: [
        { name: 'verify', status: 'completed', conclusion: 'success', headSha: 'abc1234def5678' },
        { name: 'fly-deploy', status: 'completed', conclusion: 'failure', headSha: 'abc1234def5678' },
      ],
    }));
    eq(v.code, 'CHECKS_FAILED');
    assert(v.reason.includes('fly-deploy'), v.reason);
  });

  test('아직 도는 검사가 있으면 기다린다', () => {
    const v = autoMergeGate(good({
      checks: [{ name: 'verify', status: 'in_progress', conclusion: null, headSha: 'abc1234def5678' }],
    }));
    eq(v.merge, false); eq(v.code, 'CHECKS_PENDING');
  });

  test('Vercel 상태가 실패면 막는다', () => {
    eq(autoMergeGate(good({ statuses: [{ context: 'Vercel', state: 'failure' }] })).code, 'CHECKS_FAILED');
    eq(autoMergeGate(good({ statuses: [{ context: 'Vercel', state: 'error' }] })).code, 'CHECKS_FAILED');
  });

  test('Vercel이 배포 중이면 기다린다', () => {
    eq(autoMergeGate(good({ statuses: [{ context: 'Vercel', state: 'pending' }] })).code, 'CHECKS_PENDING');
  });

  test('이 커밋에서 돈 검사가 하나도 없으면 안 합친다', () => {
    const v = autoMergeGate(good({ checks: [], statuses: [] }));
    eq(v.merge, false); eq(v.code, 'CHECKS_MISSING');
  });

  test('다른 커밋의 성공은 세지 않는다', () => {
    // 이전 커밋에서 초록이었다고 지금 커밋이 안전한 것이 아니다.
    const v = autoMergeGate(good({
      checks: [{ name: 'verify', status: 'completed', conclusion: 'success', headSha: '옛커밋' }],
      statuses: [],
    }));
    eq(v.merge, false); eq(v.code, 'CHECKS_MISSING');
  });

  test('이전 커밋 검사가 섞여 있으면 세지 않고 그 사실을 적는다', () => {
    const v = autoMergeGate(good({
      checks: [
        { name: 'verify', status: 'completed', conclusion: 'success', headSha: 'abc1234def5678' },
        { name: 'verify', status: 'completed', conclusion: 'failure', headSha: '옛커밋' },
      ],
    }));
    eq(v.merge, true, `이전 커밋의 실패가 지금을 막았다: ${v.reason}`);
    assert(v.details.some(d => d.includes('이전 커밋')), v.details.join(' / '));
  });

  test('결론이 null인데 완료로 표시된 검사는 막는다 — 모르는 값을 통과로 세지 않는다', () => {
    const v = autoMergeGate(good({
      checks: [{ name: 'weird', status: 'completed', conclusion: null, headSha: 'abc1234def5678' }],
    }));
    eq(v.merge, false); eq(v.code, 'CHECKS_FAILED');
  });

  test('skipped·neutral은 막지 않는다 — 안 돌았지만 실패도 아니다', () => {
    for (const c of ['skipped', 'neutral']) {
      eq(autoMergeGate(good({
        checks: [{ name: 'x', status: 'completed', conclusion: c, headSha: 'abc1234def5678' }],
      })).merge, true, `${c}가 막았다`);
    }
  });

  console.log('[자동 머지 — 리뷰]');

  test('변경 요청이 있으면 안 합친다', () => {
    eq(autoMergeGate(good({ changesRequested: 1 })).code, 'CHANGES_REQUESTED');
  });

  test('해결 안 된 리뷰 스레드가 있으면 안 합친다', () => {
    eq(autoMergeGate(good({ unresolvedThreads: 2 })).code, 'REVIEW_UNRESOLVED');
  });

  test('리뷰 상태를 못 읽었으면 안 합친다', () => {
    eq(autoMergeGate(good({ unresolvedThreads: null })).code, 'REVIEW_UNKNOWN');
    eq(autoMergeGate(good({ changesRequested: null })).code, 'REVIEW_UNKNOWN');
  });

  console.log('[자동 머지 — 강제 경로가 없다]');

  test('어떤 입력으로도 실패한 검사를 통과시킬 수 없다', () => {
    // 라벨을 여러 개 붙이든, 리뷰가 승인이든, mergeable이 clean이든
    // 검사가 실패면 결과는 하나다.
    const v = autoMergeGate(good({
      labels: [AUTO_MERGE_LABEL, 'urgent', 'hotfix', 'force'],
      mergeableState: 'clean',
      unresolvedThreads: 0, changesRequested: 0,
      checks: [{ name: 'verify', status: 'completed', conclusion: 'failure', headSha: 'abc1234def5678' }],
    }));
    eq(v.merge, false);
    eq(v.code, 'CHECKS_FAILED');
  });

  console.log('[자동 머지 — 왜 안 합쳤는지가 PR에 남는다]');

  test('판정 코멘트에 이유와 커밋이 들어간다', () => {
    const v = autoMergeGate(good({ checks: [], statuses: [] }));
    const c = gateComment({ number: 1, headSha: 'abc1234def5678' }, v);
    assert(c.includes('<!-- traigo-auto-merge -->'), '같은 코멘트를 갱신할 표식이 필요하다');
    assert(c.includes('abc1234'), '어느 커밋 기준인지 남아야 한다');
    assert(c.includes(v.reason), '이유가 그대로 들어가야 한다');
    assert(c.includes('강제로 합치는 경로는 없습니다'), c);
  });

  test('통과했을 때는 다른 문구다', () => {
    const c = gateComment({ number: 1, headSha: 'abc1234def5678' }, autoMergeGate(good()));
    assert(c.includes('✅'), c);
  });
}
