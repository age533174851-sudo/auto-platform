#!/usr/bin/env node
// scripts/check-game-money.mjs
//
// **게임머니는 표시 단위다 — 회계 단위가 아니다.**
//
// 무엇이 걱정인가
// ───────────────
// 잔고 10,000을 `10,000 P`라고 적는 것은 글자만 바꾸는 일이다. 그런데
// 여기에 **배수나 환율이 하나라도 들어가면** `gameMoney.ts`가 두 번째 화폐
// 권위가 된다. 그러면
//
//   paper_accounts.balance · paper_challenge_cashflows · 실현손익 ·
//   수수료 · 펀딩 · 챌린지 initial_equity/target_equity
//
// 전부가 "어느 단위로 적힌 값인가"를 다시 물어야 한다. 장부 셋을 하나로
// 합치느라 한 일이 그 순간 무의미해진다.
//
// 그리고 **LIVE에 `P`가 붙는 것**이 제일 위험하다. 실제 돈을 게임머니처럼
// 보이게 만드는 표시다.
//
// 무엇을 보는가
// ─────────────
//   ① 환율·배수·역변환 함수가 **아예 없다**
//   ② LIVE·모르는 장부는 게임머니로 적지 않는다
//   ③ 주문 본문·수량·증거금 계산이 표시 함수를 거치지 않는다
//   ④ 표시명이 상수 하나다 (바꿔도 회계에 영향 0)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MONEY = 'src/lib/trading/gameMoney.ts';
const SHEET = 'src/components/trading/OrderControls.tsx';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const money = code(read(MONEY));

// ── ① 환율·배수·역변환이 없다 ──
//
// 자리가 있으면 언젠가 붙는다. 그래서 "쓰지 마라"가 아니라 "없다"로 둔다.
for (const m of (money.match(/export\s+(?:const|function)\s+([A-Za-z0-9_]+)/g) || [])) {
  const name = m.split(/\s+/).pop();
  if (/rate|ratio|multiplier|convert|exchange|toKrw|toUsd|parse|unformat|fromText/i.test(name)) {
    err(`${MONEY}가 환산에 쓸 수 있는 것을 내보냅니다 (${name}) — 표시 단위가 화폐가 됩니다`);
  }
}
// 숫자 리터럴 곱셈으로 몰래 환산하지 않는가
if (/\*\s*(?:RATE|UNIT_RATE|[0-9]{2,})/.test(money)) {
  err(`${MONEY}에 배수로 보이는 곱셈이 있습니다 — 게임머니는 1:1입니다`);
}

// ── ② LIVE는 게임머니가 아니다 ──
if (!/scope === 'PAPER' \|\| scope === 'CHALLENGE'/.test(money)) {
  err(`${MONEY}가 게임머니 장부를 PAPER·CHALLENGE로 한정하지 않습니다`);
}
if (/scope !== 'LIVE'/.test(money)) {
  err(`${MONEY}가 "LIVE만 아니면 게임머니"로 판단합니다 — 모르는 장부가 게임머니가 됩니다`);
}

// ── ④ 표시명이 상수 하나다 ──
if (!/export const GAME_MONEY_UNIT = '[^']+';/.test(money)) {
  err(`${MONEY}에 표시명 상수가 없습니다 — 이름을 바꾸려면 여러 곳을 고치게 됩니다`);
}
const unit = (money.match(/export const GAME_MONEY_UNIT = '([^']+)';/) || [])[1];

