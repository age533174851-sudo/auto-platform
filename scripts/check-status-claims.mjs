#!/usr/bin/env node
// scripts/check-status-claims.mjs
//
// **상태판이 런타임 사실을 직접 적으면 반드시 늙는다.**
//
// 무엇이 실제로 일어났나
// ──────────────────────
// `FULL_COMPLETION_STATUS.md`에 이렇게 적혀 있었다:
//
//   - **ISSUE** 실측 `main = Vercel = Fly = 3c46151` · `MATCHED` ·
//     Fly Worker alive.
//   ...
//   코드는 main에 있고 배포도 MATCHED다.
//
// 2026-08-21에 실제로 확인해 보니 셋 다 사실이 아니었다:
//
//   main   10fc75f
//   Fly    3c46151   ← 그대로 멈춰 있었다
//   worker heartbeat 27.6시간 전, alive: false
//   verdict MISMATCH
//
// 그 문장들은 **적힐 때는 참이었다.** 그게 이 고장의 핵심이다 —
// 검증할 수 없는 형태로 참을 적어 두면, 거짓이 되는 순간을 아무도 모른다.
//
// 같은 날 같은 모양을 코드에서도 잡았다. `my-original-v1/route.ts` 상단에
// "이 전략은 주문을 내지 않는다"가 남아 있었는데, 그 라우트는 실제로
// 100배 주문을 낸다. **코드보다 주석이 먼저 거짓말한다.**
//
// 어떻게 막나
// ───────────
// 상태판을 자동으로 갱신해 주는 것이 아니라, **늙는 문장 자체를 못 쓰게**
// 한다. 런타임 사실은 살아 있는 곳에만 있어야 한다:
//
//   /api/system/deployment      main·Vercel·Fly SHA와 verdict
//   /api/system/runtime-health  워커 생존·지문·청산 감시
//   /api/system/migrations      Required / Applied / Pending / Failed
//
// 문서는 **무엇을 왜 고쳤는지**를 적는다. 그건 늙지 않는다.

import { readFileSync, existsSync } from 'fs';

/** 지금 상태를 주장하는 문서. 과거를 적는 changelog(PROGRESS.md)는 대상이 아니다 */
const FILES = ['FULL_COMPLETION_STATUS.md'];

/** 살아 있는 사실을 주는 곳. 실패 메시지에 그대로 보여 준다 */
const LIVE = [
  '/api/system/deployment      main·Vercel·Fly SHA와 verdict',
  '/api/system/runtime-health  워커 생존 · 지문 · 청산 감시',
  '/api/system/migrations      Required / Applied / Pending / Failed',
];

/**
 * 커밋 SHA. **적는 순간부터 늙는다.**
 *
 * 코드 블록 안이든 밖이든 똑같이 늙는다. 다만 PR 번호(`#170`)와
 * 날짜(`2026-08-21`)는 늙지 않으므로 그건 얼마든지 써도 된다.
 */
const SHA = /\b[0-9a-f]{7,40}\b/g;

/**
 * 살아 있는 상태를 단정하는 말.
 *
 * "MATCHED가 무슨 뜻인가"를 설명하는 것은 괜찮다 — 그건 정의다.
 * 막는 것은 **"지금 MATCHED다"** 처럼 현재를 단정하는 쪽이다.
 */
const CLAIMS = [
  { re: /(?:Fly\s+)?Worker\s+alive/i, why: '워커 생존은 지금 값이지 문서에 적을 것이 아닙니다' },
  { re: /배포(?:도|는|가)?\s*MATCHED\s*(?:다|입니다|이다)/, why: '배포 일치는 지금 값입니다' },
  { re: /MATCHED\s*(?:다|이다)\b/, why: '배포 일치는 지금 값입니다' },
  { re: /heartbeat\s*(?:는|가)?\s*정상/i, why: '워커 heartbeat는 지금 값입니다' },
  { re: /워커(?:가|는)?\s*(?:살아\s*있다|정상이다|돌고\s*있다)/, why: '워커 상태는 지금 값입니다' },
  { re: /마이그레이션(?:이|은)?\s*(?:전부|모두)?\s*적용(?:됐다|되었다|완료)/, why: '마이그레이션 적용 여부는 지금 값입니다' },
];

/**
 * 잰 값을 적을 때는 **언제 쟀는지**가 같이 있어야 한다.
 *
 * `측정`만으로는 잡지 않는다 — "측정한 우위"처럼 개념을 가리키는 말이
 * 훨씬 흔하고, 그걸 막으면 검사가 틀린 것이 되어 사람들이 검사를 끈다.
 */
const MEASURED = /실측|실제로 확인해/;
const HAS_DATE = /20\d{2}[-.\/]\d{1,2}[-.\/]\d{1,2}/;

/**
 * 한 줄에서 **늙는 문장**을 찾는다.
 *
 * 루프와 자기 점검이 같은 함수를 쓴다. 규칙이 두 곳에 있으면 언젠가
 * 갈리고, 그때 갈리는 쪽은 늘 검사기다.
 */
