#!/usr/bin/env node
// scripts/auth-recovery-mutations.mjs
//
// **원래 고장을 그대로 되돌려 보고, 게이트가 빨개지는지 본다.**
//
// 검사기를 새로 쓰면 가장 흔한 실패는 아무것도 안 잡는 검사기다.
// 그래서 실기기에서 난 그 결함 — `/auth/reset` 라우트가 없는 상태 — 을
// 제일 먼저 재현한다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

const LINK   = 'src/lib/auth/recoveryLink.ts';
const ORIGIN = 'src/lib/auth/siteOrigin.ts';
const SUPA   = 'src/lib/supabase.ts';
const RESET  = 'src/app/auth/reset/page.tsx';
const CHECK  = 'scripts/check-auth-recovery.mjs';

const ONLY = process.argv.slice(2);

/** 검사기 + 시험. 둘 중 하나라도 빨개지면 RED다 */
function gate() {
  const c = spawnSync('node', [CHECK], { encoding: 'utf8' });
  if (c.status !== 0) return { red: true, by: '인증 복구 검사기' };
  const t = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  if (t.status !== 0) return { red: true, by: '시험' };
  return { red: false, by: null };
}

/** 파일을 통째로 치운다 (라우트 소실 재현) */
const MOVE = Symbol('move');

