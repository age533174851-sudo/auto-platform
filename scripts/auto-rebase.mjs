// scripts/auto-rebase.mjs
//
// **main이 움직일 때마다 사람이 재배치를 눌러 주는 구조를 없앤다.**
//
// `auto-merge` 라벨이 붙은 PR이 여럿 열려 있으면, 하나가 합쳐질 때마다
// 나머지 전부가 옛 main 위에 남는다. 파일이 겹치는 것은 곧바로 충돌
// 상태가 되고, 그때부터 자동 머지 판정은 영원히 "병합 충돌이 있습니다"만
// 적는다. 라벨은 붙어 있고, 검사도 초록이고, 아무 일도 안 일어난다.
//
// 판단은 여기서 하지 않는다 — `src/lib/ci/autoRebase.ts`가 한다.
// 이 파일이 하는 일은 셋뿐이다:
//   1. GitHub에서 사실을 모으고, 실제로 재배치를 시도해 본다
//   2. 그 사실을 판정기에 넘긴다
//   3. 판정이 REBASE면 force-with-lease로 올리고, 아니면 이유를 적는다
//
// 여기에 없는 것
// ──────────────
// **충돌을 기계가 해소하는 분기가 없다.** 옵션으로도 두지 않았다.
// 충돌은 두 변경이 같은 자리를 다르게 바꿨다는 뜻이고, 실제로 이
// 저장소에서 그렇게 합쳤으면 **타입은 통과하는데 지갑 판정만 죽는**
// 상태가 됐을 것이다. 검사도 초록이었을 것이다.
//
// **검사를 건너뛰는 경로도 없다.** 재배치는 새 커밋을 만들고 CI가
// 처음부터 다시 돈다. 합치는 것은 auto-merge가 따로 판정한다.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
if (!TOKEN || !REPO) {
  console.error('GITHUB_TOKEN / GITHUB_REPOSITORY 가 없습니다');
  process.exit(1);
}
const [OWNER, NAME] = REPO.split('/');

/**
 * 판정기를 컴파일해서 불러온다.
 *
 * **사본을 만들지 않는다.** 사본이 있으면 한쪽만 고쳐지고, 그때 CI는
 * 초록인데 실제 판정은 옛 규칙으로 돈다.
 */
function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-rebase-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ci/autoRebase.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
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

/** git. **출력에 토큰이 섞이지 않게** 원격 URL은 인자로만 넘긴다 */
function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  }).trim();
}
function gitTry(args, opts = {}) {
  try { git(args, opts); return true; } catch { return false; }
}

/**
 * 이미 같은 말을 적어 뒀으면 또 적지 않는다.
 *
 * 재배치 실패는 main이 움직일 때마다 다시 판정된다. 매번 적으면 충돌
 * 하나에 댓글이 수십 개 쌓이고, 그러면 진짜 신호가 묻힌다.
 */
async function upsertComment(number, body) {
  const MARK = '<!-- traigo-auto-rebase -->';
  const listed = await api(`/repos/${REPO}/issues/${number}/comments?per_page=100`);
  const mine = (listed.ok ? listed.body : []).find(c => String(c.body || '').includes(MARK));
  if (mine) {
    if (String(mine.body).trim() === body.trim()) return;   // 같은 말이다
    await api(`/repos/${REPO}/issues/comments/${mine.id}`, {
      method: 'PATCH', body: JSON.stringify({ body }),
    });
    return;
  }
  await api(`/repos/${REPO}/issues/${number}/comments`, {
    method: 'POST', body: JSON.stringify({ body }),
  });
}

