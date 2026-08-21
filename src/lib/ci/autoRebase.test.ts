// src/lib/ci/autoRebase.test.ts
//
// **이 테스트가 지키는 것: 충돌을 기계가 고르지 않는다.**
//
// 실제로 한 번 났다 — 한쪽 PR은 지갑의 오류 문자열을 판정 객체로 바꾸고,
// 다른 쪽은 같은 자리의 토큰 읽기를 바꿨다. 양쪽을 기계적으로 남기면
// 타입은 통과하는데 지갑 판정만 죽는다. 검사도 초록이다.
import { test, eq, assert } from '../../test/harness';
import {
  rebaseVerdict, rebaseComment, AUTO_MERGE_LABEL, OPT_OUT_LABEL,
} from './autoRebase';

const base = {
  number: 1, draft: false, labels: [AUTO_MERGE_LABEL], fromFork: false,
  headRef: 'claude/x', headSha: 'a'.repeat(40), baseRef: 'main',
  behindBy: 3, cleanRebase: true,
};

export function runAutoRebaseTests() {
  console.log('[자동 재배치 — 재배치를 사람이 누르는 구조를 없앤다]');

  test('깨끗하게 재배치되면 재배치한다', () => {
    const v = rebaseVerdict(base as any, 'main');
    eq(v.action, 'REBASE');
  });

  test('충돌이면 손을 뗀다 — 기계가 고르지 않는다', () => {
    const v = rebaseVerdict({ ...base, cleanRebase: false } as any, 'main');
    eq(v.action, 'NEEDS_HUMAN');
    assert(v.reason.includes('기계가 고르지 않습니다'), v.reason);
  });

  test('이미 최신이면 아무것도 하지 않는다', () => {
    eq(rebaseVerdict({ ...base, behindBy: 0 } as any, 'main').action, 'UP_TO_DATE');
  });

  test('얼마나 뒤처졌는지 모르면 이력을 고치지 않는다', () => {
    // 못 읽은 것을 0으로도 1로도 읽지 않는다.
    const v = rebaseVerdict({ ...base, behindBy: null } as any, 'main');
    eq(v.action, 'SKIP');
    assert(v.reason.includes('모르는 채로'), v.reason);
  });

  console.log('[자동 재배치 — 손대면 안 되는 것]');

  test('auto-merge 라벨이 없으면 커밋을 건드리지 않는다', () => {
    // 합칠 생각이 없는 PR의 커밋이 조용히 바뀌면 안 된다.
    // 재배치 스위치를 따로 두지 않고 머지 스위치와 같은 것을 쓴다.
    eq(rebaseVerdict({ ...base, labels: [] } as any, 'main').action, 'SKIP');
  });

  test('빼 달라는 라벨이 붙어 있으면 손대지 않는다', () => {
    const v = rebaseVerdict({ ...base, labels: [AUTO_MERGE_LABEL, OPT_OUT_LABEL] } as any, 'main');
    eq(v.action, 'SKIP');
  });

  test('초안은 대상이 아니다', () => {
    eq(rebaseVerdict({ ...base, draft: true } as any, 'main').action, 'SKIP');
  });

  test('fork에서 온 PR은 남의 브랜치 이력이다', () => {
    const v = rebaseVerdict({ ...base, fromFork: true } as any, 'main');
    eq(v.action, 'SKIP');
    assert(v.reason.includes('남의 브랜치 이력'), v.reason);
  });

  test('다른 PR 위에 쌓인 PR은 main으로 끌어오지 않는다', () => {
    // 끌어오면 아래 PR의 커밋이 통째로 딸려 들어간다.
    const v = rebaseVerdict({ ...base, baseRef: 'claude/other' } as any, 'main');
    eq(v.action, 'SKIP');
  });

  console.log('[자동 재배치 — 적는 말]');

  test('아무 일도 안 한 것은 PR에 적지 않는다', () => {
    // 댓글이 쌓이면 진짜 신호가 묻힌다.
    eq(rebaseComment({ action: 'SKIP', reason: 'x', defaultBranch: 'main' }), null);
    eq(rebaseComment({ action: 'UP_TO_DATE', reason: 'x', defaultBranch: 'main' }), null);
  });

  test('재배치했으면 검사가 다시 돈다고 적는다', () => {
    const c = rebaseComment({ action: 'REBASE', reason: 'r', defaultBranch: 'main', newSha: 'b'.repeat(40) })!;
    assert(c.includes('처음부터 다시 돕니다'), c);
    assert(c.includes('bbbbbbb'), c);
  });

  test('실패했으면 우회 경로가 없다고 적는다', () => {
    const c = rebaseComment({ action: 'NEEDS_HUMAN', reason: 'r', defaultBranch: 'main' })!;
    assert(c.includes('우회하거나 강제로 합치는 경로는 없습니다'), c);
  });
}
