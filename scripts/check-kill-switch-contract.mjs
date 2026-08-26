#!/usr/bin/env node
// scripts/check-kill-switch-contract.mjs
//
// **킬스위치의 배선은 순수 테스트로 안 잡힌다.**
//
// 이 PR에서만 같은 종류로 두 번 물렸다:
//
//   1. 라우트가 `p.qty ?? p.positionAmt`를 읽었다 — 실제 칸은 `amount`.
//      포지션이 둘 있어도 전부 0으로 떨어져 "줄일 것 없음"으로 완료.
//      순수 테스트는 `targetCount: 2`를 손으로 넣어서 못 잡았다.
//
//   2. 발동할 때 `targeted_pending`을 targeted 단계에만 남겼다.
//      PAUSE_ENTRIES·LOCK_ACCOUNT는 NULL로 남고, 읽는 쪽은 NULL을
//      fail-closed로 막는다 → **줄일 것이 애초에 없던 발동이 영원히
//      리셋되지 않는다.**
//
// 둘 다 판정기가 아니라 **라우트에 값을 넘기는 자리**의 문제였다.
// 그래서 그 자리를 검사한다.
//
// 지키는 계약
// ───────────
//   · 발동(active = true)을 만드는 라우트는 **반드시**
//     `targetedPending`을 함께 남긴다. NULL은 legacy·기록 실패이지
//     "targeted 아님"이 아니다
//   · targeted 여부를 **조합 문자열로 추론하지 않는다** —
//     REDUCE_RISK와 LOCK_ACCOUNT는 둘 다 'AB'라 구분이 불가능하다.
//     근거는 `closePct`뿐이다
//   · 대상 수량은 `amount`로 읽는다
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let bad = 0;
const err = (m) => { bad += 1; console.error(`❌ ${m}`); };

function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf8'); }
  catch { err(`${rel}을 읽지 못했습니다 — 검사가 대상을 잃었습니다`); return null; }
}

// ── ① 발동하는 곳은 targetedPending을 남긴다 ──
const ACTIVATORS = [
  'src/app/api/risk/kill-switch/trigger/route.ts',
  'src/app/api/risk/kill-switch/status/route.ts',
];
for (const rel of ACTIVATORS) {
  const src = read(rel);
  if (src == null) continue;
  // 발동을 만드는 모양은 둘이다:
  //   · 라우트가 직접 켠다        `s.active = true`
  //   · 판정기가 켠 상태를 저장한다 `evaluate(...)` → `saveKillSwitch(...)`
  //
  // 두 번째를 빠뜨리면 자동 손실한도 발동이 NULL로 남는다 — 실제로
  // 이 검사의 첫 판이 그걸 놓쳤다.
  const activates = /\.active\s*=\s*true/.test(src)
    || (/\bevaluate\s*\(/.test(src) && /saveKillSwitch\s*\(/.test(src));
  if (!activates) continue;
  if (!/targetedPending\s*=/.test(src)) {
    err(`${rel} — 킬스위치를 발동시키면서 targetedPending을 남기지 않습니다`
      + '\n     NULL은 legacy·기록 실패라는 뜻이라 읽는 쪽이 리셋을 막습니다'
      + '\n     줄일 것이 애초에 없던 발동(PAUSE_ENTRIES·LOCK_ACCOUNT)이 영원히 안 풀립니다');
  }
}

// ── ② 조합 문자열로 targeted 여부를 추론하지 않는다 ──
//
// `targetedStateOf`가 조합을 인자로 받으면 언젠가 그것으로 추론하게 된다.
// 받지 않는 것이 유일하게 확실한 방법이다.
{
  const rel = 'src/lib/risk/killSwitchTruth.ts';
  const src = read(rel);
  if (src) {
    const m = /export function targetedStateOf\(i:\s*\{([\s\S]*?)\}\)/.exec(src);
    if (!m) {
      err(`${rel}에 targetedStateOf가 없습니다 — 검사가 대상을 잃었습니다`);
    } else if (/effective|actionMode|mode\s*[?:]/.test(m[1])) {
      err(`${rel} — targetedStateOf가 조합 문자열을 인자로 받습니다`
        + '\n     REDUCE_RISK와 LOCK_ACCOUNT는 둘 다 \'AB\'라 구분할 수 없습니다'
        + '\n     받으면 언젠가 그것으로 추론하게 되고, 그때 틀립니다');
    }
    for (const name of ['TARGETED_INCOMPLETE', 'TARGETED_UNKNOWN']) {
      if (!src.includes(name)) err(`${rel}에 ${name}이 없습니다 — 리셋 차단이 사라졌습니다`);
    }
  }
}

// ── ③ 대상 수량은 amount로 읽는다 ──
{
  const rel = 'src/lib/risk/killTargets.ts';
  const src = read(rel);
  if (src) {
    if (!/Number\(\s*p\?\.amount\s*\)/.test(src)) {
      err(`${rel} — 포지션 수량을 amount로 읽지 않습니다`
        + '\n     ExecPosition의 칸 이름은 amount입니다. 다른 이름으로 읽으면'
        + '\n     전부 0이 되어 "줄일 포지션 없음"으로 조용히 완료됩니다');
    }
  }
}

// ── ④ 라우트가 대상 만들기를 다시 구현하지 않는다 ──
//
// 두 벌이 되면 한쪽만 고쳐진다. 이 저장소에서 반복된 사고의 모양이다.
{
  const rel = 'src/app/api/risk/kill-switch/trigger/route.ts';
  const src = read(rel);
  // `rr.risk?.positionAmt`(단일 심볼 재조회)는 다른 API라 정상이다.
  // 잡을 것은 **포지션 목록을 훑으며 꺼내는** 자리다.
  if (src && /\bp\.qty\b|\bp\.positionAmt\b|p\?\.qty|p\?\.positionAmt/.test(src)) {
    err(`${rel} — 라우트가 포지션 수량을 직접 꺼내고 있습니다`
      + '\n     killTargets.ts의 liveFromPositions()를 쓰세요 — 테스트가 붙어 있는 자리입니다');
  }
}

if (bad === 0) {
  console.log('✅ 킬스위치 배선 계약 유지 — 발동 시 targetedPending 기록 · 조합 추론 없음 · 수량은 amount');
} else {
  console.error('');
  console.error('   킬스위치는 급할 때 누르는 버튼입니다. 응답을 읽고 손을 뗍니다.');
  console.error('   여기서 가장 위험한 실패는 "안 됐다"가 아니라 "됐다고 말하는 것"입니다.');
}
process.exit(bad ? 1 : 0);