async function main() {
  const dir = loadJudge();
  const { rebaseVerdict, rebaseComment } = await import(`file://${join(dir, 'autoRebase.js')}`);

  const repoInfo = await api(`/repos/${REPO}`);
  if (!repoInfo.ok) { console.error('저장소 정보를 읽지 못했습니다'); process.exit(1); }
  const DEFAULT_BRANCH = repoInfo.body.default_branch;

  const listed = await api(`/repos/${REPO}/pulls?state=open&per_page=100`);
  if (!listed.ok) { console.error('PR 목록을 읽지 못했습니다:', listed.status); process.exit(1); }

  const only = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null;
  const prs = listed.body.filter(p => only == null || p.number === only);

  // 원격 URL. **토큰이 로그에 남지 않게** 이 문자열은 절대 출력하지 않는다.
  const remote = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;

  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  git(['fetch', remote, DEFAULT_BRANCH]);
  const baseSha = git(['rev-parse', 'FETCH_HEAD']);

  let rebased = 0, blocked = 0;

  for (const brief of prs) {
    const labels = (brief.labels || []).map(l => l.name);
    const fromFork = brief.head?.repo?.full_name !== REPO;

    // 라벨이 없으면 네트워크를 더 쓰지 않는다.
    let pre = rebaseVerdict({
      number: brief.number, draft: !!brief.draft, labels, fromFork,
      headRef: brief.head?.ref ?? '', headSha: brief.head?.sha ?? '',
      baseRef: brief.base?.ref ?? '', behindBy: null, cleanRebase: null,
    }, DEFAULT_BRANCH);
    if (pre.action === 'SKIP' && !pre.reason.includes('재배치를 시도해')
      && !pre.reason.includes('뒤처졌는지')) {
      console.log(`#${brief.number} 건너뜀 — ${pre.reason}`);
      continue;
    }

    const headRef = brief.head.ref;
    const headSha = brief.head.sha;

    // 이 브랜치를 가져온다.
    if (!gitTry(['fetch', remote, `${headRef}:refs/traigo/${headRef}`, '--force'])) {
      console.log(`#${brief.number} 브랜치를 가져오지 못했습니다 — 건너뜁니다`);
      continue;
    }

    // **얼마나 뒤처졌는가.** 못 세면 null로 두고 판정기가 막는다.
    let behindBy = null;
    try {
      behindBy = Number(git(['rev-list', '--count', `refs/traigo/${headRef}..${baseSha}`]));
      if (!Number.isFinite(behindBy)) behindBy = null;
    } catch { behindBy = null; }

    let cleanRebase = null;
    let newSha = null;
    if (behindBy != null && behindBy > 0) {
      // **실제로 해 본다.** "충돌할 것 같다"는 추측으로 판정하지 않는다.
      gitTry(['rebase', '--abort']);
      git(['checkout', '--detach', `refs/traigo/${headRef}`]);
      if (gitTry(['rebase', baseSha])) {
        cleanRebase = true;
        newSha = git(['rev-parse', 'HEAD']);
      } else {
        cleanRebase = false;
        gitTry(['rebase', '--abort']);
      }
      git(['checkout', '--detach', baseSha]);
    }

    const v = rebaseVerdict({
      number: brief.number, draft: !!brief.draft, labels, fromFork,
      headRef, headSha, baseRef: brief.base?.ref ?? '', behindBy, cleanRebase,
    }, DEFAULT_BRANCH);

    console.log(`#${brief.number} ${v.action} — ${v.reason}`);

    if (v.action === 'REBASE' && newSha) {
      // **force-with-lease.** 판정하는 사이에 누가 새 커밋을 올렸으면
      // 그것을 지우지 않고 실패한다 — 다음 회차에 다시 판정한다.
      const pushed = gitTry(['push', remote,
        `${newSha}:refs/heads/${headRef}`, `--force-with-lease=refs/heads/${headRef}:${headSha}`]);
      if (!pushed) {
        console.log(`#${brief.number} 올리지 못했습니다 — 그 사이 새 커밋이 있었을 수 있습니다`);
        continue;
      }
      rebased++;
      const c = rebaseComment({ action: v.action, reason: v.reason, defaultBranch: DEFAULT_BRANCH, newSha });
      if (c) await upsertComment(brief.number, c);
    } else if (v.action === 'NEEDS_HUMAN') {
      blocked++;
      const c = rebaseComment({ action: v.action, reason: v.reason, defaultBranch: DEFAULT_BRANCH });
      if (c) await upsertComment(brief.number, c);
    }
  }

  console.log(`자동 재배치: ${rebased}건 · 사람이 봐야 하는 것 ${blocked}건`);
}

main().catch(e => {
  // **값은 로그에 찍지 않는다.** 메시지에 원격 URL이 섞일 수 있으므로 지운다.
  const msg = String(e?.message || e).replace(/https:\/\/[^@\s]*@/g, 'https://***@');
  console.error('자동 재배치 실패:', msg);
  process.exit(1);
});
