#!/usr/bin/env node
// scripts/pr-backlog.mjs
//
// **열린 PR이 왜 안 올라가는지 하나씩 열어 보지 않아도 알게 한다.**
//
// 무엇이 문제였나
// ───────────────
// `auto-merge`는 라벨 하나를 스위치로 쓴다. 그게 맞다 — 라벨 없는 PR이
// 실주문 코드를 main에 꽂으면 안 된다. 그런데 **그래서 열린 PR 전부의
// 판정이 `NO_LABEL` 하나로 수렴한다.** 2026-11-05 기준 열린 PR 100개가
// 전부 초안이고 라벨이 0개라서, 머지 게이트에 물어보면 100개가 똑같이
// "라벨이 없습니다"라고만 답한다.
//
// 그래서 그중 무엇이 충돌 났고, 무엇이 검사가 빨갛고, 무엇이 지금
// 올려도 되는지는 **사람이 100개를 하나씩 열어 봐야** 알 수 있었다.
// `CLAUDE.md`가 없애라고 한 바로 그 수동 절차다.
//
// 이 스크립트가 하는 일
// ─────────────────────
// 열린 PR 전부에 **같은 판정기**를 돌리고(`autoMergeTechnicalGate` —
// 스위치만 뺀 판정), 막는 이유별로 묶어서 적는다. 그리고 지금 올려도
// 되는 것들 사이의 **파일 겹침**을 보고 순서 의존을 표시한다.
//
// **아무것도 바꾸지 않는다**
// ──────────────────────────
// 읽기만 한다. 합치지도, 라벨을 붙이지도, 초안을 해제하지도 않는다 —
// 그 셋은 사람의 결정이다. 이 스크립트는 그 결정에 필요한 사실만 모은다.
// `scripts/check-auto-merge-switches.mjs`가 이 파일에 쓰기 호출이
// 생기지 않았는지 검사한다.
//
// 쓰는 법
// ───────
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=o/r node scripts/pr-backlog.mjs
//   ... --limit 20        처음 20개만
//   ... --pr 577          한 개만
//   ... --json            기계가 읽을 형태로
//
// 토큰은 **읽기 권한만 있으면 된다.**

import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherFacts, listOpenPulls } from './lib/pr-facts.mjs';

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
if (!TOKEN || !REPO) {
  console.error('GITHUB_TOKEN / GITHUB_REPOSITORY 가 없습니다');
  process.exit(1);
}
const [OWNER, NAME] = REPO.split('/');

function parseArgs(argv) {
  const out = { limit: null, pr: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--limit') { out.limit = Number(argv[++i]); continue; }
    if (a === '--pr') { out.pr = Number(argv[++i]); continue; }
    console.error(`모르는 인자입니다: ${a}`);
    process.exit(2);
  }
  if (out.limit != null && !Number.isInteger(out.limit)) {
    console.error('--limit 은 정수여야 합니다'); process.exit(2);
  }
  if (out.pr != null && !Number.isInteger(out.pr)) {
    console.error('--pr 은 정수여야 합니다'); process.exit(2);
  }
  return out;
}

/** 판정기를 컴파일해서 쓴다 — **사본을 만들지 않는다** */
function loadGate() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-backlog-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ci/autoMergeGate.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

/**
 * **읽기 전용 API.** method를 받지 않는다.
 *
 * 인자로 method를 받게 두면 언젠가 누가 `method: 'PUT'`을 넘기고, 그때
 * 이 스크립트는 더 이상 보고기가 아니다. 모양 자체로 막는다.
 */
async function api(path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: r.ok, status: r.status, body };
}

