#!/usr/bin/env node
// scripts/check-trading-layout.mjs
//
// **거래화면이 담긴 칸의 폭을 보고 배치를 정하는가.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 터미널 껍데기가 이렇게 정했다:
//
//   const tier = tierOf(window.innerWidth);       // 뷰포트로 판단
//   <Pane style={{ width: `${rightPct}%` }}>      // 폭은 퍼센트
//
// 이 화면은 앱 탭(`.mc`) 안에 들어가고, 그 폭은 뷰포트에서 사이드바(240)와
// 뉴스 레일(300)을 뺀 값이다. 1664 창에서 "1664니까 3열"이라고 결정하지만
// 실제로 쓸 수 있는 폭은 1124였다. 게다가 퍼센트라 좁아지면 주문판이 같이
// 줄었다 — 실측 1664에서 301px, 1440에서 240px, 1366에서 226px. 그 안에서
// 라벨과 값이 겹쳤다(1366에서 13곳).
//
// **CI는 그때도 전부 초록이었다.** 테스트·빌드·타입검사 어느 것도 화면
// 폭을 보지 않기 때문이다.
//
// 이 검사가 보는 것과 안 보는 것
// ──────────────────────────────
// 실제 렌더 기하는 브라우저가 있어야 잰다. Playwright는 이 저장소의
// 의존성이 아니고, UI 검증 하나 때문에 무거운 의존성을 추가하지 않는다.
// 그래서 **소스 계약**만 여기서 지킨다:
//   · 배치 판단이 한 곳(lib/ui/tradingLayout)에 있고 테스트가 돈다
//   · 껍데기가 뷰포트가 아니라 담긴 칸을 잰다
//   · 열 폭이 퍼센트가 아니다
//   · 검사기가 찾을 표식(data-region)이 있다
//   · 뉴스 레일 자동 접기가 실제로 배선돼 있다
// 실제 픽셀 확인은 `scripts/probe/`가 한다(수동, README 참조).

import { readFileSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

let bad = false;
const err = (m) => { bad = true; console.error(`❌ ${m}`); };

const PLAN   = 'src/lib/ui/tradingLayout.ts';
const PLANT  = 'src/lib/ui/tradingLayout.test.ts';
const SHELL  = 'src/components/terminal/TerminalShell.tsx';
const APP    = 'src/app/page.tsx';
const MOBILE = 'src/components/terminal/MobileShell.tsx';
const TOPBAR = 'src/components/terminal/TopBar.tsx';
const SYMS   = 'src/components/terminal/SymbolSearch.tsx';
const FILES = [PLAN, PLANT, SHELL, APP, MOBILE, TOPBAR, SYMS];

const code = {};
for (const f of FILES) {
  if (!existsSync(f)) { err(`${f}를 찾지 못했습니다 — 이 검사가 무엇을 보는지 다시 확인하세요`); continue; }
  const t = readFileSync(f, 'utf8');
  if (!t.trim()) { err(`${f}가 비어 있습니다`); continue; }
  code[f] = stripJsComments(t);
}
if (bad) { console.error('\n검사할 파일을 못 읽었습니다. 여기서 멈춥니다.\n'); process.exit(1); }

const need = (f, re, msg) => { if (!re.test(code[f])) err(`${f}: ${msg}`); };
const deny = (f, re, msg) => { if (re.test(code[f])) err(`${f}: ${msg}`); };

/* ── ① 배치 판단이 한 곳에 있고 실제로 돈다 ────────────────── */
need(PLAN, /export function planTradingLayout/, '배치 판단 함수가 없습니다');
need(PLAN, /export function shouldCollapseNewsRail/, '뉴스 레일 판단이 없습니다');
need(PLAN, /export const ORDER_MIN\s*=\s*(\d+)/, '주문판 최소폭이 없습니다');
/* 중앙 최소폭은 UI-1의 panelPrefs가 정본이다. 여기서 다시 선언하면
   한쪽만 바뀌는 날이 온다. */
deny(PLAN, /const\s+CENTER_MIN\s*=\s*\d/, '중앙 최소폭을 다시 선언합니다 — panelPrefs에서 가져오세요');
need(PLAN, /from\s*'\.\/panelPrefs'/, 'panelPrefs의 검증된 값을 쓰지 않습니다');
need(PLANT, /export function runTradingLayoutTests/, '배치 판단에 테스트가 없습니다');
const runner = readFileSync('scripts/run-tests.mjs', 'utf8');
if (!/runTradingLayoutTests\s*\(\s*\)/.test(runner)) {
  err('scripts/run-tests.mjs에 runTradingLayoutTests()가 등록되지 않았습니다 — 테스트가 돌지 않습니다');
}
const orderMin = Number(/export const ORDER_MIN\s*=\s*(\d+)/.exec(code[PLAN])?.[1] || 0);
if (orderMin < 340) err(`${PLAN}: 주문판 최소폭이 ${orderMin}px입니다 — 340px 아래에서는 라벨과 값이 겹칩니다`);

/* ── ② 껍데기가 담긴 칸을 잰다 ─────────────────────────────── */
need(SHELL, /ResizeObserver/, '담긴 칸의 폭을 재지 않습니다 — 옆 칸이 접혀 넓어진 것을 놓칩니다');
need(SHELL, /planTradingLayout\s*\(/, '배치 판단을 쓰지 않습니다');
/* 뷰포트로 tier를 정하던 것이 이번 고장의 뿌리다. */
/* **껍데기는 뷰포트 폭을 아예 읽지 않는다.** 조건식으로 감싸거나 변수에
   담아서 넘기는 변형이 얼마든지 가능하므로, 특정 호출 모양을 막는 대신
   `window.innerWidth`가 이 파일에 나타나는 것 자체를 막는다.
   폭은 ResizeObserver가 잰 담긴 칸의 값만 쓴다. */
deny(SHELL, /window\.innerWidth/, '뷰포트 폭을 읽습니다 — 이 화면은 앱 탭 안에 있어 담긴 칸의 폭과 다릅니다');
need(SHELL, /planTradingLayout\s*\(\s*availW\s*\)/, '측정한 칸 폭을 배치 판단에 넘기지 않습니다');

/* ── ③ 열 폭이 퍼센트가 아니다 ─────────────────────────────── */
deny(SHELL, /width:\s*`\$\{[^}]*Pct\}%`/, '열 폭이 퍼센트입니다 — 좁아지면 주문판이 같이 줄어듭니다');
need(SHELL, /width:\s*orderW/, '주문판 폭을 픽셀로 주지 않습니다');
need(SHELL, /ORDER_MIN/, '주문판 최소폭을 지키지 않습니다');
need(SHELL, /CENTER_MIN/, '중앙 최소폭을 지키지 않습니다');
/* 예전 저장값은 가로가 퍼센트였다. 같은 키로 읽으면 주문판이 27px가 된다. */
deny(SHELL, /tg_terminal_layout_v1/, '옛 저장 키를 그대로 씁니다 — 퍼센트 값이 픽셀로 읽힙니다');

/* ── ④ 검사기가 찾을 표식 ──────────────────────────────────
   내용(문구)으로 영역을 추측하면, 문구가 바뀌는 날 검사가 조용히
   아무것도 안 보게 된다. */
for (const [f, name] of [[SHELL, 'order'], [SHELL, 'chart'], [SHELL, 'market'],
                         [TOPBAR, 'topbar'], [MOBILE, 'tradingShell']]) {
  if (!new RegExp(`data-region="${name}"`).test(code[f])) {
    err(`${f}: data-region="${name}" 표식이 없습니다 — 기하 검사가 이 영역을 찾지 못합니다`);
  }
}
need(MOBILE, /data-mode=\{wide \?/, '태블릿·모바일을 구분해 표시하지 않습니다');

/* ── ⑤ 뉴스 레일이 거래 탭에서 먼저 물러난다 ────────────────
   공간 우선순위: 중앙 > 주문 > 종목 > 시세·뉴스. */
need(APP, /shouldCollapseNewsRail\s*\(/, '뉴스 레일 자동 접기를 배선하지 않았습니다');
need(APP, /tab\s*===\s*'trading'/, '거래 탭에서만 접는 조건이 없습니다 — 다른 화면까지 바뀝니다');
/* 상태만 두고 조건에서 안 쓰면 아무 일도 안 한다. 조건에 실제로
   들어가 있는지 본다. */
need(APP, /&&\s*!railUserOpened/, '사용자가 직접 펼친 선택이 자동 접기 조건에 반영되지 않습니다 — 자동 판단이 조작을 덮습니다');

/* ── ⑥ 좁을 때 글자를 줄여서 맞추지 않는다 ──────────────────
   상단바는 우선순위가 낮은 것을 빼고, 종목 헤더는 한국어 단어를 지킨다. */
need(TOPBAR, /ResizeObserver/, '상단바가 자기 폭을 재지 않습니다');
/* 이름만 있고 폭 조건과 연결돼 있지 않으면 좁아져도 아무것도 안 빠진다. */
need(TOPBAR, /const roomy\s*=/, '상단바가 폭으로 밀도를 정하지 않습니다');
need(TOPBAR, /showBalance\s*=\s*[^;]*roomy/, '선물 잔고가 폭 조건과 연결돼 있지 않습니다 — 좁아져도 안 빠집니다');
need(TOPBAR, /showConnChip\s*=\s*[^;]*roomy/, '거래소 칩이 폭 조건과 연결돼 있지 않습니다');
need(SYMS, /wordBreak:\s*'keep-all'/, '종목 헤더가 한국어 단어를 줄 중간에서 끊습니다');

/* ── ⑦ 실행 의미는 건드리지 않았다 ─────────────────────────
   배치 작업이 주문 payload·실행 경로를 바꾸면 안 된다. */
deny(SHELL, /fetch\s*\(|\/api\//, '껍데기가 서버를 부릅니다 — 배치 파일이 할 일이 아닙니다');

if (bad) {
  console.error('\n거래화면 배치가 담긴 칸의 폭을 보지 않거나, 최소폭을 지키지 않습니다.\n'
    + '실제 픽셀 확인은 scripts/probe/README.md 참조.\n');
  process.exit(1);
}
console.log('✅ 거래화면 배치 계약 — 담긴 칸의 폭으로 판단 · 중앙/주문 최소폭 · 표식 · 레일 우선순위');
