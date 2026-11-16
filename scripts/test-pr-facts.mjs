// scripts/test-pr-facts.mjs
//
// **못 읽은 것이 0이 되지 않는다는 것을 값으로 못 박는다.**
//
// 이 모듈이 틀리는 방식은 하나뿐이다: 읽기 실패를 "깨끗함"으로 바꾸는
// 것. 리뷰를 못 읽어서 `unresolvedThreads: 0`이 되면 판정기는 통과를
// 주고, 미해결 리뷰가 달린 PR이 합쳐진다. 그래서 실패 경로마다
// null인지 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReviewThreads, normalizeChangesRequested,
  reviewFacts, headContainsBase, buildFacts, prDetail, gatherFacts, baseTip,
  listOpenPulls,
} from './lib/pr-facts.mjs';

const ok = body => ({ ok: true, status: 200, body });
const fail = (status = 500, body = null) => ({ ok: false, status, body });

test('리뷰 스레드 — 미해결만 센다', () => {
  assert.equal(normalizeReviewThreads([]), 0);
  assert.equal(normalizeReviewThreads([{ isResolved: true, isOutdated: false }]), 0);
  assert.equal(normalizeReviewThreads([{ isResolved: false, isOutdated: false }]), 1);
  // outdated는 그 코드가 사라진 것이라 세지 않는다
  assert.equal(normalizeReviewThreads([{ isResolved: false, isOutdated: true }]), 0);
  // snake_case (CCR REST)
  assert.equal(normalizeReviewThreads([{ is_resolved: false, is_outdated: false }]), 1);
});

test('리뷰 스레드 — 모양을 모르면 null이다 (0이 아니다)', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, [null], ['x'],
                     [{ foo: 1 }], [{ isResolved: 'false' }]]) {
    assert.equal(normalizeReviewThreads(bad), null,
      `${JSON.stringify(bad)}가 null이 아니다`);
  }
});

test('CHANGES_REQUESTED — 숫자도 배열도 받는다', () => {
  assert.equal(normalizeChangesRequested(0), 0);
  assert.equal(normalizeChangesRequested(3), 3);
  assert.equal(normalizeChangesRequested([]), 0);
  assert.equal(normalizeChangesRequested([{ state: 'APPROVED' }]), 0);
  assert.equal(normalizeChangesRequested([{ state: 'changes_requested' }]), 1);
  assert.equal(normalizeChangesRequested(
    [{ state: 'CHANGES_REQUESTED' }, { state: 'COMMENTED' }, { state: 'CHANGES_REQUESTED' }]), 2);
});

test('CHANGES_REQUESTED — 모르면 null이다', () => {
  for (const bad of [null, undefined, 'x', NaN, {}, [null], [{}], [{ state: '' }]]) {
    assert.equal(normalizeChangesRequested(bad), null,
      `${JSON.stringify(bad)}가 null이 아니다`);
  }
});

test('리뷰 — GraphQL이 되면 그것을 쓴다', async () => {
  const graphql = async () => ok({
    data: { repository: { pullRequest: {
      reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] },
      reviews: { totalCount: 2 },
    } } },
  });
  const api = async () => { throw new Error('REST를 부르면 안 된다'); };
  const r = await reviewFacts({ api, graphql, repo: 'o/r', owner: 'o', name: 'r', number: 1 });
  assert.deepEqual(r, { unresolvedThreads: 1, changesRequested: 2 });
});

test('리뷰 — GraphQL이 403이면 REST로 떨어진다', async () => {
  const graphql = async () => ({ ok: false, body: null });
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path.includes('ccr/review_threads')) {
      return ok([{ is_resolved: false, is_outdated: false },
                 { is_resolved: true, is_outdated: false }]);
    }
    if (path.includes('/reviews')) return ok([{ state: 'CHANGES_REQUESTED' }]);
    return fail(404);
  };
  const r = await reviewFacts({ api, graphql, repo: 'o/r', owner: 'o', name: 'r', number: 7 });
  assert.deepEqual(r, { unresolvedThreads: 1, changesRequested: 1 });
  assert.ok(calls.some(p => p.includes('ccr/review_threads')), 'CCR 라우트를 불러야 한다');
});

test('리뷰 — 둘 다 실패하면 null이다. **다른 경로가 있다는 게 아는 것은 아니다**', async () => {
  const graphql = async () => ({ ok: false, body: null });
  const api = async () => fail(403);
  const r = await reviewFacts({ api, graphql, repo: 'o/r', owner: 'o', name: 'r', number: 7 });
  assert.deepEqual(r, { unresolvedThreads: null, changesRequested: null });
});

