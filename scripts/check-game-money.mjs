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
const SHEET = 'src/components/trading/TradeSheet.tsx';

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
const walk = (dir) => {
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
};

// 주문 본문을 만드는 곳에서 표시 함수가 값으로 쓰이면 안 된다
const sheet = code(read(SHEET));
const bodyBlock = (sheet.match(/const body: any = \{[\s\S]*?\};/) || [''])[0];
if (/format(GameMoney|MoneyForScope)/.test(bodyBlock)) {
  err(`${SHEET}의 주문 본문이 표시 함수를 거칩니다 — 글자가 주문 값이 됩니다`);
}
if (unit && new RegExp(`['"\`][^'"\`]*\\b${unit}\\b[^'"\`]*['"\`]`).test(bodyBlock)) {
  err(`${SHEET}의 주문 본문에 표시 단위가 들어갑니다`);
}

// 서버·엔진 쪽 어디에도 표시 함수가 들어오면 안 된다
for (const dir of ['src/app/api', 'src/lib/engine', 'worker/src']) {
  for (const f of walk(dir)) {
    const body = code(read(f));
    if (/from '[^']*trading\/gameMoney'/.test(body) || /require\([^)]*gameMoney/.test(body)) {
      err(`${f}가 표시 함수를 불러옵니다 — 게임머니는 화면에만 있어야 합니다`);
    }
  }
}

if (bad > 0) {
  console.error(`\n게임머니 표시 경계 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log(`✅ 게임머니 — 표시 전용(${unit}) · 환산 함수 없음 ·`
  + ' LIVE/모름 제외 · 주문 본문·엔진 비침투');
