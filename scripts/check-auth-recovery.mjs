#!/usr/bin/env node
// scripts/check-auth-recovery.mjs
//
// **인증 메일이 가리키는 경로에 실제로 라우트가 있는가.**
//
// 이 검사가 없어서 난 일
// ──────────────────────
// `sbResetPassword`는 메일을 `${origin}/auth/reset`으로 보내고 있었는데
// `src/app/auth/reset/`이 없었다. 요청 쪽도 있고 변경 쪽
// (`sbUpdatePassword`)도 있었는데 그 사이 착지만 비어 있었다. 사용자는
// 메일을 받고, 링크를 누르고, Next.js 404를 봤다. 실기기에서 재현됐다.
//
// 이 저장소가 이름 붙인 1번 고장이다: **만들어 놓고 배선을 안 함.**
// 시험으로는 못 잡는다 — 라우트의 존재는 파일 시스템의 사실이다.
// 그래서 파일 시스템을 본다.
import { readFileSync, existsSync } from 'node:fs';

const SUPA  = 'src/lib/supabase.ts';
const ORIGIN = 'src/lib/auth/siteOrigin.ts';
const LINK  = 'src/lib/auth/recoveryLink.ts';
const RESET = 'src/app/auth/reset/page.tsx';
const APP   = 'src/app';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  if (!existsSync(p)) { err(`${p}가 없습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
  return readFileSync(p, 'utf8');
};
/** 주석은 규율이 아니다 */
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const supa   = read(SUPA);
const origin = read(ORIGIN);
const link   = read(LINK);
const reset  = read(RESET);

// ══════════ ① 메일이 가리키는 경로에 라우트가 있다 ══════════
//
// 이것 하나가 이번 고장의 전부다.
{
  const src = code(origin);
  const block = /AUTH_RETURN_PATHS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src);
  if (!block) {
    err(`${ORIGIN}에서 AUTH_RETURN_PATHS를 찾지 못했습니다 — 복귀 경로 정본이 없습니다`);
  } else {
    const paths = [...block[1].matchAll(/'(\/[^']+)'/g)].map(m => m[1]);
    if (paths.length === 0) err(`${ORIGIN}의 AUTH_RETURN_PATHS가 비어 있습니다`);
    for (const p of paths) {
      // App Router: /auth/reset → src/app/auth/reset/page.tsx
      const page = `${APP}${p}/page.tsx`;
      const pageJs = `${APP}${p}/page.jsx`;
      const routeTs = `${APP}${p}/route.ts`;
      if (!existsSync(page) && !existsSync(pageJs) && !existsSync(routeTs)) {
        err(`인증 메일이 ${p}로 보내는데 그 라우트가 없습니다 (${page})`
          + '\n     사용자는 메일 링크를 누르고 404를 봅니다 — 실제로 일어난 고장입니다');
      }
    }
  }
}

// ══════════ ② 경로를 다시 적지 않는다 (정본이 하나다) ══════════
//
// 같은 문자열이 두 곳에 있으면 한쪽만 고쳐진다. 그때 메일은 옛 경로로
// 가고 라우트는 새 경로에 생긴다.
{
  const src = code(supa);
  for (const lit of ["'/auth/reset'", '"/auth/reset"', "'/auth/callback'", '"/auth/callback"']) {
    if (src.includes(lit)) {
      err(`${SUPA}가 복귀 경로 ${lit}를 직접 적습니다`
        + ' — AUTH_RETURN_PATHS를 쓰세요. 경로가 두 곳이면 한쪽만 고쳐집니다');
    }
  }
  if (!/AUTH_RETURN_PATHS\.reset/.test(src)) {
    err(`${SUPA}의 비밀번호 재설정이 경로 정본을 쓰지 않습니다`);
  }
  if (!/authReturnUrl\s*\(/.test(src)) {
    err(`${SUPA}가 복귀 주소 정본을 쓰지 않습니다`);
  }
}

// ══════════ ③ 출처를 버리지 않는다 ══════════
//
// `NEXT_PUBLIC_SITE_URL`이 없으면 브라우저의 현재 주소가 쓰인다. preview
// 배포에서 요청하면 그 주소로 메일이 가고, 배포가 지워지면 링크가 죽는다.
// 값만 돌려주면 그 차이를 아무도 알 수 없다.
{
  const src = code(origin);
  for (const k of ['CONFIGURED', 'BROWSER', 'UNKNOWN']) {
    if (!src.includes(k)) err(`${ORIGIN}에 출처 ${k}가 없습니다`);
  }
  if (!/canonical/.test(src)) {
    err(`${ORIGIN}가 "운영 정본인가"를 구분하지 않습니다`);
  }
  if (!/\^https\?:\\\/\\\//.test(src)) {
    err(`${ORIGIN}가 스킴을 확인하지 않습니다 — //evil.example.com이 통과합니다`);
  }
  // 운영 도메인을 코드에 박지 않는다
  const hard = src.match(/https:\/\/(?!app\.example\.com)[a-z0-9.-]+\.(?:com|app|io|dev|net)\b/gi) || [];
  if (hard.length > 0) {
    err(`${ORIGIN}에 도메인이 박혀 있습니다 (${hard.slice(0, 3).join(', ')})`
      + ' — 정본은 환경변수로 들어와야 미리보기에서도 시험할 수 있습니다');
  }
}

