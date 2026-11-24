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

/**
 * main의 SHA. 안 주면 **이 체크아웃에서 직접 읽는다.**
 *
 * 안 주면 서버가 세 SHA를 대조하지 못하고 `main: null`을 돌려준다 —
 * 그러면 "Vercel과 Fly는 같다"까지만 알고 **그게 main인지는 모른다.**
 * 호출부가 매번 기억해야 하는 인자는 언젠가 빠진다.
 */
function mainShaFrom(env) {
  const given = String(env.MAIN || '').trim();
  if (given) return { sha: given, source: 'MAIN' };

  // ★ **읽기 전에 가져온다.** 이걸 빼먹고 한 번 틀렸다.
  //
  //   로컬 `origin/main` 참조는 마지막 fetch 시점에 멈춰 있다. 그 사이
  //   누가 main에 머지하면 참조는 옛 SHA를 들고 있고, 배포는 새 SHA를
  //   돌린다. 그러면 이 스크립트가 **멀쩡한 배포를 MISMATCH로 적는다.**
  //
  //   실제로 그랬다 (2026-11-24): 로컬 참조 `cc3dc28a`, 실제 배포
  //   `efd6a935`(다른 참여자가 #750을 머지했다) → `MISMATCH`. 배포는
  //   아무 문제가 없었다.
  //
  //   늘 틀리는 검사는 꺼지고, 틀릴 수 있는 검사는 진짜 빨강과 구별되지
  //   않는다. 그래서 가져오기를 **판정 안에** 넣는다.
  let fetched = false;
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', 'main'],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60_000 });
    fetched = true;
  } catch { /* 망이 없을 수 있다 — 아래에서 낡았을 수 있다고 적는다 */ }

  for (const ref of ['origin/main', 'FETCH_HEAD', 'main', 'HEAD']) {
    try {
      const out = execFileSync('git', ['rev-parse', ref], { stdio: ['ignore', 'pipe', 'ignore'] });
      const sha = String(out).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) {
        // **가져오지 못했으면 그 사실을 출처에 적는다.** 적어 두지 않으면
        // 낡은 참조로 난 MISMATCH를 배포 문제로 읽는다.
        return { sha, source: `git ${ref}${fetched ? '' : ' (가져오지 못함 — 낡았을 수 있습니다)'}` };
      }
    } catch { /* 다음 ref */ }
  }
  return { sha: '', source: '없음' };
}

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
  // ── **시크릿이 없다고 확인을 포기하지 않는다** ──
  //
  // 예전에는 `BASE`(워크플로가 `EXIT_MONITOR_URL`에서 넣는다)가 비면
  // 여기서 `::error::확인할 주소가 없습니다`로 끝냈다. 그런데 무인 회차는
  // 그 시크릿을 **일부러 받지 않으므로**(CLAUDE.md의 울타리) 회차마다
  // "배포를 확인하지 못했습니다"가 남고 사람이 대신 눌러야 했다.
  //
  // `/api/system/deployment`는 **인증이 없는 경로**다. 주소만 알면 읽힌다.
  // 그래서 주소를 네 곳에서 차례로 찾고(`deploymentBaseFrom`), 없으면
  // 공개 기본값까지 내려가서라도 **확인은 한다.**
  const dir = loadJudge();
  const { deploymentCheckVerdict, deploymentBaseFrom } =
    await import(`file://${join(dir, 'deploymentCheck.js')}`);

  const { base: BASE, source: baseSource } = deploymentBaseFrom(process.env);
  const { sha: MAIN, source: mainSource } = mainShaFrom(process.env);
  // ★ **주소는 찍지 않는다**(머리말 규칙). 어디서 왔는지만 찍는다 —
  //   기본값으로 엉뚱한 배포를 본 회차를 나중에 구별하기 위한 한 줄이다.
  console.log(`주소 출처: ${baseSource} · main SHA 출처: ${mainSource}`);
  if (!MAIN) {
    // main을 모르면 **세 SHA 대조가 아니다.** 그 사실을 적고 계속한다 —
    // Vercel·Fly가 서로 같은지는 여전히 읽을 값이 있다.
    console.log('::warning::main의 SHA를 읽지 못했습니다 — 세 SHA 대조가 아니라'
      + ' Vercel·Fly 비교까지만입니다');
  }

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