/** 막는 이유를 사람이 읽을 묶음으로 */
export const BUCKETS = [
  { key: 'READY',    title: '지금 올려도 되는 것', codes: ['OK'] },
  { key: 'CONFLICT', title: '충돌 — 먼저 풀어야 함', codes: ['CONFLICT'] },
  { key: 'BEHIND',   title: 'base 뒤처짐 — main을 넣고 검사를 다시 돌려야 함', codes: ['BEHIND_BASE'] },
  { key: 'CHECKS',   title: '검사가 빨갛거나 안 돌았음', codes: ['CHECKS_FAILED', 'CHECKS_PENDING', 'CHECKS_MISSING', 'REQUIRED_CHECK_MISSING', 'CHECKS_STALE'] },
  { key: 'REVIEW',   title: '리뷰가 남았음', codes: ['CHANGES_REQUESTED', 'REVIEW_UNRESOLVED'] },
  { key: 'STACKED',  title: 'base가 main이 아님 (앞 PR이 먼저)', codes: ['STACKED'] },
  { key: 'UNKNOWN',  title: '읽지 못했음 — **통과가 아니다**', codes: ['MERGEABILITY_UNKNOWN', 'REVIEW_UNKNOWN'] },
];

export function bucketOf(code) {
  for (const b of BUCKETS) if (b.codes.includes(code)) return b.key;
  return 'UNKNOWN';
}

/**
 * 올려도 되는 것들 사이의 **파일 겹침**.
 *
 * 왜 필요한가: 둘 다 "지금 올려도 됨"이어도 같은 파일을 고쳤으면 하나가
 * 들어간 순간 다른 하나는 `BEHIND_BASE`나 `CONFLICT`가 된다. 그걸 모르고
 * 순서를 정하면 두 번째부터 전부 막히고, 사람은 보고서가 틀렸다고 읽는다.
 */
