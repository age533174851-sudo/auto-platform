#!/usr/bin/env node
// scripts/check-migrate-target.mjs
//
// **migrate가 붙는 DB와 런타임이 읽는 DB가 같은가.**
//
// 무엇을 좁히는가
// ───────────────
// migrate 워크플로는 "남음 0"이라 하고, 런타임 API는 `pendingCount: 62`
// 라고 한다. 두 숫자가 다른 이유는 둘 중 하나다:
//
//   ① 서로 다른 데이터베이스를 보고 있다
//   ② 같은 DB인데 **세는 기준이 다르다**
//     (migrate = 실행·채택 기준 / 런타임 = 매니페스트 대조 + 체크섬)
//
// ①을 먼저 배제해야 ②를 볼 수 있다. 이 스크립트가 ①만 답한다.
//
// 무엇을 하지 않는가
// ──────────────────
// **DB에 붙지 않는다.** 접속 문자열을 파싱만 한다 — 쿼리도, 쓰기도 없다.
// 그리고 비밀번호·호스트·접속 문자열을 어디에도 출력하지 않는다.
// 나가는 것은 **project ref**뿐이고, 그건 공개 URL의 일부라 비밀이 아니다.
//
// 어떻게 비교하는가
// ─────────────────
//   migrate 쪽   SUPABASE_DB_URL에서 ref를 뽑는다
//                (`db.<ref>.supabase.co` 또는 사용자 `postgres.<ref>`)
//   런타임 쪽    BASE/api/system/deployment 의 migrations.readFrom.projectRef
//
// **모르는 것은 "같다"로 적지 않는다.** 한쪽이라도 ref를 못 읽으면
// UNKNOWN이고, UNKNOWN은 통과가 아니다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = String(process.env.BASE || '').replace(/\/+$/, '');

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-mig-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/runtime/heartbeatVerify.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

function dbUrl() {
  for (const k of ['SUPABASE_DB_URL', 'DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL_POOLER']) {
    const v = String(process.env[k] || '').trim();
    if (v) return { url: v, from: k };
  }
  return { url: '', from: null };
}

async function runtimeSide() {
  if (!BASE) return { ref: null, pendingCount: null, note: '확인할 주소(BASE)가 없습니다' };
  try {
    const r = await fetch(`${BASE}/api/system/deployment`, { signal: AbortSignal.timeout(20_000) });
    const b = await r.json().catch(() => null);
    return {
      ref: b?.migrations?.readFrom?.projectRef ?? b?.supabase?.projectRef ?? null,
      pendingCount: b?.migrations?.pendingCount ?? null,
      basis: b?.migrations?.basis ?? null,
      note: null,
    };
  } catch (e) {
    return { ref: null, pendingCount: null, note: `deployment 조회 실패: ${String(e?.message || e).slice(0, 160)}` };
  }
}

async function main() {
  const dir = loadJudge();
  const { projectRefFromPostgresUrl, sameProject } = await import(`file://${join(dir, 'heartbeatVerify.js')}`);

  const { url, from } = dbUrl();
  const migrateRef = projectRefFromPostgresUrl(url);
  const rt = await runtimeSide();

  const L = [];
  L.push(`migrate 접속 정보: ${from || '(없음)'}`);
  L.push(`  project ref: ${migrateRef ?? '(모름)'}`);
  L.push(`런타임(admin client)`);
  L.push(`  project ref: ${rt.ref ?? '(모름)'}`);
  if (rt.pendingCount != null) L.push(`  pendingCount: ${rt.pendingCount}`);
  if (rt.basis) L.push(`  세는 기준: ${rt.basis.source} · ${rt.basis.comparedAgainst} · 체크섬 ${rt.basis.checksumChecked ? '봄' : '안 봄'}`);
  if (rt.note) L.push(`  ${rt.note}`);

  const same = sameProject(migrateRef, rt.ref);
  let code, exit;
  if (same === true) {
    code = 'SAME_PROJECT';
    exit = 0;
    L.push('');
    L.push('✅ 같은 Supabase 프로젝트입니다.');
    L.push('   그래도 개수가 다르면 원인은 DB가 아니라 **세는 기준**입니다:');
    L.push('   migrate = 실행·채택 기준 / 런타임 = 매니페스트 대조 + 체크섬.');
  } else if (same === false) {
    code = 'DIFFERENT_PROJECT';
    exit = 1;
    L.push('');
    L.push('❌ migrate와 런타임이 서로 다른 Supabase 프로젝트를 보고 있습니다.');
    L.push('   "남음 0"과 "pendingCount"는 서로 다른 데이터베이스의 사실이라 비교할 수 없습니다.');
  } else {
    code = 'UNKNOWN';
    exit = 1;
    L.push('');
    L.push('❌ 같은 프로젝트인지 확인하지 못했습니다 — **다르다는 뜻도, 같다는 뜻도 아닙니다.**');
    L.push('   확인하지 못한 것은 통과가 아니므로 실패로 끝냅니다.');
  }

  console.log(L.join('\n'));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try { appendFileSync(summary, ['## migrate ↔ 런타임 대상 대조', '', '```', L.join('\n'), '```', ''].join('\n')); } catch {}
  }
  void code;
  return exit;
}

main().then(c => process.exit(c)).catch(e => {
  console.log(`::error::대상 대조에 실패했습니다: ${String(e?.message || e).slice(0, 200)}`);
  process.exit(1);
});
