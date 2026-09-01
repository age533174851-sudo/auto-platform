#!/usr/bin/env node
// scripts/check-migrations.mjs
//
// **"만들어 놓고 배선을 안 함"을 CI에서 잡는다.**
//
// 이 저장소에서 가장 자주 난 사고가 그거다. 마이그레이션 파일은
// 커밋됐는데 아무도 적용하지 않았고, 화면은 옛 목록 기준으로 초록을
// 켰다. 054·055·056이 전부 그랬다.
//
// 여기서 보는 것:
//   1. 모든 .sql이 번호를 갖거나 LEGACY에 이유가 적혀 있는가
//   2. 번호가 겹치지 않는가
//   3. src/lib/system/migrationManifest.ts가 최신인가
//   4. 자동으로 못 도는 마이그레이션이 몇 개인가 (있으면 사유를 적는다)
//   5. 화면·응답이 사람에게 운영 숙제를 넘기지 않는가
//   6. canonical 파일(001 · 076)의 target이 그대로인가 — 운영 채택 계약
import { readFileSync, existsSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, renderManifest, OUT, LEGACY, loadPlan, MIG_DIR } from './gen-migration-manifest.mjs';

let bad = 0;
const err = (m) => { console.error(`::error::${m}`); bad += 1; };

const built = await buildManifest();

// 1. 배선 안 된 파일
if (built.unlisted.length) {
  err(`번호도 없고 LEGACY에도 없는 마이그레이션 파일: ${built.unlisted.join(', ')}`);
  console.error('   → 번호를 붙여 자동 파이프라인에 넣거나, gen-migration-manifest.mjs의 LEGACY에 이유를 적으세요.');
}

// 2. 번호 중복 — 순서가 두 갈래가 되면 어느 쪽이 먼저인지 아무도 모른다
const byId = new Map();
for (const r of built.rows) {
  if (byId.has(r.id)) err(`마이그레이션 번호 ${r.id}가 겹칩니다: ${byId.get(r.id)} · ${r.name}`);
  else byId.set(r.id, r.name);
}