// ══════════ ④ 착지 화면이 경우를 구분한다 ══════════
{
  const src = code(link);
  for (const k of ['EXPIRED', 'REJECTED', 'WRONG_TYPE', 'NO_TOKEN', 'RECOVERY_TOKEN']) {
    if (!src.includes(k)) err(`${LINK}에 ${k} 판정이 없습니다 — 경우를 뭉뚱그리면 안내할 수 없습니다`);
  }
  // 실패 판정이 성공 판정보다 **앞**이어야 한다.
  //
  // 만료 링크에도 `type=recovery`가 같이 온다. 성공을 먼저 보면 만료된
  // 링크에 입력창을 띄우고 저장 단계에서야 실패한다.
  const iErr = src.indexOf("h.get('error')");
  const iOk = src.indexOf("h.get('access_token')");
  if (iErr < 0 || iOk < 0) err(`${LINK}에서 오류/토큰 판독을 찾지 못했습니다`);
  else if (iErr > iOk) {
    err(`${LINK}가 오류보다 토큰을 먼저 봅니다 — 만료 링크에 입력창이 뜹니다`);
  }
}

// ══════════ ⑤ 비밀을 남기지 않는다 ══════════
{
  for (const [rel, src] of [[LINK, link], [RESET, reset], [SUPA, supa]]) {
    const c = code(src);
    // 토큰·코드·비밀번호를 로그로 내보내지 않는가
    const logs = [...c.matchAll(/console\.(log|warn|error|info)\s*\(([^\n]*)/g)];
    for (const m of logs) {
      if (/access_token|refresh_token|token_hash|exchangeCode|\bcode\b|password|\bpw\b/i.test(m[2])) {
        err(`${rel}가 로그에 비밀을 담을 수 있습니다: console.${m[1]}(${m[2].slice(0, 60)}...)`);
      }
    }
  }
  // 착지 화면이 주소창에서 토큰을 지우는가
  if (!/history\.replaceState/.test(code(reset))) {
    err(`${RESET}가 주소창에서 토큰을 지우지 않습니다`
      + ' — 화면 캡처·공유·기록에 그대로 남습니다');
  }
}

// ══════════ ⑥ 열린 리다이렉트를 만들지 않는다 ══════════
{
  const src = code(link);
  if (!/export function safeReturnPath/.test(src)) {
    err(`${LINK}에 복귀 경로 검사가 없습니다`);
  } else {
    for (const [re, why] of [
      [/startsWith\('\/'\)/, '상대 경로만 받는지 보지 않습니다'],
      [/startsWith\('\/\/'\)/, '프로토콜 상대 URL(//evil.com)을 막지 않습니다'],
    ]) {
      if (!re.test(src)) err(`${LINK}의 복귀 경로 검사가 ${why}`);
    }
  }
  if (!/safeReturnPath\s*\(/.test(code(reset))) {
    err(`${RESET}가 복귀 경로 검사를 쓰지 않습니다 — 열린 리다이렉트가 됩니다`);
  }
}

// ══════════ ⑦ 세션 없이 비밀번호를 바꾸지 않는다 ══════════
//
// 같은 브라우저에 다른 계정이 로그인돼 있을 수 있다. 복구 세션 확인 없이
// `updateUser`를 부르면 **그 사람의** 비밀번호가 바뀐다.
{
  const src = code(reset);
  if (!/judgeNewPassword\s*\(/.test(src)) {
    err(`${RESET}가 저장 판정을 쓰지 않습니다`);
  }
  // ★ **이름이 아니라 파생을 본다.**
  //
  //   처음 판은 `hasRecoverySession`이라는 낱말만 찾았다. 그래서 그 값을
  //   `true`로 박는 변경이 그대로 통과했다(MUT-AR18) — 칸은 있고 확인은
  //   없는 상태다. 단계 계산은 `recoveryPhaseOf`가 갖고, 화면은 거기서
  //   나온 값을 그대로 넘겨야 한다.
  if (!/recoveryPhaseOf\s*\(/.test(src)) {
    err(`${RESET}가 단계 계산 정본을 쓰지 않습니다`
      + ' — 화면 안에서 단계를 정하면 시험이 닿지 못합니다');
  }
  if (!/hasRecoverySession:\s*computed\.canSave/.test(src)) {
    err(`${RESET}의 복구 세션 여부가 단계 계산에서 나오지 않습니다`
      + ' — 값을 박아 두면 세션 없이 저장이 열립니다');
  }
  // 화면의 `phase`가 **계산값에서 나오는가.**
  //
  // ★ 처음에는 `setPhase(`가 있는지만 봤다. 그래서 다른 이름의 상태를
  //   하나 더 두고 거기서 읽는 변경이 통과했다(MUT-AR22) — 정본은 남아
  //   있는데 화면이 안 쓰는 상태다. 이름을 금지하는 대신 **파생을 본다.**
  if (!/const phase: Phase = localPhase \?\? computed\.phase;/.test(src)) {
    err(`${RESET}의 단계가 recoveryPhaseOf의 계산값에서 나오지 않습니다`
      + ' — 화면이 따로 단계를 들고 있으면 둘이 갈립니다');
  }
  // `useState<Phase>`로 단계를 다시 들지 않는가
  if (/useState<Phase>/.test(src)) {
    err(`${RESET}가 단계를 상태로 다시 듭니다 — recoveryPhaseOf가 정본입니다`);
  }
  // 기다리다 못 받은 것을 "받았다"로 적지 않는가
  if (!/recoveryPhaseOf/.test(code(link)) || !/waitedOut/.test(code(link))) {
    err(`${LINK}에 대기 만료 판정이 없습니다 — 못 기다린 것이 통과가 됩니다`);
  } else {
    const fn = code(link).indexOf('export function recoveryPhaseOf');
    const body = code(link).slice(fn, fn + 900);
    if (!/if \(i\.waitedOut\) return \{ phase: 'blocked'/.test(body)) {
      err(`${LINK}가 대기 만료를 막지 않습니다 — 세션 없이 입력창이 열립니다`);
    }
    if (!/if \(i\.hasSessionUser\) return \{ phase: 'ready', canSave: true \}/.test(body)) {
      err(`${LINK}의 통과 경로가 세션 확인 하나가 아닙니다`);
    }
  }
  const iJudge = src.indexOf('judgeNewPassword');
  const iUpdate = src.indexOf('updateUser');
  if (iJudge >= 0 && iUpdate >= 0 && iJudge > iUpdate) {
    err(`${RESET}가 비밀번호를 바꾼 뒤에 판정합니다 — 판정이 먼저입니다`);
  }
  if (!/NO_SESSION/.test(code(link))) {
    err(`${LINK}에 세션 없음 판정이 없습니다`);
  }
}

if (bad > 0) {
  console.error(`\n인증 복구 배선 검사 실패 (${bad}건)`);
  console.error('\n   메일은 정상으로 보이고 링크만 안 되는 종류의 고장입니다.');
  process.exit(1);
}
console.log('✅ 인증 복구 배선 — 메일 경로에 라우트 존재 · 경로 정본 하나 ·'
  + ' 복귀 주소 출처 표시 · 만료/재사용/종류 구분 · 비밀 미기록 ·'
  + ' 열린 리다이렉트 금지 · 세션 확인 선행');
