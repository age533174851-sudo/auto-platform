#!/usr/bin/env node
// scripts/check-get-writes.mjs
//
// **읽기 요청이 조용히 쓰기를 하고 있었다.**
//
// `/api/wallets/overview`는 GET인데 `account_equity_snapshots`에 INSERT를
// 했다. 붙어 있던 주석은 정직했다 — "읽기 요청이 쓰기를 하는 것이
// 어색하지만, 표를 채우는 다른 경로가 없는 상태를 더 두는 것이 나쁘다."
// 그 임시 조치가 실제로 만든 것은 세 가지 고장이었다:
//
//   1. **사람이 안 보면 기록이 안 남는다.** 자동매매는 24시간 도는데
//      자산 곡선은 사람이 앱을 여는 시간에만 남았다
//   2. **탭을 두 개 열면 두 번 찍힌다.** "마지막에서 15분" 판정은
//      동시 요청 둘을 다 통과시킨다
//   3. 브라우저의 프리페치·재시도가 그대로 쓰기가 된다
//
// 그래서 이 검사를 둔다. **새로 생기는 "GET이 쓰는" 경로를 CI가 막는다.**
// 이미 그렇게 도는 것들은 아래에 이유와 함께 적어 둔다 — 목록에 없는
// 것이 새로 생기면 실패한다.
//
// 지우는 검사가 아니라 **늘어나는 것을 막는 검사**다.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = 'src/app/api';
const WRITES = ['.insert(', '.upsert(', '.delete(', '.update('];

// ── 이미 GET으로 쓰는 경로 ──
//
// 전부 **스케줄러가 GET으로 깨우는** 것들이다(Vercel Cron·GitHub Actions는
// GET으로 부른다). 사람이 화면을 여는 경로가 아니므로 위의 세 고장이
// 생기지 않는다. 새로 추가할 때는 **왜 GET이어야 하는지**를 여기 적는다.
const ALLOW = {
  'src/app/api/auth/me/route.ts':
    '로그인 직후 프로필 행을 만든다 — 없으면 그 사용자는 아무것도 못 한다. 멱등 upsert다',
  'src/app/api/cron/calendar-sync/route.ts':
    'Vercel Cron이 GET으로 깨운다 — 사람이 여는 화면이 아니다',
  'src/app/api/cron/cleanup/route.ts':
    'Vercel Cron이 GET으로 깨운다 — 사람이 여는 화면이 아니다',
  'src/app/api/cron/ai-scoring/route.ts':
    'Vercel Cron이 GET으로 깨운다 — 사람이 여는 화면이 아니다',
  'src/app/api/autotrade/my-original-v1/route.ts':
    '스케줄러가 GET으로 평가를 깨운다. 기록은 평가 결과이고 멱등 키가 붙는다',
  'src/app/api/autotrade/scheduled-exit/route.ts':
    '스케줄러가 GET으로 깨운다 — 청산은 늦추면 안 된다',
  'src/app/api/autotrade/exit-monitor/route.ts':
    '워커가 GET으로 깨운다. **닫는 쪽이라 막지 않는다** — 못 여는 것은 불편이고 못 닫는 것은 사고다',
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}

