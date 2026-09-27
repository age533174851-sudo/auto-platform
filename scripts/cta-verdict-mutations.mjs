#!/usr/bin/env node
// scripts/cta-verdict-mutations.mjs
//
// **실행 버튼 판정을 하나씩 무너뜨리고, 그때 시험이 빨개지는지 본다.**
//
// 왜 따로인가
// ───────────
// `check-canonical-trading.mjs`는 **배선**을 본다 — 색·DOM·클릭이 같은
// 값을 보는가. 그 판정이 **무엇을 막는가**는 배선 검사로 알 수 없다.
// 실기에서 난 고장이 바로 그 둘의 틈이었다:
//
//   버튼은 회색이었다(색은 맞았다). 그런데 DOM은 안 꺼졌고,
//   `form.submit()`은 화면의 intent를 모른다 —
//   **청산 탭에서 진입 주문이 나갈 수 있었다.**
//
// 그래서 여기 게이트는 시험(`scripts/run-tests.mjs`)이다. 판정에서 방어를
// 하나씩 떼고, 시험이 실제로 그것을 붙잡는지 확인한다. 낱말이 아니라
// 입력→출력을 본다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CTAV = 'src/lib/trading/ctaVerdict.ts';
const ONLY = process.argv.slice(2);

function gate() {
  const r = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  return { red: r.status !== 0 };
}

const CASES = [
  ['MUT-V1 ★ 청산 탭에서도 진입 주문을 통과시킨다 (실기 고장 그대로)', 'RED',
   [[`    : !i.intentOpen ? '청산 화면입니다 — 진입 주문은 여기서 보내지 않습니다'\n`, ``]]],

  ['MUT-V2 ★ 보내는 중에도 또 보낸다 (중복 주문)', 'RED',
   [[`    : i.busy ? '주문을 보내는 중입니다'\n`, ``]]],

  ['MUT-V3 ★ 게이트가 안 열렸는데 보낸다', 'RED',
   [[`    : !i.gateReady ? '아직 주문을 보낼 수 없습니다'\n`, ``]]],

  ['MUT-V4 ★ 종목이 없는데 보낸다', 'RED',
   [[`    : i.locked ? '거래할 종목이 없습니다'\n`, ``]]],

  ['MUT-V5 ★ 이 시장에 없는 방향을 보낸다', 'RED',
   [[`    i.unavailable ? '이 시장에는 이 방향이 없습니다'\n`, ``]]],

  ['MUT-V6 ★ 방향을 고르지 않았는데 바로 보낸다', 'RED',
   [[`  return { off: false, on, action: on ? 'SUBMIT' : 'CHOOSE_SIDE', reason: null };`,
     `  return { off: false, on, action: 'SUBMIT', reason: null };`]]],

  ['MUT-V7 ★ 반대 방향을 눌러도 그대로 보낸다', 'RED',
   [[`  const on = !!i.sideChosen && !!i.sameSide;`, `  const on = !!i.sideChosen;`]]],

  ['MUT-V8 ★ 꺼져 있는데도 할 일을 내준다 (클릭이 살아난다)', 'RED',
   [[`  if (offReason) return { off: true, on, action: 'NONE', reason: offReason };`,
     `  if (offReason) return { off: true, on, action: on ? 'SUBMIT' : 'NONE', reason: offReason };`]]],

  ['MUT-V9 ★ 막혔는데 off를 false로 적는다 (색만 회색)', 'RED',
   [[`  if (offReason) return { off: true, on, action: 'NONE', reason: offReason };`,
     `  if (offReason) return { off: false, on, action: 'NONE', reason: offReason };`]]],

  ['MUT-V10 ★ 사유 순서를 바꿔 종목 없음보다 게이트를 먼저 말한다', 'RED',
   [[`    i.unavailable ? '이 시장에는 이 방향이 없습니다'\n`
     + `    : i.locked ? '거래할 종목이 없습니다'\n`
     + `    : !i.intentOpen ? '청산 화면입니다 — 진입 주문은 여기서 보내지 않습니다'\n`
     + `    : i.busy ? '주문을 보내는 중입니다'\n`
     + `    : !i.gateReady ? '아직 주문을 보낼 수 없습니다'\n`,
     `    !i.gateReady ? '아직 주문을 보낼 수 없습니다'\n`
     + `    : i.unavailable ? '이 시장에는 이 방향이 없습니다'\n`
     + `    : i.locked ? '거래할 종목이 없습니다'\n`
     + `    : !i.intentOpen ? '청산 화면입니다 — 진입 주문은 여기서 보내지 않습니다'\n`
     + `    : i.busy ? '주문을 보내는 중입니다'\n`]]],

  ['OK-V1 판정 정본에 주석 한 줄 추가', 'GREEN',
   [[`export function ctaVerdict(`, `// 대조군\nexport function ctaVerdict(`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: 시험(run-tests)\n총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

for (const [name, kind, cuts] of selected) {
  if (!existsSync(CTAV)) { console.log(`  ⚠  ${name} — 파일이 없습니다`); noop += 1; continue; }
  const before = readFileSync(CTAV, 'utf8');
  let after = before, missing = false;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) { missing = true; break; }
    after = after.replace(from, () => to);
  }
  if (missing || after === before) {
    console.log(`  ⚠  ${name} — 대상 문구를 찾지 못했습니다`);
    noop += 1; continue;
  }
  writeFileSync(CTAV, after);
  let res;
  try { res = gate(); } finally { writeFileSync(CTAV, before); }

  if (kind === 'RED') {
    if (res.red) { console.log(`  ●  ${name} — RED (검출)`); detected += 1; }
    else { console.log(`  ✗  ${name} — GREEN (새 나감)`); missed += 1; }
  } else {
    if (!res.red) { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); greenOk += 1; }
    else { console.log(`  ✗  ${name} — RED (과도 검출)`); greenBad += 1; }
  }
}

console.log(`\n검출 ${detected} / 누락 ${missed} / 판정불가 ${noop}`
  + ` / 대조군 PASS ${greenOk} · 과도검출 ${greenBad}`);
process.exit(missed > 0 || greenBad > 0 || noop > 0 ? 1 : 0);
