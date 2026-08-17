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
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
    tsc, 'src/lib/ci/autoMergeGate.ts', 'src/lib/ci/deployDispatch.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

/**
 * **워크플로 job 이름과 판정기의 자기 이름이 실제로 같은가.**
 *
 * 둘이 어긋나면 조용히 망가진다 — 판정기가 자기 검사를 못 알아보고
 * "아직 도는 검사가 있습니다"로 자기를 기다리다가, 라벨을 붙인 그
 * 실행에서는 영원히 안 합쳐진다. 로그만 보면 정상처럼 보인다.
 *
 * 그래서 여기서 파일을 직접 읽어 확인하고, 다르면 **판정을 시작하지도
 * 않는다.** 조용히 틀리는 쪽이 언제나 더 나쁘다.
 */
function assertSelfCheckWired(selfName) {
  const path = '.github/workflows/auto-merge.yml';
  if (!existsSync(path)) throw new Error(`${path}을 찾지 못했습니다`);
  const yml = readFileSync(path, 'utf8');
  // `jobs:` 아래만 본다 — `on:` 아래 트리거 이름도 같은 들여쓰기라서
  // 통째로 훑으면 트리거를 job으로 착각한다.
  const at = yml.search(/^jobs:$/m);
  if (at < 0) throw new Error(`${path}에 jobs: 블록이 없습니다`);
  const jobs = [...yml.slice(at).matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map(m => m[1]);
  if (!jobs.includes(selfName)) {
    throw new Error(
      `워크플로 job 이름이 판정기의 SELF_CHECK_NAME('${selfName}')과 다릅니다. `
      + `찾은 job: ${jobs.join(', ') || '(없음)'} — `
      + '이대로 두면 판정기가 자기 검사를 기다리다 영원히 안 합칩니다.');
  }
}

/**
 * **필수 검사 이름이 실제 워크플로의 job 이름과 같은가.**
 *
 * `REQUIRED_CHECKS`에 오타가 있으면 그 이름의 검사는 영원히 '없음'이
 * 되어 **모든 PR이 REQUIRED_CHECK_MISSING으로 막힌다.** 반대로 워크플로
 * job 이름만 바꾸면 같은 일이 난다.
 *
 * 막히는 쪽이라 위험하지는 않지만, 원인이 안 보이면 사람이 게이트를
 * 꺼 버린다. 그래서 시작할 때 파일로 확인하고 다르면 이름을 대 준다.
 */
function assertRequiredChecksWired(required) {
  const names = Array.isArray(required) ? required : [];
  if (names.length === 0) {
    throw new Error('REQUIRED_CHECKS가 비어 있습니다 — 검사 없이 합쳐질 수 있습니다');
  }
  const path = '.github/workflows/ci.yml';
  if (!existsSync(path)) throw new Error(`${path}을 찾지 못했습니다`);
  const yml = readFileSync(path, 'utf8');
  const at = yml.search(/^jobs:$/m);
  if (at < 0) throw new Error(`${path}에 jobs: 블록이 없습니다`);
  const jobs = [...yml.slice(at).matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map(m => m[1]);
  const missing = names.filter(n => !jobs.includes(n));
  if (missing.length > 0) {
    throw new Error(
      `필수 검사 이름이 ${path}의 job에 없습니다: ${missing.join(', ')} — `
      + `찾은 job: ${jobs.join(', ') || '(없음)'}. `
      + '이대로 두면 모든 PR이 REQUIRED_CHECK_MISSING으로 막힙니다');
  }
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

/**
 * head가 base tip을 조상으로 갖는가. **못 읽으면 null**
 *
 * 2026-08-17에 이 확인이 **네 번 연속 실패**했다. #139는 검사가 전부
 * 초록이고 로컬에서 `a919bd5 → 67bb099`가 ahead임이 확인되는데도
 * `MERGEABILITY_UNKNOWN`으로 계속 막혔다. 그 사이 로그에 남은 것은
 * "확인하지 못했습니다" 한 줄뿐이라 **왜 실패했는지 알 방법이 없었다.**
 *
 * 그래서 둘을 더한다:
 *   · 한 번 실패했다고 포기하지 않는다 — 짧게 재시도한다
 *   · 실패하면 **HTTP 상태와 응답 요약을 로그에 남긴다**
 *
 * **판정 규칙은 그대로다.** 모르면 여전히 null이고, null이면 합치지
 * 않는다. 확인하지 못한 것을 통과로 바꾸는 것이 아니라, 확인을 실제로
 * 할 수 있게 만들고 못 했을 때 이유가 보이게 하는 것이다.
 */
async function headContainsBase(baseSha, headSha) {
  const path = `/repos/${REPO}/compare/${baseSha}...${headSha}`;
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await api(path);
    last = r;
    if (r.ok) {
      const s = r.body?.status;
      // 'ahead' | 'identical' 이면 head가 base를 포함한다.
      // 'behind' | 'diverged' 이면 아니다.
      if (s === 'ahead' || s === 'identical') return true;
      if (s === 'behind' || s === 'diverged') return false;
      console.log(`compare 응답에 status가 없습니다 (${JSON.stringify(s)}) — ${path}`);
      return null;
    }
    if (attempt < 3) await new Promise(res => setTimeout(res, attempt * 1000));
  }
  // **왜 못 읽었는지 남긴다.** 이 한 줄이 없어서 네 번을 헤맸다.
  console.log(`compare 실패 HTTP ${last?.status} — ${path}`
    + (last?.body?.message ? ` :: ${String(last.body.message).slice(0, 200)}` : ''));
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
  const outDir = loadGate();
  const { autoMergeGate, gateComment, AUTO_MERGE_LABEL, SELF_CHECK_NAME, REQUIRED_CHECKS } =
    await import(`file://${join(outDir, 'autoMergeGate.js')}`);
  const { deployDispatchPlan, deployDispatchRequest, dispatchResultNote } =
    await import(`file://${join(outDir, 'deployDispatch.js')}`);

  assertSelfCheckWired(SELF_CHECK_NAME);
  assertRequiredChecksWired(REQUIRED_CHECKS);

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

  // ── 합쳤으면 **배포까지 부른다** ──
  //
  // 여기가 없어서 #128·#129가 main에만 있고 Fly에는 없었다.
  // `secrets.GITHUB_TOKEN`으로 만든 push는 워크플로를 발동시키지 않으므로
  // main에서는 ci도 fly-deploy도 안 돈다. 그래서 fly-deploy의
  // `workflow_run` 가드가 받을 "main의 ci"는 애초에 존재하지 않았고,
  // 실제로 도착한 PR 브랜치 ci는 전부 skipped 처리됐다 —
  // **로그에는 실행이 남아서 배포가 도는 것처럼 보였다.**
  //
  // `workflow_dispatch`는 그 재귀 방지의 명시적 예외라 GITHUB_TOKEN으로도
  // 새 실행이 만들어진다. 머지가 끝난 뒤에 부르므로 checkout이 잡는
  // main은 반드시 합쳐진 코드다.
  const dp = deployDispatchPlan({ merged, hasToken: !!TOKEN });
  console.log(`배포: ${dp.code} — ${dp.reason}`);
  if (dp.dispatch) {
    const req = deployDispatchRequest(REPO);
    const r = await api(req.path, { method: req.method, body: req.body });
    console.log(dispatchResultNote({ ok: r.ok, status: r.status, message: r.body?.message ?? null }));
  }

  console.log(`끝 — ${merged}건 합침`);
}

main().catch(e => { console.error(e?.message || e); process.exit(1); });
