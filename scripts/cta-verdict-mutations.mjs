#!/usr/bin/env node
// scripts/cta-verdict-mutations.mjs
//
// **실행 버튼 판정 + 확인 창의 순서.** 둘 다 "무엇을 막는가"이고,
// 배선 검사로는 알 수 없다. 그래서 게이트가 시험이다.
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
const REVIEW = 'src/lib/trading/paperOrderReview.ts';
const CLOSERV = 'src/lib/trading/paperCloseReview.ts';
const ONLY = process.argv.slice(2);

function gate() {
  const r = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  return { red: r.status !== 0 };
}

const CASES = [
  ['MUT-V1 ★ 청산 탭에서도 진입 주문을 통과시킨다 (실기 고장 그대로)', CTAV, 'RED',
   [[`    : !i.intentOpen ? '청산 화면입니다 — 진입 주문은 여기서 보내지 않습니다'\n`, ``]]],

  ['MUT-V2 ★ 보내는 중에도 또 보낸다 (중복 주문)', CTAV, 'RED',
   [[`    : i.busy ? '주문을 보내는 중입니다'\n`, ``]]],

  ['MUT-V3 ★ 게이트가 안 열렸는데 보낸다', CTAV, 'RED',
   [[`    : !i.gateReady ? '아직 주문을 보낼 수 없습니다'\n`, ``]]],

  ['MUT-V4 ★ 종목이 없는데 보낸다', CTAV, 'RED',
   [[`    : i.locked ? '거래할 종목이 없습니다'\n`, ``]]],

  ['MUT-V5 ★ 이 시장에 없는 방향을 보낸다', CTAV, 'RED',
   [[`    i.unavailable ? '이 시장에는 이 방향이 없습니다'\n`, ``]]],

  ['MUT-V6 ★ 방향을 고르지 않았는데 바로 확인 창을 연다', CTAV, 'RED',
   [[`  return { off: false, on, action: on ? 'OPEN_REVIEW' : 'CHOOSE_SIDE', reason: null };`,
     `  return { off: false, on, action: 'OPEN_REVIEW', reason: null };`]]],

  ['MUT-V7 ★ 반대 방향을 눌러도 그대로 보낸다', CTAV, 'RED',
   [[`  const on = !!i.sideChosen && !!i.sameSide;`, `  const on = !!i.sideChosen;`]]],

  ['MUT-V8 ★ 꺼져 있는데도 할 일을 내준다 (클릭이 살아난다)', CTAV, 'RED',
   [[`  if (offReason) return { off: true, on, action: 'NONE', reason: offReason };`,
     `  if (offReason) return { off: true, on, action: on ? 'SUBMIT' : 'NONE', reason: offReason };`]]],

  ['MUT-V9 ★ 막혔는데 off를 false로 적는다 (색만 회색)', CTAV, 'RED',
   [[`  if (offReason) return { off: true, on, action: 'NONE', reason: offReason };`,
     `  if (offReason) return { off: false, on, action: 'NONE', reason: offReason };`]]],

  ['MUT-V10 ★ 사유 순서를 바꿔 종목 없음보다 게이트를 먼저 말한다', CTAV, 'RED',
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

  // ── 확인 창의 **순서**에 관한 사실들 ──
  //
  //   "취소하면 안 나간다" · "두 번 눌러도 한 번만" · "여는 것만으로는
  //   아무것도 안 나간다"는 배선 검사로 알 수 없다. 전이를 깨 보고 시험이
  //   붙잡는지 확인한다.

  ['MUT-V11 ★ 취소했는데 창이 그대로 남는다', REVIEW, 'RED',
   [[`    case 'CANCEL':
      // 보내는 중에는 못 닫는다 — 결과 메시지가 갈 곳이 없어진다.
      if (phase === 'SUBMITTING') return stay(s);
      return stay(REVIEW_CLOSED);`,
     `    case 'CANCEL':
      return stay(s);`]]],

  ['MUT-V12 ★ 연타를 막지 않는다 (같은 주문이 두 번 나간다)', REVIEW, 'RED',
   [[`      return { state: { opened: s.opened, sent: true }, effects: ['SUBMIT'] };`,
     `      return { state: { opened: s.opened, sent: false }, effects: ['SUBMIT'] };`]]],

  ['MUT-V13 ★ 창을 여는 것만으로 주문이 나간다', REVIEW, 'RED',
   [[`      return stay({ opened: env.current, sent: false });`,
     `      return { state: { opened: env.current, sent: false }, effects: ['SUBMIT'] };`]]],

  ['MUT-V14 ★ 청산 탭에서도 창이 열린다', REVIEW, 'RED',
   [[`      if (!env.intentOpen) return stay(s);\n`, ``]]],

  ['MUT-V15 ★ 종목이 바뀌어도 창을 그대로 둔다 (읽은 것과 다른 주문)', REVIEW, 'RED',
   [[`      if (sameTicket(s.opened, env.current)) return stay(s);
      return stay(REVIEW_CLOSED);`,
     `      return stay(s);`]]],

  ['MUT-V16 ★ 정체성이 달라도 확인을 통과시킨다', REVIEW, 'RED',
   [[`    : !sameTicket(i.opened, i.current)
      ? '확인하던 주문과 지금 주문이 다릅니다 — 닫고 다시 확인하세요'\n`, ``]]],

  ['MUT-V17 ★ 게이트가 닫혔는데 확인을 통과시킨다', REVIEW, 'RED',
   [[`    : !i.gateReady ? '아직 주문을 보낼 수 없습니다'\n`, ``]]],

  ['MUT-V18 ★ 보내는 중에도 확인을 통과시킨다', REVIEW, 'RED',
   [[`    i.phase === 'SUBMITTING' || i.busy ? '주문을 보내는 중입니다'\n`, ``]]],

  ['MUT-V19 ★ 실패했는데 창을 닫는다 (사유가 사라진다)', REVIEW, 'RED',
   [[`      return stay({ opened: e.ok ? null : s.opened, sent: false });`,
     `      return stay({ opened: null, sent: false });`]]],

  ['MUT-V20 ★ 성공했는데 창이 남는다', REVIEW, 'RED',
   [[`      return stay({ opened: e.ok ? null : s.opened, sent: false });`,
     `      return stay({ opened: s.opened, sent: false });`]]],

  ['MUT-V21 ★ 꺼졌는데 할 일을 내준다', REVIEW, 'RED',
   [[`  if (offReason) return { off: true, action: 'NONE', reason: offReason };`,
     `  if (offReason) return { off: true, action: 'SUBMIT', reason: offReason };`]]],

  ['MUT-V22 ★ 없는 계획의 0을 값으로 적는다', REVIEW, 'RED',
   [[`  if (!plan.ok) return unknown(plan.reason || '주문 계획을 만들지 못했습니다');`, ``]]],

  ['MUT-V23 ★ 청산가가 없는데 거리를 적는다', REVIEW, 'RED',
   [[`  if (plan.liquidationPrice == null) return null;`, ``]]],

  ['MUT-V25 ★ 청산 탭에서도 확인을 통과시킨다 (실제 배선이 못 받던 조건)', REVIEW, 'RED',
   [[`    : !i.intentOpen ? '청산 화면입니다 — 진입 주문은 여기서 보내지 않습니다'\n`, ``]]],

  ['MUT-V26 ★ 청산으로 바뀌어도 창을 닫지 않는다', REVIEW, 'RED',
   [[`      if (!env.intentOpen) return stay(REVIEW_CLOSED);\n`, ``]]],

  ['MUT-V27 ★ 실행 버튼 판정을 무시하고 아무 때나 연다', REVIEW, 'RED',
   [[`  if (i.ctaAction !== 'OPEN_REVIEW') return false;\n`, ``]]],

  ['MUT-V24 ★ 표시 줄 하나가 조용히 사라진다', REVIEW, 'RED',
   [[`    { key: 'ENTRY_FEE', label: '예상 진입 수수료', value: planned(i.plan, i.plan.entryFee) },\n`, ``]]],

  ['OK-V2 확인 판정 정본에 주석 한 줄 추가', REVIEW, 'GREEN',
   [[`export function reviewReduce(`, `// 대조군\nexport function reviewReduce(`]]],

  // ── 전량청산의 **순서** (Phase 2D) ──
  //
  //   "첫 클릭에는 안 나간다" · "취소하면 안 나간다" · "연타해도 한 번" ·
  //   "사라진 포지션은 못 닫는다"는 배선 검사로 알 수 없다.

  ['MUT-W1 ★ 창을 여는 것만으로 청산이 나간다', CLOSERV, 'RED',
   [[`      return stay({ opened: { positionId: id }, sent: false });`,
     `      return { state: { opened: { positionId: id }, sent: false }, effects: ['CLOSE'] };`]]],

  ['MUT-W2 ★ 취소했는데 창이 남는다', CLOSERV, 'RED',
   [[`      if (phase === 'SUBMITTING') return stay(s);
      return stay(CLOSE_REVIEW_CLOSED);

    case 'CONFIRM': {`,
     `      return stay(s);

    case 'CONFIRM': {`]]],

  ['MUT-W3 ★ 연타를 막지 않는다 (같은 포지션이 두 번 닫힌다)', CLOSERV, 'RED',
   [[`      return { state: { opened: s.opened, sent: true }, effects: ['CLOSE'] };`,
     `      return { state: { opened: s.opened, sent: false }, effects: ['CLOSE'] };`]]],

  ['MUT-W4 ★ 이미 닫힌 포지션을 다시 닫는다', CLOSERV, 'RED',
   [[`    : !i.openIds.includes(id) ? '포지션이 더 이상 열려 있지 않습니다'\n`, ``]]],

  ['MUT-W5 ★ 사라진 창을 다른 포지션으로 재사용한다', CLOSERV, 'RED',
   [[`      if (env.openIds.includes(s.opened.positionId)) return stay(s);
      return stay(CLOSE_REVIEW_CLOSED);`,
     `      return stay(s);`]]],

  ['MUT-W6 ★ 실패했는데 창을 닫는다 (재시도 불가)', CLOSERV, 'RED',
   [[`      return stay({ opened: e.ok ? null : s.opened, sent: false });`,
     `      return stay({ opened: null, sent: false });`]]],

  ['MUT-W7 ★ 성공했는데 창이 남는다', CLOSERV, 'RED',
   [[`      return stay({ opened: e.ok ? null : s.opened, sent: false });`,
     `      return stay({ opened: s.opened, sent: false });`]]],

  ['MUT-W8 ★ 로그인 없이도 청산을 통과시킨다', CLOSERV, 'RED',
   [[`    : !i.hasAuth ? '로그인해야 청산할 수 있습니다'\n`, ``]]],

  ['MUT-W9 ★ 보내는 중에도 확인을 통과시킨다', CLOSERV, 'RED',
   [[`    i.phase === 'SUBMITTING' || i.busy ? '청산 요청을 보내는 중입니다'\n`, ``]]],

  ['MUT-W10 ★ 보내는 중인데 창을 닫는다 (결과가 갈 곳이 없다)', CLOSERV, 'RED',
   [[`    case 'CANCEL':
      // 보내는 중에는 못 닫는다 — 결과 메시지가 갈 곳이 없어진다.
      if (phase === 'SUBMITTING') return stay(s);`,
     `    case 'CANCEL':
      if (false) return stay(s);`]]],

  ['MUT-W11 ★ 본문에 체결가를 끼워 넣는다', CLOSERV, 'RED',
   [[`  return { positionId: String(positionId) };`,
     `  return { positionId: String(positionId), exitPrice: 0 } as any;`]]],

  ['MUT-W12 ★ 없는 손절가를 0으로 적는다', CLOSERV, 'RED',
   [[`  if (v == null || v === '' || typeof v === 'boolean') return unknown(reason);`,
     `  if (v == null) return { kind, amount: 0 };`]]],

  ['MUT-W13 ★ 표시 줄 하나가 조용히 사라진다', CLOSERV, 'RED',
   [[`    {
      key: 'MARGIN', label: '증거금',
      value: numberOr(p.margin, 'MONEY', '증거금을 읽지 못했습니다'),
    },\n`, ``]]],

  ['MUT-W14 ★ 장부에 없는 포지션의 창을 연다', CLOSERV, 'RED',
   [[`      if (!id || !env.openIds.includes(id)) return stay(s);`, `      if (!id) return stay(s);`]]],

  ['OK-W1 청산 판정 정본에 주석 한 줄 추가', CLOSERV, 'GREEN',
   [[`export function closeReviewReduce(`, `// 대조군\nexport function closeReviewReduce(`]]],

  ['OK-V1 판정 정본에 주석 한 줄 추가', CTAV, 'GREEN',
   [[`export function ctaVerdict(`, `// 대조군\nexport function ctaVerdict(`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: 시험(run-tests)\n총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

for (const [name, file, kind, cuts] of selected) {
  if (!existsSync(file)) { console.log(`  ⚠  ${name} — 파일이 없습니다`); noop += 1; continue; }
  const before = readFileSync(file, 'utf8');
  let after = before, missing = false;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) { missing = true; break; }
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
