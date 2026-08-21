#!/usr/bin/env node
// scripts/check-entry-gates.mjs
//
// **경로가 셋인데 하나만 고쳐져 있었다.**
//
// `symbolOwnershipConflict`는 #4-a에서 만들어졌고 `my-original-v1`
// 한 곳에서만 쓰였다. `daily-ladder`와 `scalp`는 같은 계좌·같은 종목에
// 그대로 들어갈 수 있었다 — ONE_WAY 계좌에서 그건 한쪽의 손절이 다른
// 쪽 진입에 발동한다는 뜻이다.
//
// 이 저장소에서 가장 자주 난 고장 두 개 중 하나가 정확히 이것이라,
// 값으로 막는다: **주문을 내는 자동매매 경로는 아래 관문을 전부
// 지나야 한다.** 새 경로를 만들면 이 검사가 먼저 실패한다.
//
// 왜 유닛 테스트가 아닌가
// ──────────────────────
// 관문을 부르는지는 라우트 파일의 사실이고, 라우트는 하니스에서 불러올
// 수 없다(next/server 의존). 그래서 원문을 읽어 확인한다 — 정교하진
// 않지만 이 검사가 막으려는 것(경로 하나가 관문을 빼먹는 것)은 정확히 잡는다.
//
// **못 읽으면 통과시키지 않는다.** 파일을 못 찾으면 그건 '문제 없음'이
// 아니라 이 검사가 고장 난 것이다.
import { readFileSync, existsSync, globSync } from 'node:fs';

/** 주문을 내는 자동매매 경로 */
const ENTRY_ROUTES = [
  'src/app/api/autotrade/my-original-v1/route.ts',
  'src/app/api/autotrade/daily-ladder/route.ts',
  'src/app/api/autotrade/scalp/route.ts',
  // 외부 신호로 사람 없이 주문이 나가는 경로. **감사에서 나온 옆문이다.**
  'src/app/api/webhook/tradingview/route.ts',
  'src/app/api/webhook/signal/route.ts',
];

/**
 * 관문 여섯을 한 번에 부르는 합성 함수.
 *
 * 라우트마다 여섯을 따로 부르면 새 경로가 생길 때 다섯 개만 복사하는
 * 일이 반드시 생긴다. 이 함수를 부르면 여섯이 다 돈다.
 */
const COMPOSITE = 'autoEntryGate';

/**
 * **닫기만 하는 경로**는 관문을 지나지 않는다.
 *
 * 청산·손절 이동을 막으면 그건 이 관문이 막으려는 것의 정반대다 —
 * 못 여는 것은 불편이고 못 닫는 것은 사고다.
 */
const EXIT_ONLY_ROUTES = {
  'src/app/api/autotrade/exit-monitor/route.ts':
    '포지션을 닫고 손절을 옮기기만 한다 — 새로 열지 않으므로 진입 관문을 걸지 않는다',
};

/** 이 경로들이 반드시 지나야 하는 관문 */
const REQUIRED = [
  { needle: 'killSwitchGate', why: '사용자가 누른 정지를 무시하고 주문이 나갑니다' },
  { needle: 'strategyConflictGate', why: '같은 종목에 두 전략이 들어가 서로의 손절을 건드립니다' },
  { needle: 'sleeveCapitalGate', why: '다른 전략의 증거금을 끌어다 씁니다' },
  { needle: 'migrationGate', why: 'DB가 코드를 못 따라온 채로 주문이 나갑니다' },
  { needle: 'exitMonitorGate', why: '닫아 줄 감시가 죽은 채로 새 포지션을 엽니다' },
  { needle: 'parityGate', why: '워커가 다른 DB·다른 키를 보는 채로 주문이 나갑니다' },
];

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

for (const f of ENTRY_ROUTES) {
  if (!existsSync(f)) {
    err(`${f}를 찾지 못했습니다 — 이 검사가 무엇을 보고 있는지 다시 확인하세요`);
    continue;
  }
  const src = readFileSync(f, 'utf8');

  // 합성 함수 하나를 부르면 여섯이 다 돈다.
  if (new RegExp(`\\b${COMPOSITE}\\s*\\(`).test(src)) continue;

  for (const r of REQUIRED) {
    // 주석에 이름만 적어 두고 안 부르는 경우를 거른다: `(` 가 붙어야 호출이다.
    const called = new RegExp(`\\b${r.needle}\\s*\\(`).test(src);
    const imported = src.includes(r.needle);
    if (!called) {
      err(`${f}\n     ${r.needle}를 부르지 않습니다 — ${r.why}`
        + `\n     (또는 ${COMPOSITE}()를 부르면 여섯이 한 번에 돕니다)`
        + (imported ? '\n     (이름은 있는데 호출이 없습니다)' : ''));
    }
  }
}

