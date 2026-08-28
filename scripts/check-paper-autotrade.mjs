#!/usr/bin/env node
// scripts/check-paper-autotrade.mjs
//
// **모의 자동매매를 켜면 모의 계좌에 실제로 체결되는가.**
//
// 전수 추적에서 나온 것: 사용자가 자동매매 화면에서 '모의'를 고르면
// `autotrade_schedules.mode = 'PAPER'`가 저장되고 워커가 그 줄을 평가한다.
// 거기까지는 돌았다. 그다음이 전략마다 달랐다:
//
//   daily-ladder   live_orders에 INTENT 한 줄. **모의 계좌는 그대로**
//   scalp          아무것도 안 함. 기록조차 없음
//   my-original-v1 **모드 관문이 아예 없어** PAPER인데 테스트넷 실주문
//
// 셋 중 어느 것도 "모의 계좌에 체결한다"가 아니었다. 모의 잔고와 손익은
// 영원히 그대로였고, 사용자는 자동매매가 도는 줄 알았다.
//
// 배선이라 순수 테스트로는 안 잡힌다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let bad = 0;
const err = (m) => { bad += 1; console.error(`❌ ${m}`); };

function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf8'); }
  catch { err(`${rel}을 읽지 못했습니다 — 검사가 대상을 잃었습니다`); return null; }
}
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 전략 실행 라우트 전부. **하나라도 빠지면 그 전략만 조용히 다르게 돈다** */
const ROUTES = [
  'src/app/api/autotrade/daily-ladder/route.ts',
  'src/app/api/autotrade/scalp/route.ts',
  'src/app/api/autotrade/my-original-v1/route.ts',
];

// ── ① 모든 전략에 모드 관문이 있다 ──
for (const rel of ROUTES) {
  const src = read(rel);
  if (!src) continue;
  const code = stripComments(src);
  if (!/gateOrder\s*\(/.test(code)) {
    err(`${rel} — 모드 관문(gateOrder)이 없습니다`
      + '\n     관문이 없으면 PAPER로 켠 예약이 그대로 내려와'
      + '\n     **거래소에 실주문**이 나갑니다 — 사용자가 고르지 않은 계좌입니다');
  }
  if (!/modeGate\.disposition\s*!==\s*'SEND'/.test(code)) {
    err(`${rel} — 관문 판정을 실행 앞에서 쓰지 않습니다`);
  }
}

// ── ② 모든 전략이 같은 모의 체결 어댑터를 쓴다 ──
for (const rel of ROUTES) {
  const src = read(rel);
  if (!src) continue;
  const code = stripComments(src);
  // **정의가 아니라 호출을 본다.**
  if (!/await\s+dispatchPaperEntry\s*\(/.test(code)) {
    err(`${rel} — 모의 모드에서 모의 계좌에 체결하지 않습니다`
      + '\n     평가만 하고 끝나면 모의 잔고와 손익이 영원히 그대로입니다'
      + '\n     사용자는 자동매매가 도는 줄 알고, 성적표는 백지입니다');
  }
}

// ── ③ 판정을 라우트에서 다시 쓰지 않는다 ──
for (const rel of ROUTES) {
  const src = read(rel);
  if (!src) continue;
  const code = stripComments(src);
  // 라우트가 직접 openPaperPosition을 부르면 규칙이 네 벌이 된다.
  if (/openPaperPosition\s*\(/.test(code)) {
    err(`${rel} — 모의 체결을 라우트에서 직접 만듭니다`
      + '\n     세 전략이 각자 적으면 언젠가 한 곳만 고쳐지고,'
      + '\n     그때 전략마다 모의 결과가 갈립니다');
  }
}

// ── ④ 거래소로 나가는 모드를 모의 장부에 적지 않는다 ──
{
  const rel = 'src/lib/engine/paperDispatch.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/cap\.sendsOrders/.test(code)) {
      err(`${rel} — 거래소로 보내는 모드를 걸러내지 않습니다`
        + '\n     같은 거래가 거래소와 모의 장부 양쪽에 생깁니다');
    }
    if (!/MOCK/.test(code)) {
      err(`${rel} — 모의 장부 환경(MOCK)을 가르지 않습니다`
        + '\n     PAPER를 TESTNET으로 눕히면 두 장부가 섞이고 다시는 못 가릅니다');
    }
  }
}

if (bad === 0) {
  console.log('✅ 모의 자동매매 배선 유지 — 같은 전략 · 같은 관문 · 모의는 모의 계좌로');
} else {
  console.error('');
  console.error('   모의라고 켰는데 거래소로 나가는 것이 가장 나쁩니다.');
  console.error('   그다음이 아무 일도 안 일어나면서 도는 것처럼 보이는 것입니다.');
}
process.exit(bad ? 1 : 0);