test('리뷰 — 한쪽만 읽혀도 null이다', async () => {
  const graphql = async () => ({ ok: false, body: null });
  const api = async path =>
    path.includes('ccr/review_threads') ? ok([]) : fail(500);
  const r = await reviewFacts({ api, graphql, repo: 'o/r', owner: 'o', name: 'r', number: 7 });
  assert.equal(r.changesRequested, null);
  assert.equal(r.unresolvedThreads, null, '한쪽을 모르면 전체가 모르는 것이다');
});

test('base 포함 — ahead/identical은 true, behind/diverged는 false', async () => {
  for (const [status, want] of [['ahead', true], ['identical', true],
                                ['behind', false], ['diverged', false]]) {
    const r = await headContainsBase({
      api: async () => ok({ status }), repo: 'o/r', baseSha: 'b', headSha: 'h', sleep: async () => {},
    });
    assert.equal(r, want, status);
  }
});

test('base 포함 — 재시도하고, 끝까지 못 읽으면 null이다', async () => {
  let n = 0;
  const r1 = await headContainsBase({
    api: async () => { n++; return n < 3 ? fail(502) : ok({ status: 'ahead' }); },
    repo: 'o/r', baseSha: 'b', headSha: 'h', sleep: async () => {},
  });
  assert.equal(r1, true); assert.equal(n, 3, '재시도해야 한다');

  const r2 = await headContainsBase({
    api: async () => fail(403), repo: 'o/r', baseSha: 'b', headSha: 'h', sleep: async () => {},
  });
  assert.equal(r2, null);
});

test('base 포함 — status가 모르는 값이면 null이다', async () => {
  const r = await headContainsBase({
    api: async () => ok({ status: 'weird' }), repo: 'o/r', baseSha: 'b', headSha: 'h', sleep: async () => {},
  });
  assert.equal(r, null);
});

const prStub = (over = {}) => ({
  number: 9, draft: true, labels: [{ name: 'x' }],
  base: { ref: 'main', sha: 'base1' }, head: { sha: 'head1' },
  mergeable: true, mergeable_state: 'clean', ...over,
});

