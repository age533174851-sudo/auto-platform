#!/usr/bin/env node
// scripts/verify-deployment.mjs
//
// **배포됐는지 눌러서 값으로 확인한다.**
//
// 왜 YAML이 아니라 여기인가
// ─────────────────────────
// 이 판정은 원래 워크플로 안의 한 줄짜리 `python3 -c`였다:
//
//     verdict=$(python3 -c "... print(d.get('verdict') or '(없음)')")
//     if [ "$verdict" != "MATCHED" ]; then exit 1; fi
//
// 그런데 `verdict`는 객체(`{code, matched, reason}`)다. 출력은
// `{'code': 'MATCHED', ...}`가 됐고 문자열 `MATCHED`와 절대 같아지지
// 않았다 — **8번 실행해서 8번 다 실패했다.** 그동안 배포는 멀쩡했다.
//
// 언제나 빨강인 검사는 진짜 어긋난 날의 빨강과 구별되지 않는다.
// `wait-worker-alive`와 같은 이유로 판정을 파일로 옮기고 테스트를 붙였다
// (`src/lib/ops/deploymentCheck.ts`).
//
// 값은 찍지 않는다 — 주소도 로그에 넣지 않는다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = String(process.env.BASE || '').replace(/\/+$/, '');
const MAIN = String(process.env.MAIN || '').trim();

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-deploy-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ops/deploymentCheck.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

async function main() {
  if (!BASE) {
    console.log('::error::확인할 주소가 없습니다 (EXIT_MONITOR_URL) — 배포 상태를 확인하지 못했습니다');
    return 1;
  }

  const dir = loadJudge();
  const { deploymentCheckVerdict } = await import(`file://${join(dir, 'deploymentCheck.js')}`);

  // 이 경로는 인증이 없다. 헤더를 붙이지 않는다.
  let url = `${BASE}/api/system/deployment`;
  if (MAIN) url += `?main=${encodeURIComponent(MAIN)}`;

  let body = null;
  let httpCode = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    httpCode = r.status;
    body = await r.json().catch(() => null);
  } catch (e) {
    console.log(`::warning::요청이 실패했습니다: ${String(e?.message || e).slice(0, 120)}`);
  }

  console.log(`HTTP ${httpCode ?? '(응답 없음)'}`);
  // 본문은 그대로 남긴다 — 나중에 "언제부터 어긋났나"를 볼 때 이 줄이 기준이 된다.
  if (body) console.log(JSON.stringify(body));

  if (httpCode !== 200) {
    console.log(`::error::배포 상태를 읽지 못했습니다 (HTTP ${httpCode ?? '없음'})`);
    return 1;
  }

  const v = deploymentCheckVerdict({ body, expectMain: MAIN || null });
  const d = v.detail;
  console.log(`main ${d.main ?? '?'} · vercel ${d.vercel ?? '?'} · fly ${d.fly ?? '?'}`
    + ` · 남은 마이그레이션 ${d.pendingCount == null ? '확인 못 함' : d.pendingCount}`);
  // ── 예약 주 경로가 도는가 ──
  //
  // **여기서 실패로 만들지 않는다.** 이 워크플로가 답하는 질문은 "세 SHA가
  // 같은가"이고, 예약 폴러 상태는 다른 질문이다. 두 빨강을 한 칸에 넣으면
  // 배포가 어긋난 날과 예약이 멈춘 날이 구별되지 않는다.
  //
  // 대신 **판정과 근거를 같이 찍는다.** 예전에는 이 사실이 `fly logs`에만
  // 있어서 사람이 열어야 읽혔고, 그래서 2026-08-29에 "확인 불가"로 끝났다.
  const sch = body?.scheduler;
  if (sch?.code) {
    console.log(`예약 주 경로: ${sch.code} — ${sch.reason}`);
    for (const e of Array.isArray(sch.evidence) ? sch.evidence : []) console.log(`  · ${e}`);
    if (sch.code === 'WORKER_PRESENT_BUT_CONFIG_BLOCKED' || sch.code === 'WORKER_PRESENT_BUT_RUNTIME_BROKEN') {
      console.log(`::warning::Fly Worker 예약 폴러가 돌지 않습니다 (${sch.code}) — ${sch.reason}`);
    }
  } else {
    console.log('예약 주 경로: 응답에 없습니다 — 이 배포에는 아직 그 칸이 없습니다');
  }

  // **결론은 로그 맨 끝 한 줄에서 읽힌다.**
  console.log(`verdict: ${v.code}${v.serverCode && v.serverCode !== v.code ? ` (서버 ${v.serverCode})` : ''}`);

  if (v.ok) { console.log(v.reason); return 0; }
  console.log(`::error::${v.reason}`);
  return 1;
}

main().then(c => process.exit(c)).catch(e => {
  console.log(`::error::배포 확인에 실패했습니다: ${String(e?.message || e).slice(0, 200)}`);
  process.exit(1);
});
