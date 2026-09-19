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
const SHEET     = 'src/components/trading/OrderControls.tsx';
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
// 손절 값은 컨트롤러가 만든다 — 화면이 손절가를 직접 적으면 체결 기준이
// 화면에 생긴다.
if (!/stopRequestFields\s*\(/.test(code(read('src/lib/trading/useTradeForm.ts')))) {
  err('useTradeForm이 손절 값을 stopPresets를 거치지 않고 만듭니다');
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
  const form = code(read('src/lib/trading/useTradeForm.ts'));
  if (!/const gate = submitGate\(\{/.test(form)) {
    err('useTradeForm이 submitGate로 판정하지 않습니다 — 권한·수량·계획이 모두 필요합니다');
  }
  if (!/disabled=\{!form\.gate\.ready \|\| form\.busy\}/.test(workspace)) {
    err(`${WORKSPACE}의 주문 버튼이 판정과 무관하게 열려 있습니다`);
  }
}

// ── ★ 한 화면에서 끝난다 ──
//
// 시트를 여닫는 구조를 버렸다. 실기(360×660)에서 시트를 열면 캔들이 52px만
// 남았고 그 띠는 배경과 격자선뿐이었다. 여닫는 층이 없으면 52vh·88vh·
// visual viewport·겹침 문제가 통째로 사라진다.
{
  // 시트로 돌아가지 않는다
  for (const gone of ['sheetSnap', 'SheetSnap', 'workspace-sheet', 'TradeSheet']) {
    if (workspace.includes(gone)) {
      err(`${WORKSPACE}가 시트 구조로 돌아갔습니다 (${gone})`);
    }
  }
  // 주문 조작과 호가가 **상주한다**
  if (!/<OrderControls/.test(workspace)) {
    err(`${WORKSPACE}에 상주 주문 조작부가 없습니다`);
  }
  if (!/data-testid="workspace-split"/.test(workspace)) {
    err(`${WORKSPACE}에 주문│호가 분할 줄이 없습니다`);
  }
  if (!/<OrderBookView/.test(workspace)) {
    err(`${WORKSPACE}에 상주 호가가 없습니다`);
  }
  // 폭은 실측 최소치가 정한다 — 50:50을 박지 않는다
  if (!/splitColumns\(width\)/.test(workspace)) {
    err(`${WORKSPACE}가 열 비율을 oneScreen에 묻지 않습니다`);
  }
  if (!/minWidth: BOOK_MIN_PX/.test(workspace)) {
    err(`${WORKSPACE}가 호가 열에 최소 폭을 주지 않습니다 — 가격이 잘립니다`);
  }
  const one = code(read('src/lib/trading/oneScreen.ts'));
  if (!/export const BOOK_MIN_PX = 110;/.test(one)) {
    err('호가 최소 폭이 바뀌었습니다 — 실측(가격 53 + 수량 30 + 패딩 16)을 다시 확인하세요');
  }
}

// ── ★ 첫 화면이 통 안에서 끝난다 — 붙인 버튼이 슬라이더를 덮지 않는다 ──
//
// 320×600 실측: LONG/SHORT 줄이 `position: sticky; bottom: var(--nav-h)`로
// 흐름 위치(787)에서 붙는 위치(490)로 끌어올려지며 **슬라이더(447~452)를
// 덮었다.** `elementFromPoint`로 슬라이더 한가운데를 찍으면 그 버튼이
// 나왔다 — 보이는데 눌리지 않았다. 손절 2% 버튼은 앱 하단 탭 밑이었다.
//
// 이건 sticky의 성질이지 버그가 아니다. 그래서 z-index나 패딩이 아니라
// **덮을 일이 없는 배치**로 고쳤다. 다시 붙이지 않는다.
{
  const cta = workspace.slice(workspace.indexOf('data-testid="workspace-cta"'));
  const ctaBlock = cta.slice(0, cta.indexOf('</div>'));
  if (!ctaBlock) {
    err(`${WORKSPACE}에 LONG/SHORT 줄이 없습니다`);
  }
  if (/position: 'sticky'|position: 'fixed'/.test(ctaBlock)) {
    err(`${WORKSPACE}의 LONG/SHORT 줄이 다시 붙었습니다 — 320×600에서 이 줄이 슬라이더를 덮었습니다`);
  }

  // 통 높이를 받으면 그 안에서 끝난다
  if (!/coreBudget\(coreHeight, headH[,)]/.test(workspace)) {
    err(`${WORKSPACE}가 세로 예산을 oneScreen에 묻지 않습니다`);
  }
  if (!/height: coreHeight/.test(workspace)) {
    err(`${WORKSPACE}가 통 높이 안에서 끝나지 않습니다 — 아래 칸이 화면 밖으로 밀립니다`);
  }
  // 시장정보 높이는 **재서** 넣는다. 320px에서 105px, 360px에서 78px이다.
  if (!/useMeasuredHeight<HTMLDivElement>\(\)/.test(workspace)) {
    err(`${WORKSPACE}가 시장정보 줄 높이를 재지 않습니다 — 접히면 CTA가 잘립니다`);
  }

  // 넘치면 **말없이 자르지 않고** 그 칸이 스크롤한다
  const scrollers = (workspace.match(/overflowY: 'auto'/g) || []).length;
  if (scrollers < 2) {
    err(`${WORKSPACE}에서 넘치는 칸이 스크롤하지 않습니다 (${scrollers}곳) — 넘친 줄이 말없이 사라집니다`);
  }

  // 예상값은 **주문 칸 밖**에 있다. 주문 칸은 좁으면 안에서 스크롤하는데,
  // 증거금·청산가가 거기 딸려 올라가면 누르기 직전에 안 보인다.
  if (!/<OrderEstimate/.test(workspace)) {
    err(`${WORKSPACE}가 예상값 줄을 따로 그리지 않습니다`);
  }
  const splitStart = workspace.indexOf('data-testid="workspace-split"');
  const estAt = workspace.indexOf('<OrderEstimate');
  const ctaAt = workspace.indexOf('data-testid="workspace-cta"');
  if (!(splitStart >= 0 && estAt > splitStart && ctaAt > estAt)) {
    err(`${WORKSPACE}의 예상값 줄이 [주문│호가]와 CTA 사이에 있지 않습니다`);
  }

  const one = code(read('src/lib/trading/oneScreen.ts'));
  // 호가 3+1+3이 통째로 들어갈 높이를 바닥으로 준다
  if (!/export const SPLIT_MIN_H = BOOK_H \+ SPLIT_PAD_H;/.test(one)) {
    err('[주문│호가] 바닥이 미니 호가 실측 높이에서 나오지 않습니다 — 매수 줄이 잘립니다');
  }
  // 차트가 격자선만 남는 높이로 내려가지 않는다 (실기 실패: 52px · 색 2종)
  const m = one.match(/export const CHART_MIN_H = (\d+);/);
  if (!m || Number(m[1]) < 90) {
    err(`차트 바닥이 ${m ? m[1] : '?'}px입니다 — 실기에서 52px은 격자선뿐이었습니다`);
  }
}

// ── ★ 포지션은 주문이 간 장부에서 읽는다 ──
//
// 정본 화면에 포지션 줄이 없던 동안 `BottomDock`이 대신 그렸고, 그 둘은
// 다른 계좌를 보고 있었다.
//
//   주문      usePaperTarget(challengeId) → /api/paper/order   → 챌린지 계좌
//   포지션 표시 usePaperAccount            → /api/paper/account → is_default
//
// 챌린지로 주문하면 방금 연 포지션이 안 보이고 기본 계좌 포지션이 보인다.
// 오류는 없다 — "포지션이 없네"로 읽힌다. 계좌가 어긋나는 것은 배치 문제가
// 아니라 **장부 문제**다.
{
  const row = code(read('src/components/trading/PositionRow.tsx'));
  if (!row) {
    err('한 화면에 포지션 줄이 없습니다 — 주문한 포지션을 확인할 곳이 없습니다');
  }

  // ① 이 줄은 **다시 읽지 않는다.** 새 조회가 생기면 계좌가 갈릴 자리가 생긴다.
  if (/\/api\/paper\/account/.test(row)) {
    err('포지션 줄이 /api/paper/account를 읽습니다 — 그 라우트는 늘 기본 계좌입니다');
  }
  if (/\/api\/paper\/positions/.test(row)) {
    err('포지션 줄이 포지션을 다시 조회합니다 — 화면이 이미 가진 장부를 써야 합니다');
  }
  // **이름이 아니라 호출을 본다.** 타입을 `usePaperLedger`에서 가져오는
  // 것은 정상이다 — 그 장부가 주는 모양을 그대로 받는다는 뜻이니까.
  // 처음에 이름만 찾게 썼더니 그 import 줄에 걸려 빨개졌다.
  for (const hook of ['usePaperAccount', 'useBinanceStream', 'usePaperLedger', 'usePaperTarget']) {
    if (new RegExp(`${hook}\\s*\\(`).test(row)) {
      err(`포지션 줄이 스스로 장부를 읽습니다 (${hook}) — props로 받은 정본만 씁니다`);
    }
  }
  // ② 청산은 기존 정본 경로 하나다. 새 정산 권위를 만들지 않는다.
  if (!/'\/api\/paper\/close'/.test(row)) {
    err('포지션 줄이 기존 청산 경로를 쓰지 않습니다');
  }
  for (const banned of [/paper_account_id/, /accountId/, /fillPrice:/, /realizedPnl/, /unrealized/]) {
    if (banned.test(row)) {
      err(`포지션 줄이 계좌·손익을 스스로 다룹니다 (${banned}) — 정본에 없는 값을 만들지 않습니다`);
    }
  }

  // ③ 화면이 **주문에 쓰는 바로 그 장부**를 넘기는가.
  // **한 곳만 보면 안 된다.** 포지션 줄은 두 자리에 있다(통 안 / 통 밖).
  // 한쪽만 지켜도 통과하게 두면, 나머지 한쪽으로 다른 장부가 들어온다 —
  // 실제로 뮤테이션이 그 틈으로 살아남았다.
  const rows = (workspace.match(/<PositionRow/g) || []).length;
  const fed = (workspace.match(/positions=\{openPositions\}/g) || []).length;
  const reloads = (workspace.match(/onClosed=\{ledger\.reload\}/g) || []).length;
  if (rows === 0) {
    err(`${WORKSPACE}가 포지션 줄을 그리지 않습니다`);
  }
  if (fed !== rows) {
    err(`${WORKSPACE}의 포지션 줄 ${rows}곳 중 ${fed}곳만 자기 장부를 받습니다`);
  }
  if (reloads !== rows) {
    err(`${WORKSPACE}의 포지션 줄 ${rows}곳 중 ${reloads}곳만 청산 뒤 장부를 다시 읽습니다`);
  }
  if (!/const openPositions = paperOrders && auth \? ledger\.openPositions : \[\]/.test(workspace)) {
    err(`${WORKSPACE}의 포지션 출처가 usePaperLedger가 아닙니다 — 계좌가 갈립니다`);
  }
}

// ── ★ 같은 사유를 두 번 적지 않는다 ──
//
// 실기에서 `비율이 0입니다`가 화면에 두 번 찍혔다. 판정은 하나
// (`planSizing` → `submitGate`)인데 그리는 곳만 둘이었다 — 슬라이더 안과
// 주문 버튼 위. 남기는 쪽은 **버튼에 가장 가까운 것**이다.
{
  const slider = code(read('src/components/trading/SizingSlider.tsx'));
  for (const dup of ['sizing-locked', 'sizing-reason']) {
    if (slider.includes(dup)) {
      err(`SizingSlider가 사유를 다시 그립니다 (${dup}) — order-blocked-reason과 같은 문장이 두 번 보입니다`);
    }
  }
  // 사유를 그리는 곳은 한 곳뿐이어야 한다.
  const controls = code(read(SHEET));
  const spots = (controls.match(/data-testid="order-blocked-reason"/g) || []).length;
  if (spots !== 1) {
    err(`잠금 사유를 그리는 곳이 ${spots}곳입니다 — 정확히 한 곳이어야 합니다`);
  }
}

// ── ★ 칸 이름을 글자 단위로 쪼개지 않는다 ──
//
// `손절<br/>거리`라고 직접 넣어 둔 탓에 실기에서 `손절` / `거리`가 서로
// 다른 칸 이름처럼 보였다. 좁아서 접힌 게 아니라 늘 갈라져 있었다.
{
  const controls = code(read(SHEET));
  if (/손절<br\s*\/?>거리/.test(controls)) {
    err('손절거리 라벨에 강제 줄바꿈이 있습니다 — 두 칸 이름으로 읽힙니다');
  }
}

// ── ★ 잠긴 주문 버튼에는 이유가 있다 ──
//
// 실기에서 로그인·잔고·수량이 다 있는데 버튼만 회색이었고, 사유가 화면
// 어디에도 없었다. 판정은 맞았고 **말을 안 한 것이 고장**이었다.
{
  const gateMod = code(read('src/lib/trading/submitGate.ts'));
  if (!/reason: string \| null;/.test(gateMod)) {
    err('submitGate가 사유를 함께 돌려주지 않습니다');
  }
  // 막힌 분기마다 사유가 붙어 있는가
  const blocked = (gateMod.match(/ready: false/g) || []).length;
  const reasons = (gateMod.match(/reason: i\.[a-zA-Z]+ \|\|/g) || []).length;
  if (blocked > reasons) {
    err(`submitGate에 사유 없는 잠금이 있습니다 (잠금 ${blocked} · 사유 ${reasons})`);
  }
  const controls = code(read(SHEET));
  if (!/data-testid="order-blocked-reason"/.test(controls)) {
    err('주문 조작부가 잠금 사유를 그리지 않습니다');
  }
  // 손절은 선물에서 필수다 — 그 칸이 숨으면 주문 자체가 불가능해진다
  if (!/STOP_PCTS\.map/.test(controls)) {
    err('주문 조작부에 손절 거리 프리셋이 없습니다 — 선물은 손절이 필수라 주문이 막힙니다');
  }
}

// ── ★ 숫자를 잘라서 통과시키지 않는다 ──
{
  const controls = code(read(SHEET));
  const slider = code(read('src/components/trading/SizingSlider.tsx'));
  for (const [name, body] of [['OrderControls', controls], ['SizingSlider', slider]]) {
    if (/textOverflow: 'ellipsis'/.test(body)) {
      err(`${name}이 값을 …로 잘라 통과시킵니다 — 잘린 숫자는 자릿수를 잘못 세게 만듭니다`);
    }
    if (!/overflowWrap: 'anywhere'/.test(body)) {
      err(`${name}이 좁을 때 줄을 나누지 않습니다 — 값이 잘립니다`);
    }
  }
  // 사이징 계산이 두 곳에 있으면 같은 입력에 다른 수량이 나온다
  if (/planSizing\(/.test(slider)) {
    err('SizingSlider가 수량을 다시 계산합니다 — 계산은 useTradeForm 한 곳입니다');
  }
}

// ── ★ 주문 판정이 한 벌이다 ──
{
  const form = code(read('src/lib/trading/useTradeForm.ts'));
  if (!/buildPaperPlan\(/.test(form)) {
    err('useTradeForm이 서버와 같은 계획 함수를 쓰지 않습니다');
  }
  if (/buildPaperPlan\(/.test(code(read('src/components/trading/OrderControls.tsx')))) {
    err('주문 조작부가 계획을 직접 계산합니다 — 판정은 useTradeForm 한 곳입니다');
  }
  // 대기 주문 백엔드가 없으므로 지정가 UI를 만들지 않는다
  // **낱말이 아니라 UI를 본다.** 주석에 '지정가'를 못 쓰게 하면 곧
  // 우회 표현을 쓰게 되고, 검사가 뜻이 아니라 글자를 보게 된다.
  const ctl = code(read('src/components/trading/OrderControls.tsx'));
  for (const banned of [/>\s*지정가\s*</, /['"]LIMIT['"]/, /\bBBO\b/, /orderType/]) {
    if (banned.test(ctl)) {
      err(`주문 조작부에 대기 주문 UI가 있습니다 (${banned}) — 모의 백엔드에 그 개념이 없습니다`);
    }
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
  + ' 비로그인 fail-closed · 한 화면 상주 · 통 안에서 종료 · 포지션 장부 일치 · 사유 1곳 · CTA 비부착 · 예상값 상시노출 · 넘침 비은폐 · 잠금 사유 노출 ·'
  + ' 값 비절단 · 판정 1벌');
