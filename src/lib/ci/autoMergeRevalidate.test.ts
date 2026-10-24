// Offline fake GitHub API: no network, no real merge request.
import { test, eq, assert } from '../../test/harness';
import { attemptMergeAfterRecheck, type MergeApi } from './autoMergeRevalidate';

const expected = {
  repo: 'owner/repo', number: 42, headSha: 'H1', baseSha: 'B1',
  baseRef: 'main', mergeableState: 'clean',
};
const good = () => ({
  number: 42, state: 'open', merged: false, draft: false,
  labels: [{ name: 'auto-merge' }], head: { sha: 'H1' },
  base: { ref: 'main', sha: 'B1' }, mergeable: true, mergeable_state: 'clean',
});

type FakeOptions = {
  pr?: any; branch?: any; failDetail?: boolean; failBranch?: boolean;
  throwDetail?: boolean; throwBranch?: boolean;
};
function fake(options: FakeOptions = {}) {
  const calls: Array<{ path: string; method?: string; body?: string }> = [];
  const api: MergeApi = async (path, init) => {
    calls.push({ path, method: init?.method, body: init?.body });
    if (init?.method === 'PUT') return { ok: true, status: 200, body: { merged: true } };
    if (path.includes('/branches/')) {
      if (options.throwBranch) throw Error('network');
      if (options.failBranch) return { ok: false, status: 503 };
      return { ok: true, status: 200, body: options.branch ?? { commit: { sha: 'B1' } } };
    }
    if (options.throwDetail) throw Error('network');
    if (options.failDetail) return { ok: false, status: 503 };
    return { ok: true, status: 200, body: options.pr ?? good() };
  };
  return { api, calls };
}

export function runAutoMergeRevalidateTests() {
  console.log('[자동 머지 — PUT 직전 재검증 · 오프라인 fake API]');

  test('변경 없는 PR만 squash PUT 1건, HEAD SHA 조건을 붙인다', async () => {
    const f = fake();
    const result = await attemptMergeAfterRecheck(f.api, expected);
    eq(result.attempted, true);
    const puts = f.calls.filter(c => c.method === 'PUT');
    eq(puts.length, 1);
    eq(puts[0].path, '/repos/owner/repo/pulls/42/merge');
    eq(JSON.parse(puts[0].body || '{}').sha, 'H1');
    eq(JSON.parse(puts[0].body || '{}').merge_method, 'squash');
  });

  test('base 이동·라벨 제거·Draft·HEAD 이동·조회 실패는 PUT 0건', async () => {
    const scenarios: Array<[string, FakeOptions]> = [
      ['base tip moved', { branch: { commit: { sha: 'B2' } } }],
      ['PR base moved', { pr: { ...good(), base: { ref: 'main', sha: 'B2' } } }],
      ['label removed', { pr: { ...good(), labels: [] } }],
      ['draft transition', { pr: { ...good(), draft: true } }],
      ['head moved', { pr: { ...good(), head: { sha: 'H2' } } }],
      ['PR closed', { pr: { ...good(), state: 'closed' } }],
      ['mergeability lost', { pr: { ...good(), mergeable: null } }],
      ['mergeability state changed', { pr: { ...good(), mergeable_state: 'blocked' } }],
      ['PR detail HTTP failure', { failDetail: true }],
      ['branch HTTP failure', { failBranch: true }],
      ['PR read throws', { throwDetail: true }],
      ['branch read throws', { throwBranch: true }],
      ['malformed PR detail', { pr: { number: 42 } }],
      ['malformed branch', { branch: {} }],
    ];
    for (const [name, options] of scenarios) {
      const f = fake(options);
      const result = await attemptMergeAfterRecheck(f.api, expected);
      assert(!result.attempted, name + ' unexpectedly attempted merge');
      eq(f.calls.filter(c => c.method === 'PUT').length, 0, name + ' sent PUT');
    }
  });

  test('main이 아닌 base 또는 불완전한 expected identity는 요청 자체를 하지 않는다', async () => {
    for (const change of [{ baseRef: 'feature' }, { headSha: '' }, { baseSha: '' }]) {
      const f = fake();
      const result = await attemptMergeAfterRecheck(f.api, { ...expected, ...change });
      eq(result.attempted, false);
      eq(f.calls.length, 0);
    }
  });
}
