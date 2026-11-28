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
import { existsSync, readFileSync, globSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

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

/**
 * **주석을 걷은 줄.** 줄 번호를 쓰는 곳이 있어 줄마다 따로 걷는다
 * (여러 줄을 한 번에 걷으면 블록 주석의 줄바꿈이 사라져 줄 번호가 밀린다).
 *
 * 전에는 줄머리만 봤다:
 *
 *     if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
 *         || t.startsWith('{/*')) return;
 *
 * 줄머리가 그 모양이면 **그 줄의 나머지 진짜 코드까지 버렸다.** TSX 에서
 * `{/* … *\/}` 는 주석을 쓰는 평범한 방법이라 사고로도 생긴다. 기계 탐침으로
 * 실제로 돌려 확인했다(변이는 저장소의 TypeScript 파서로 구문 유효성 확인):
 *
 *     setInterval(() => {
 *       {/* 메모 *\/} void fetch('/api/binance/futures/order', { method: 'POST' });
 *     }, 60000);
 *
 *   평범하게 부르면                          rc=1  ← 금지는 동작한다
 *   줄 전체를 `//` 로 주석 처리하면          rc=0  ← 맞는 동작(대조)
 *   위처럼 줄머리에 주석을 두고 부르면       rc=0  ← 구멍
 *   `/* 메모 *\/` 로 두고 부르면              rc=0  ← 구멍
 *
 * 즉 **타이머가 아무도 안 볼 때 반복해서 내는 주문**이 주석 한 개 뒤에
 * 숨었다. 이 파일이 막으려는 바로 그것이고, 본문이 결과를 적어 두었다 —
 * "탭을 닫으면 진입한 포지션을 아무도 청산하지 않습니다."
 */
export function codeLines(src) {
  return String(src).split('\n').map((l) => (
    // 여러 줄 블록 주석의 **가운데 줄**(` * …`)은 한 줄만 보면 구분할 수
    // 없다. 그 줄은 지금처럼 버린다 — 버려서 생기는 쪽은 과소검출이 아니라
    // 과대검출(주석에 적어 둔 코드를 호출로 세는 것)이므로 닫히는 방향이다.
    l.trim().startsWith('*') ? '' : stripJsComments(l)
  ));
}

/** 클라이언트가 붙이면 안 되는 확인 토큰 */
const CONFIRM_TOKENS = ['LIVE_ORDER_CONFIRMED'];

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

/** 실제로 읽은 자동 엔진. **목록 길이를 읽은 수로 적지 않는다.** */
const enginesRead = [];
const enginesMissing = [];

for (const f of AUTO_ENGINES) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch {
    // 파일이 사라졌으면 그건 더 좋은 상태다 — 없는 것을 실패로 만들지 않는다.
    // 다만 **읽지 못했다고 말한다.** 안 본 것을 본 것으로 세지 않는다.
    enginesMissing.push(f);
    continue;
  }
  enginesRead.push(f);
  const rawLines = src.split('\n');
  const lines = codeLines(src);   // 줄 번호가 그대로 맞는다
  lines.forEach((line, i) => {
    const t = rawLines[i].trim();   // 사람에게 보여 줄 때는 원문을 쓴다
    if (!line.trim()) return;

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

/**
 * **타이머가 돌고 + 주문 경로를 부르는가.** 주석 줄은 세지 않는다.
 *
 * 루프와 자기 점검이 **같은 함수**를 쓴다. 판단이 두 곳에 있으면 언젠가
 * 갈린다 — 그때 갈리는 쪽은 늘 검사기다.
 */
export function rogueHits(src) {
  const lines = codeLines(src);
  // **타이머도 주석이면 타이머가 아니다.** 걷은 줄에서 찾는다.
  if (!/setInterval\s*\(/.test(lines.join('\n'))) return [];
  return ORDER_ENDPOINTS.filter(ep => lines.some(l => l.includes(ep)));
}

/**
 * 훑는 범위. 예전에는 `src/components/**` 뿐이었다.
 *
 * 실측 RED (2026-11-10, main `220f8001`): `src/app/`에 60초 `setInterval`로
 * `/api/binance/futures/order`를 부르고 `LIVE_ORDER_CONFIRMED`까지 붙이는
 * 클라이언트 컴포넌트를 두고 이 검사기를 돌렸더니
 * **`✅ 브라우저 주문 권한 0건` · exit 0** 이었다. 이 검사기가 막으려고
 * 쓰여진 바로 그 사고가 글롭 밖이라 안 보였다.
 *
 * Next.js app 라우터에서는 화면이 `src/app/**`에도 산다. `src/components`만
 * 보는 것은 범위를 절반만 보는 것이다.
 */
const SCAN_GLOB = 'src/**/*.tsx';
let scanned = 0;

// 새 자동 엔진이 목록 밖에서 생기는 것을 막는다.
{
  const all = globSync(SCAN_GLOB)
    .map(f => f.replaceAll('\\', '/'))
    .filter(f => !/\.test\.tsx$/.test(f));

  // ── 범위가 좁아지면 이 검사는 조용히 꺼진다 ──
  // 글롭이 `src/components` 밖을 실제로 포함하는지 값으로 확인한다.
  if (!all.some(f => !f.startsWith('src/components/'))) {
    err(`훑는 범위가 src/components 안으로 좁아졌습니다 (${SCAN_GLOB} → ${all.length}개)`
      + '\n     src/app 등에 생긴 자동 엔진은 이 검사로 안 보입니다');
  }
  // 규칙이 실제로 걸리는지. 통과만 하는 검사기는 없는 것보다 나쁘다.
  if (rogueHits(`setInterval(() => { fetch('${ORDER_ENDPOINTS[0]}'); }, 1000);`).length !== 1
      || rogueHits(`// setInterval(() => fetch('${ORDER_ENDPOINTS[0]}'))`).length !== 0
      || rogueHits(`fetch('${ORDER_ENDPOINTS[0]}')`).length !== 0
      // ★ 줄머리 주석 뒤의 **진짜 호출**을 본다. 전에는 줄을 통째로 버려서
      //   이 둘이 0건이었다 — 타이머가 도는 주문이 주석 한 개 뒤에 숨었다.
      || rogueHits(`setInterval(() => { {/* m */} fetch('${ORDER_ENDPOINTS[0]}'); }, 1000);`).length !== 1
      || rogueHits(`setInterval(() => { /* m */ fetch('${ORDER_ENDPOINTS[0]}'); }, 1000);`).length !== 1) {
    err('자기 점검 실패 — 타이머+주문 판별이 깨졌습니다');
  }

  scanned = all.length;
  for (const f of all) {
    if (AUTO_ENGINES.includes(f)) continue;
    if (MANUAL_ORDER_OK[f]) continue;
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    // 타이머가 있고 + 주문 경로를 부르는 파일 = 새 자동 실행 권한
    const hitsOrder = rogueHits(src);
    if (hitsOrder.length > 0) {
      err(`${f}\n     타이머와 주문 경로(${hitsOrder.join(', ')})가 같은 파일에 있습니다`
        + '\n     아무도 안 볼 때 반복해서 주문이 나갈 수 있습니다'
        + '\n     자동 실행은 서버(워커)로 옮기고, 브라우저는 상태 표시와 명령 요청만 하세요');
    }
  }
}

// ── 면제는 만료돼야 한다 ──
//
// 이 파일은 `MANUAL_ORDER_OK`에 대해 이미 적어 두었다: "확인 없이 넣으면
// 이 검사는 꺼진 것과 같다." 그런데 그 목록이 **낡었는지는 아무도 안
// 봤다.** 면제한 파일이 사라져도, 면제가 더는 필요 없어져도 항목은
// 영구히 남고, 그 경로에 나중에 무엇이 생기든 통과한다.
//
// 실측 RED (main `220f8001`): `TradingPage.tsx`의 주문 경로를 다른
// 문자열로 바꿔 면제가 쓸모없어진 상태에서도 원본 검사기는
// `✅ … 사람이 누르는 주문 2곳(사유 기록됨)` · exit 0 이었다.
//
// 그래서 **면제가 지금도 필요한지** 값으로 확인한다. 필요 없어진 면제는
// 미리 뚫어 둔 구멍이다.
for (const [f, why] of Object.entries(MANUAL_ORDER_OK)) {
  if (!existsSync(f)) {
    err(`${f}\n     면제 목록에 있는데 파일이 없습니다 — 낡은 면제입니다`
      + '\n     그 경로에 나중에 무엇이 생기든 이 검사를 통과합니다'
      + `\n     사유: ${why}`);
    continue;
  }
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch {
    err(`${f}\n     면제 목록에 있는데 읽지 못했습니다 — 통과로 넘기지 않습니다`);
    continue;
  }
  if (rogueHits(src).length === 0) {
    err(`${f}\n     면제가 더는 필요하지 않습니다 (타이머+주문이 같이 없습니다)`
      + '\n     필요 없어진 면제는 미리 뚫어 둔 구멍입니다 — 목록에서 지우세요'
      + `\n     사유: ${why}`);
  }
}

if (bad === 0) {
  console.log(`✅ 자동 엔진 ${enginesRead.length}개 읽음`
    + (enginesMissing.length ? ` · 없는 파일 ${enginesMissing.length}개(${enginesMissing.join(', ')})` : '')
    + ` · 브라우저 주문 권한 0건`
    + ` · 훑은 화면 파일 ${scanned}개(${SCAN_GLOB})`
    + ` · 사람이 누르는 주문 ${Object.keys(MANUAL_ORDER_OK).length}곳(전부 지금도 필요함)`);
} else {
  console.error('');
  console.error('   사람이 누르는 주문과 타이머가 내는 주문은 다릅니다.');
  console.error('   앞은 보고 있고 한 번이고, 뒤는 아무도 안 볼 때 반복됩니다.');
}
process.exit(bad ? 1 : 0);
