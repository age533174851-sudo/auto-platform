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

/** GET 함수 본문만 잘라낸다. POST가 쓰는 것은 정상이다 */
function getBody(src) {
  const m = /export\s+async\s+function\s+GET\s*\(/.exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  const next = /\nexport\s+(?:async\s+)?function\s/.exec(rest);
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
