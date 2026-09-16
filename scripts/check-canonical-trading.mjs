#!/usr/bin/env node
// scripts/check-canonical-trading.mjs
//
// **사용자가 실제로 다니는 길에 붙어 있는가.**
//
// 무엇이 고장이었나
// ─────────────────
// 거래소형 거래 화면을 만들어 놓고 `모의매매` 탭에만 붙였다. 그런데 사람이
// 여는 길은 `/ → 매매`이고 그건 `TerminalTab → TerminalShell → MobileShell`
// 이다. 실제 기기 스크린샷에서야 드러났다 — **코드는 있고 화면에는 없었다.**
//
// 시험으로는 못 잡는다. 컴포넌트는 정상이고, 시험도 통과하고, 빌드도 된다.
// 잡히는 곳은 "누가 그걸 렌더하는가"뿐이다.
//
// 무엇을 보는가
// ─────────────
//   ① 매매 탭이 터미널로 간다
//   ② 모바일 터미널이 정본 거래 화면을 렌더한다
//   ③ 정본 거래 화면을 렌더하는 곳이 **하나뿐이다** (두 번째 화면 금지)
//   ④ 정본 화면의 사이징은 슬라이더 하나다 (옛 퍼센트 줄이 안 따라온다)
//   ⑤ 손절 거리는 사이징과 섞이지 않는다
//   ⑥ 실거래 주문은 정본 시트가 가로채지 않는다
//   ⑦ 도달할 수 없는 화면을 되살리지 않는다
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PAGE      = 'src/app/page.tsx';
const SHELL     = 'src/components/terminal/TerminalShell.tsx';
const MOBILE    = 'src/components/terminal/MobileShell.tsx';
const WORKSPACE = 'src/components/trading/TradingWorkspace.tsx';
const SHEET     = 'src/components/trading/TradeSheet.tsx';
const TARGET    = 'src/lib/trading/paperTarget.ts';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const page = code(read(PAGE));
const shell = code(read(SHELL));
const mobile = code(read(MOBILE));
const workspace = code(read(WORKSPACE));
const sheet = code(read(SHEET));
const target = code(read(TARGET));

// ── ① 매매 탭 → 터미널 ──
if (!/tab\s*===\s*'trading'\s*\?[\s\S]{0,200}<TerminalTab/.test(page)) {
  err(`${PAGE}에서 매매 탭이 터미널로 가지 않습니다 — 진입점이 바뀌었으면 이 검사도 같이 바뀌어야 합니다`);
}

// ── ② 모바일 터미널 → 정본 거래 화면 ──
if (!/plan\.kind !== 'desktop'[\s\S]{0,120}MobileShell/.test(shell)) {
  err(`${SHELL}에서 모바일이 MobileShell로 가지 않습니다`);
}
if (!/<TradingWorkspace/.test(mobile)) {
  err(`${MOBILE}이 정본 거래 화면을 렌더하지 않습니다 — 만들어 놓고 길에 안 붙인 상태입니다`);
}
// 세로·가로 둘 다. 폰을 돌리면 다른 규칙의 주문판이 나오면 안 된다.
{
  const n = (mobile.match(/<TradingWorkspace/g) || []).length;
  if (n < 2) err(`${MOBILE}이 정본 거래 화면을 ${n}곳에서만 씁니다 — 세로와 가로 둘 다여야 합니다`);
}
// 정본 화면이 뜨는 동안 두 번째 차트를 같이 두지 않는다
if (!/canonMarket \? null : <ChartDrawer/.test(mobile)) {
  err(`${MOBILE}이 정본 화면과 TradingView 차트를 함께 그립니다 — 봉을 말하는 곳이 둘이 됩니다`);
}

// ── ③ 정본 거래 화면을 렌더하는 곳이 하나뿐이다 ──
const walk = (dir) => {
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.tsx$/.test(p) && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
};
{
  const hosts = walk('src').filter(f => f !== WORKSPACE && /<TradingWorkspace/.test(code(read(f))));
  if (hosts.length !== 1) {
    err(`정본 거래 화면을 렌더하는 파일이 ${hosts.length}개입니다 (${hosts.join(', ') || '없음'})`
      + ' — 거래 화면이 둘이 되면 언젠가 규칙이 갈립니다');
  }
}

// ── ④ 사이징은 슬라이더 하나 ──
if (!/<SizingSlider/.test(sheet)) {
  err(`${SHEET}에 사이징 슬라이더가 없습니다`);
}
for (const legacy of ['setByRisk', '위험 0.5', '[0.5, 1, 2]']) {
  if (sheet.includes(legacy) || workspace.includes(legacy)) {
    err(`정본 화면에 옛 위험 역산 사이징이 따라왔습니다 (${legacy})`);
  }
}
// 잔고 퍼센트 버튼을 슬라이더 밖에서 또 만들지 않는다
if (/\[25,\s*50,\s*75,\s*100\]/.test(sheet) || /\[25,\s*50,\s*75,\s*100\]/.test(workspace)) {
  err('정본 화면이 사이징 퍼센트 줄을 슬라이더와 별도로 또 그립니다');
}