export function agingProblems(line) {
  const out = [];
  // 이 검사 파일 자체를 설명하는 줄은 예로 든 것이다.
  if (/check-status-claims/.test(line)) return out;

  for (const m of line.match(SHA) || []) {
    // 순수 숫자는 SHA가 아니다(연도·개수 등). 글자가 하나는 있어야 한다.
    if (!/[a-f]/.test(m)) continue;
    out.push({ what: `커밋 SHA \`${m}\``,
      why: '적는 순간부터 늙습니다 — 다음 배포에 바로 거짓이 됩니다' });
  }
  for (const c of CLAIMS) {
    if (c.re.test(line)) out.push({ what: '런타임 상태 단정', why: c.why });
  }
  if (MEASURED.test(line) && !HAS_DATE.test(line)) {
    out.push({ what: '언제 쟀는지 없는 실측 주장',
      why: '언제 잰 값인지 없으면 지금 값으로 읽힙니다 — 날짜를 같이 적으십시오' });
  }
  return out;
}

// ── 규칙이 실제로 걸리는지 매번 확인한다 ──
// 통과만 하고 아무것도 막지 않는 검사기는 없는 것보다 나쁘다.
{
  const must = [
    ['커밋 220f8001 기준', /SHA/],
    ['Fly Worker alive', /상태 단정/],
    ['실측 진입 12건', /언제 쟀는지/],
  ];
  const fails = must.filter(([line, want]) => !agingProblems(line).some(p => want.test(p.what)));
  const quiet = ['PR #170에서 고쳤다', '2026-08-21에 쟀다 — 실측 12건', 'MATCHED가 무슨 뜻인가'];
  const noisy = quiet.filter(line => agingProblems(line).length > 0);
  if (fails.length > 0 || noisy.length > 0) {
    console.error('❌ 자기 점검 실패 — 늙는 문장 판별이 깨졌습니다');
    for (const [line] of fails) console.error(`   못 잡음: ${line}`);
    for (const line of noisy) console.error(`   잘못 잡음: ${line}`);
    process.exit(1);
  }
}

const problems = [];
const missing = [];
let scanned = 0;

for (const f of FILES) {
  if (!existsSync(f)) { missing.push(f); continue; }
  const lines = readFileSync(f, 'utf8').split('\n');
  scanned++;
  lines.forEach((line, i) => {
    for (const p of agingProblems(line)) problems.push({ f, n: i + 1, ...p, line });
  });
}

// ── 감시 목록이 조용히 비면 이 검사는 꺼진 것과 같다 ──
//
// 실측 RED (2026-11-10, main `220f8001`): `FULL_COMPLETION_STATUS.md`를
// `STATUS.md`로 **이름만 바꾸고** 그 안에 늙는 문장 5종을 넣었더니
// `✅ 상태판 0개 · 늙는 문장 0건` · exit 0 이었다. 같은 내용을 원래
// 이름으로 두면 전부 잡힌다. 즉 지킬 것이 없어진 게 아니라 **감시가
// 꺼진 것**이다.
//
// 0개를 봤다고 적는 것은 정직하지만, 그 상태로 **통과시키는 것**은
// `CLAUDE.md`의 "확인하지 못한 것은 통과가 아니다"에 걸린다.
if (missing.length > 0) {
  console.error('❌ 감시 목록이 낡았습니다 — 적어 둔 상태판이 없습니다\n');
  for (const f of missing) console.error(`  ${f}`);
  console.error('\n이름이 바뀌었으면 그 문서는 지금 아무도 안 보고 있습니다.');
  console.error('문서를 없앴다면 이 검사기의 FILES에서도 지우십시오 —');
  console.error('감시 목록은 비어 있을 수 있지만 **조용히** 비어서는 안 됩니다.');
  process.exit(1);
}

if (problems.length > 0) {
  console.error('❌ 상태판이 늙는 문장을 담고 있습니다\n');
  for (const p of problems) {
    console.error(`  ${p.f}:${p.n}  ${p.what}`);
    console.error(`    ${p.why}`);
    console.error(`    ${p.line.trim().slice(0, 110)}\n`);
  }
  console.error('왜 막는가');
  console.error('  이 문장들은 적힐 때는 참이었습니다. 그게 핵심입니다 —');
  console.error('  검증할 수 없는 형태로 참을 적어 두면 거짓이 되는 순간을 아무도 모릅니다.');
  console.error('\n런타임 사실은 살아 있는 곳에만 둡니다');
  for (const l of LIVE) console.error(`  ${l}`);
  console.error('\n문서에는 무엇을 왜 고쳤는지를 적으십시오 — 그건 늙지 않습니다.');
  process.exit(1);
}

console.log(`✅ 상태판 ${scanned}개 · 늙는 문장 0건`);
