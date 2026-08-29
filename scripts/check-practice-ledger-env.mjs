#!/usr/bin/env node
// scripts/check-practice-ledger-env.mjs
//
// **실전 거래를 연습 장부에 적지 않는다 — 다시는.**
//
// 무슨 일이 있었나
// ────────────────
// `tab:trading`의 브라우저 원화 연습 장부(`tg_paper_balance_v1`)에
// TESTNET·LIVE 체결이 함께 쌓이고 있었다. 장부를 바꾸는 자리가 여섯이었고
// **그중 다섯에 모드 검사가 없었다.** 한 자리만 고치고 끝냈다면 나머지
// 다섯으로 계속 섞였을 것이다.
//
// 그래서 두 겹으로 막았다:
//   ① 장부 함수가 환경을 인자로 **강제**하고 MOCK이 아니면 아무 일도 안 한다
//   ② 이 검사가 그 인자를 우회하는 길을 막는다
//
// 여기서 보는 것
// ──────────────
//   · 장부를 바꾸는 함수가 전부 환경을 첫 인자로 받는가
//   · 화면이 저장소 키를 직접 건드리지 않는가 (판정을 통째로 건너뛰는 길)
//   · 모르는 환경을 MOCK으로 읽지 않는가
//   · 정본 PAPER(서버)와 연습 장부를 한 파일에서 섞어 쓰지 않는가
//
// **비밀도 값도 읽지 않는다.** 이 검사가 보는 것은 호출 모양뿐이다.
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/**
 * 주석을 걷어낸다.
 *
 * **안 걷어내면 검사가 제 설명을 코드로 읽는다.** 이 저장소는 그 고장을
 * 이미 두 번 겪었다(#211의 표시 계층 검사, #215의 인증 계약 검사).
 * 이 PR도 "예전에는 paperBuy(...)를 불렀다"는 역사를 주석에 남긴다.
 */
function stripComments(src) {
  let out = ''; let i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c; i += 1;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') { out += s[i]; i += 1; } out += s[i] ?? ''; i += 1; }
      out += q; i += 1; continue;
    }
    out += c; i += 1;
  }
  return out;
}

/** 브라우저 로컬 연습 장부를 바꾸는 함수들 */
const MUTATORS = [
  'paperBuy', 'paperSell', 'closePaperPosition', 'reversePaperPosition',
  'checkPaperExits', 'savePaperBalance', 'resetPaperBalance',
];

/** 연습 장부가 저장되는 키 — 화면이 직접 건드리면 판정을 건너뛴다 */
const LEDGER_KEYS = ['tg_paper_balance_v1'];

/** 연습 장부를 쓰는 화면 */
const PRACTICE_SCREENS = ['src/components/pages/TradingPage.tsx'];

const STORE = 'src/lib/autotrade/store.ts';
const JUDGE = 'src/lib/autotrade/practiceEnv.ts';

// ── ① 판정 모듈이 살아 있는가 ──
{
  const src = read(JUDGE);
  if (!src) err(`${JUDGE}가 없습니다 — 환경 판정이 사라지면 막을 것이 없습니다`);
  else {
    const code = stripComments(src);
    if (!/export function mayMutatePracticeLedger/.test(code)) {
      err(`${JUDGE}: mayMutatePracticeLedger가 없습니다`);
    }
    // **MOCK 하나만 참이어야 한다.** 여기가 느슨해지면 나머지가 다 무의미하다.
    if (!/env === 'MOCK'/.test(code)) {
      err(`${JUDGE}: 로컬 장부 변경 허용이 \`env === 'MOCK'\`이 아닙니다`);
    }
    // 모르는 값을 MOCK으로 읽으면 오타 하나가 실전을 연습 장부에 적는 문이 된다.
    if (!/return 'UNKNOWN'/.test(code)) {
      err(`${JUDGE}: 모르는 모드를 UNKNOWN으로 돌려주지 않습니다`);
    }
  }
}

