#!/usr/bin/env node
// scripts/check-scheduled-exit-runner.mjs
//
// **"이 시각에 팔겠다"는 약속을 지킬 실행기가 실제로 있는가.**
//
// 브라우저 없이 도는 실행기가 `scheduled-exit.yml`(GitHub Actions) 하나뿐이던
// 동안, 선언은 `*/5 * * * *`였지만 실측은 이랬다 (29개 구간 · 53시간):
//
//   5분 이내 0건 · 중앙값 50분 · 최대 600분 · 30분 초과 25건
//
// 라우트는 유예 30분을 넘긴 예약을 stale로 닫고 **주문하지 않는다.**
// 즉 대부분의 구간에서 그 사이에 걸린 예약은 영원히 나가지 않았다.
//
// 그리고 화면은 그걸 모른 채 "앱을 닫아도 제 시각에 나갑니다"를 적었다 —
// `accuracyNote({ appOpen: true, repoCron: true, dailyCron: true })`,
// **세 인자가 전부 하드코딩 true**였다.
//
// 배선과 문구라 순수 테스트로는 안 잡힌다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let bad = 0;
const err = (m) => { bad += 1; console.error(`❌ ${m}`); };

function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf8'); }
  catch { err(`${rel}을 읽지 못했습니다 — 검사가 대상을 잃었습니다`); return null; }
}
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── ① 워커가 예약청산을 깨운다 ──
{
  const rel = 'worker/src/index.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    // **정의가 아니라 호출을 본다.**
    if (!/await\s+pollScheduledExit\s*\(/.test(code)) {
      err(`${rel} — 워커가 예약청산을 깨우지 않습니다`
        + '\n     브라우저 없이 도는 것이 GitHub 예약뿐이면 실측 중앙값이 50분입니다'
        + '\n     유예는 30분이라, 그 사이에 걸린 예약은 **영원히 안 나갑니다**');
    }
    // 주기가 유예 안에 들어와야 한다.
    const m = code.match(/SCHEDULED_EXIT_INTERVAL_MS\s*\|\|\s*(\d[\d_]*)/);
    if (!m) {
      err(`${rel} — 예약청산 주기가 상수로 없습니다`);
    } else if (Number(String(m[1]).replace(/_/g, '')) > 5 * 60_000) {
      err(`${rel} — 예약청산 주기가 너무 깁니다 (${m[1]}ms)`
        + '\n     한 회차를 놓쳐도 유예(30분) 안에 들어와야 합니다');
    }
  }
}

// ── ② 화면이 실행기 상태를 지어내지 않는다 ──
{
  const rel = 'src/components/terminal/ScheduledExitPanel.tsx';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    // 하드코딩된 실행기 주장이 돌아오는 것을 막는다.
    if (/accuracyNote\s*\(\s*\{[^}]*true/.test(code)) {
      err(`${rel} — 실행기 상태를 손으로 true로 적습니다`
        + '\n     확인하지 않고 "앱을 닫아도 제 시각에 나갑니다"를 적는 자리입니다');
    }
    if (!/scheduledExitRunnerOf\s*\(/.test(code)) {
      err(`${rel} — 서버가 준 사실로 판정하지 않습니다`);
    }
    // **사용자에게 할 일을 넘기지 않는다.**
    if (/x-admin-secret/.test(code)) {
      err(`${rel} — 사용자에게 스케줄러를 붙이라고 시킵니다`
        + '\n     "분 단위로 …를 x-admin-secret과 함께 호출" 같은 문장은'
        + '\n     그 문장을 없애는 코드를 먼저 써야 합니다');
    }
  }
}

// ── ③ 서버가 근거를 값으로 준다 ──
{
  const rel = 'src/app/api/autotrade/scheduled-exit/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/overdueExitsOf\s*\(/.test(code)) {
      err(`${rel} — 놓친 예약을 세지 않습니다`
        + '\n     그게 "실행기가 제때 안 왔다"의 유일한 직접 증거입니다');
    }
    if (!/runner\s*:\s*\{/.test(code)) {
      err(`${rel} — 화면에 실행기 근거를 내려주지 않습니다`);
    }
    if (!/stale\s*:\s*staleCount/.test(code)) {
      err(`${rel} — 유예를 넘겨 못 나간 건수를 응답에 넣지 않습니다`);
    }
  }
}

// ── ④ 운영 화면에서 보인다 ──
{
  const rel = 'src/app/api/system/runtime-health/route.ts';
  const src = read(rel);
  if (src && !/scheduledExitRunnerOf\s*\(/.test(stripComments(src))) {
    err(`${rel} — 예약청산이 제때 나가는지 운영 화면에 없습니다`);
  }
}

if (bad === 0) {
  console.log('✅ 예약청산 실행기 유지 — 워커가 분 단위로 깨우고 · 화면은 근거로만 말한다');
} else {
  console.error('');
  console.error('   못 여는 것은 불편이고 못 닫는 것은 사고입니다.');
  console.error('   "제 시각에 나갑니다"를 근거 없이 적는 것이 그 사고를 숨깁니다.');
}
process.exit(bad ? 1 : 0);
