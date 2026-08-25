#!/usr/bin/env node
// scripts/check-admin-client.mjs
//
// **서버가 Supabase에 붙는 문은 하나여야 한다.**
//
// 무엇을 막는가
// ─────────────
// 2026-08-24에 Production에서 확정된 것: 서버의 GET이 캐시에 굳어
// **사흘 전 값**을 돌려주고 있었다(`FETCH_CACHE_STALE`). 고친 자리는
// `getSupabaseAdmin()` 한 곳이다 — 거기서 client의 fetch에 읽기 전용
// `no-store`를 물린다.
//
// 그러면 **그 문을 우회해 자기 client를 만드는 코드**가 새로 생기는
// 순간 같은 고장이 그 자리에서 되살아난다. 그리고 이번처럼 조용히
// 틀린다 — 오류가 아니라 오래된 값이다.
//
// 왜 그게 위험한가
// ────────────────
// 서버에서 Supabase를 읽는 자리가 265곳이고, 그중에는 이런 것이 있다:
//
//   킬스위치 상태   꺼져 있다고 읽으면 막아야 할 주문이 나간다
//   포지션·주문     닫힌 것을 열려 있다고 읽으면 중복 청산이 된다
//   heartbeat       낡으면 살아 있는 워커가 죽은 것으로 보인다
//
// 그래서 **자기 client를 만드는 것**을 막는다. 조회를 막는 것이 아니라
// 문을 하나로 유지하는 것이다.
//
// 무엇이 면제인가
// ───────────────
//   src/lib/supabase/server.ts   문 그 자체
//   src/lib/supabase.ts          브라우저 client (anon 키). 목적이 다르다
//   src/lib/supabase/client.ts   같은 것
//   worker/                      Next 런타임 밖이라 이 캐시가 없다
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** 문 그 자체와 브라우저용 */
const ALLOWED = new Set([
  'src/lib/supabase/server.ts',
  'src/lib/supabase.ts',
  'src/lib/supabase/client.ts',
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
const err = (m) => { bad += 1; console.error(`❌ ${m}`); };

// ── ① 서버 코드가 자기 client를 만들지 않는가 ──
for (const file of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (ALLOWED.has(rel)) continue;
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) return;
    if (!/\bcreateClient\s*[<(]/.test(line)) return;
    err(`${rel}:${i + 1} — 서버 코드가 Supabase client를 직접 만들고 있습니다`
      + `\n     ${t.slice(0, 120)}`
      + '\n     getSupabaseAdmin()을 쓰세요 — 그 문에서만 읽기 캐시를 막습니다'
      + '\n     우회하면 사흘 전 값을 읽는 고장이 그 자리에서 되살아납니다');
  });
}

// ── ② 문 자체가 여전히 캐시를 막고 있는가 ──
//
// **검사가 대상을 잃으면 조용히 통과한다.** 고친 코드가 사라지지
// 않았는지 여기서 같이 본다.
try {
  const gate = readFileSync(join(ROOT, 'src/lib/supabase/server.ts'), 'utf8');
  if (!/adminClientOptions\s*\(/.test(gate)) {
    err('src/lib/supabase/server.ts가 adminClientOptions()를 쓰지 않습니다'
      + '\n     서버 읽기가 다시 캐시에 굳을 수 있습니다');
  }
  const impl = readFileSync(join(ROOT, 'src/lib/supabase/serverFetch.ts'), 'utf8');
  if (!/no-store/.test(impl)) {
    err('src/lib/supabase/serverFetch.ts에 no-store가 없습니다 — 수정이 사라졌습니다');
  }
} catch (e) {
  err(`서버 client 파일을 읽지 못했습니다: ${String(e?.message || e).slice(0, 120)}`);
}

if (bad === 0) {
  console.log('✅ 서버 Supabase client 생성 지점 1곳 (getSupabaseAdmin) · 읽기 캐시 차단 유지');
} else {
  console.error('');
  console.error('   서버가 낡은 값을 읽으면 오류가 아니라 **조용히 틀린 판단**이 됩니다.');
  console.error('   닫힌 포지션을 열려 있다고, 켠 킬스위치를 꺼져 있다고 읽습니다.');
}
process.exit(bad ? 1 : 0);
