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
import { listOpenPulls } from './lib/pr-facts.mjs';

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
  const { rebaseVerdict, rebaseComment, rebasePrePushVerdict } = await import(`file://${join(dir, 'autoRebase.js')}`);

  const repoInfo = await api(`/repos/${REPO}`);
  if (!repoInfo.ok) { console.error('저장소 정보를 읽지 못했습니다'); process.exit(1); }
  const DEFAULT_BRANCH = repoInfo.body.default_branch;

  // **재배치가 머지에 필요한지 먼저 묻는다.**
  //
  // base 규칙이 "최신 main 위에 있어야 한다"를 요구하지 않으면, 재배치는
  // 초록인 검사를 버리기만 한다 — 그리고 bot이 만든 push의 런은 잡 0개로
  // 끝나서 필수 체크가 아예 안 생긴다(판정 모듈 주석의 실측). 판단은
  // `autoRebase.ts`에 있고, 여기서는 사실만 읽어 넘긴다.
  //
  // **못 읽으면 null을 넘긴다.** 모르는 것을 "요구하지 않는다"로 바꾸지
  // 않는다 — 그렇게 바꾸면 진짜로 요구하는 저장소에서 PR이 영영 멈춘다.
  const rules = await api(`/repos/${REPO}/rules/branches/${encodeURIComponent(DEFAULT_BRANCH)}`);
  let baseRequiresUpToDate = null;
  if (rules.ok && Array.isArray(rules.body)) {
    const strictRules = rules.body.filter(r => r?.type === 'required_status_checks');
    // 규칙이 여럿이면 **하나라도 요구하면 요구하는 것**이다.
    // 규칙이 하나도 없으면 최신 상태를 요구하는 것이 없다 → false.
    baseRequiresUpToDate = strictRules
      .some(r => r?.parameters?.strict_required_status_checks_policy === true);
    console.log(`${DEFAULT_BRANCH} 규칙: 최신 상태 요구 ${baseRequiresUpToDate ? '있음' : '없음'}`
      + ` (required_status_checks 규칙 ${strictRules.length}개)`);
  } else {
    console.log(`⚠ ${DEFAULT_BRANCH} 보호 규칙을 읽지 못했습니다 (HTTP ${rules.status})`
      + ' — 모르는 채로 재배치 여부를 바꾸지 않습니다');
  }

  // **30분 안전망은 열린 PR 전부를 훑어야 한다.** 예전에는 첫 장(100개)만
  // 훑었다 — 열린 PR이 225개일 때 첫 장 밖의 PR은 main이 움직여도
  // 재배치되지 않고, 왜 안 됐는지 아무 데도 안 남았다. `auto-merge.mjs`와
  // `pr-backlog.mjs`가 같은 자리에서 같이 틀렸다. 목록은 한 함수로 모은다.
  const listed = await listOpenPulls({ api, repo: REPO });
  if (!listed.ok) { console.error('PR 목록을 읽지 못했습니다:', listed.status); process.exit(1); }
  // 다 못 읽었으면 **적어 둔다.** 훑지 못한 PR을 "재배치할 것 없음"으로 읽지 않는다.
  if (!listed.complete) {
    console.log(`⚠ PR 목록을 다 읽지 못했습니다 — ${listed.pages}장까지 ${listed.all.length}개`
      + (listed.failedPage ? ` (${listed.failedPage}장에서 HTTP ${listed.status})` : ' (장 수 상한)')
      + '. 이 회차는 열린 PR 전부를 보지 못했습니다.');
  }

  const only = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null;
  const prs = listed.all.filter(p => only == null || p.number === only);

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
      baseRequiresUpToDate,
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
      baseRequiresUpToDate,
    }, DEFAULT_BRANCH);

    console.log(`#${brief.number} ${v.action} — ${v.reason}`);

    if (v.action === 'REBASE' && newSha) {
      // 목록 조회 후 git rebase를 수행하는 동안 라벨·Draft·base·main이
      // 바뀔 수 있다. force-with-lease는 HEAD 변경만 보호하므로 별도
      // 최신 조회가 필요하다. 실패·불완전한 응답은 모두 push 금지.
      const [freshPr, freshMain] = await Promise.all([
        api(`/repos/${REPO}/pulls/${brief.number}`),
        api(`/repos/${REPO}/branches/${encodeURIComponent(DEFAULT_BRANCH)}`),
      ]);
      const p = freshPr.ok && freshPr.body?.state === 'open'
        && freshPr.body?.merged_at == null
        && typeof freshPr.body?.draft === 'boolean'
        && Array.isArray(freshPr.body?.labels)
        ? freshPr.body : null;
      const latest = p ? {
        number: p.number, draft: p.draft,
        labels: p.labels.map(l => l.name),
        fromFork: p.head?.repo?.full_name !== REPO,
        headRef: p.head?.ref ?? '', headSha: p.head?.sha ?? '',
        baseRef: p.base?.ref ?? '', behindBy, cleanRebase,
      } : null;
      const safety = rebasePrePushVerdict({
        initial: {
          number: brief.number, draft: !!brief.draft, labels, fromFork,
          headRef, headSha, baseRef: brief.base?.ref ?? '', behindBy, cleanRebase,
        },
        latest, expectedBaseSha: baseSha,
        latestBaseSha: freshMain.ok ? (freshMain.body?.commit?.sha ?? null) : null,
        defaultBranch: DEFAULT_BRANCH,
      });
      if (!safety.allow) {
        blocked++;
        console.log(`#${brief.number} 재배치 push 보류 — ${safety.reason}`);
        continue;
      }
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