// 3. 목록 파일이 최신인가
const want = renderManifest(built);
const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
if (have !== want) {
  err('src/lib/system/migrationManifest.ts가 낡았습니다 — `npm run gen:migrations`를 실행하고 커밋하세요');
  if (have) {
    const hn = (have.match(/name: '/g) || []).length;
    console.error(`   현재 ${hn}개 기록 · 실제 ${built.rows.length}개`);
  }
}

// 4. 자동으로 못 도는 것
const manual = built.rows.filter(r => r.risk !== 'ADDITIVE');
if (manual.length) {
  console.log(`자동 적용 대상이 아닌 마이그레이션 ${manual.length}개 (승인 필요):`);
  for (const m of manual) console.log(`  · ${m.name} — ${m.risk}`);
  console.log('  자동 파이프라인은 이 파일들을 실행하지 않습니다. 명령 기반 승인이 필요합니다.');
}

// 5. 화면·응답이 사람에게 운영 숙제를 넘기지 않는가
//
// **"Supabase SQL 편집기에서 실행하세요"는 자동화 미완성의 증거다.**
// 적용은 migrate 워크플로가 자동으로 한다. 사람에게 남는 말은
// "자동으로 적용하는 중" 또는 "권한이 없어 자동 처리하지 못했습니다"뿐이다.
//
// 주석은 뺀다 — 왜 그렇게 했는지 설명하는 글에는 옛 문구가 나올 수밖에 없다.
const CHORE_PHRASES = [
  { re: /마이그레이션[^\n'"`]{0,20}(?:을|를)\s*적용하세요/, why: '마이그레이션 적용을 사람에게 시킵니다' },
  { re: /SQL\s*(?:Editor|편집기)[^\n'"`]{0,30}(?:실행|붙여|적용)/i, why: 'SQL 편집기 작업을 사람에게 시킵니다' },
  { re: /fly\s+logs[^\n'"`]{0,20}(?:확인|보)/i, why: 'Fly 로그 확인을 사람에게 시킵니다' },
  { re: /heartbeat[^\n'"`]{0,20}확인하세요/i, why: 'heartbeat 확인을 사람에게 시킵니다' },
  { re: /SHA[^\n'"`]{0,20}비교하세요/i, why: 'SHA 대조를 사람에게 시킵니다' },
];

{
  const files = [
    ...globSync('src/components/**/*.tsx'),
    ...globSync('src/app/**/*.tsx'),
    ...globSync('src/app/api/**/*.ts'),
    ...globSync('src/lib/**/*.ts'),
  ].filter(f => !f.endsWith('.test.ts'));

  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;   // 주석은 설명이다
      for (const c of CHORE_PHRASES) {
        if (c.re.test(line)) err(`${f}:${i + 1} — ${c.why}\n     ${t.slice(0, 110)}`);
      }
    });
  }
}

// 6. canonical 마이그레이션의 target 계약 (001 · 076)
//
// **이 target 이름들은 운영 계약이다.** 운영 DB에는 이미 전부 있고
// (2026-08-31 read-only audit), runner의 채택 판정이 그것들을 전부 찾으면
// 해당 파일은 실행 없이 BASELINE으로 기록된다. 하나라도 못 찾으면 **파일이
// 실제로 실행되고**, 그 안의 `drop policy if exists`가 운영 정책을 갈아엎는다.
//
// 일회용 PG에서 실증했다. `idx_tg_dedup` 하나만 지워도, `idx_jobs_conn` 하나만
// 지워도 채택이 거부되고 파일이 APPLIED로 실행되며 소유자 정책의 OID가
// 바뀐다 — 지워졌다가 다시 만들어졌다는 뜻이다.
//
// 그래서 이 파일들의 target 이름은 혼자 바꿀 수 없다. 바꾸려면 운영
// 카탈로그를 먼저 확인해야 한다. 판정 로직은 복제하지 않고 앱과 같은 파일을
// 쓴다. 두 파일에 같은 검사를 두 번 적지 않는다 — 판단은 한 곳에 둔다.
{
  const CONTRACTS = [
    {
      file: '001_kill_switch_bootstrap.sql',
      what: 'kill-switch canonical',
      targets: [
        'table:kill_switch_state:kill_switch_state',
        'table:kill_switch_log:kill_switch_log',
        'table:telegram_alert_log:telegram_alert_log',
        'table:worker_heartbeat:worker_heartbeat',
        'table:worker_lock:worker_lock',
        'index:kill_switch_state:idx_kill_switch_conn',
        'index:telegram_alert_log:idx_tg_dedup',
        'policy:kill_switch_state:ks_state_owner',
        'policy:kill_switch_log:ks_log_owner',
      ],
      // 022_rls_worker_tables.sql이 만드는 것들 — 여기로 끌어오면 판단이 두 곳에 생긴다
      foreignPolicies: [
        { name: 'worker_lock_service', owner: '022_rls_worker_tables.sql' },
        { name: 'worker_heartbeat_service', owner: '022_rls_worker_tables.sql' },
        { name: 'telegram_alert_log_service', owner: '022_rls_worker_tables.sql' },
        { name: 'kill_switch_log_service', owner: '022_rls_worker_tables.sql' },
      ],
      // gen_random_uuid()를 쓰면서 확장을 남에게 맡기지 않는다. 001이 chain의
      // 첫 자리라 스스로 깔아야 한다.
      selfBootstrapsPgcrypto: true,
    },
    {
      file: '076_jobs_queue.sql',
      what: 'jobs queue canonical',
      targets: [
        'table:jobs:jobs',
        'index:jobs:idx_jobs_pending',
        'index:jobs:idx_jobs_conn',
        'policy:jobs:jobs_owner',
      ],
      // jobs는 SELECT 소유자 정책 하나뿐이다. 적재·실행은 service_role이 RLS를
      // 우회한다 — 그 모델을 바꾸는 정책을 여기서 새로 만들지 않는다.
      foreignPolicies: [
        { name: 'jobs_service', owner: 'service_role 우회 모델 (정책을 만들지 않는다)' },
        { name: 'jobs_insert', owner: 'service_role 우회 모델 (정책을 만들지 않는다)' },
        { name: 'jobs_update', owner: 'service_role 우회 모델 (정책을 만들지 않는다)' },
        { name: 'jobs_delete', owner: 'service_role 우회 모델 (정책을 만들지 않는다)' },
      ],
      // 076은 001 뒤에 돈다. pgcrypto는 001이 책임진다.
      selfBootstrapsPgcrypto: false,
    },
  ];

  const plan = await loadPlan();

  for (const c of CONTRACTS) {
    let sql = null;
    try { sql = readFileSync(join(MIG_DIR, c.file), 'utf8'); }
    catch { err(`${c.file}이 없습니다 — ${c.what} 마이그레이션은 지우면 안 됩니다`); continue; }

    const cls = plan.classifyMigration(sql);
    if (cls.risk !== 'ADDITIVE' || !cls.autoApply) {
      err(`${c.file}이 ${cls.risk}로 분류됩니다 (autoApply=${cls.autoApply}) — ${cls.reasons.join(' · ')}`);
    }

    const want = [...c.targets].sort();
    const got = plan.migrationTargets(sql).map(t => `${t.kind}:${t.table}:${t.name}`).sort();
    const missing = want.filter(x => !got.includes(x));
    const extra = got.filter(x => !want.includes(x));
    if (missing.length) {
      err(`${c.file}에서 사라진 target: ${missing.join(', ')}`);
      console.error('   → 운영에서 채택이 거부되고 이 파일이 실제로 실행됩니다 (drop policy 포함).');
    }
    if (extra.length) {
      err(`${c.file}에 늘어난 target: ${extra.join(', ')}`);
      console.error('   → 운영 카탈로그에 없는 이름이면 마찬가지로 채택이 거부됩니다.');
    }

    if (c.selfBootstrapsPgcrypto
        && /gen_random_uuid\s*\(/i.test(sql)
        && !/\bCREATE\s+EXTENSION\b[\s\S]*?\bpgcrypto\b/i.test(sql)) {
      err(`${c.file}이 gen_random_uuid()를 쓰면서 pgcrypto를 스스로 깔지 않습니다 — 빈 DB 재생이 실패합니다`);
    }

    for (const p of c.foreignPolicies) {
      if (new RegExp(`\\bcreate\\s+policy\\s+${p.name}\\b`, 'i').test(sql)) {
        err(`${c.file}이 ${p.name}를 만듭니다 — 그것은 ${p.owner}의 책임입니다`);
      }
    }
  }
}

if (bad === 0) {
  console.log(`마이그레이션 배선 확인: 파일 ${built.rows.length}개 · 자동 적용 ${built.rows.length - manual.length}개 · `
    + `자동 대상 아님 ${manual.length}개 · 구파일 ${Object.keys(LEGACY).length}개`);
}
process.exit(bad ? 1 : 0);