// ── ⑤ 손절 거리는 사이징이 아니다 ──
// import 줄에 이름만 남아 있어도 `includes`는 통과한다. **그리는지**를 본다.
if (!/STOP_PCTS\.map\s*\(/.test(sheet)) {
  err(`${SHEET}가 손절 거리 프리셋을 그리지 않습니다 — 사이징과 뜻이 달라 지우면 안 됩니다`);
}
// 손절 프리셋은 퍼센트로 나간다. 화면이 손절가를 정하면 체결 기준이 화면에 생긴다.
if (!/stopRequestFields\s*\(/.test(sheet)) {
  err(`${SHEET}가 손절 값을 stopPresets를 거치지 않고 직접 만듭니다`);
}

// ── ⑥ 실거래를 가로채지 않는다 ──
if (!/paperSheetHandlesOrders\s*\(/.test(workspace)) {
  err(`${WORKSPACE}가 모의 여부를 확인하지 않습니다 — 실거래가 모의 라우트로 갈 수 있습니다`);
}
// **문자열을 손으로 적지 않는다.** 한 번 'mock'이라고 적었다가 — 도달할 수
// 없는 옛 화면의 어휘였다 — 모의인데 실거래 주문폼이 열렸다.
if (!/return tradeMode === PAPER_TRADE_MODE;/.test(target)) {
  err(`${TARGET}의 모의 판정이 정본 상수 비교가 아닙니다 — 어휘가 갈리면 모드가 뒤바뀝니다`);
}
if (!/const PAPER_TRADE_MODE: TradeMode = 'PAPER';/.test(target)) {
  err(`${TARGET}의 모의 모드 이름이 TradeMode 타입에 묶여 있지 않습니다`);
}
// 정본 시트가 실거래 라우트를 직접 부르지 않는다
for (const route of ['/api/binance/futures/order', '/api/binance/spot/order', '/api/binance/coinm/order']) {
  if (sheet.includes(route)) err(`${SHEET}가 실거래 라우트를 직접 부릅니다 (${route})`);
}

// ── ⑦ 비로그인에서 닫혀 있는가 ──
//
// 로그인 전에는 가용 잔고를 **물어볼 수조차 없다**. 그 상태에서 슬라이더가
// 움직이거나 주문 버튼이 열려 있으면, 사용자는 "되는 줄 알고" 누르고
// 서버가 401로 막는다 — 화면이 거짓말을 한 것이다.
{
  const slider = code(read('src/components/trading/SizingSlider.tsx'));
  if (!/const balanceUnknown = availableBalance == null;/.test(slider)) {
    err('SizingSlider가 잔고 못 읽음을 판정하지 않습니다');
  }
  if (!/const locked = !!disabled \|\| balanceUnknown;/.test(slider)) {
    err('SizingSlider가 잔고를 못 읽어도 잠기지 않습니다');
  }
  if (!/disabled=\{locked\}/.test(slider)) {
    err('SizingSlider의 입력이 잠금 상태를 반영하지 않습니다');
  }
  // 못 읽은 잔고를 0으로 접지 않는다 — 0은 "돈이 없다"로 읽힌다
  if (/availableBalance \|\| 0|Number\(availableBalance\) \|\| 0/.test(slider)) {
    err('SizingSlider가 못 읽은 잔고를 0으로 접습니다');
  }
  // 주문 버튼은 세 가지가 모두 참일 때만 열린다
  if (!/const ready = canOrder && quantity != null && quantity > 0 && preview\.ok;/.test(sheet)) {
    err(`${SHEET}의 주문 가능 판정이 약해졌습니다 — 권한·수량·계획이 모두 필요합니다`);
  }
  if (!/disabled=\{!ready \|\| busy\}/.test(sheet)) {
    err(`${SHEET}의 주문 버튼이 판정과 무관하게 열려 있습니다`);
  }
}

// ── ⑧ 도달할 수 없는 화면을 되살리지 않는다 ──
//
// `TradingPage.tsx`는 `renderPage()`의 case로만 닿는데, `renderPage()`는
// `tab !== 'trading'`일 때만 불린다. 즉 그 case는 실행되지 않는다.
// 지우는 것은 별도 정리 작업이고, 여기서는 **정본 화면으로 다시 쓰지
// 않는다**는 것만 고정한다.
{
  const tp = code(read('src/components/pages/TradingPage.tsx'));
  if (/<TradingWorkspace|PriceChart|TradeSheet|SizingSlider/.test(tp)) {
    err('도달할 수 없는 TradingPage에 정본 거래 부품이 붙었습니다 — 거기서는 아무도 볼 수 없습니다');
  }
  if (!/case 'trading':\s*return <TradingPageComp/.test(page)) {
    // case가 사라졌으면 이 검사의 전제가 바뀐 것이다. 조용히 통과시키지 않는다.
    err(`${PAGE}의 trading case가 바뀌었습니다 — TradingPage 도달 가능성을 다시 확인하세요`);
  }
}

if (bad > 0) {
  console.error(`\n정본 거래 화면 배선 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 정본 거래 화면 — 매매 탭에 붙음 · 세로/가로 한 벌 · 렌더 1곳 ·'
  + ' 사이징 슬라이더 1개 · 손절 거리 보존 · 실거래 비가로채기 ·'
  + ' 비로그인 fail-closed');
