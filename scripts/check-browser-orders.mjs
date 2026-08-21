#!/usr/bin/env node
// scripts/check-browser-orders.mjs
//
// **타이머가 도는 브라우저 코드는 주문을 내지 않는다.**
//
// 무슨 일이 있었나
// ────────────────
// `AutoTradeEngine.tsx`가 60초 `setInterval`로 전략을 평가하고, 조건이
// 맞으면 `/api/binance/futures/order`에 `LIVE_ORDER_CONFIRMED`를 붙여
// **실제 주문을 냈다.** 전략 목록은 전략빌더가 localStorage에 넣어 둔
// 것이었다.
//
//   · 탭을 닫으면 진입한 포지션을 아무도 청산하지 않는다
//   · 다른 기기에서는 그 전략이 존재하지도 않는다
//   · 워커가 지키는 관문(마이그레이션·청산감시·지문·소유권·킬스위치)을
//     **하나도 지나지 않는다**
//
// 즉 워커와 별개인 **두 번째 실행 권한**이었다.
//
// 사람이 누르는 주문과 무엇이 다른가
// ─────────────────────────────────
// 거래 화면에서 사용자가 '매수'를 누르는 것은 그 사람이 보고 있고,
// 한 번에 하나이고, 실패하면 바로 안다. **타이머는 아무도 안 볼 때
// 반복해서 낸다.** 그래서 여기서 막는 것은 타이머가 도는 파일뿐이다.
import { readFileSync, globSync } from 'node:fs';

/** 자동으로(사람 없이) 반복 실행되는 브라우저 코드 */
const AUTO_ENGINES = [
  'src/components/AutoTradeEngine.tsx',
  'src/components/MockAutoTrade.tsx',
];

/** 실제 거래소에 닿는 주문 경로 */
const ORDER_ENDPOINTS = [
  '/api/binance/futures/order',
  '/api/binance/spot/order',
  '/api/binance/coinm/order',
  '/api/exchange/order',
  '/api/gate/order',
  '/api/stock/order',
];

/** 클라이언트가 붙이면 안 되는 확인 토큰 */
const CONFIRM_TOKENS = ['LIVE_ORDER_CONFIRMED'];

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

for (const f of AUTO_ENGINES) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch {
    // 파일이 사라졌으면 그건 더 좋은 상태다 — 없는 것을 실패로 만들지 않는다.
    continue;
  }
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    // 주석은 검사하지 않는다 — 왜 없앴는지 설명하려면 경로를 적어야 한다.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return;

    for (const ep of ORDER_ENDPOINTS) {
      if (line.includes(ep)) {
        err(`${f}:${i + 1}\n     타이머가 도는 브라우저 코드가 주문 경로(${ep})를 부릅니다`
          + '\n     탭을 닫으면 진입한 포지션을 아무도 청산하지 않습니다'
          + '\n     자동매매는 서버 예약(autotrade_schedules)이 유일한 경로입니다'
          + `\n     ${t.slice(0, 110)}`);
      }
    }
    for (const tok of CONFIRM_TOKENS) {
      if (line.includes(tok)) {
        err(`${f}:${i + 1}\n     클라이언트가 ${tok}을 붙이고 있습니다`
          + '\n     실거래 확인은 서버가 판단합니다 — 브라우저가 스스로 확인했다고 말할 수 없습니다'
          + `\n     ${t.slice(0, 110)}`);
      }
    }
  });
}

/**
 * 타이머와 주문이 같은 파일에 있지만 **사람이 누르는** 주문인 곳.
 *
 * 타이머는 시세 갱신용이고, 주문은 확인 대화상자나 사용자가 고른 비율로
 * 나간다. 사람이 보고 있고, 한 번이고, 실패하면 바로 안다 — 타이머가
 * 아무도 안 볼 때 반복해서 내는 것과 다르다.
 *
 * **이 목록에 넣으려면 그 파일의 주문이 정말 사용자 행동에서만
 * 시작되는지 확인해야 한다.** 확인 없이 넣으면 이 검사는 꺼진 것과 같다.
 */
const MANUAL_ORDER_OK = {
  'src/components/terminal/BottomDock.tsx':
    '시세 타이머(10s·15s)와 별개로, 주문은 confirmDialog로 사용자 확인을 받은 뒤에만 나간다',
  'src/components/pages/TradingPage.tsx':
    '시세·워커 타이머와 별개로, 청산은 사용자가 비율을 고른 순간에만 나간다',
};

// 새 자동 엔진이 목록 밖에서 생기는 것을 막는다.
{
  const all = globSync('src/components/**/*.tsx').map(f => f.replaceAll('\\', '/'));
  for (const f of all) {
    if (AUTO_ENGINES.includes(f)) continue;
    if (MANUAL_ORDER_OK[f]) continue;
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    // 타이머가 있고 + 주문 경로를 부르는 파일 = 새 자동 실행 권한
    const hasTimer = /setInterval\s*\(/.test(src);
    if (!hasTimer) continue;
    const hitsOrder = ORDER_ENDPOINTS.filter(ep => {
      // 주석 줄은 뺀다
      return src.split('\n').some(l => {
        const t = l.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('{/*')) return false;
        return l.includes(ep);
      });
    });
    if (hitsOrder.length > 0) {
      err(`${f}\n     타이머와 주문 경로(${hitsOrder.join(', ')})가 같은 파일에 있습니다`
        + '\n     아무도 안 볼 때 반복해서 주문이 나갈 수 있습니다'
        + '\n     자동 실행은 서버(워커)로 옮기고, 브라우저는 상태 표시와 명령 요청만 하세요');
    }
  }
}

if (bad === 0) {
  console.log(`✅ 자동 엔진 ${AUTO_ENGINES.length}개 · 브라우저 주문 권한 0건`
    + ` · 사람이 누르는 주문 ${Object.keys(MANUAL_ORDER_OK).length}곳(사유 기록됨)`);
} else {
  console.error('');
  console.error('   사람이 누르는 주문과 타이머가 내는 주문은 다릅니다.');
  console.error('   앞은 보고 있고 한 번이고, 뒤는 아무도 안 볼 때 반복됩니다.');
}
process.exit(bad ? 1 : 0);