// ── ② 장부 함수가 환경을 강제로 받는가 ──
{
  const src = read(STORE);
  if (!src) err(`${STORE}가 없습니다`);
  else {
    const code = stripComments(src);
    for (const fn of MUTATORS) {
      const m = code.match(new RegExp(`export function ${fn}\\s*\\(([^)]*)\\)`, 's'));
      if (!m) { err(`${STORE}: ${fn}을 찾지 못했습니다 — 이름이 바뀌었다면 이 검사도 같이 고치세요`); continue; }
      const first = m[1].split(',')[0] ?? '';
      if (!/\benv\b/.test(first)) {
        err(`${STORE}: ${fn}이 환경을 첫 인자로 받지 않습니다`
          + '\n     기본값을 두면 안 적은 자리가 곧 실전을 연습 장부에 적는 자리가 됩니다');
      }
    }
    // 받기만 하고 확인 안 하면 받은 것이 아니다.
    if (!/mayMutatePracticeLedger\s*\(/.test(code)) {
      err(`${STORE}: 환경을 받아 놓고 mayMutatePracticeLedger로 확인하지 않습니다`);
    }
  }
}

// ── ③ 화면이 저장소 키를 직접 건드리지 않는가 ──
//
// 예전에는 TP/SL 편집이 `localStorage.setItem('tg_paper_balance_v1', …)`으로
// **판정을 통째로 건너뛰었다.** 모드 검사도 저장 규칙도 지나가지 않았다.
for (const rel of PRACTICE_SCREENS) {
  const src = read(rel);
  if (!src) { err(`${rel}이 없습니다`); continue; }
  const code = stripComments(src);
  for (const key of LEDGER_KEYS) {
    if (new RegExp(`(setItem|removeItem)\\s*\\(\\s*['"\`]${key}`).test(code)) {
      err(`${rel}: 저장소 키 '${key}'를 직접 씁니다 — 장부 함수를 거치세요`
        + '\n     직접 쓰면 환경 검사도 저장 규칙도 지나가지 않습니다');
    }
  }
  // 장부를 바꾸는 호출은 전부 환경을 먼저 넘겨야 한다.
  for (const fn of MUTATORS) {
    const calls = [...code.matchAll(new RegExp(`\\b${fn}\\s*\\(([^,)]*)`, 'g'))];
    for (const c of calls) {
      const firstArg = (c[1] ?? '').trim();
      // **화면에서는 환경을 리터럴로 박을 수 없다.**
      //
      // 처음엔 `'MOCK'` 리터럴도 인정했다. 그랬더니 모든 모드에서 도는
      // 자리에 `'MOCK'`을 적어 넣는 것으로 검사를 통과할 수 있었다 —
      // 막으려던 바로 그 혼합이 그대로 가능했다. 화면은 실제 `tradeMode`에서
      // 환경을 **유도**해야 한다.
      const looksEnv = /^tradeEnvOf\s*\(/.test(firstArg)
        || /^env[A-Za-z0-9_]*$/.test(firstArg)
        || /^[A-Za-z0-9_]*Env$/.test(firstArg);
      if (!looksEnv) {
        err(`${rel}: ${fn}(…)의 첫 인자가 실제 모드에서 나온 환경이 아닙니다 — \`${firstArg.slice(0, 40)}\``
          + '\n     화면에서는 tradeEnvOf(tradeMode)로 유도하세요. 리터럴을 박으면'
          + '\n     모든 모드에서 도는 자리가 MOCK인 척할 수 있습니다');
      }
    }
  }
}

// ── ④ 정본 PAPER와 연습 장부를 같은 화면에서 섞지 않는가 ──
//
// 서버 PAPER(USDT)와 브라우저 연습 장부(KRW)는 다른 장부다. 한 화면이
// 둘을 같이 읽으면 어느 쪽 숫자를 보여 주는지 화면에서 알 수 없게 된다.
for (const rel of PRACTICE_SCREENS) {
  const code = stripComments(read(rel) ?? '');
  const usesLocal = MUTATORS.some(fn => new RegExp(`\\b${fn}\\s*\\(`).test(code))
    || /loadPaperBalance\s*\(/.test(code);
  const usesServerPaper = /['"`]\/api\/paper\//.test(code);
  if (usesLocal && usesServerPaper) {
    err(`${rel}: 브라우저 연습 장부와 서버 PAPER를 한 화면에서 같이 씁니다`
      + '\n     둘은 통화도 정본 여부도 다릅니다 — 합쳐 보이면 사용자는 둘 다 못 믿습니다');
  }
}

// ── ⑤ 과거 데이터를 추측으로 정리하지 않는가 ──
//
// 줄마다 환경이 적혀 있지 않아 사후에 가려낼 수 없다. 지우는 것도
// 재분류하는 것도 추측이다.
{
  const code = stripComments(read(JUDGE) ?? '');
  if (!/LEGACY_LEDGER_STATUS/.test(code)) {
    err(`${JUDGE}: 이미 섞인 과거 장부를 어떻게 볼 것인지가 적혀 있지 않습니다`);
  }
  if (!/usableForStats:\s*false/.test(code)) {
    err(`${JUDGE}: 오염된 과거 장부를 성과·통계 근거에서 빼지 않았습니다`);
  }
}

if (bad === 0) {
  console.log('✅ 연습 장부 환경 격리 — 로컬 장부를 바꾸는 통로 '
    + `${MUTATORS.length}개가 전부 환경을 받고, MOCK에서만 움직입니다`);
} else {
  console.error('');
  console.error('   한 장부에 MOCK·TESTNET·LIVE가 섞이면, 줄마다 환경이 적혀 있지 않아');
  console.error('   사후에 가려낼 수 없습니다. 섞이기 전에 막는 수밖에 없습니다.');
}
process.exit(bad ? 1 : 0);
