#!/usr/bin/env node
// scripts/check-migration-approval-gate.mjs
//
// **승인 없이 운영 DB에 적용되는 길을 다시 열지 못하게 한다.**
//
// 무엇이 있었나
// ─────────────
// `097_jobs_killswitch_active_unique.sql`은 머리말에 "SAFETY: Do not apply
// to any operating DB without separate user approval"이라고 **스스로 적어
// 두었는데**, 분류기가 ADDITIVE로 읽었다. 그러면 체인이 이렇게 된다:
//
//   main push → migrate.yml → apply-migrations.mjs → ADDITIVE는 자동 적용
//
// 주석은 관문이 아니다. 파일이 요구한 것과 파이프라인이 하는 일이
// 어긋나 있었고, 어긋났다는 사실을 아무도 보지 못했다.
//
// 이 검사기가 세는 것
// ───────────────────
//   ① 승인 경로가 ADDITIVE·UNKNOWN을 통과시키지 않는가
//   ② 자동 적용되는 위험도가 ADDITIVE 하나뿐인가
//   ③ 기존 표에 제약을 거는 마이그레이션이 자동 목록에 없는가
//   ④ migrate.yml이 여전히 push로 돌면(= 자동이면) 위 셋이 더 중요하다

import { readFileSync, existsSync } from 'node:fs';
import { loadPlan, buildManifest } from './gen-migration-manifest.mjs';

let bad = 0;
const err = (m) => { bad++; console.error(`❌ ${m}`); console.log(`::error::${m}`); };

const RUNNER = 'scripts/apply-migrations.mjs';
const WF = '.github/workflows/migrate.yml';
if (!existsSync(RUNNER)) { err(`${RUNNER}를 찾지 못했습니다`); process.exit(1); }
const runner = readFileSync(RUNNER, 'utf8');
// 주석은 코드가 아니다 — 옛 모양을 주석에 인용해 두면 거기 걸린다.
const runnerCode = runner.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── ① 승인 경로가 무엇을 통과시키는가 ──
const m = runnerCode.match(/const APPROVABLE_RISKS = \[([^\]]*)\]/);
if (!m) {
  err('승인 가능한 위험도 목록(APPROVABLE_RISKS)을 찾지 못했습니다 — 승인 경로의 한정이 사라졌습니다');
} else {
  const list = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const forbidden of ['ADDITIVE', 'UNKNOWN']) {
    if (list.includes(forbidden)) {
      err(`승인 경로가 ${forbidden}을 통과시킵니다 — `
        + (forbidden === 'ADDITIVE'
          ? '자동으로 가는 것을 승인 경로에 넣을 이유가 없습니다'
          : '무슨 일이 일어나는지 모르는 파일을 이름만 보고 승인할 수 없습니다'));
    }
  }
  if (!list.includes('DATA_DEPENDENT')) {
    err('승인 경로에 DATA_DEPENDENT가 없습니다 — 기존 표에 제약을 거는 파일을 '
      + '승인으로도 적용할 수 없게 되어, 사람이 결정할 길이 사라집니다');
  }
}
if (!/if \(!APPROVABLE_RISKS\.includes\(entry\.risk\)\)/.test(runnerCode)) {
  err('승인 경로의 위험도 확인이 사라졌습니다');
}

// ── ② 자동 적용되는 위험도는 ADDITIVE 하나뿐인가 ──
const { classifyMigration } = await loadPlan();
for (const [sql, want] of [
  ['CREATE UNIQUE INDEX i ON public.jobs (a)', 'DATA_DEPENDENT'],
  ['ALTER TABLE live_orders ADD CONSTRAINT c CHECK (q > 0)', 'DATA_DEPENDENT'],
  ['DROP TABLE jobs', 'DESTRUCTIVE'],
  ['create table if not exists t (id uuid)', 'ADDITIVE'],
]) {
  const c = classifyMigration(sql);
  if (c.risk !== want) err(`분류가 바뀌었습니다: ${JSON.stringify(sql)} → ${c.risk} (기대 ${want})`);
  if (c.autoApply && c.risk !== 'ADDITIVE') {
    err(`${c.risk}인데 자동 적용입니다 — 자동으로 가도 되는 것은 ADDITIVE뿐입니다`);
  }
}

// ── ③ 기존 표에 제약을 거는 파일이 자동 목록에 섞여 있지 않은가 ──
const built = await buildManifest();
for (const r of built.rows) {
  if (r.risk !== 'ADDITIVE') continue;
  const sql = readFileSync(`supabase/migrations/${r.name}`, 'utf8');
  const c = classifyMigration(sql);
  if (c.risk !== r.risk) {
    err(`${r.name}: 기록된 위험도(${r.risk})와 분류 결과(${c.risk})가 다릅니다 — `
      + 'gen-migration-manifest.mjs를 다시 돌리세요');
  }
}

// ── ④ migrate.yml이 자동으로 도는 사실을 적어 둔다 ──
if (existsSync(WF)) {
  const wf = readFileSync(WF, 'utf8');
  const auto = /^on:[\s\S]*?^\s{2}push:/m.test(wf);
  console.log(auto
    ? '  · migrate.yml은 main push로 자동 실행됩니다 — 위 관문이 유일한 방어선입니다'
    : '  · migrate.yml은 수동 실행만 받습니다');
}

if (bad === 0) {
  console.log('✅ 마이그레이션 승인 관문 — 자동 적용은 ADDITIVE만 · 기존 표 제약은 승인 필요 · 매니페스트 일치');
} else {
  console.error('');
  console.error('   이 관문이 없으면 main에 push하는 것만으로 운영 DB 스키마가 바뀝니다.');
  process.exit(1);
}
