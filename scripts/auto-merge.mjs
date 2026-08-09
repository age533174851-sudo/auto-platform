// scripts/auto-merge.mjs
//
// **라벨이 붙고 모든 검사가 통과한 PR만 합친다.**
//
// 판단은 여기서 하지 않는다 — `src/lib/ci/autoMergeGate.ts`가 한다.
// 이 파일이 하는 일은 셋뿐이다:
//   1. GitHub에서 사실을 모은다
//   2. 그 사실을 판정기에 넘긴다
//   3. 판정이 merge면 squash로 합치고, 아니면 이유를 PR에 적는다
//
// 왜 판단을 여기 안 두는가
// ────────────────────────
// 이 스크립트는 GitHub Actions 안에서만 돈다. 여기에 조건을 적으면
// **값으로 확인할 방법이 없다** — 실주문 코드를 main에 넣는 판단인데.
// 판정기는 유닛 테스트가 붙어 있고, 그 테스트가 CI에서 매번 돈다.
//
// 강제 머지 경로는 없다
// ─────────────────────
// 이 파일 어디에도 검사를 건너뛰는 분기가 없다. 옵션으로도 두지 않았다.
// 옵션은 언젠가 켜지고, 그때 켜는 사람은 왜 그것이 있는지 모른다.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;   // owner/repo
if (!TOKEN || !REPO) {
  console.error('GITHUB_TOKEN / GITHUB_REPOSITORY 가 없습니다');
  process.exit(1);
}
const [OWNER, NAME] = REPO.split('/');

// ── 판정기를 컴파일해서 불러온다 ──
//
// 판정기는 TypeScript이고 이 스크립트는 node로 돈다. 저장소의 테스트
// 러너가 쓰는 것과 같은 방식으로 tsc에 통과시켜 쓴다 — **사본을 만들지
// 않는다.** 사본이 있으면 한쪽만 고쳐지고, 그때 CI는 초록인데 실제
// 머지 판정은 옛 규칙으로 돈다.
function loadGate() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-gate-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ci/autoMergeGate.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return join(dir, 'autoMergeGate.js');
}

async function api(path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: r.ok, status: r.status, body };
}

async function graphql(query, variables) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => null);
  return { ok: r.ok && !j?.errors, body: j };
}

/**
 * 리뷰 상태. **못 읽으면 null이다** — 0으로 두면 미해결 리뷰를 무시하고 합친다.
 */
async function reviewFacts(number) {
  const q = `query($o:String!,$n:String!,$p:Int!){
    repository(owner:$o,name:$n){ pullRequest(number:$p){
      reviewThreads(first:100){ nodes { isResolved isOutdated } }
      reviews(first:100, states:CHANGES_REQUESTED){ totalCount }
    }}}`;
  const r = await graphql(q, { o: OWNER, n: NAME, p: number });
  if (!r.ok) return { unresolvedThreads: null, changesRequested: null };
  const pr = r.body?.data?.repository?.pullRequest;
  const nodes = pr?.reviewThreads?.nodes;
  if (!Array.isArray(nodes) || pr?.reviews?.totalCount == null) {
    return { unresolvedThreads: null, changesRequested: null };
  }
  return {
    // outdated된 스레드는 이미 그 코드가 사라진 것이라 세지 않는다.
    unresolvedThreads: nodes.filter(t => !t.isResolved && !t.isOutdated).length,
    changesRequested: pr.reviews.totalCount,
  };
}

/** head가 base tip을 조상으로 갖는가. **못 읽으면 null** */
async function headContainsBase(baseSha, headSha) {
  const r = await api(`/repos/${REPO}/compare/${baseSha}...${headSha}`);
  if (!r.ok) return null;
  const s = r.body?.status;
  // 'ahead' | 'identical' 이면 head가 base를 포함한다.
  // 'behind' | 'diverged' 이면 아니다.
  if (s === 'ahead' || s === 'identical') return true;
  if (s === 'behind' || s === 'diverged') return false;
  return null;
}