/**
 * 저수준 주문 라우트 — **사람이 누르는 경로**다.
 *
 * `/api/binance/futures/order` 같은 곳은 거래 화면의 매수·청산 버튼도
 * 부른다. 여기에 자동매매 관문(예약 겹침·전략 계좌)을 걸면 사용자가
 * 손으로 내는 주문까지 막힌다 — 그건 이 관문이 막으려는 것이 아니다.
 *
 * 대신 이 라우트들이 **자동으로 반복 호출되지 않는지**를 다른 검사가
 * 본다(`check-browser-orders.mjs`: 타이머 + 주문 경로 금지).
 *
 * 여기 적힌 것은 "확인했고, 사람이 시작하는 경로다"라는 기록이다.
 * 새 라우트가 생기면 아래 검사가 목록에 없다고 실패시킨다.
 */
const MANUAL_ORDER_ROUTES = {
  'src/app/api/binance/futures/order/route.ts': '거래 화면의 매수·청산이 부른다 (사용자 확인 후)',
  'src/app/api/binance/spot/order/route.ts': '거래 화면의 현물 주문이 부른다',
  'src/app/api/binance/coinm/order/route.ts': '거래 화면의 코인마진 주문이 부른다',
  'src/app/api/exchange/order/route.ts': '거래 화면의 주문이 부른다',
  'src/app/api/stock/order/route.ts': '주식 주문 화면이 부른다',
  'src/app/api/orders/preflight/route.ts': '주문 전 확인만 한다 — 주문을 내지 않는다',
};

// ── 주문을 내는 라우트가 목록 밖에서 생기는 것을 막는다 ──
//
// **감사에서 나온 구멍이 이것이다.** 예전 검사는
// `src/app/api/autotrade/*/route.ts`만 봤다. 저수준 주문 라우트는
// 그 바깥이었고, 브라우저 자동 엔진이 정확히 그리로 우회했다.
{
  const all = globSync('src/app/api/**/route.ts').map(f => f.replaceAll('\\', '/'));
  for (const f of all) {
    if (ENTRY_ROUTES.includes(f) || MANUAL_ORDER_ROUTES[f] || EXIT_ONLY_ROUTES[f]) continue;
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    // 거래소에 실제로 주문을 보내는 라우트만 본다.
    const places = /executeOrder\s*\(|placeFuturesOrder\s*\(|futuresPlaceOrder\s*\(/.test(src);
    if (!places) continue;
    err(`${f}\n     주문을 내는 라우트인데 어느 목록에도 없습니다`
      + '\n     자동 진입 경로면 ENTRY_ROUTES에 넣고 관문을 전부 지나게 하세요'
      + '\n     사람이 누르는 경로면 MANUAL_ORDER_ROUTES에 사유와 함께 적으세요');
  }
}

// 새 진입 경로가 목록에 없는 채로 생기는 것을 막는다.
{
  const found = globSync('src/app/api/autotrade/*/route.ts')
    .map(f => f.replaceAll('\\', '/'));
  // 주문 실행기를 부르는 파일만 진입 경로로 본다.
  const entries = found.filter(f => {
    try {
      const src = readFileSync(f, 'utf8');
      return /executeOrder\s*\(|placeFuturesOrder\s*\(/.test(src);
    } catch { return false; }
  });
  const missing = entries.filter(f => !ENTRY_ROUTES.includes(f));
  for (const m of missing) {
    err(`${m}\n     주문을 내는 경로인데 이 검사의 목록에 없습니다`
      + '\n     ENTRY_ROUTES에 추가하고 관문을 전부 지나게 하세요');
  }
  if (entries.length === 0) {
    err('주문을 내는 자동매매 경로를 하나도 찾지 못했습니다 — 이 검사가 고장 났습니다');
  }
}

if (bad === 0) {
  console.log(`✅ 진입 경로 ${ENTRY_ROUTES.length}개 · 관문 ${REQUIRED.length}종 · 빠진 것 0개`
    + ` · 사람이 누르는 주문 라우트 ${Object.keys(MANUAL_ORDER_ROUTES).length}곳(사유 기록됨)`);
} else {
  console.error('');
  console.error('   같은 판단을 여러 경로에 복사해 두면 언젠가 한쪽만 고쳐집니다.');
  console.error('   관문은 src/lib/engine/에 한 곳씩 두고 세 경로가 같은 함수를 부릅니다.');
}
process.exit(bad ? 1 : 0);
