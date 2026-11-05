// scripts/lib/pr-facts.mjs
//
// **PR 사실을 모으는 곳은 한 곳이다.**
//
// 판정은 `src/lib/ci/autoMergeGate.ts`가 한다. 이 파일은 그 판정기에
// 넣을 `PrFacts`를 GitHub API 응답에서 만든다.
//
// 왜 따로 뺐나
// ────────────
// 이 사실을 쓰는 곳이 둘이 됐다:
//
//   · `scripts/auto-merge.mjs` — 라벨이 붙은 PR을 실제로 합친다
//   · `scripts/pr-backlog.mjs` — 열린 PR 전부를 **읽기만** 하고 보고한다
//
// 판정기는 둘이 같은 것을 쓰지만, 넣는 사실을 각자 따로 만들면
// **같은 PR에 다른 사실이 들어가서 다른 답이 나온다.** 보고서가 "올려도
// 된다"고 한 PR을 머지 러너가 막으면, 사람은 보고서를 못 믿게 되고
// 다시 100개를 하나씩 열어 본다 (`CLAUDE.md`: 같은 판단이 두 곳에
// 있으면 언젠가 갈린다).
//
// 왜 주입형인가
// ─────────────
// 토큰을 쥔 `api`·`graphql`을 인자로 받는다. 그래야
//   ① 토큰 처리가 호출하는 쪽에 그대로 남고 (이 파일은 시크릿을 모른다)
//   ② 가짜 응답을 넣어 **테스트할 수 있다** (`scripts/test-pr-facts.mjs`)
//
// 못 읽은 것은 null이다
// ─────────────────────
// 리뷰도 base 포함 여부도, 읽지 못하면 **null로 둔다.** 0으로 두면
// 미해결 리뷰를 무시하고 통과시킨다. 판정기는 null을 받으면 막는다 —
// 그게 맞는 결과다 (`CLAUDE.md`: UNKNOWN을 0으로 적지 않는다).

/**
 * 리뷰 스레드 응답 → 미해결 개수. **모르면 null.**
 *
 * 두 가지 모양을 받는다:
 *   · GraphQL `reviewThreads.nodes` — `{isResolved, isOutdated}`
 *   · CCR REST `/pulls/{n}/ccr/review_threads` — 같은 키 또는 snake_case
 *
 * outdated된 스레드는 그 코드가 이미 사라진 것이라 세지 않는다.
 */
export function normalizeReviewThreads(nodes) {
  if (!Array.isArray(nodes)) return null;
  let n = 0;
  for (const t of nodes) {
    if (t == null || typeof t !== 'object') return null;  // 모양이 다르면 모르는 것이다
    const resolved = t.isResolved ?? t.is_resolved ?? t.resolved;
    const outdated = t.isOutdated ?? t.is_outdated ?? t.outdated;
    if (typeof resolved !== 'boolean') return null;
    if (!resolved && outdated !== true) n++;
  }
  return n;
}

/**
 * 리뷰 목록 → CHANGES_REQUESTED 개수. **모르면 null.**
 *
 * GraphQL은 `reviews(states:CHANGES_REQUESTED).totalCount`를 주고,
 * REST `/pulls/{n}/reviews`는 전체 리뷰 배열을 준다. 후자는 직접 센다.
 */
export function normalizeChangesRequested(payload) {
  if (typeof payload === 'number' && Number.isFinite(payload)) return payload;
  if (!Array.isArray(payload)) return null;
  let n = 0;
  for (const r of payload) {
    if (r == null || typeof r !== 'object') return null;
    const s = String(r.state ?? '').toUpperCase();
    if (!s) return null;
    if (s === 'CHANGES_REQUESTED') n++;
  }
  return n;
}

const THREADS_QUERY = `query($o:String!,$n:String!,$p:Int!){
  repository(owner:$o,name:$n){ pullRequest(number:$p){
    reviewThreads(first:100){ nodes { isResolved isOutdated } }
    reviews(first:100, states:CHANGES_REQUESTED){ totalCount }
  }}}`;

/**
 * 리뷰 상태. GraphQL을 먼저 쓰고, 막히면 REST로 떨어진다.
 *
 * 왜 두 경로인가: GitHub Actions 안에서는 GraphQL이 되지만, Claude Code
 * 세션에서는 **403으로 막힌다**(`GitHub GraphQL is not available from
 * Claude Code sessions`). 세션에서 보고서를 돌릴 수 없으면 이 도구는
 * 쓸모가 없다. 그래서 같은 사실을 REST로도 읽는다.
 *
 * **둘 다 실패하면 null이다** — 다른 경로가 있다는 것이 모르는 것을
 * 아는 것으로 바꾸지는 않는다.
 */