const CASES = [
  // ── ★ 실제로 있었던 결함 ──
  ['MUT-AR1 /auth/reset 라우트가 없다 (원래 결함 · 사용자가 본 404)', RESET, 'RED', MOVE],

  // ── 경로 정본이 갈라진다 ──
  ['MUT-AR2 메일 경로를 supabase.ts에 다시 적는다', SUPA, 'RED',
   [[`  const redirectTo = authReturnUrl(getSiteOrigin(), AUTH_RETURN_PATHS.reset);`,
     `  const base = getSiteUrl();\n  const redirectTo = base ? \`\${base}/auth/reset\` : undefined;`]]],

  ['MUT-AR3 경로 정본에서 reset 항목을 뺀다', ORIGIN, 'RED',
   [[`  reset: '/auth/reset',`, `  reset: '/auth/reset-password',`]]],

  // ── 복귀 주소의 출처를 버린다 ──
  ['MUT-AR4 preview 주소를 운영 정본이라고 적는다', ORIGIN, 'RED',
   [[`    return { origin: br, source: 'BROWSER', canonical: false,`,
     `    return { origin: br, source: 'BROWSER', canonical: true,`]]],

  ['MUT-AR5 스킴 확인을 없앤다 (//evil.example.com 통과)', ORIGIN, 'RED',
   [[`  if (!/^https?:\\/\\//i.test(s)) return '';`, `  if (false) return '';`]]],

  ['MUT-AR6 origin을 몰라도 상대 경로를 redirectTo로 보낸다', ORIGIN, 'RED',
   [[`  if (!o?.origin) return undefined;`, `  if (false) return undefined;`]]],

  // ── 착지 판정이 경우를 뭉갠다 ──
  ['MUT-AR7 만료 링크보다 토큰을 먼저 본다 (만료에 입력창이 뜬다)', LINK, 'RED',
   [[`  const err = h.get('error') || q.get('error') || '';`,
     `  if (h.get('access_token')) {
    return { code: 'RECOVERY_TOKEN', canProceed: false, awaitsSession: true, exchangeCode: null,
      offerResend: false, message: '재설정 링크를 확인하고 있습니다...' };
  }
  const err = h.get('error') || q.get('error') || '';`]]],

  ['MUT-AR8 가입 확인 링크로도 비밀번호를 바꾸게 한다', LINK, 'RED',
   [[`  if (type && type !== 'recovery') {`, `  if (false) {`]]],

  ['MUT-AR9 만료를 일반 거부로 뭉갠다', LINK, 'RED',
   [[`    const expired = /otp_expired|expired/i.test(\`\${err} \${errCode}\`);`,
     `    const expired = false;`]]],

  ['MUT-AR10 토큰이 없어도 진행시킨다', LINK, 'RED',
   [[`    code: 'NO_TOKEN', canProceed: false, awaitsSession: false, exchangeCode: null,`,
     `    code: 'NO_TOKEN', canProceed: true, awaitsSession: false, exchangeCode: null,`]]],

  // ── 비밀이 새 나간다 ──
  ['MUT-AR11 오류 메시지에 토큰을 담는다', LINK, 'RED',
   [[`        message: '재설정 링크가 만료되었습니다. 보안을 위해 링크는 일정 시간 뒤 사용할 수 없습니다 '
          + '— 아래에서 새 링크를 받아 주세요.',`,
     `        message: '재설정 링크가 만료되었습니다: ' + String(h.get('access_token') || ''),`]]],

  ['MUT-AR12 주소창에서 토큰을 지우지 않는다', RESET, 'RED',
   [[`      window.history.replaceState(null, '', window.location.pathname);`,
     `      void window.history;`]]],

  ['MUT-AR13 토큰을 콘솔에 찍는다', RESET, 'RED',
   [[`  const strength = checkPasswordStrength(pw);`,
     `  const strength = checkPasswordStrength(pw);
  console.log('[reset] access_token', landed.hash);`]]],

  // ── 열린 리다이렉트 ──
  ['MUT-AR14 프로토콜 상대 URL을 통과시킨다 (//evil.example.com)', LINK, 'RED',
   [[`  if (v.startsWith('//')) return fallback;   // 프로토콜 상대 URL`, ``]]],

  ['MUT-AR15 절대 URL을 그대로 복귀 경로로 쓴다', LINK, 'RED',
   [[`  if (!v.startsWith('/')) return fallback;   // 절대 URL·스킴 전부 거절`, ``]]],

  ['MUT-AR16 착지 화면이 복귀 경로를 검사하지 않는다', RESET, 'RED',
   [[`  const backTo = safeReturnPath(`, `  const backTo = String(`]]],

  // ── 세션 없이 비밀번호를 바꾼다 ──
  ['MUT-AR17 복구 세션 없이도 저장한다 (남의 비밀번호를 바꾼다)', LINK, 'RED',
   [[`  if (!i?.hasRecoverySession) {`, `  if (false) {`]]],

  ['MUT-AR18 착지 화면이 세션 여부를 판정에 안 넘긴다', RESET, 'RED',
   [[`      hasRecoverySession: computed.canSave,`, `      hasRecoverySession: true,`]]],

  ['MUT-AR19 두 비밀번호가 달라도 저장한다', LINK, 'RED',
   [[`  if (i.password !== i.confirm) {`, `  if (false) {`]]],

  ['MUT-AR20 강도 검사를 없앤다', LINK, 'RED',
   [[`  if (!i.strengthOk) {`, `  if (false) {`]]],

  ['MUT-AR21 세션을 못 기다렸는데 입력창을 연다', LINK, 'RED',
   [[`  if (i.waitedOut) return { phase: 'blocked', canSave: false };`,
     `  if (i.waitedOut) return { phase: 'ready', canSave: true };`]]],

  ['MUT-AR22 화면이 단계를 직접 세팅한다 (정본 우회)', RESET, 'RED',
   [[`  const phase: Phase = localPhase ?? computed.phase;`,
     `  const [directPhase, setPhase] = useState<Phase>('ready');
  void setPhase;
  const phase: Phase = localPhase ?? directPhase;`]]],

  // ── 대조군 ──
  ['OK-AR1 판정 파일에 주석 한 줄 추가', LINK, 'GREEN',
   [[`export function readRecoveryLink(`, `// 대조군\nexport function readRecoveryLink(`]]],
  ['OK-AR2 복귀 주소 파일에 주석 한 줄 추가', ORIGIN, 'GREEN',
   [[`export function resolveSiteOrigin(`, `// 대조군\nexport function resolveSiteOrigin(`]]],
  ['OK-AR3 착지 화면에 주석 한 줄 추가', RESET, 'GREEN',
   [[`export default function ResetPasswordPage(`, `// 대조군\nexport default function ResetPasswordPage(`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;

// ── --audit: 뮤테이션 잔재 검사 ──
//
// 스윕이 중간에 죽으면(컨테이너 재시작 등) 되돌리기가 실행되지 않고
// 페이로드가 작업 트리에 남는다. 실제로 그렇게 커밋될 뻔했다.
if (process.env.AUTH_AUDIT === '1' || ONLY.includes('--audit')) {
  let dirty = 0;
  if (existsSync(`${RESET}.mutbak`)) { console.log(`  ✗ 잔재: ${RESET}가 치워진 채입니다`); dirty += 1; }
  for (const [name, file, , cuts] of CASES) {
    if (cuts === MOVE || !existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const [from, to] of cuts) {
      if (to && !src.includes(from) && src.includes(to)) {
        console.log(`  ✗ 잔재: ${name}\n      ${file}`); dirty += 1;
      }
    }
  }
  console.log(dirty === 0 ? '✅ 뮤테이션 잔재 없음'
    : `❌ 뮤테이션 잔재 ${dirty}건 — 되돌린 뒤 다시 실행하세요`);
  process.exit(dirty === 0 ? 0 : 1);
}

console.log(`게이트: 인증 복구 검사기 + 전체 시험\n총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

for (const [name, file, kind, cuts] of selected) {
  if (!existsSync(file)) { console.log(`  ⚠  ${name} — 파일이 없습니다`); noop += 1; continue; }

  // 파일을 통째로 치우는 경우 (라우트 소실)
  if (cuts === MOVE) {
    const bak = `${file}.mutbak`;
    renameSync(file, bak);
    let res;
    try { res = gate(); } finally { renameSync(bak, file); }
    if (res.red) { console.log(`  ●  ${name} — RED (검출: ${res.by})`); detected += 1; }
    else { console.log(`  ✗  ${name} — GREEN (새 나감)`); missed += 1; }
    continue;
  }

  const before = readFileSync(file, 'utf8');
  let after = before, missing = false;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) { missing = true; break; }
    // ★ 함수로 넘긴다. 문자열 치환은 `$'`를 "매치 뒤 전체"로 해석한다.
    after = after.replace(from, () => to);
  }
  if (missing || after === before) {
    console.log(`  ⚠  ${name} — 대상 문구를 찾지 못했습니다`);
    noop += 1; continue;
  }

  writeFileSync(file, after);
  let res;
  try { res = gate(); } finally { writeFileSync(file, before); }

  if (kind === 'RED') {
    if (res.red) { console.log(`  ●  ${name} — RED (검출: ${res.by})`); detected += 1; }
    else { console.log(`  ✗  ${name} — GREEN (새 나감)`); missed += 1; }
  } else {
    if (!res.red) { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); greenOk += 1; }
    else { console.log(`  ✗  ${name} — RED (과도 검출: ${res.by})`); greenBad += 1; }
  }
}

console.log(`\n검출 ${detected} / 누락 ${missed} / 판정불가 ${noop}`
  + ` / 대조군 PASS ${greenOk} · 과도검출 ${greenBad}`);
process.exit(missed > 0 || greenBad > 0 || noop > 0 ? 1 : 0);
