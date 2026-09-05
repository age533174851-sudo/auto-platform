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
  /* 함수 조각을 정규식 `[\s\S]*?\n\}` 로 잘랐더니, 시그니처가 여러 줄이
     되자 **타입 블록의 닫는 괄호**까지만 잡혀서 본문을 못 봤다. 그 상태로
     "판정을 쓰지 않습니다"가 떴다 — 검사기가 코드가 아니라 줄바꿈을 보고
     있었던 것이다. 다음 top-level 함수 앞까지 인덱스로 자른다. */
  const start = page.indexOf('function ExecutionTruthHero(');
  const hero = start < 0 ? null : (() => {
    const next = page.indexOf('\nfunction ', start + 1);
    return page.slice(start, next < 0 ? page.length : next);
  })();
  if (!hero) err(`${PAGE}: ExecutionTruthHero를 찾지 못했습니다`);
  else {
    if (!/cockpitVerdict\s*\(/.test(hero)) err(`${PAGE}: 첫 줄이 판정을 쓰지 않습니다`);
    /* 이 안에서 예약을 세거나 mode를 읽으면 판정 주인이 둘이 된다. */
    if (/\.filter\(|\.enabled|envOf\s*\(|headerEnvOf\s*\(/.test(hero)) {
      err(`${PAGE}: 첫 줄이 예약을 스스로 판단합니다 — 판정은 autoCockpit 한 곳입니다`);
    }
    /* 6가지 답이 실제로 그려지는가. 표식만 있고 값이 없으면 첫 Fold가
       질문에 답하지 않는다. */
    for (const k of ['env', 'count', 'executable', 'targets', 'lastDecision', 'problem']) {
      if (!hero.includes(`data-truth="${k}"`)) {
        err(`${PAGE}: 첫 줄에 ${k} 표식이 없습니다 — 첫 화면이 그 질문에 답하지 않습니다`);
      }
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

/* ── ⑤-2 같은 화면의 다른 카드도 환경을 단정하지 않는다 ──────
   AutotradeControl은 읽기 실패 때도 schedules를 []로 두고, 그것을
   headerEnvOf에 넣어 기본값 TESTNET을 얻고 있었다. 그래서 아무것도 읽지
   못한 채 "자동매매 (테스트넷) TESTNET"이라고 단정했고, 첫 줄이 LIVE인데
   바로 아래 카드가 TESTNET이라고 말하는 화면이 실제로 찍혔다. */
{
  const CTL = 'src/components/AutotradeControl.tsx';
  if (!existsSync(CTL)) err(`${CTL}를 찾지 못했습니다`);
  else {
    const ctl = stripJsComments(readFileSync(CTL, 'utf8'));
    if (!/schedulesRead\s*=\s*Array\.isArray\(/.test(ctl)) {
      err(`${CTL}: 못 읽은 것과 빈 목록을 가르지 않습니다 — 읽기 실패가 TESTNET이 됩니다`);
    }
    if (!/schedulesRead\s*\?\s*autoTitle\(/.test(ctl)) {
      err(`${CTL}: 못 읽었는데도 환경이 붙은 제목을 씁니다`);
    }
    if (!/schedulesRead\s*\?\s*\(/.test(ctl)) {
      err(`${CTL}: 못 읽었는데도 환경 배지를 그립니다`);
    }
  }
}

/* ── ⑤-3 읽는 곳이 하나다 ────────────────────────────────
   첫 줄과 아래 카드가 각자 `/api/autotrade/schedule`을 불렀다. 판정 함수는
   하나여도 **읽은 시점이 둘**이라 네트워크 타이밍이 갈리면 서로 다른 상태를
   보여 줄 수 있었다. 실제로 "첫 줄 LIVE · 아래 TESTNET"이 찍혔다.
   (두 소유자는 인증 경로마저 달랐다 — 하나는 Supabase 세션, 하나는
   localStorage 관례 키. 한쪽만 권한이 있는 상태가 가능했다.) */
{
  const CTL = 'src/components/AutotradeControl.tsx';
  const ctl = existsSync(CTL) ? stripJsComments(readFileSync(CTL, 'utf8')) : '';
  /* **읽기만 센다.** 처음엔 PATCH(예약 끄기)까지 세어서, 쓰기를 하는 것을
     "두 번째 소유자"라고 잘못 잡았다. 뒤따르는 옵션에 method가 있으면 쓰기다. */
  const readsOf = (src) => {
    let n = 0;
    for (const m of src.matchAll(/fetch\(\s*'\/api\/autotrade\/schedule/g)) {
      if (!/method\s*:/.test(src.slice(m.index, m.index + 160))) n++;
    }
    return n;
  };
  const pageFetches = readsOf(page);
  const ctlFetches = readsOf(ctl);
  if (ctlFetches < 1) err(`${CTL}: 예약을 읽는 곳이 없습니다`);
  /* 화면 표시를 위한 두 번째 읽기를 막는다. AutoPage에 남아 있는 하나는
     전체 정지가 **실제로 무엇을 껐는지** 확인하는 write 검증이고, 그것을
     없애면 "모두 중단됨"을 서버 확인 없이 적게 되므로 남긴다. */
  if (pageFetches > 1) {
    err(`${PAGE}: 예약을 ${pageFetches}번 읽습니다 — 표시용 읽기는 한 곳이어야 합니다`);
  }
  /* 이름 앞부분만 맞아도 통과하던 규칙이었다 — `onSnapshotX`로 바꿔도
     지나갔다. 이 저장소에서 같은 형태의 구멍이 세 번째다. 실제 **배선**을
     본다: 화면이 넘기고(prop), 카드가 부른다(호출). */
  if (!/onSnapshot=\{/.test(page)) {
    err(`${PAGE}: 아래 카드에 스냅샷 콜백을 넘기지 않습니다 — 읽는 곳이 둘이 됩니다`);
  }
  /* 본문에 `onSnapshot(...)` 호출이 남아 있어도, **인자로 받지 않으면**
     그 이름은 어디서도 오지 않는다. 실제로 시그니처에서만 지운 변형이
     빠져나갔다. 받는 자리와 부르는 자리를 둘 다 본다. */
  {
    const i = ctl.indexOf('export default function AutotradeControl(');
    const sig = i < 0 ? '' : ctl.slice(i, ctl.indexOf(') {', i) + 3);
    if (!/\bonSnapshot\b/.test(sig)) {
      err(`${CTL}: 스냅샷 콜백을 인자로 받지 않습니다 — 위로 올릴 방법이 없습니다`);
    }
  }
  if (!/\bonSnapshot\s*\(/.test(ctl)) {
    err(`${CTL}: 읽은 스냅샷을 위로 올리지 않습니다`);
  }
  /* 첫 줄이 자기 fetch 결과를 쓰면 다시 두 소유자가 된다. */
  if (/loadSchedules\(\)[\s\S]{0,200}?setSchedRows/.test(page)) {
    err(`${PAGE}: 검증용 읽기 결과를 화면 표시에 씁니다 — 소유자가 둘이 됩니다`);
  }
}

/* ── ⑤-4 전역 관문을 판정에 넣는다 ───────────────────────
   예약 줄이 멀쩡해도 자동 실행 열쇠가 없으면 크론이 진입 엔진을 부르지
   못한다. 그 판정은 이미 autotradeHealth에 있다. 첫 줄이 그것을 안 보면
   "실행 가능"이라고 적어 놓고 아래 안전 점검에는 "막힘"이 뜨는 화면이 된다. */
if (!/health\?:|health\b/.test(plan) || !/UNCONFIRMED/.test(plan)) {
  err(`${PLAN}: 전역 관문(autotradeHealth)을 판정에 넣지 않습니다`);
}
if (!/gates === null \|\| gateUnknown\.length > 0/.test(plan)) {
  err(`${PLAN}: 관문을 확인하지 못한 경우를 ARMED로 올리지 않는다는 계약이 없습니다`);
}
/* 함수 안에서 health를 받기만 하고 **JSX가 안 넘기면** 언제나 undefined다.
   그 상태로도 위 규칙은 통과했다 — 받는 쪽이 아니라 주는 쪽을 본다. */
if (!/<ExecutionTruthHero[^>]*health=\{/.test(page)) {
  err(`${PAGE}: 첫 줄에 전역 관문(health)을 넘기지 않습니다 — 항상 '확인 못 함'이 됩니다`);
}

/* ── ⑤-5 스냅샷 발행이 의미로 비교된다 ──────────────────
   `autotradeHealth()`는 렌더마다 새 배열을 준다. 참조로 비교하면 값이 안
   바뀌어도 늘 "달라졌다"가 되고, 부모 → 자식 → 새 배열 → 부모 … 구조가
   만들어진다. 실측으로 폭주하지는 않았지만 **안 도는 이유가 계약이 아니라
   우연**이다. */
if (!/export function snapshotSignature/.test(plan)) {
  err(`${PLAN}: 스냅샷을 의미로 비교하는 함수가 없습니다`);
}
if (/Date\.now\(\)|Math\.random\(\)/.test(
  (/export function snapshotSignature[\s\S]*?\n\}/.exec(plan) || [''])[0])) {
  err(`${PLAN}: 서명에 매번 변하는 값이 들어갑니다 — 그러면 아무것도 막지 못합니다`);
}
/* 서명은 **원본 필드를 손으로 나열**해서 만들면 조용히 어긋난다. 화면 결과를
   바꾸는데 목록에 없는 필드가 생기면 값이 바뀌어도 서명은 그대로다. 실제로
   `runtime.lastEvaluationAtMs`·`connectionNote`·`strategyNote`·health의 `label`·
   같은 id에서의 `symbol` 다섯 자리가 빠져 있었다. 그래서 입력이 아니라
   **부모가 실제로 관찰하는 결과**(판정 + 정지 대상)로만 만들게 못박는다. */
{
  const i = plan.indexOf('export function snapshotSignature');
  const body = i < 0 ? '' : plan.slice(i, (() => {
    const n = plan.indexOf('\nexport ', i + 1);
    return n < 0 ? plan.length : n;
  })());
  for (const [call, why] of [
    ['cockpitVerdict(', '첫 줄의 판정'],
    ['stopTargets(', '정지 대상'],
  ]) {
    if (!body.includes(call)) {
      err(`${PLAN}: 서명이 ${why}(${call})에서 나오지 않습니다 — 원본 필드를 손으로 나열하면 빠뜨린 자리가 조용히 새 나갑니다`);
    }
  }
}
/* 위 다섯 자리를 못박은 시험이 지워지면 규칙도 같이 사라진다. */
for (const m of [
  'lastEvaluationAtMs',            // 어느 줄이 '마지막 판단'인지
  'connectionNote',                // 막힌 사유 문구
  'strategyNote',                  // 전략 사유 문구
  "label, state: 'bad'",           // 점검 항목 이름
  '정지 대상이 바뀌었는데 서명이 같다', // 같은 종목·다른 id
]) {
  if (!planT.includes(m)) {
    err(`${PLANT}: 서명이 놓쳤던 자리(${m})를 못박은 시험이 없습니다`);
  }
}
if (!/snapshotSignature\(/.test(page)) {
  err(`${PAGE}: 스냅샷을 의미로 비교하지 않습니다 — 매 렌더마다 다시 그립니다`);
}
if (/prev\.health\s*===\s*v\.health/.test(page)) {
  err(`${PAGE}: 점검 결과를 참조로 비교합니다 — 매 렌더마다 새 배열이라 항상 다릅니다`);
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
