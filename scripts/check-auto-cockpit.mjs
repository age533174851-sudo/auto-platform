// 자동매매 첫 화면이 "지금 내 돈이 움직이는가"에 거짓으로 답하지 않는가.
//
// 왜 이 검사가 있나
// ─────────────────
// 이 화면에는 그 질문의 주인이 **둘**이었다. AutotradeControl은 서버
// 예약·연결·실행기를 읽어 판정했고, AutoPage는 `useState('paper')` 로컬
// 토글만 보고 "모의 자동매매 모드 — 실제 자금 이동 없음"이라고 단정했다.
// 실전 예약이 켜져 있어도 그렇게 적혔다.
//
// 그래서 판정을 lib/ui/autoCockpit 한 곳으로 모았다. 이 검사는 그 계약이
// 다시 갈라지는 것을 막는다:
//
//   ① 판정이 한 곳에 있고 테스트가 실제로 돈다
//   ② 화면이 판정을 쓰고, 그 안에서 다시 판단하지 않는다
//   ③ 로컬 모드 토글이 실행 환경을 단정하지 않는다
//   ④ 못 읽은 것을 0/꺼짐으로 눕히지 않는다
//   ⑤ 검사기가 찾을 표식이 있다
//
// 실제 픽셀·상태 확인은 scripts/probe/auto-cockpit.mjs (수동).

import { readFileSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

let bad = false;
const err = (m) => { bad = true; console.error(`❌ ${m}`); };

const PLAN  = 'src/lib/ui/autoCockpit.ts';
const PLANT = 'src/lib/ui/autoCockpit.test.ts';
const PAGE  = 'src/components/pages/AutoPage.tsx';

for (const f of [PLAN, PLANT, PAGE]) {
  if (!existsSync(f)) err(`${f}를 찾지 못했습니다 — 이 검사가 무엇을 보는지 다시 확인하세요`);
}
if (bad) { console.error('\n검사할 파일을 못 읽었습니다. 여기서 멈춥니다.\n'); process.exit(1); }

const plan = stripJsComments(readFileSync(PLAN, 'utf8'));
const planT = readFileSync(PLANT, 'utf8');
const page = stripJsComments(readFileSync(PAGE, 'utf8'));

/* ── ① 판정이 한 곳에 있고 테스트가 돈다 ────────────────── */
if (!/export function cockpitVerdict\s*\(/.test(plan)) err(`${PLAN}: 첫 화면 판정 함수가 없습니다`);
if (!/export function runAutoCockpitTests/.test(planT)) err(`${PLANT}: 테스트가 없습니다`);
const runner = readFileSync('scripts/run-tests.mjs', 'utf8');
if (!/runAutoCockpitTests\s*\(\s*\)/.test(runner)) {
  err('scripts/run-tests.mjs에 runAutoCockpitTests()가 등록되지 않았습니다 — 테스트가 돌지 않습니다');
}

/* ── ② 판정은 서버가 만든 사실만 조합한다 ──────────────────
   여기서 새 판단을 만들면 서버와 화면이 갈라진다. 환경 판정은 UI-3 이전에
   만들어 둔 autoOverview가 정본이다. */
if (!/from '\.\/autoOverview'/.test(plan)) {
  err(`${PLAN}: 환경 판정을 autoOverview에서 가져오지 않습니다 — 같은 판단이 두 벌이 됩니다`);
}
/* **`enabled` 하나로 '실행 중'이라고 쓰지 않는다.** 이 파일에 RUNNING이라는
   상태 이름 자체를 두지 않는다 — 이름이 생기면 언젠가 enabled에 붙는다. */
if (/'RUNNING'/.test(plan)) {
  err(`${PLAN}: RUNNING 상태를 만듭니다 — 이 화면이 증명할 수 있는 것은 '켜져 있고 막히지 않았다'까지입니다`);
}
for (const st of ['UNKNOWN', 'OFF', 'BLOCKED', 'ARMED']) {
  if (!new RegExp(`'${st}'`).test(plan)) err(`${PLAN}: ${st} 상태가 없습니다`);
}

/* ── ③ 못 읽은 것을 0이나 꺼짐으로 눕히지 않는다 ────────────
   `Array.isArray`로 '읽었는가'를 먼저 가르지 않으면 null이 빈 배열과 같아지고,
   그 순간 "켜져 있는 자동매매가 없습니다"가 된다. */
if (!/Array\.isArray\(rows\)/.test(plan)) {
  err(`${PLAN}: 못 읽은 경우를 빈 목록과 구분하지 않습니다 — null이 '꺼짐'이 됩니다`);
}
if (!/activeCount:\s*null/.test(plan)) {
  err(`${PLAN}: 개수를 모를 때 null을 쓰지 않습니다 — 확인 못 한 것을 0으로 적지 마세요`);
}

/* ── ④ 화면이 판정을 쓰고, 안에서 다시 판단하지 않는다 ────── */
if (!/cockpitVerdict\s*\(/.test(page)) err(`${PAGE}: 첫 화면 판정을 쓰지 않습니다`);
{
  const hero = /function ExecutionTruthHero\([\s\S]*?\n\}/.exec(page);
  if (!hero) err(`${PAGE}: ExecutionTruthHero를 찾지 못했습니다`);
  else {
    if (!/cockpitVerdict\s*\(/.test(hero[0])) err(`${PAGE}: 첫 줄이 판정을 쓰지 않습니다`);
    /* 이 안에서 예약을 세거나 mode를 읽으면 판정 주인이 둘이 된다. */
    if (/\.filter\(|\.enabled|envOf\s*\(|headerEnvOf\s*\(/.test(hero[0])) {
      err(`${PAGE}: 첫 줄이 예약을 스스로 판단합니다 — 판정은 autoCockpit 한 곳입니다`);
    }
  }
}

/* ── ⑤ 로컬 토글이 실행 환경을 단정하지 않는다 ──────────────
   `execMode`는 서버를 부르지 않는 로컬 상태다. 그 값으로 "실제 자금 이동
   없음" 같은 현재 사실을 적으면, 실전 예약이 켜져 있어도 그렇게 보인다. */
for (const claim of ['실제 자금 이동 없음', '연결된 거래소로 실제 주문 실행']) {
  if (page.includes(claim)) {
    err(`${PAGE}: 로컬 모드 토글이 실행 환경을 단정합니다 ("${claim}")`);
  }
}
if (!/미리보기 모드/.test(page)) {
  err(`${PAGE}: 로컬 모드 선택의 범위를 밝히지 않습니다 — 실행 환경으로 읽힙니다`);
}

/* ── ⑥ 검사기·프로브가 찾을 표식 ─────────────────────────── */
for (const attr of ['data-region="executionTruth"', 'data-state=', 'data-env=']) {
  if (!page.includes(attr)) err(`${PAGE}: ${attr} 표식이 없습니다 — 상태 검사가 이 줄을 찾지 못합니다`);
}

/* ── ⑦ 첫 줄이 화면 맨 위에 있다 ──────────────────────────
   진단 카드가 실제 돈 상태보다 위에 오면 안 된다. */
{
  const iHero = page.indexOf('<ExecutionTruthHero');
  const iCtl = page.indexOf('<AutotradeControl');
  const iBoard = page.indexOf('<AutoStatusBoard');
  if (iHero < 0) err(`${PAGE}: 첫 줄을 그리지 않습니다`);
  else if (iCtl >= 0 && iHero > iCtl) err(`${PAGE}: 실행 상태가 제어판보다 아래에 있습니다`);
  else if (iBoard >= 0 && iHero > iBoard) err(`${PAGE}: 실행 상태가 진단판보다 아래에 있습니다`);
}

/* ── ⑧ 테스트가 위험한 케이스를 실제로 짚는다 ────────────── */
for (const [needle, why] of [
  ['LIVE_LIMITED', '실전이 섞였을 때를 검사하지 않습니다'],
  ['needsRebind', '연결이 끊긴 예약을 검사하지 않습니다'],
  ['STALE', '실행기가 끊긴 경우를 검사하지 않습니다'],
  ['cockpitVerdict(null', '못 읽은 경우를 검사하지 않습니다'],
  ['cockpitVerdict([]', '읽었는데 없는 경우를 검사하지 않습니다'],
]) {
  if (!planT.includes(needle)) err(`${PLANT}: ${why}`);
}

if (bad) {
  console.error('\n첫 화면이 실행 상태를 근거 없이 단정하거나, 판정 주인이 둘입니다.\n'
    + '실제 상태 확인은 scripts/probe/auto-cockpit.mjs 참조.\n');
  process.exit(1);
}
console.log('✅ 자동매매 첫 화면 계약 — 판정 하나 · 못 읽음≠꺼짐 · 로컬 토글이 환경을 단정하지 않음');
