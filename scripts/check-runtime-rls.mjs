#!/usr/bin/env node
// scripts/check-runtime-rls.mjs
//
// **runtime_* 세 표가 다시 열리지 못하게 한다.**
//
// 운영 `traigo`에서 확인된 상태는 RLS OFF + anon/authenticated 전권이었다.
// 원인은 `044_runtime_jobs.sql`이 잠그는 문장을 **하나도 적지 않은** 것이다 —
// Supabase에서 public 표는 아무것도 안 적으면 브라우저 역할에 열린다.
//
// 이 검사기는 진짜 DB 없이 **모양**만 센다. 실제 차단은
// `scripts/runtime-rls-proof.sh`가 격리 PostgreSQL에서 증명한다.

import { readFileSync, existsSync } from 'node:fs';

const MIG = 'supabase/migrations/098_runtime_tables_rls.sql';
const TABLES = ['runtime_jobs', 'runtime_leases', 'runtime_ticks'];
let bad = 0;
const err = (m) => { bad++; console.error(`❌ ${m}`); console.log(`::error::${m}`); };

if (!existsSync(MIG)) { err(`${MIG}을 찾지 못했습니다`); process.exit(1); }
const sql = readFileSync(MIG, 'utf8');
// 주석은 코드가 아니다 — 설명에 적힌 문장에 걸리면 안 된다.
const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

// ── ① 세 표가 모두 대상인가 ──
for (const t of TABLES) {
  if (!new RegExp(`'${t}'`).test(code)) err(`${t}가 잠금 대상에 없습니다`);
}

// ── ② RLS · FORCE · 회수 · service_role 네 가지가 다 있는가 ──
const NEED = [
  [/ENABLE ROW LEVEL SECURITY/i, 'RLS를 켜지 않습니다'],
  [/FORCE ROW LEVEL SECURITY/i,
    'FORCE가 없습니다 — 표 소유자는 RLS를 건너뛰므로 정책이 반쪽이 됩니다'],
  [/REVOKE ALL ON [^\n]*FROM anon/i, 'anon 권한을 거두지 않습니다'],
  [/REVOKE ALL ON [^\n]*FROM authenticated/i, 'authenticated 권한을 거두지 않습니다'],
  [/REVOKE ALL ON [^\n]*FROM PUBLIC/i,
    'PUBLIC 권한을 거두지 않습니다 — 새 역할이 여기서 상속받습니다'],
  [/FOR ALL TO service_role/i, 'service_role 정책이 없습니다 — 서버·워커가 끊깁니다'],
  [/GRANT ALL ON [^\n]*TO service_role/i, 'service_role에 권한을 주지 않습니다'],
];
for (const [re, why] of NEED) if (!re.test(code)) err(`${MIG}: ${why}`);

// ── ③ 브라우저 역할에 권한을 **주는** 문장이 섞여 있지 않은가 ──
for (const m of code.matchAll(/GRANT[^\n;]*\bTO\b([^\n;]*)/gi)) {
  const to = m[1];
  for (const role of ['anon', 'authenticated', 'PUBLIC']) {
    if (new RegExp(`\\b${role}\\b`).test(to)) {
      err(`${MIG}: ${role}에 권한을 주는 GRANT가 있습니다 — 잠그는 파일이 열고 있습니다`);
    }
  }
}

// ── ④ 044가 여전히 잠그지 않는가 (원인을 기억해 둔다) ──
const SRC = 'supabase/migrations/044_runtime_jobs.sql';
if (existsSync(SRC)) {
  const s = readFileSync(SRC, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  if (/ENABLE ROW LEVEL SECURITY/i.test(s) && !existsSync(MIG)) {
    err('044가 RLS를 켜는데 098이 없습니다 — 둘 중 하나만 있으면 상태가 갈립니다');
  }
}

// ── ⑤ 자동 적용 대상이 되면 안 된다 ──
//
// 이 파일은 운영 권한을 바꾼다. 승인 없이 main push로 들어가면 안 된다.
{
  const { loadPlan } = await import('./gen-migration-manifest.mjs');
  const { classifyMigration } = await loadPlan();
  const c = classifyMigration(sql);
  if (c.autoApply) {
    err(`${MIG}이 자동 적용 대상입니다 (${c.risk}) — 운영 권한 변경은 승인을 거쳐야 합니다`);
  } else {
    console.log(`  · ${MIG} → ${c.risk} (자동 적용 아님)`);
  }
}

if (bad === 0) {
  console.log('✅ runtime_* 잠금 — 표 3개 · RLS·FORCE·회수(anon·authenticated·PUBLIC)·service_role 전용 · 승인 필요');
} else {
  console.error('');
  console.error('   잠그는 문장을 빠뜨리는 것이 곧 여는 것입니다.');
  process.exit(1);
}