/** 이 판정 코멘트는 하나만 유지한다 — 매번 새로 달면 PR이 잡음으로 덮인다 */
async function upsertComment(number, body) {
  const list = await api(`/repos/${REPO}/issues/${number}/comments?per_page=100`);
  const mine = (list.ok && Array.isArray(list.body) ? list.body : [])
    .find(c => String(c.body || '').includes('<!-- traigo-auto-merge -->'));
  if (mine) {
    await api(`/repos/${REPO}/issues/comments/${mine.id}`,
      { method: 'PATCH', body: JSON.stringify({ body }) });
  } else {
    await api(`/repos/${REPO}/issues/${number}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) });
  }
}

async function main() {
  const gatePath = loadGate();
  const { autoMergeGate, gateComment, AUTO_MERGE_LABEL } = await import(`file://${gatePath}`);

  const only = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null;

  const listed = await api(`/repos/${REPO}/pulls?state=open&per_page=100`);
  if (!listed.ok) {
    console.error('PR 목록을 읽지 못했습니다:', listed.status);
    process.exit(1);
  }
  const prs = listed.body.filter(p => (only == null || p.number === only));

  let merged = 0;
  for (const brief of prs) {
    // 라벨이 없으면 API를 더 부르지 않는다 — 레이트리밋을 아낀다.
    const labels = (brief.labels || []).map(l => l.name);
    if (!labels.includes(AUTO_MERGE_LABEL)) {
      console.log(`#${brief.number} 건너뜀 — 라벨 없음`);
      continue;
    }

    // mergeable은 상세 조회에서만 채워진다. 계산 중이면 null이 온다.
    const detail = await api(`/repos/${REPO}/pulls/${brief.number}`);
    if (!detail.ok) { console.log(`#${brief.number} 상세 조회 실패`); continue; }
    const pr = detail.body;
    const headSha = pr.head.sha;

    const [runs, statuses, review, contains] = await Promise.all([
      api(`/repos/${REPO}/commits/${headSha}/check-runs?per_page=100`),
      api(`/repos/${REPO}/commits/${headSha}/status`),
      reviewFacts(pr.number),
      headContainsBase(pr.base.sha, headSha),
    ]);

    const facts = {
      number: pr.number,
      draft: !!pr.draft,
      labels: (pr.labels || []).map(l => l.name),
      baseRef: pr.base.ref,
      headSha,
      baseSha: pr.base.sha,
      headContainsBase: contains,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state || 'unknown',
      checks: (runs.ok ? (runs.body.check_runs || []) : []).map(c => ({
        name: c.name, status: c.status, conclusion: c.conclusion, headSha: c.head_sha,
      })),
      statuses: (statuses.ok ? (statuses.body.statuses || []) : []).map(s => ({
        context: s.context, state: s.state,
      })),
      unresolvedThreads: review.unresolvedThreads,
      changesRequested: review.changesRequested,
    };

    // 검사 목록을 못 읽었으면 **빈 배열로 두지 않는다** — 그러면
    // '검사가 없다'가 되어 CHECKS_MISSING으로 막힌다. 그게 맞는 결과다.
    if (!runs.ok) facts.checks = [];

    const v = autoMergeGate(facts);
    console.log(`#${pr.number} ${v.merge ? 'MERGE' : v.code} — ${v.reason}`);
    await upsertComment(pr.number, gateComment({ number: pr.number, headSha }, v));

    if (!v.merge) continue;

    const r = await api(`/repos/${REPO}/pulls/${pr.number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        merge_method: 'squash',
        // **이 SHA일 때만 합친다.** 판정과 머지 사이에 새 커밋이 들어오면
        // GitHub이 409로 거절한다 — 검사 안 된 코드가 들어가는 것을 막는다.
        sha: headSha,
      }),
    });
    if (r.ok) {
      merged++;
      console.log(`#${pr.number} 합쳤습니다`);
      await upsertComment(pr.number,
        `<!-- traigo-auto-merge -->\n✅ **자동 머지 완료** · \`${headSha.slice(0, 7)}\` (squash)`);
    } else {
      const why = r.body?.message || `HTTP ${r.status}`;
      console.log(`#${pr.number} 머지 실패: ${why}`);
      await upsertComment(pr.number,
        `<!-- traigo-auto-merge -->\n❌ **자동 머지가 거절됐습니다** · \`${headSha.slice(0, 7)}\`\n\n`
        + `${why}\n\n조건을 다시 확인한 뒤 다음 신호에서 재시도합니다. 강제로 합치지 않습니다.`);
    }
  }

  console.log(`끝 — ${merged}건 합침`);
}

main().catch(e => { console.error(e?.message || e); process.exit(1); });