// ── ③ 회계 경로가 표시 함수를 거치지 않는다 ──
//
// **훑지 못한 것을 "비침투"로 적지 않는다.**
//
// 예전에는 `catch { return out; }`이었다. 뿌리 하나를 읽지 못하면 그
// 아래가 전부 검사 밖으로 나가고, 집계는 그대로 "주문 본문·엔진 비침투"를
// 적었다. 이 파일이 바로 아래에서 빈 `bodyBlock`을 잡는 이유와 같다 —
// **살아 있는 척하는 검사가 제일 나쁘다.** 한쪽에만 그 단언이 있었다.
//
// 실측했다 (main ed00c1a4):
//
//   worker/src/zzprobe/bad.ts 가 gameMoney를 import
//     → ❌ 표시 함수를 불러옵니다                       rc=1  (맞다)
//   같은 파일을 둔 채 그 뿌리 경로만 바꿈 (worker/src → worker/srcX)
//     → ✅ 게임머니 — … 주문 본문·엔진 비침투           rc=0
//   readdirSync를 빈 결과로 만듦
//     → ✅ 같은 문장                                     rc=0
//
// 세 뿌리 모두 고정 경로 읽기가 걸쳐 있지 않다(고정 읽기는
// `src/lib/trading`·`src/components/trading` 쪽이다). 그래서 어느 하나가
// 사라져도 아무도 눈치채지 못한다.
const walkFailures = [];
const walk = (dir) => {
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir); }
  catch (e) { walkFailures.push(`${dir} (${errCode(e)})`); return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); }
    catch (e2) { walkFailures.push(`${p} (${errCode(e2)})`); continue; }
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
};

/** 예외에서 원인 코드만 꺼낸다 — 경로 외의 내용은 적지 않는다 */
function errCode(e) {
  const c = e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e);
  return c.slice(0, 40);
}

// 주문 본문을 만드는 곳에서 표시 함수가 값으로 쓰이면 안 된다
const sheet = code(read(SHEET));
// 주문 본문은 이제 컨트롤러가 만든다. 여기를 안 옮기면 규칙이 **빈 문자열을
// 검사하며 조용히 통과**한다 — 살아 있는 척하는 검사가 제일 나쁘다.
const formSrc = code(read('src/lib/trading/useTradeForm.ts'));
const bodyBlock = (formSrc.match(/const body: any = \{[\s\S]*?\};/) || [''])[0];
if (!bodyBlock) {
  err('주문 본문 블록을 찾지 못했습니다 — 이 검사가 아무것도 안 보고 있습니다');
}
if (/format(GameMoney|MoneyForScope)/.test(bodyBlock)) {
  err(`${SHEET}의 주문 본문이 표시 함수를 거칩니다 — 글자가 주문 값이 됩니다`);
}
if (unit && new RegExp(`['"\`][^'"\`]*\\b${unit}\\b[^'"\`]*['"\`]`).test(bodyBlock)) {
  err(`${SHEET}의 주문 본문에 표시 단위가 들어갑니다`);
}

// 서버·엔진 쪽 어디에도 표시 함수가 들어오면 안 된다
//
// 뿌리마다 **몇 장 읽었는지 센다.** 오늘 실측: src/app/api 179 ·
// src/lib/engine 130 · worker/src 5개. 셋 다 비어 있을 수 없는 뿌리이므로
// "0개"는 경로가 바뀌었다는 뜻이고, 그때 "비침투"는 참이 아니다.
const scanned = [];
for (const dir of ['src/app/api', 'src/lib/engine', 'worker/src']) {
  const files = walk(dir);
  scanned.push({ dir, count: files.length });
  for (const f of files) {
    const body = code(read(f));
    if (/from '[^']*trading\/gameMoney'/.test(body) || /require\([^)]*gameMoney/.test(body)) {
      err(`${f}가 표시 함수를 불러옵니다 — 게임머니는 화면에만 있어야 합니다`);
    }
  }
}

if (walkFailures.length > 0) {
  for (const f of walkFailures) {
    err(`훑지 못한 디렉터리: ${f} — 못 본 것은 통과가 아닙니다.`
      + ' 그 아래에서 표시 함수가 회계 경로에 들어왔는지 아무도 보지 않았습니다');
  }
}
for (const s0 of scanned) {
  if (s0.count === 0) {
    err(`${s0.dir}에서 읽은 파일이 0개입니다 — 경로가 바뀌었는지 확인해야 합니다.`
      + ' 읽은 것이 0이면 "엔진 비침투"는 참이 아니라 아직 모른다는 뜻입니다');
  }
}

if (bad > 0) {
  console.error(`\n게임머니 표시 경계 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log(`✅ 게임머니 — 표시 전용(${unit}) · 환산 함수 없음 ·`
  + ' LIVE/모름 제외 · 주문 본문·엔진 비침투');
console.log(`   읽은 파일(하위 폴더 포함): ${scanned.map(s0 => `${s0.dir} ${s0.count}개`).join(' · ')}`
  + ' · 훑지 못한 디렉터리 0');