export function overlapGroups(entries) {
  const groups = [];
  for (const e of entries) {
    const hit = groups.find(g => g.some(o =>
      o.files.some(f => e.files.includes(f))));
    if (hit) hit.push(e); else groups.push([e]);
  }
  return groups;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = loadGate();
  const { autoMergeTechnicalGate, AUTO_MERGE_LABEL } =
    await import(`file://${join(outDir, 'autoMergeGate.js')}`);

  // **장을 넘겨 전부 읽는다.** 예전에는 첫 장(100개)만 읽고 그것이
  // 전부인 양 적었다 — 열린 PR이 225개일 때 125개가 조용히 빠졌다.
  const listed = await listOpenPulls({ api, repo: REPO });
  if (!listed.ok) {
    console.error(`PR 목록을 읽지 못했습니다: HTTP ${listed.status}`);
    process.exit(1);
  }
  const totalOpen = listed.all.length;
  let briefs = listed.all;
  if (args.pr != null) briefs = briefs.filter(p => p.number === args.pr);
  if (args.limit != null) briefs = briefs.slice(0, args.limit);
  const truncated = briefs.length < totalOpen;

  const rows = [];
  const unread = [];
  for (const brief of briefs) {
    const facts = await gatherFacts({
      api, graphql: null, repo: REPO, owner: OWNER, name: NAME,
      number: brief.number, log: () => {},
    });
    if (!facts) { unread.push(brief.number); continue; }
    const v = autoMergeTechnicalGate(facts);
    rows.push({
      number: facts.number,
      title: String(brief.title ?? '').slice(0, 70),
      head: String(facts.headSha).slice(0, 8),
      branch: brief.head?.ref ?? '?',
      draft: facts.draft,
      labeled: (facts.labels || []).includes(AUTO_MERGE_LABEL),
      code: v.code,
      reason: v.reason,
      bucket: bucketOf(v.code),
      createdAt: brief.created_at,
    });
    if (!args.json) process.stderr.write('.');
  }
  if (!args.json) process.stderr.write('\n');

  // 올려도 되는 것만 파일을 더 읽는다 — 레이트리밋을 아낀다
  const ready = rows.filter(r => r.bucket === 'READY');
  for (const r of ready) {
    const f = await api(`/repos/${REPO}/pulls/${r.number}/files?per_page=100`);
    // **못 읽으면 null이다.** 빈 배열로 두면 "아무 파일도 안 겹친다"가 된다
    r.files = f.ok && Array.isArray(f.body) ? f.body.map(x => x.filename) : null;
  }
  const filesKnown = ready.filter(r => Array.isArray(r.files));
  const filesUnknown = ready.filter(r => !Array.isArray(r.files));
  const groups = overlapGroups(filesKnown);

  if (args.json) {
    console.log(JSON.stringify({ repo: REPO, rows, unread,
      overlapGroups: groups.map(g => g.map(e => e.number)),
      filesUnreadable: filesUnknown.map(e => e.number) }, null, 2));
    return;
  }

  console.log(`\n# 열린 PR 적체 보고 — ${REPO}`);
  console.log(`\n읽은 PR ${rows.length}개` + (unread.length ? ` · **읽지 못한 PR ${unread.length}개: ${unread.join(', ')}**` : ''));
  // **못 본 것을 "없음"으로 적지 않는다.** 목록이 잘렸거나 --limit 으로
  // 줄였으면 그 사실을 여기 적는다. 안 적으면 보는 사람이 이 보고서를
  // 적체 전부로 믿는다.
  if (!listed.complete) {
    console.log(`\n> ⚠ **PR 목록을 다 읽지 못했습니다** — ${listed.pages}장까지 읽어 ${totalOpen}개를 모았습니다`
      + (listed.failedPage ? ` (${listed.failedPage}장에서 HTTP ${listed.status})` : ' (장 수 상한에 닿았습니다)')
      + '. 아래는 **적체 전부가 아닙니다.**');
  }
  if (truncated) {
    console.log(`\n> ⚠ 열린 PR ${totalOpen}개 중 **${briefs.length}개만** 판정했습니다`
      + (args.pr != null ? ' (`--pr`)' : ' (`--limit`)')
      + '. 나머지는 보지 않았습니다.');
  }
  console.log(`초안 ${rows.filter(r => r.draft).length}개 · \`${AUTO_MERGE_LABEL}\` 라벨 ${rows.filter(r => r.labeled).length}개`);
  console.log('\n판정은 `src/lib/ci/autoMergeGate.ts`의 `autoMergeTechnicalGate`가 한 것입니다 —');
  console.log('라벨·초안 스위치만 뺀 **같은 판정기**입니다. 이 보고서는 아무것도 바꾸지 않았습니다.');

  for (const b of BUCKETS) {
    const mine = rows.filter(r => r.bucket === b.key);
    if (!mine.length) continue;
    console.log(`\n## ${b.title} — ${mine.length}개\n`);
    for (const r of mine.sort((x, y) => x.number - y.number)) {
      console.log(`- **#${r.number}** \`${r.head}\` ${r.title}`);
      if (b.key !== 'READY') console.log(`  - ${r.code}: ${r.reason}`);
    }
  }

  if (groups.length) {
    console.log('\n## 올리는 순서\n');
    console.log('같은 파일을 고친 PR은 한 줄에 묶었습니다 — 묶음 안에서는 **앞에서부터 하나씩**');
    console.log('올리고, 하나가 들어가면 뒤의 것은 main을 다시 넣어 검사를 돌려야 합니다.');
    console.log('묶음끼리는 서로 겹치지 않으니 순서를 바꿔도 됩니다.\n');
    groups.forEach((g, i) => {
      console.log(`${i + 1}. ${g.map(e => `#${e.number}`).join(' → ')}`
        + (g.length > 1 ? `  (겹치는 파일 있음)` : ''));
    });
  }
  if (filesUnknown.length) {
    console.log(`\n⚠️ 파일 목록을 읽지 못한 PR: ${filesUnknown.map(e => `#${e.number}`).join(', ')}`);
    console.log('   — 겹침을 **확인하지 못했습니다.** 순서에서 빼 두었습니다.');
  }

  console.log('\n---\n');
  console.log('합치려면 사람이 `auto-merge` 라벨을 붙이고 초안을 해제해야 합니다.');
  console.log('이 스크립트에는 그 경로가 없습니다.');
}

main().catch(e => { console.error(e?.message || e); process.exit(1); });