test('buildFacts — 응답을 그대로 사실로 옮긴다', () => {
  const f = buildFacts({
    pr: prStub(),
    runs: ok({ check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success', head_sha: 'head1' }] }),
    statuses: ok({ statuses: [{ context: 'Vercel', state: 'success' }] }),
    review: { unresolvedThreads: 0, changesRequested: 0 },
    contains: true,
  });
  assert.equal(f.number, 9);
  assert.equal(f.draft, true);
  assert.deepEqual(f.labels, ['x']);
  assert.equal(f.baseRef, 'main');
  assert.equal(f.headSha, 'head1');
  assert.equal(f.headContainsBase, true);
  assert.deepEqual(f.checks, [{ name: 'verify', status: 'completed', conclusion: 'success', headSha: 'head1' }]);
  assert.deepEqual(f.statuses, [{ context: 'Vercel', state: 'success' }]);
});

test('buildFacts — 검사를 못 읽으면 빈 배열이다 (판정기가 CHECKS_MISSING으로 막는다)', () => {
  const f = buildFacts({
    pr: prStub(), runs: fail(500), statuses: fail(500),
    review: { unresolvedThreads: 0, changesRequested: 0 }, contains: true,
  });
  assert.deepEqual(f.checks, []);
  assert.deepEqual(f.statuses, []);
});

test('buildFacts — 리뷰가 null이면 null로 들어간다. **0으로 바뀌지 않는다**', () => {
  const f = buildFacts({
    pr: prStub(), runs: ok({ check_runs: [] }), statuses: ok({ statuses: [] }),
    review: { unresolvedThreads: null, changesRequested: null }, contains: null,
  });
  assert.equal(f.unresolvedThreads, null);
  assert.equal(f.changesRequested, null);
  assert.equal(f.headContainsBase, null);
  // review 자체가 없을 때도 0이 아니다
  const g = buildFacts({ pr: prStub(), runs: ok({}), statuses: ok({}), review: null, contains: null });
  assert.equal(g.unresolvedThreads, null);
  assert.equal(g.changesRequested, null);
});

test('buildFacts — head.sha가 없으면 던진다 (조용히 빈 사실을 만들지 않는다)', () => {
  assert.throws(() => buildFacts({ pr: { number: 1, base: {} }, runs: ok({}), statuses: ok({}) }));
  assert.throws(() => buildFacts({ pr: null }));
});

test('buildFacts — 라벨은 문자열과 객체 둘 다 받는다', () => {
  const f = buildFacts({
    pr: prStub({ labels: ['a', { name: 'b' }, null, { name: '' }] }),
    runs: ok({}), statuses: ok({}), review: null, contains: true,
  });
  assert.deepEqual(f.labels, ['a', 'b']);
});

// ─────────────────────────────────────────────────────────────────────
// **GitHub은 mergeable을 느리게 계산한다.**
//
// 2026-11-05에 열린 PR 100개를 전수 판정했을 때 34개가
// `MERGEABILITY_UNKNOWN`으로 나왔다. 한 번 더 물어보니 #441·#443·#446은
// `mergeable=false, dirty` — **실제로 충돌난 PR**이었고 #449·#455는
// 멀쩡했다. 한 번만 묻고 포기해서 **충돌을 과소보고했다.**
//
// 그래서 null이면 짧게 다시 묻는다. 끝까지 null이면 **여전히 null이다** —
// 재시도가 모르는 것을 아는 것으로 바꾸지는 않는다.
// ─────────────────────────────────────────────────────────────────────

test('상세 조회 — mergeable이 null이면 다시 묻는다', async () => {
  let n = 0;
  const r = await prDetail({
    api: async () => {
      n++;
      return ok({ number: 1, head: { sha: 'h' }, base: { ref: 'main', sha: 'b' },
        mergeable: n < 3 ? null : false, mergeable_state: n < 3 ? 'unknown' : 'dirty' });
    },
    repo: 'o/r', number: 1, sleep: async () => {},
  });
  assert.equal(n, 3, '계산될 때까지 다시 물어야 한다');
  assert.equal(r.body.mergeable, false);
  assert.equal(r.body.mergeable_state, 'dirty');
});

test('상세 조회 — 한 번에 나오면 더 묻지 않는다', async () => {
  let n = 0;
  await prDetail({
    api: async () => { n++; return ok({ number: 1, head: { sha: 'h' }, mergeable: true }); },
    repo: 'o/r', number: 1, sleep: async () => {},
  });
  assert.equal(n, 1);
});

test('상세 조회 — 끝까지 null이면 null이다. **재시도가 아는 것으로 바꾸지 않는다**', async () => {
  let n = 0;
  const r = await prDetail({
    api: async () => { n++; return ok({ number: 1, head: { sha: 'h' }, mergeable: null }); },
    repo: 'o/r', number: 1, sleep: async () => {}, attempts: 4,
  });
  assert.equal(n, 4);
  assert.equal(r.body.mergeable, null);
});

test('상세 조회 — HTTP 실패는 즉시 돌려준다 (재시도로 덮지 않는다)', async () => {
  let n = 0;
  const r = await prDetail({
    api: async () => { n++; return fail(404); },
    repo: 'o/r', number: 1, sleep: async () => {},
  });
  assert.equal(n, 1, '없는 PR을 네 번 묻지 않는다');
  assert.equal(r.ok, false);
});

test('gatherFacts — 느리게 계산된 mergeable이 사실에 들어간다', async () => {
  let detailCalls = 0;
  const api = async path => {
    if (/\/pulls\/\d+$/.test(path)) {
      detailCalls++;
      return ok({ number: 5, draft: true, labels: [], head: { sha: 'h5' },
        base: { ref: 'main', sha: 'b5' },
        mergeable: detailCalls < 2 ? null : false,
        mergeable_state: detailCalls < 2 ? 'unknown' : 'dirty' });
    }
    if (path.includes('check-runs')) return ok({ check_runs: [] });
    if (path.endsWith('/status')) return ok({ statuses: [] });
    if (path.includes('ccr/review_threads')) return ok([]);
    if (path.includes('/reviews')) return ok([]);
    if (path.includes('/compare/')) return ok({ status: 'ahead' });
    return fail(404);
  };
  const f = await gatherFacts({ api, graphql: null, repo: 'o/r', owner: 'o', name: 'r',
    number: 5, sleep: async () => {} });
  assert.equal(f.mergeable, false, '두 번째 조회 값이 들어가야 한다');
  assert.equal(f.mergeableState, 'dirty');
});

// ─────────────────────────────────────────────────────────────────────
// **`pr.base.sha`는 base 브랜치의 지금 tip이 아니다.**
//
// 게이트의 `BEHIND_BASE` 검사는 이렇게 적혀 있다:
//
//     head가 base tip을 조상으로 갖고 있어야, 그 head에서 돈 검사가
//     지금의 main과 합쳐진 상태를 실제로 본 것이다.
//
// 그런데 비교에 넣던 값은 `pr.base.sha` — **PR이 만들어지거나 마지막으로
// 갱신된 시점의 base 커밋**이다. main이 그 뒤로 움직이면 이 값은 낡는다.
//
// 2026-11-05 실측: 열린 PR 중 "기술적으로 올려도 됨"으로 나온 21개 중
// 16개가 실제로는 main에 뒤처져 있었다.
//
//     #449 #455 #475 #477 #492 #512 #517   main 대비 119 커밋 뒤
//     #546 #547 #548 #551 #553 #556 #560 #571 #573   17 커밋 뒤
//
// 전부 `base.sha`가 `38bb8217`(10월) 또는 `f6f948fc`로 굳어 있어서,
// head는 그 낡은 값보다는 당연히 `ahead`다. 그래서 검사가 통과했다.
// **119커밋 전 main에서 돈 CI를 지금 main의 증거로 쓰게 된다.**
//
// 고치는 방향은 더 엄격해지는 쪽이다 — base ref의 **지금 tip**을 읽어서
// 비교한다. tip을 못 읽으면 null이고, null이면 게이트가 막는다.
// ─────────────────────────────────────────────────────────────────────

test('base tip — ref 를 읽어 지금 tip 을 돌려준다', async () => {
  const r = await baseTip({
    api: async path => {
      assert.ok(path.includes('/git/ref/heads/main'), path);
      return ok({ object: { sha: 'tip999' } });
    },
    repo: 'o/r', ref: 'main',
  });
  assert.equal(r, 'tip999');
});

test('base tip — 못 읽으면 null이다 (낡은 base.sha로 떨어지지 않는다)', async () => {
  for (const res of [fail(404), fail(500), ok({}), ok({ object: {} }), ok(null)]) {
    const r = await baseTip({ api: async () => res, repo: 'o/r', ref: 'main' });
    assert.equal(r, null, JSON.stringify(res));
  }
});

test('**뒤처진 PR이 BEHIND_BASE로 잡힌다** — 낡은 base.sha를 쓰지 않는다', async () => {
  // main 은 tipNEW 로 움직였고, PR 은 10월의 baseOLD 위에서 만들어졌다.
  // head 는 baseOLD 보다는 ahead 지만 tipNEW 에는 17 커밋 뒤처져 있다.
  const compared = [];
  const api = async path => {
    if (/\/pulls\/\d+$/.test(path)) {
      return ok({ number: 9, draft: true, labels: [], head: { sha: 'headX' },
        base: { ref: 'main', sha: 'baseOLD' }, mergeable: true, mergeable_state: 'blocked' });
    }
    if (path.includes('/git/ref/heads/main')) return ok({ object: { sha: 'tipNEW' } });
    if (path.includes('/compare/')) {
      compared.push(path);
      // tipNEW...headX 는 behind, baseOLD...headX 는 ahead
      if (path.includes('tipNEW')) return ok({ status: 'behind' });
      return ok({ status: 'ahead' });
    }
    if (path.includes('check-runs')) return ok({ check_runs: [] });
    if (path.endsWith('/status')) return ok({ statuses: [] });
    if (path.includes('ccr/review_threads')) return ok([]);
    if (path.includes('/reviews')) return ok([]);
    return fail(404);
  };
  const f = await gatherFacts({ api, graphql: null, repo: 'o/r', owner: 'o', name: 'r',
    number: 9, sleep: async () => {} });
  assert.ok(compared.some(p => p.includes('tipNEW')),
    `지금 tip 과 비교해야 한다 — 비교한 경로: ${compared.join(' ')}`);
  assert.ok(!compared.some(p => p.includes('baseOLD')),
    `낡은 base.sha 와 비교하면 안 된다 — 비교한 경로: ${compared.join(' ')}`);
  assert.equal(f.headContainsBase, false, '뒤처진 PR 은 false 여야 게이트가 막는다');
  assert.equal(f.baseSha, 'tipNEW', '사실에 기록되는 base 도 지금 tip 이어야 한다');
});

test('base tip 을 못 읽으면 headContainsBase 는 null이다 (통과가 아니다)', async () => {
  const api = async path => {
    if (/\/pulls\/\d+$/.test(path)) {
      return ok({ number: 9, draft: true, labels: [], head: { sha: 'headX' },
        base: { ref: 'main', sha: 'baseOLD' }, mergeable: true, mergeable_state: 'blocked' });
    }
    if (path.includes('/git/ref/heads/main')) return fail(403);
    if (path.includes('/compare/')) return ok({ status: 'ahead' });
    if (path.includes('check-runs')) return ok({ check_runs: [] });
    if (path.endsWith('/status')) return ok({ statuses: [] });
    if (path.includes('ccr/review_threads')) return ok([]);
    if (path.includes('/reviews')) return ok([]);
    return fail(404);
  };
  const f = await gatherFacts({ api, graphql: null, repo: 'o/r', owner: 'o', name: 'r',
    number: 9, sleep: async () => {} });
  assert.equal(f.headContainsBase, null, '못 읽은 것은 통과가 아니다');
});

// ══════════ 열린 PR 목록 — 100개에서 끊기지 않는다 ══════════
//
// 2026-11-07에 열린 PR이 225개인데 두 도구가 **100개만** 보고 있었다.
// `?state=open&per_page=100` 한 번으로 끝냈기 때문이다. 보고서는
// "읽은 PR 100개"라고 적었고, 나머지 125개가 빠졌다는 말은 어디에도
// 없었다. `auto-merge.mjs`의 30분 안전망도 같은 자리를 공유해서,
// 첫 장 밖의 라벨 붙은 PR은 **영원히 합쳐지지 않는다.**
// 못 본 것을 "없음"으로 적지 않는다.

const pulls = n => Array.from({ length: n }, (_, i) => ({ number: i + 1 }));

test('열린 PR 목록 — 100개를 넘으면 다음 장을 읽는다', async () => {
  const seen = [];
  const api = async path => {
    seen.push(path);
    const m = /[?&]page=(\d+)/.exec(path);
    const page = m ? Number(m[1]) : 1;
    if (page === 1) return ok(pulls(100));
    if (page === 2) return ok(pulls(100));
    if (page === 3) return ok(pulls(25));
    return ok([]);
  };
  const r = await listOpenPulls({ api, repo: 'o/r' });
  assert.equal(r.ok, true);
  assert.equal(r.complete, true, '다 읽었으면 complete');
  assert.equal(r.all.length, 225, `225개를 모두 읽어야 한다 — 받은 것 ${r.all.length}`);
  assert.equal(seen.length, 3, '짧은 장에서 멈춘다');
});

test('열린 PR 목록 — 꽉 찬 장에서 멈추지 않는다 (100의 배수 함정)', async () => {
  const api = async path => {
    const m = /[?&]page=(\d+)/.exec(path);
    const page = m ? Number(m[1]) : 1;
    return ok(page <= 2 ? pulls(100) : []);
  };
  const r = await listOpenPulls({ api, repo: 'o/r' });
  assert.equal(r.all.length, 200);
  assert.equal(r.complete, true, '빈 장을 받으면 다 읽은 것이다');
});

test('열린 PR 목록 — 한 장이라도 못 읽으면 complete가 아니다 (부분을 전체로 적지 않는다)', async () => {
  const api = async path => {
    const m = /[?&]page=(\d+)/.exec(path);
    const page = m ? Number(m[1]) : 1;
    return page === 1 ? ok(pulls(100)) : fail(502);
  };
  const r = await listOpenPulls({ api, repo: 'o/r' });
  assert.equal(r.complete, false, '못 읽은 장이 있으면 complete=false');
  assert.equal(r.all.length, 100, '읽은 것은 그대로 돌려준다');
  assert.equal(r.failedPage, 2, '어느 장에서 멈췄는지 적는다');
});

test('열린 PR 목록 — 장 수 상한에 닿으면 complete가 아니다', async () => {
  const api = async () => ok(pulls(100));   // 끝나지 않는 저장소
  const r = await listOpenPulls({ api, repo: 'o/r', maxPages: 3 });
  assert.equal(r.complete, false, '상한에 닿은 것은 다 읽은 것이 아니다');
  assert.equal(r.all.length, 300);
});

test('열린 PR 목록 — 배열이 아닌 응답을 0개로 읽지 않는다', async () => {
  const api = async () => ok({ message: 'not an array' });
  const r = await listOpenPulls({ api, repo: 'o/r' });
  assert.equal(r.complete, false);
  assert.equal(r.all.length, 0);
});
