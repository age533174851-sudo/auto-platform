#!/usr/bin/env node
// 키·시크릿·토큰의 **값이 어디에도 남지 않는가**를 저장소 전체에서 본다.
//
// 왜 시험으로 부족한가
// ────────────────────
// `credentialExposure.test.ts`는 **고친 자리**가 되돌아오지 않는지 본다.
// 그런데 이 유출의 특징은 **새 자리에서 또 생긴다**는 것이다: 거래소
// 쪽 마스킹을 지문으로 고치는 동안 KIS 라우트는 같은 함수를 복제해
// 앞뒤 4자를 계속 흘리고 있었다. 자리를 열거하는 시험으로는 다음에
// 생기는 자리를 막을 수 없다.
//
// 그래서 여기서는 **패턴 자체**를 금지한다.
//
// 무엇을 금지하는가
// ─────────────────
//   ① 자격증명 변수에 `.slice`/`.substring`/`.substr`를 걸어 조각 만들기
//   ② 그 조각을 로그·응답에 넣기
//   ③ 서명이 들어 있는 URL을 로그에 찍기
//
// 무엇을 허용하는가
// ─────────────────
//   · 해시/지문 (`createHash(...).digest('hex').slice(...)`, `fingerprintOf`)
//   · `Bearer ` 접두사 제거 (`authHeader.slice(7)`) — 검증용이고 출력이 아니다
//   · 키 파생 (`createHmac(...).digest('hex').slice(0, 64)`)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'worker/src'];
const errors = [];
const err = (m) => errors.push(m);

/** 주석은 코드가 아니다 — 검사기가 자기 설명문을 규칙으로 읽으면 오탐이 난다 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p, out); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => { try { return walk(r); } catch { return []; } });
if (files.length === 0) {
  err('검사할 파일을 하나도 찾지 못했습니다 — 경로가 바뀌었는지 확인해야 합니다');
}

/** 자격증명을 가리키는 이름 */
const CRED = '(?:apiKey|api_key|apiSecret|api_secret|appKey|appSecret|secret|sessionToken|session_token|accessToken|access_token|refreshToken|passphrase|privateKey|signature)';

/** 해시·지문을 거친 값은 안전하다 */
const HASHED = /digest\(\s*['"]hex['"]\s*\)|fingerprintOf|hashSecret|createHash|createHmac/;

let scanned = 0;
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const code = stripComments(raw);
  scanned += 1;

  // ── ① 자격증명에서 조각 만들기 ──
  const slicer = new RegExp(`${CRED}[\\w.?]{0,24}\\s*\\.\\s*(?:slice|substring|substr)\\s*\\(`, 'gi');
  for (const m of code.matchAll(slicer)) {
    const line = code.slice(0, m.index).split('\n').length;
    const text = code.split('\n')[line - 1] || '';
    if (HASHED.test(text)) continue;                      // 지문은 허용
    if (/\.slice\(\s*7\s*\)/.test(text)) continue;          // 'Bearer ' 제거
    if (/slice\(\s*0,\s*100\s*\)/.test(text)) continue;     // 입력 길이 제한
    err(`${f}:${line}: 자격증명에서 조각을 만듭니다 — 지문을 쓰십시오\n    ${text.trim()}`);
  }

  // ── ② 로그에 자격증명 이름이 등장 ──
  for (const [i, line] of code.split('\n').entries()) {
    if (!/console\.(log|error|warn|info|debug)\s*\(/.test(line)) continue;
    const bad = new RegExp(`\\b${CRED}\\b`, 'i');
    if (bad.test(line) && !HASHED.test(line) && !/<NAME>|<VALUE>|SERVICE_ROLE_KEY 확인/.test(line)) {
      err(`${f}:${i + 1}: 로그에 자격증명이 들어갑니다\n    ${line.trim()}`);
    }
    // 서명이 붙은 URL을 찍으면 서명이 통째로 샌다.
    if (/\burl\b/.test(line) && !/baseUrl|__agentproxy|html_url|avatar_url/.test(line)) {
      err(`${f}:${i + 1}: 로그에 URL이 들어갑니다 — 서명 질의가 함께 샙니다\n    ${line.trim()}`);
    }
  }
}

// ── ③ 마스킹 정본이 하나이고 지문을 쓰는가 ──
const CRYPTO = 'src/lib/exchanges/crypto.ts';
const crypto = stripComments(readFileSync(CRYPTO, 'utf8'));
if (!/fingerprintOf\(key\)/.test(crypto)) {
  err(`${CRYPTO}: maskKey가 지문을 쓰지 않습니다`);
}
if (/slice\(0, 4\)[\s\S]{0,40}slice\(-4\)/.test(crypto)) {
  err(`${CRYPTO}: 앞 4 + 뒤 4 마스킹이 돌아왔습니다`);
}
const dupes = files.filter((f) => f !== CRYPTO
  && /function maskKey/.test(stripComments(readFileSync(f, 'utf8'))));
for (const f of dupes) {
  err(`${f}: maskKey를 복제했습니다 — 한쪽만 고쳐지고 다른 쪽은 계속 흘립니다`);
}

if (errors.length) {
  for (const e of errors) console.error(`❌ ${e}`);
  process.exit(1);
}
console.log(`✅ 자격증명 노출 — ${scanned}개 파일에서 키·시크릿·토큰 값의 조각을 만들거나`
  + ' 로그·응답에 담는 자리가 없습니다 (지문만 씁니다)');