/**
 * GET 핸들러 본문만 잘라낸다. POST가 쓰는 것은 정상이다.
 *
 * **쓰는 법을 바꾸면 비켜 가던 것**
 * ─────────────────────────────────
 * 예전에는 \`export async function GET(\` 하나만 찾았다. Next는
 * \`export const GET = async () => {}\` 꼴도 똑같이 받아 주는데, 그 꼴로
 * 쓴 라우트는 여기서 \`null\`이 되어 **검사 대상에서 통째로 빠졌다** —
 * 계수에도 안 들어갔다.
 *
 * 실측했다. 그 꼴로 \`.insert(\`를 넣은 라우트를 두고 돌려도
 * "GET 라우트 132개 · 새로 쓰는 것 0개"가 찍히고 종료코드는 0이었다.
 * 막으려고 만든 검사가 **표기법만 바꾸면 통과하는 것**이 가장 나쁘다 —
 * 그 검사는 있는 것보다 나쁘다. 있다고 믿게 하기 때문이다.
 *
 * 경계도 넓혔다. 예전 정규식은 다음 \`export\`가 \`const POST = ...\` 꼴이면
 * 그것을 경계로 보지 못해 POST 본문까지 GET으로 셌다. 지금 그 조합은
 * 저장소에 없지만(측정함: \`function GET\` 뒤의 다음 export는 전부
 * \`async function\`), 생기면 엉뚱한 자리를 지적하게 된다.
 *
 * 여전히 안 보는 것 — 적어 둔다
 * ──────────────────────────────
 * \`export { GET } from '../route'\` 재수출(현재 2곳)은 \`null\`로 건너뛴다.
 * 쓰기가 있다면 **부모 라우트에 있고 그 파일은 따로 검사된다.** 건너뛰는
 * 것이 맞다. \`export const GET = someHandler\` 같은 간접 핸들러는 본문이
 * 이 파일에 없어 못 본다 — 현재 0곳이고, 생기면 이 주석을 고쳐야 한다.
 */
function getBody(src) {
  const decl = /export\s+(?:async\s+function\s+GET\s*\(|const\s+GET\s*=)/.exec(src);
  if (decl == null) return null;
  const rest = src.slice(decl.index + decl[0].length);
  const next = /\nexport\s+(?:async\s+)?(?:function|const|let|var|class)\s/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

const files = walk(ROOT);
const bad = [];
let checked = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const body = getBody(src);
  if (body == null) continue;
  checked++;
  const hits = WRITES.filter(w => body.includes(w));
  if (hits.length === 0) continue;
  const key = f.replace(/\\/g, '/');
  if (ALLOW[key]) continue;
  bad.push({ file: key, hits });
}

// 목록에 있는데 이제 안 쓰는 것도 알려준다 — 면제가 쌓이면 검사가 헐거워진다.
const stale = Object.keys(ALLOW).filter(k => {
  let src;
  try { src = readFileSync(k, 'utf8'); } catch { return true; }
  const body = getBody(src);
  return body == null || !WRITES.some(w => body.includes(w));
});

if (bad.length > 0) {
  console.error('❌ GET이 DB에 쓰고 있습니다 — 읽기 요청은 읽기만 해야 합니다\n');
  for (const b of bad) {
    console.error(`  ${b.file}`);
    console.error(`    ${b.hits.join(' · ')}`);
  }
  console.error('\n왜 막는가');
  console.error('  · 사람이 화면을 안 열면 기록이 안 남습니다 (자동매매는 24시간 돕니다)');
  console.error('  · 탭을 두 개 열면 같은 순간이 두 번 기록됩니다 — 간격 판정은 동시 요청을 못 막습니다');
  console.error('  · 브라우저의 프리페치·재시도가 그대로 쓰기가 됩니다');
  console.error('\n어떻게 고치나');
  console.error('  쓰는 일을 POST 라우트로 옮기고 워커가 깨우게 하십시오');
  console.error('  (예: /api/wallets/snapshot — 워커가 15분마다 부르고, 중복은 DB 제약이 막습니다)');
  console.error('  스케줄러가 GET으로 깨우는 경로라면 scripts/check-get-writes.mjs의 ALLOW에 이유와 함께 적으십시오');
  process.exit(1);
}

if (stale.length > 0) {
  console.error('❌ 면제 목록에 이제 필요 없는 항목이 있습니다 — 면제가 쌓이면 검사가 헐거워집니다\n');
  for (const s of stale) console.error(`  ${s}`);
  process.exit(1);
}

console.log(`✅ GET 라우트 ${checked}개 · 새로 쓰는 것 0개 (스케줄러 경로 면제 ${Object.keys(ALLOW).length}개)`);
