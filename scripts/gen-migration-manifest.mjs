#!/usr/bin/env node
// scripts/gen-migration-manifest.mjs
//
// `supabase/migrations/*.sql`를 읽어 **코드가 아는 마이그레이션 목록**을
// 만든다. 사용: `node scripts/gen-migration-manifest.mjs`
//
// 왜 파일로 굽는가
// ────────────────
// Vercel의 API 라우트는 저장소의 sql 파일을 읽을 수 없다(번들에 안 들어간다).
// 그런데 `/api/system/status`는 "지금 코드가 요구하는 마이그레이션이
// 무엇이고 DB에 몇 개가 적용돼 있는가"에 답해야 한다. 그래서 빌드 시점에
// 목록을 TS 파일로 구워 넣고, CI가 그 파일이 낡았으면 실패시킨다.
//
// **목록이 낡으면 화면은 조용히 옛날 기준으로 초록을 켠다.** 그게
// 054·055·056에서 실제로 일어난 일이라, 여기서는 CI가 막는다.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = process.cwd();
export const MIG_DIR = join(root, 'supabase', 'migrations');
export const OUT = join(root, 'src', 'lib', 'system', 'migrationManifest.ts');

/**
 * 번호가 없는 파일들 — **자동 파이프라인 대상이 아니다.**
 *
 * 번호 체계가 생기기 전에 손으로 실행한 것들과, 번호 마이그레이션 여러 개를
 * 한 번에 붙여 넣으려고 묶어 둔 사본이다. 사본을 자동으로 다시 실행하면
 * 같은 SQL이 두 번 돈다.
 *
 * **여기 없는 번호 없는 파일이 생기면 CI가 실패한다.** 그래야 "만들어
 * 놓고 배선을 안 함"이 조용히 지나가지 않는다.
 */
export const LEGACY = {
  'RUN_031_to_035.sql': '031~035를 손으로 붙여 넣던 사본 — 번호 파일이 원본이다',
  'RUN_ALL_008_to_015.sql': '008~015 사본 — 번호 파일이 원본이다',
  'RUN_AUTOTRADE_PHASE_A.sql': '031~035 묶음 사본 — 번호 파일이 원본이다',
  'RUN_PENDING.sql': '미적용분 묶음 사본 — 번호 파일이 원본이다',
  'RUN_PENDING_COMPACT.sql': '미적용분 묶음 사본(축약) — 번호 파일이 원본이다',
  'RUN_PHASE_B_strategy.sql': '050 사본 — 번호 파일이 원본이다',
  'exchange_connections_rls.sql': '번호 체계 이전에 손으로 적용됨',
  // canonical 책임은 076_jobs_queue.sql로 옮겼다. 이 파일은 운영이 실제로
  // 거쳐 온 경로라 기록으로 남긴다 — 자동 파이프라인은 여전히 돌리지 않는다.
  'jobs.sql': '번호 체계 이전에 손으로 적용됨 — 정본은 076_jobs_queue.sql',
  // canonical 책임은 001_kill_switch_bootstrap.sql로 옮겼다. 이 파일은 운영이
  // 실제로 거쳐 온 경로라 기록으로 남긴다 — 자동 파이프라인은 여전히 돌리지 않는다.
  'kill_switch.sql': '번호 체계 이전에 손으로 적용됨 — 정본은 001_kill_switch_bootstrap.sql',
  'strategy_profiles.sql': '번호 체계 이전에 손으로 적용됨',
};

export function checksumOf(sql) {
  // 줄 끝 문자만 다른 파일을 "바뀌었다"고 말하지 않는다.
  return createHash('sha256').update(String(sql).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

export function readMigrationFiles() {
  const names = readdirSync(MIG_DIR).filter(n => n.endsWith('.sql')).sort();
  return names.map(name => ({
    name,
    sql: readFileSync(join(MIG_DIR, name), 'utf8'),
  }));
}

export async function buildManifest() {
  const { classifyMigration, migrationIdOf } = await loadPlan();
  const rows = [];
  const unlisted = [];
  for (const f of readMigrationFiles()) {
    const id = migrationIdOf(f.name);
    if (id == null) {
      if (!LEGACY[f.name]) unlisted.push(f.name);
      continue;
    }
    const c = classifyMigration(f.sql);
    rows.push({ name: f.name, id, risk: c.risk, checksum: checksumOf(f.sql) });
  }
  rows.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));
  return { rows, unlisted };
}

/** migrationPlan.ts를 프로젝트 tsc로 컴파일해서 불러온다 — 판정 로직을 복제하지 않는다 */
export async function loadPlan() {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, cpSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'traigo-mig-'));
  cpSync(join(root, 'src', 'lib', 'system', 'migrationPlan.ts'), join(dir, 'migrationPlan.ts'));
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`TypeScript를 찾을 수 없습니다: ${tsc} — 먼저 npm install`);
  execFileSync(process.execPath, [tsc, 'migrationPlan.ts', '--module', 'commonjs',
    '--target', 'es2019', '--skipLibCheck'], { cwd: dir, stdio: 'pipe' });
  return await import(`file://${join(dir, 'migrationPlan.js')}`);
}

export function renderManifest({ rows }) {
  const body = rows.map(r =>
    `  { name: '${r.name}', id: ${r.id}, risk: '${r.risk}', checksum: '${r.checksum}' },`).join('\n');
  return `// src/lib/system/migrationManifest.ts
//
// **자동 생성 파일. 손으로 고치지 마세요.**
// 만드는 곳: scripts/gen-migration-manifest.mjs
// 다시 만들기: npm run gen:migrations
//
// 이 목록은 "지금 코드가 요구하는 마이그레이션"이다. DB의
// schema_migrations 표와 비교해서 무엇이 남았는지 화면에 적는다.
// CI(scripts/check-migrations.mjs)가 이 파일이 낡았으면 실패시킨다.

export interface ManifestEntry {
  name: string;
  id: number;
  risk: 'ADDITIVE' | 'DESTRUCTIVE' | 'UNKNOWN';
  /** 파일 내용의 sha256 앞 16자 — 적용된 뒤 파일이 바뀌었는지 본다 */
  checksum: string;
}

export const MIGRATION_MANIFEST: ManifestEntry[] = [
${body}
];

/** 코드가 요구하는 마이그레이션 파일 이름 (번호 순) */
export const REQUIRED_MIGRATIONS: string[] = MIGRATION_MANIFEST.map(m => m.name);
`;
}

const isMain = process.argv[1] && process.argv[1].endsWith('gen-migration-manifest.mjs');
if (isMain) {
  const built = await buildManifest();
  if (built.unlisted.length) {
    console.error(`::error::번호도 없고 목록에도 없는 마이그레이션 파일: ${built.unlisted.join(', ')}`);
    console.error('번호를 붙여 파이프라인에 넣거나, LEGACY에 이유와 함께 적으세요.');
    process.exit(1);
  }
  writeFileSync(OUT, renderManifest(built));
  console.log(`${OUT} — 마이그레이션 ${built.rows.length}개 기록`);
}
