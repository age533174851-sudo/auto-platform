#!/usr/bin/env node
// scripts/check-autodev-safety.mjs
//
// **무인 회차가 만든 변경을, 커밋된 뒤에 한 번 더 본다.**
//
// 왜 프롬프트만으로는 부족한가
// ─────────────────────────────
// "안전장치를 제거하지 마라"는 지시다. 지시는 지켜지지 않을 수 있고,
// 지켜지지 않은 것을 **아무도 보지 않는 시간에** 알아차릴 방법이 없다.
// 그래서 결과물을 기계가 센다.
//
// 가장 비싼 실패 모양은 이것이다: 시험이 빨간데 원인을 찾는 대신
// **막고 있던 관문을 지워서 초록으로 만든다.** 그렇게 지워진 관문은
// 아무도 다시 세우지 않는다.
//
// 무엇을 보는가
// ─────────────
//   ① 안전 닻(fail-closed 표식)의 개수가 **줄지 않았는가**
//   ② 검사기를 지우거나 단정을 줄이지 않았는가
//   ③ 제 울타리(워크플로)를 스스로 고치지 않았는가
//   ④ 마이그레이션을 건드리지 않았는가
//   ⑤ (dev 갈래) 거래 엔진 경로를 건드리지 않았는가
//
// 쓰는 법:  node scripts/check-autodev-safety.mjs --base <ref> --mode dev|trading
import { execFileSync } from 'node:child_process';
import { stripJsComments } from './lib/strip-comments.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const BASE = argOf('--base', 'origin/main');
const MODE = argOf('--mode', 'dev') === 'trading' ? 'trading' : 'dev';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };

const git = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
};

// ── 바뀐 파일 목록 ──
const nameStatus = git('diff', '--name-status', `${BASE}...HEAD`);
if (nameStatus == null) {
  err(`기준(${BASE})과 비교하지 못했습니다 — 비교하지 못한 것을 통과로 보지 않습니다`);
  process.exit(1);
}
const changed = nameStatus.split('\n').filter(Boolean).map((l) => {
  const [status, ...rest] = l.split('\t');
  return { status, path: rest[rest.length - 1] };
});

if (changed.length === 0) {
  console.log('✅ 변경 없음 — 볼 것이 없습니다 (고칠 것이 없는 회차는 정상입니다)');
  process.exit(0);
}

// ── ③ 제 울타리를 스스로 고치지 않는다 ──
//
// 무인 회차가 자기 워크플로를 고칠 수 있으면, 울타리를 넓히는 변경을
// 스스로 제안할 수 있다. 그 PR을 사람이 놓치면 다음 회차부터 울타리가
// 없다. 울타리 변경은 **사람이 직접 연 PR에서만** 한다.
for (const f of changed) {
  if (f.path.startsWith('.github/workflows/')) {
    err(`무인 회차가 워크플로를 고쳤습니다: ${f.path} — 제 울타리는 스스로 넓힐 수 없습니다`);
  }
}

// ── ④ 마이그레이션은 건드리지 않는다 ──
for (const f of changed) {
  if (f.path.startsWith('supabase/migrations/')) {
    err(`무인 회차가 마이그레이션을 건드렸습니다: ${f.path} — 운영 DB 스키마는 별도 승인 사항입니다`);
  }
}

// ── ⑤ dev 갈래는 거래 엔진에 손대지 않는다 ──
//
// trading 갈래는 **일부러** 여기에 손대라고 만든 것이라 이 규칙을
// 적용하지 않는다. 대신 그쪽은 검증을 더 세게 받는다.
if (MODE === 'dev') {
  const TRADING_PATHS = [
    'src/lib/engine/', 'src/lib/strategies/', 'src/lib/exchanges/',
    'src/lib/smoke/', 'src/lib/execution/', 'src/lib/risk/',
    'src/lib/backtest/', 'worker/',
  ];
  for (const f of changed) {
    const hit = TRADING_PATHS.find((p) => f.path.startsWith(p));
    if (hit) {
      err(`dev 갈래가 거래 엔진 경로를 건드렸습니다: ${f.path} (${hit}) — `
        + `그 수정은 claude-hourly-trading 갈래에서, 더 센 검증을 받고 해야 합니다`);
    }
  }
}