export async function reviewFacts({ api, graphql, repo, owner, name, number, log = () => {} }) {
  const UNKNOWN = { unresolvedThreads: null, changesRequested: null };

  if (typeof graphql === 'function') {
    const r = await graphql(THREADS_QUERY, { o: owner, n: name, p: number });
    if (r?.ok) {
      const pr = r.body?.data?.repository?.pullRequest;
      const threads = normalizeReviewThreads(pr?.reviewThreads?.nodes);
      const changes = normalizeChangesRequested(pr?.reviews?.totalCount);
      if (threads !== null && changes !== null) {
        return { unresolvedThreads: threads, changesRequested: changes };
      }
    }
    log(`#${number} 리뷰 GraphQL 실패 — REST로 다시 시도합니다`);
  }

  const [t, rv] = await Promise.all([
    api(`/repos/${repo}/pulls/${number}/ccr/review_threads`),
    api(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
  ]);

  // CCR 라우트는 배열을 바로 주거나 `{review_threads: [...]}`로 준다.
  const rawThreads = t?.ok
    ? (Array.isArray(t.body) ? t.body : (t.body?.review_threads ?? t.body?.threads))
    : null;
  const threads = normalizeReviewThreads(rawThreads);
  const changes = rv?.ok ? normalizeChangesRequested(rv.body) : null;

  if (threads === null) log(`#${number} 리뷰 스레드를 읽지 못했습니다 (HTTP ${t?.status})`);
  if (changes === null) log(`#${number} 리뷰 목록을 읽지 못했습니다 (HTTP ${rv?.status})`);
  if (threads === null || changes === null) return UNKNOWN;
  return { unresolvedThreads: threads, changesRequested: changes };
}

/**
 * head가 base tip을 조상으로 갖는가. **못 읽으면 null.**
 *
 * 이 확인이 2026-08-17에 네 번 연속 실패했고, 로그에 "확인하지 못했습니다"
 * 한 줄만 남아서 이유를 알 수 없었다. 그래서 짧게 재시도하고, 실패하면
 * **HTTP 상태와 응답 요약을 남긴다.** 판정 규칙은 그대로다 — 모르면 null,
 * null이면 합치지 않는다.
 */
export async function headContainsBase({ api, repo, baseSha, headSha, log = () => {}, attempts = 3, sleep }) {
  const path = `/repos/${repo}/compare/${baseSha}...${headSha}`;
  const wait = sleep || (ms => new Promise(res => setTimeout(res, ms)));
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await api(path);
    last = r;
    if (r?.ok) {
      const s = r.body?.status;
      if (s === 'ahead' || s === 'identical') return true;
      if (s === 'behind' || s === 'diverged') return false;
      log(`compare 응답에 status가 없습니다 (${JSON.stringify(s)}) — ${path}`);
      return null;
    }
    if (attempt < attempts) await wait(attempt * 1000);
  }
  log(`compare 실패 HTTP ${last?.status} — ${path}`
    + (last?.body?.message ? ` :: ${String(last.body.message).slice(0, 200)}` : ''));
  return null;
}

/**
 * API 응답들 → `PrFacts`. **순수 함수다** (그래서 테스트가 붙는다).
 *
 * `runs`를 읽지 못했으면 검사 목록을 빈 배열로 둔다. 그러면 판정기가
 * `CHECKS_MISSING`으로 막는다 — '검사를 못 읽었다'와 '검사가 없다'는
 * 둘 다 "통과를 확인하지 못했다"이고, 결과가 같아야 맞다.
 */
export function buildFacts({ pr, runs, statuses, review, contains }) {
  if (!pr || typeof pr !== 'object') throw new Error('buildFacts: pr이 없습니다');
  if (!pr.head?.sha) throw new Error('buildFacts: head.sha가 없습니다');
  const headSha = pr.head.sha;
  return {
    number: pr.number,
    draft: !!pr.draft,
    labels: (pr.labels || []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
    baseRef: pr.base?.ref,
    headSha,
    baseSha: pr.base?.sha,
    headContainsBase: contains,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state || 'unknown',
    checks: (runs?.ok ? (runs.body?.check_runs || []) : []).map(c => ({
      name: c.name, status: c.status, conclusion: c.conclusion, headSha: c.head_sha,
    })),
    statuses: (statuses?.ok ? (statuses.body?.statuses || []) : []).map(s => ({
      context: s.context, state: s.state,
    })),
    unresolvedThreads: review?.unresolvedThreads ?? null,
    changesRequested: review?.changesRequested ?? null,
  };
}

/** 한 PR의 사실을 전부 모은다. 상세 조회 실패면 null. */
export async function gatherFacts({ api, graphql, repo, owner, name, number, log = () => {} }) {
  const detail = await api(`/repos/${repo}/pulls/${number}`);
  if (!detail?.ok) {
    log(`#${number} 상세 조회 실패 HTTP ${detail?.status}`);
    return null;
  }
  const pr = detail.body;
  const headSha = pr.head.sha;
  const [runs, statuses, review, contains] = await Promise.all([
    api(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`),
    api(`/repos/${repo}/commits/${headSha}/status`),
    reviewFacts({ api, graphql, repo, owner, name, number, log }),
    headContainsBase({ api, repo, baseSha: pr.base.sha, headSha, log }),
  ]);
  return buildFacts({ pr, runs, statuses, review, contains });
}
