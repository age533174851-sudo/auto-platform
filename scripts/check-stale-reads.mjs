#!/usr/bin/env node
// scripts/check-stale-reads.mjs
//
// **한 곳의 SELECT 모양만 바꿔 증상을 숨기지 않는다.**
//
// 무엇을 세는가
// ─────────────
// 2026-08-24 Production에서 같은 요청 안의 같은 client가 한 질의는
// 사흘 전 값을, 다른 질의는 1초 전 값을 돌려줬다. 권한도 프로젝트도
// 워커 쓰기도 정상이었다 — 남은 차이는 **질의의 모양**뿐이었다.
//
// 그게 캐시라면 이 문제는 `/api/system/deployment` 한 곳의 것이 아니다.
// **서버에서 Supabase를 읽는 모든 자리가 같은 위험을 진다.**
//
// 그래서 그 자리들을 센다. 지금은 막지 않고 **수를 세어 보여 준다** —
// 원인이 확정되기 전에 전부 고치라고 하면, 고쳐야 할 이유도 모른 채
// 큰 변경이 들어간다.
//
// 무엇이 위험한가
// ───────────────
// 자동매매에서 낡은 값을 읽는다는 것은 이런 뜻이다:
//
//   포지션을 닫았는데 열려 있다고 읽는다  → 중복 청산
//   킬스위치를 켰는데 꺼져 있다고 읽는다   → 막아야 할 주문이 나간다
//   heartbeat가 낡아 죽은 것으로 본다      → 지금 겪는 것
//
// **조용히 틀리는 쪽이 언제나 더 나쁘다.**
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 서버에서 도는 코드인가 (브라우저 번들은 이 위험이 다르다) */
function isServerSide(rel, src) {
  if (rel.startsWith('src/app/api/')) return true;
  if (rel.startsWith('worker/')) return true;
  // 서버 전용 client를 부르는 lib
  return /getSupabaseAdmin|supabase\/server/.test(src);
}

const files = walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'worker')));
const hits = [];

for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  let src = '';
  try { src = readFileSync(file, 'utf8'); } catch { continue; }
  if (!/\.from\(/.test(src)) continue;
  if (!isServerSide(rel, src)) continue;

  const lines = src.split('\n');
  let count = 0;
  lines.forEach((line) => {
    // 읽기만 센다. insert/update/upsert/delete는 GET이 아니라 캐시 대상이 아니다.
    if (!/\.from\(\s*['"`]/.test(line)) return;
    count += 1;
  });
  // 워커는 Next.js 밖에서 도는 순수 Node 프로세스라 이 캐시의 대상이
  // 아니다. **그래도 세어서 보여 준다** — "안 세었다"와 "해당 없다"는
  // 다른 사실이고, 나중에 워커가 Next 런타임으로 옮겨 가면 대상이 된다.
  if (count > 0) hits.push({ file: rel, count, nextRuntime: !rel.startsWith('worker/') });
}

hits.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
const total = hits.reduce((n, h) => n + h.count, 0);

const atRisk = hits.filter(h => h.nextRuntime).reduce((n, h) => n + h.count, 0);
const workerSide = total - atRisk;
console.log(`ℹ️ 서버에서 Supabase 표를 만지는 자리: 파일 ${hits.length}개 · 호출 ${total}곳`);
console.log(`   Next 런타임(캐시 대상 가능) ${atRisk}곳 · 워커(Next 밖, 대상 아님) ${workerSide}곳`);
for (const h of hits.slice(0, 12)) {
  console.log(`   ${h.count.toString().padStart(3)}  ${h.file}${h.nextRuntime ? '' : '   (Next 밖)'}`);
}
if (hits.length > 12) console.log(`   … 외 ${hits.length - 12}개 파일`);
console.log('');
console.log('   같은 요청 안에서 어떤 SELECT만 낡는 현상이 확정되면,');
console.log('   **이 자리 전부가 같은 위험을 집니다.** 한 곳의 컬럼 모양만');
console.log('   바꾸는 것은 그 자리만 낫게 하고 나머지를 그대로 둡니다.');
console.log('   고치려면 client 한 곳(getSupabaseAdmin)에서 막아야 합니다.');

// **막지 않는다.** 원인이 확정되기 전에는 세어 보여 주기만 한다.
process.exit(0);
