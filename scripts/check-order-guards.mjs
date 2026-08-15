#!/usr/bin/env node
// scripts/check-order-guards.mjs
//
// **킬 스위치가 일곱 주문 경로 중 둘에서만 돌고 있었다.**
//
// 세어 보기 전까지 아무도 몰랐다. 화면에는 '킬스위치 발동 중'이 떠 있는데
// COIN-M도, 현물도, 주식도, 사다리도, 스캘핑도 주문을 계속 냈다.
// 그리고 하필 자동매매 실행기(AutoTradeEngine)가 부르는
// `/api/exchange/order`에는 그 어떤 보호도 없었다.
//
// 이건 이 저장소에서 가장 자주 나는 고장이다:
// **경로가 여럿인데 한쪽만 고친다.** 고친 쪽을 보고 "됐다"고 믿는다.
//
// 반쯤 걸린 안전장치는 없는 것보다 나쁘다
// ────────────────────────────────────────
// 킬스위치가 없으면 사용자는 직접 포지션을 닫는다. 킬스위치가 절반만
// 걸려 있으면 사용자는 **다 멈춘 줄 알고 화면을 닫는다.** 그동안 나머지
// 경로는 계속 주문을 낸다.
//
// 그래서 이 검사는 "붙였는가"를 CI에서 센다. 새 주문 경로를 만들면
// 여기 목록에 넣어야 하고, 안 넣으면 빌드가 깨진다.

import { readFileSync, existsSync } from 'node:fs';

// **실제 돈이 나갈 수 있는 경로만 넣는다.**
// 조회·모의 라우트를 섞으면 목록이 길어지고, 길어지면 아무도 안 본다.
const ORDER_ROUTES = [
  'src/app/api/binance/futures/order/route.ts',
  'src/app/api/binance/coinm/order/route.ts',
  'src/app/api/binance/spot/order/route.ts',
  'src/app/api/stock/order/route.ts',
  'src/app/api/exchange/order/route.ts',
  'src/app/api/webhook/tradingview/route.ts',
  'src/app/api/autotrade/daily-ladder/route.ts',
  'src/app/api/autotrade/scalp/route.ts',
  'src/app/api/autotrade/my-original-v1/route.ts',
  // 강제 스모크 테스트도 **실제 주문을 낸다.** 테스트넷 전용이라고
  // 목록에서 빼면, 킬스위치가 켜진 계좌에서도 주문이 나간다.
  //
  // 라우트가 아니라 이 파일이다 — 1회차는 사람이(POST), 2회차부터는
  // 워커가(advance) 부르는데 **시작 절차는 여기 하나뿐**이다.
  // 라우트 둘을 각각 검사하면 실제 주문을 내는 곳은 아무도 안 본다.
  'src/lib/smoke/startAttempt.ts',
];

// 각 경로가 반드시 물어봐야 하는 것.
//
// 킬스위치는 **사용자가 누르는 것**이다. "이 계좌를 지금 멈춰라".
// 나머지 관문(liveTradingGate, gateOrder)은 운영자·배포 쪽 판정이라
// 성격이 다르고, 그래서 킬스위치를 대신하지 못한다.
const REQUIRED = [
  {
    key: 'killSwitch',
    label: '킬 스위치',
    // killSwitchGate가 권장이고, isKillSwitchActive 직접 호출도 인정한다.
    // 다만 직접 호출은 readOk를 놓치기 쉬워 아래에서 따로 경고한다.
    test: (src) => /killSwitchGate|isKillSwitchActive/.test(src),
    why: '사용자가 계좌를 멈추려고 누르는 장치입니다. 여기 없으면 눌러도 이 경로는 계속 주문합니다',
  },
];

const errors = [];
const warns = [];

for (const rel of ORDER_ROUTES) {
  if (!existsSync(rel)) {
    errors.push(`${rel}\n     목록에 있는데 파일이 없습니다 — 지웠으면 이 목록에서도 빼세요`);
    continue;
  }
  const src = readFileSync(rel, 'utf8');

  for (const r of REQUIRED) {
    if (!r.test(src)) {
      errors.push(`${rel}\n     ${r.label}가 없습니다 — ${r.why}`);
    }
  }

  // **`try { … } catch {}`로 감싼 킬스위치는 안 건 것과 같다.**
  // 조회가 실패하면 조용히 통과한다. 실제로 그렇게 돼 있었다.
  if (/try\s*\{[^}]*isKillSwitchActive[^}]*\}\s*catch\s*\{\s*\}/s.test(src)) {
    errors.push(`${rel}\n     킬스위치를 빈 catch로 감쌌습니다 —`
      + ' 조회가 실패하면 조용히 통과합니다. killSwitchGate를 쓰세요');
  }

  // readOk를 안 보는 직접 호출.
  if (/isKillSwitchActive/.test(src) && !/readOk/.test(src) && !/killSwitchGate/.test(src)) {
    warns.push(`${rel}\n     isKillSwitchActive를 직접 부르면서 readOk를 안 봅니다 —`
      + ' 조회 실패가 통과로 새어 나갑니다');
  }
}

// 목록에 없는 새 주문 경로를 놓치지 않는다.
//
// 이 검사의 가장 흔한 실패는 "검사는 통과했는데 새 경로가 목록에 없다"이다.
// 그러면 검사가 켜져 있는 것처럼 보이면서 아무것도 안 지킨다.
//
// `node:fs`의 globSync를 정적 import하지 않는다 — 없는 런타임에서는
// 모듈 로드 자체가 깨져서, 안전장치 검사가 통째로 안 돌게 된다.
// **검사가 조용히 사라지는 것이 검사가 못 찾는 것보다 나쁘다.**
let candidates = [];
try {
  const fs = await import('node:fs');
  candidates = typeof fs.globSync === 'function'
    ? fs.globSync('src/app/api/**/order/route.ts')
    : [];
} catch { candidates = []; }

const known = new Set(ORDER_ROUTES);
// 모의 전용 경로는 실주문이 아니다.
const NOT_REAL = new Set([
  'src/app/api/paper/order/route.ts',
  // 실주문 갈래가 501을 돌려준다 (아직 미구현). 구현되면 목록에 넣어야 한다.
  'src/app/api/order/route.ts',
]);
for (const c of candidates) {
  const rel = c.replaceAll('\\', '/');
  if (known.has(rel) || NOT_REAL.has(rel)) continue;
  errors.push(`${rel}\n     새 주문 경로로 보이는데 이 검사의 목록에 없습니다 —`
    + ' 실주문을 낸다면 ORDER_ROUTES에, 아니면 NOT_REAL에 사유와 함께 넣으세요');
}

if (warns.length > 0) {
  console.log('⚠️  주문 경로 경고:');
  for (const w of warns) console.log(`   · ${w}`);
  console.log('');
}

if (errors.length > 0) {
  console.error('❌ 주문 경로에 안전장치가 빠졌습니다:');
  for (const e of errors) console.error(`   · ${e}`);
  console.error('');
  console.error('   반쯤 걸린 안전장치는 없는 것보다 나쁩니다 —');
  console.error('   사용자는 다 멈춘 줄 알고 화면을 닫습니다.');
  process.exit(1);
}

console.log(`✅ 실주문 경로 ${ORDER_ROUTES.length}개 · 안전장치 빠진 것 0개`);