// ── ② 검사기를 지우거나 약하게 만들지 않는다 ──
for (const f of changed) {
  if (!/^scripts\/check-.*\.mjs$/.test(f.path)) continue;
  if (f.status === 'D') {
    err(`검사기를 지웠습니다: ${f.path} — 막는 것을 없애서 통과시키지 않습니다`);
    continue;
  }
  const before = git('show', `${BASE}:${f.path}`);
  const after = git('show', `HEAD:${f.path}`);
  if (before == null || after == null) continue;
  // **`err(`만 세면 공허하다.** 이 저장소의 검사기는 보고 방식이
  // 제각각이다 — `err()`를 쓰는 것도 있고 배열에 쌓아 두었다가
  // `console.error`로 뿜는 것도 있다(`check-order-guards.mjs`는
  // `err(`가 0건이라, 처음 쓴 규칙이 그 파일에는 아무것도 막지
  // 못했다). 그래서 **실패를 알리는 신호를 모두** 센다.
  //
  // **주석을 걷어내고 센다.** 처음에는 원문에서 셌는데, 단정을 한 줄
  // 주석 처리해도 글자는 그대로라 44 → 44로 안 줄었다. 막는 것을
  // 지우는 가장 쉬운 방법이 주석 처리인데 그것을 못 보던 셈이다.
  const countSignals = (t) =>
    (stripJsComments(t).match(/\berr\(|\.push\(|console\.error\(/g) || []).length;
  const b = countSignals(before); const a = countSignals(after);
  if (a < b) {
    err(`검사기의 단정이 줄었습니다: ${f.path} (실패 신호 ${b} → ${a}건) — `
      + `검사기가 막으면 검사기가 옳다고 보고 원인을 다시 봅니다`);
  }
}

// ── ① 안전 닻이 줄지 않았는가 ──
//
// 이 저장소가 비싸게 배운 fail-closed 표식들이다. 리팩터링으로 이름이
// 바뀔 수도 있지만, **무인 회차에서는 그 판단을 하지 않는다** —
// 이름을 바꿔야 한다면 사람이 연 PR에서 한다.
const ANCHORS = [
  'maySend: false',
  "fail('BLOCKED'",
  'killSwitchGate',
  'quantizeOrder(',
  'roundTrigger(',
  'unresolvedExposureBlock(',
  'smokeTestnetVerdict(',
  'unprotectedExposureVerdict(',
  'residualVerdict(',
  'NO_FIXED_SL',
  'NO_FIXED_TP',
  'reduceOnly',
  'closePosition',
];

/** 추적 중인 소스 전체에서 닻이 몇 번 나오는가 */
function anchorCounts(ref) {
  const out = {};
  for (const a of ANCHORS) out[a] = 0;
  const list = git('ls-tree', '-r', '--name-only', ref);
  if (list == null) return null;
  const files = list.split('\n').filter((p) => /\.(ts|tsx|mjs)$/.test(p));
  for (const p of files) {
    const body = git('show', `${ref}:${p}`);
    if (body == null) continue;
    for (const a of ANCHORS) {
      let i = 0; let n = 0;
      for (;;) { const k = body.indexOf(a, i); if (k < 0) break; n += 1; i = k + a.length; }
      out[a] += n;
    }
  }
  return out;
}

{
  // 소스 파일이 하나도 안 바뀌었으면 셀 필요가 없다 — 느린 작업이다.
  const touchedSource = changed.some((f) => /\.(ts|tsx|mjs)$/.test(f.path));
  if (touchedSource) {
    const before = anchorCounts(BASE);
    const after = anchorCounts('HEAD');
    if (!before || !after) {
      err('안전 닻을 세지 못했습니다 — 세지 못한 것을 통과로 보지 않습니다');
    } else {
      for (const a of ANCHORS) {
        if (after[a] < before[a]) {
          err(`안전 닻이 줄었습니다: \`${a}\` ${before[a]} → ${after[a]}건 — `
            + `fail-closed 분기를 지워서 시험을 통과시키지 않습니다. `
            + `이름을 바꿔야 한다면 사람이 연 PR에서 하세요`);
        }
      }
    }
  }
}

if (bad === 0) {
  console.log(`✅ 무인 회차 변경 안전 (${MODE}) — 파일 ${changed.length}개 · `
    + '안전 닻 유지 · 검사기 유지 · 울타리/마이그레이션 무변경');
} else {
  console.error('');
  console.error('   무인 회차는 사람이 보지 않는 시간에 돕니다.');
  console.error('   막고 있던 것을 지워서 초록을 만드는 것이 가장 비싼 실패입니다.');
}
process.exit(bad ? 1 : 0);
