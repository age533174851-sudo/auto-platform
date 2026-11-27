#!/usr/bin/env node
// scripts/check-deploy-evidence.mjs
//
// **관측하지 않은 것을 관측한 척 넘기지 않는다.**
//
// `ops-runner`가 `deployVerification`에 `vercelSha: mainSha`를 넘기고 있었다.
// 관측한 적 없는 값을 main과 같게 만들어 넘긴 것이라 Vercel 검사는 언제나
// 통과했고, 같은 값이 장부에도 적혔다 — **판정과 기록이 함께 거짓이 된다.**
//
// 2026-09-13에 Vercel만 6시간 넘게 옛 커밋이었다. 그때 DEPLOY가 돌았다면
// 이 자리는 초록으로 기록됐을 것이다.
//
// 한 번 고쳐도 같은 모양이 다시 들어올 수 있다. 그래서 여기서 막는다.
import { readFileSync } from 'node:fs';
import { stripJsComments, stripYamlComments } from './lib/strip-comments.mjs';

const RUNNER = 'scripts/ops-runner.mjs';
const LIB = 'src/lib/ops/selfHeal.ts';
const WF = '.github/workflows/ops-runner.yml';
let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

// **주석 걷기는 공용 함수를 쓴다.** 여기 있던 줄머리 필터는 `//` 로 시작
// 하는 줄만 지워서 줄 끝 주석과 여러 줄 `/* … */` 를 못 걷는다.
// (이 채택이 막혀 있던 이유가 공용 함수의 정규식 리터럴 탈선이었고,
//  같은 커밋에서 그것을 고쳤다.)
const runner = readFileSync(RUNNER, 'utf8');
const code = stripJsComments(runner);

// ── 1. main을 Vercel로 둔갑시키지 않는가 ──
if (/vercelSha\s*:\s*mainSha/.test(code)) {
  err(`${RUNNER}가 vercelSha에 mainSha를 넘깁니다 — 관측하지 않은 값입니다`);
}
// 장부에도 같은 둔갑이 없어야 한다. INSERT의 두 번째 값이 mainSha면 안 된다.
if (/VALUES\s*\(\$\{lit\(mainSha\)\},\s*\$\{lit\(mainSha\)\}/.test(code)) {
  err(`${RUNNER}가 deployment_verifications.vercel_sha에 mainSha를 적습니다`);
}

// ── 2. 실제로 관측하는 경로가 있는가 ──
if (!/observedVercelSha\(/.test(code)) {
  err(`${RUNNER}가 관측 함수(observedVercelSha)를 쓰지 않습니다`);
}
if (!/\/api\/system\/deployment/.test(code)) {
  err(`${RUNNER}가 배포 상태 경로를 읽지 않습니다 — 무엇을 근거로 판정합니까`);
}
if (!/vercelSha\s*=\s*await\s+readVercelSha\(\)/.test(code)) {
  err(`${RUNNER}가 관측 결과를 판정에 쓰지 않습니다`);
}

// ── 3. 못 읽었을 때 null로 떨어지는가 ──
//
// `|| mainSha` 같은 폴백이 하나라도 있으면 이 검사는 무의미해진다.
if (/readVercelSha\(\)\s*(\|\||\?\?)/.test(code)) {
  err(`${RUNNER}가 관측 실패에 폴백을 답니다 — 모름은 모름으로 남아야 합니다`);
}

// ── 4. 판정 모듈이 빈 값을 "같다"로 읽지 않는가 ──
// 여기는 주석을 **아예** 걷지 않았다. 기계 탐침 실측 (ed00c1a4, `//` 주석):
//   selfHeal.ts:245 `if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;` → rc=0 ✅
//   selfHeal.ts:265 `ok: vercel ? same(main, vercel) : null`         → rc=0 ✅
// 둘 다 주석 처리하면 모양 검사와 "비어 있으면 모름"이 사라지는데 통과했다.
const lib = stripJsComments(readFileSync(LIB, 'utf8'));
if (!/ok:\s*vercel\s*\?\s*same\(main,\s*vercel\)\s*:\s*null/.test(lib)) {
  err(`${LIB}의 Vercel 검사가 "비어 있으면 모름"을 유지하지 않습니다`);
}
if (!/\^\[0-9a-f\]\{7,40\}\$/.test(lib)) {
  err(`${LIB}의 관측 함수가 SHA 모양을 검사하지 않습니다 — 소음이 관측으로 들어옵니다`);
}

// ── 5. 주소가 배선돼 있는가 (있어야 관측이 가능하다) ──
// 배선도 같다. 그 한 줄을 주석 처리하면 관측 주소가 안 넘어가 **관측
// 경로가 영원히 모름**이 되는데 통과했다 (실측 rc=0). 키 자리만 센다.
const wf = stripYamlComments(readFileSync(WF, 'utf8'));
if (!/^\s*DEPLOY_STATUS_URL:\s*\$\{\{\s*secrets\./m.test(wf)) {
  err(`${WF}에 배포 상태 주소가 배선되지 않았습니다 — 관측 경로가 영원히 모름이 됩니다`);
}

// ── 6. 값이 로그에 새지 않는가 ──
if (/console\.log\([^)]*DEPLOY_STATUS_URL/.test(code) || /console\.log\([^)]*\bbase\b/.test(code)) {
  err(`${RUNNER}가 배포 상태 주소를 로그에 찍습니다`);
}

if (bad > 0) {
  console.error(`\n배포 증거 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 배포 증거 — 관측 없는 SHA 둔갑 없음 · 관측 경로 배선 · 폴백 없음 · 모양 검사 · 주소 비노출');
