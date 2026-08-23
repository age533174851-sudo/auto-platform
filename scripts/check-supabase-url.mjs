#!/usr/bin/env node
// scripts/check-supabase-url.mjs
//
// **서버가 Supabase URL을 고르는 곳은 한 군데여야 한다.**
//
// 무엇을 막는가
// ─────────────
// 이 저장소에서 가장 비싸게 반복된 고장이 **"경로가 둘인데 한쪽만
// 고침"**이다. Supabase URL이 정확히 그 모양이었다:
//
//   getSupabaseAdmin()            NEXT_PUBLIC_SUPABASE_URL
//   /api/system/deployment 지문   SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL
//   /api/system/runtime-health    SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL
//   parityGate · ops/command      SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL
//
// 그래서 화면에 뜨는 지문이 실제로 읽는 DB의 지문이 아니었다. 워커는
// heartbeat를 잘 쓰고 있는데 진단은 사흘 전 줄을 최신이라고 했다.
//
// 무엇이 걸리고 무엇이 안 걸리나
// ──────────────────────────────
//   ❌ fingerprintOf(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
//   ❌ createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, ...)
//   ❌ process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
//
//   ✅ !!process.env.NEXT_PUBLIC_SUPABASE_URL          있는지만 본다
//   ✅ Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)   같은 것
//   ✅ 브라우저 코드                                    번들에 들어가는 값이라 목적이 다르다
//
// 즉 **"있는지 묻는 것"은 되고, "어디에 접속할지 고르는 것"은 안 된다.**
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** 여기서만 고른다 */
const RESOLVER = 'src/lib/supabase/url.ts';

/**
 * 브라우저로 나가는 코드. `NEXT_PUBLIC_*`는 여기서 쓰라고 있는 값이다.
 * anon key와 짝이라 service role과 목적이 다르다.
 */
const BROWSER_FILES = new Set([
  'src/lib/supabase.ts',        // 브라우저 클라이언트 (anon)
  'src/lib/supabase/client.ts', // 같은 것
  'src/middleware.ts',          // edge, anon
  'src/components/LoginModal.tsx',
]);

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

let bad = 0;
function err(msg) { bad += 1; console.error(`❌ ${msg}`); }

const files = walk(join(ROOT, 'src'));
for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (rel === RESOLVER) continue;
  if (BROWSER_FILES.has(rel)) continue;

  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) return;
    if (!/process\.env\.(NEXT_PUBLIC_)?SUPABASE_URL/.test(line)) return;

    // 있는지만 묻는 것은 통과
    const presenceOnly =
      /!!\s*process\.env\.(NEXT_PUBLIC_)?SUPABASE_URL/.test(line)
      || /Boolean\(\s*process\.env\.(NEXT_PUBLIC_)?SUPABASE_URL/.test(line)
      // 객체 리터럴의 상태 보고: `NEXT_PUBLIC_SUPABASE_URL: !!process.env...`
      || /:\s*!!\s*process\.env\./.test(line);
    if (presenceOnly) return;

    err(`${rel}:${i + 1} — 서버 코드가 Supabase URL을 직접 고르고 있습니다`
      + `\n     ${t.slice(0, 120)}`
      + `\n     resolveServerSupabaseUrl()/serverSupabaseUrl()을 쓰세요 (${RESOLVER})`
      + '\n     고르는 곳이 둘이면 화면의 지문과 실제로 읽는 DB가 갈립니다');
  });
}

// ── schema_migrations를 읽는 곳은 전부 같은 client여야 한다 ──
//
// migrate 워크플로(`SUPABASE_DB_URL`)와 런타임 API(admin client)가 서로
// 다른 DB를 보면 "남음 0"과 "pendingCount 62"가 동시에 참이 된다.
// 런타임 쪽만큼은 한 client로 모은다 — 그래야 두 숫자를 비교하는 것이
// 의미가 있다.
for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  const src = readFileSync(file, 'utf8');
  if (!/\.from\(\s*['"]schema_migrations['"]/.test(src)) continue;
  const viaAdmin = /getSupabaseAdmin/.test(src);
  // sb를 인자로 받는 순수 판정기(migrationGate)는 부르는 쪽이 책임진다.
  const takesClient = /function\s+\w+\s*\(\s*sb\b/.test(src);
  if (!viaAdmin && !takesClient) {
    err(`${rel} — schema_migrations를 읽는데 getSupabaseAdmin을 쓰지 않습니다`
      + '\n     다른 client로 읽으면 "남음 0"과 "pendingCount 62"가 동시에 참이 됩니다');
  }
}

// 해석기 자체가 사라지지 않았는지 본다 — 검사가 대상을 잃으면 조용히 통과한다.
try {
  const r = readFileSync(join(ROOT, RESOLVER), 'utf8');
  for (const name of ['resolveServerSupabaseUrl', 'serverSupabaseUrl', 'URL_MISMATCH']) {
    if (!r.includes(name)) err(`${RESOLVER}에 ${name}이 없습니다 — 해석기가 바뀌었습니다`);
  }
} catch {
  err(`${RESOLVER}을 읽지 못했습니다 — 해석기가 사라졌습니다`);
}

if (bad === 0) {
  console.log(`✅ 서버 Supabase URL 선택 지점 1곳 (${RESOLVER}) · 검사한 파일 ${files.length}개`);
} else {
  console.error('');
  console.error('   화면에 뜨는 지문이 실제로 읽는 DB의 지문이 아니면,');
  console.error('   "같은 DB를 보고 있다"는 확인 자체가 거짓말이 됩니다.');
}
process.exit(bad ? 1 : 0);
