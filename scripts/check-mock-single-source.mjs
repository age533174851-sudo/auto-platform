#!/usr/bin/env node
// scripts/check-mock-single-source.mjs
//
// **모의계좌가 둘이었다.**
//
//   서버 PAPER      paper_accounts · paper_positions · USDT · 실제 전략 평가
//   브라우저 로컬    localStorage · 원화 · 자체 decide() · 자체 TP/SL
//
// 그래서 자동매매 MOCK 화면과 지갑 MOCK 탭이 **서로 다른 잔고**를 보여
// 줬고, 어느 쪽이 진짜인지 알 방법이 없었다. 그 상태에서 색깔·레이아웃을
// 갈아엎으면 예쁜 화면 두 곳이 다른 답을 하는 꼴이 된다.
//
// 이 검사는 "돌아오지 않게" 한다. 배선이라 순수 테스트로는 안 잡힌다.
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

/** 모의 잔고를 보여 주는 화면. **여기는 서버만 읽는다** */
const MOCK_SCREENS = [
  'src/components/MockAutoTrade.tsx',
  'src/components/pages/AutoPage.tsx',
  'src/components/pages/WalletPage.tsx',
];

/** 브라우저 로컬 장부 함수 — 화면이 모의 잔고로 쓰면 안 된다 */
const LOCAL_LEDGER = ['loadPaperBalance', 'paperBuy', 'paperSell', 'checkPaperExits', 'resetPaperBalance'];

// ── ① 모의 잔고 화면은 로컬 장부를 읽지 않는다 ──
for (const rel of MOCK_SCREENS) {
  const src = read(rel);
  if (!src) continue;
  const code = stripComments(src);
  for (const fn of LOCAL_LEDGER) {
    if (new RegExp(`\\b${fn}\\s*\\(`).test(code)) {
      err(`${rel} — 로컬 장부(${fn})를 씁니다`
        + '\n     서버 PAPER와 다른 숫자가 나오는 자리입니다'
        + '\n     같은 계좌를 두 화면이 다르게 보여 주면 사용자는 둘 다 못 믿습니다');
    }
  }
}

// ── ② 브라우저가 모의를 체결하지 않는다 ──
{
  const rel = 'src/components/AutoTradeEngine.tsx';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    for (const fn of ['paperBuy', 'paperSell', 'checkPaperExits']) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(code)) {
        err(`${rel} — 브라우저가 모의를 체결/청산합니다 (${fn})`
          + '\n     이 컴포넌트는 상시 마운트되지만 **탭을 닫으면 멈춥니다**'
          + '\n     진입만 하고 멈추면 그 포지션을 아무도 청산하지 않습니다');
      }
    }
  }
}

// ── ③ 두 화면이 같은 정규화기를 쓴다 ──
for (const rel of ['src/components/MockAutoTrade.tsx', 'src/lib/portfolio/paperPanel.ts']) {
  const src = read(rel);
  if (src && !/paperViewOf\s*\(/.test(stripComments(src))) {
    err(`${rel} — 공용 정규화기(paperViewOf)를 쓰지 않습니다`
      + '\n     각자 서버 응답을 꺼내 쓰면 언젠가 한쪽에만 칸이 늘고 숫자가 갈립니다');
  }
}

// ── ④ 예전 로컬 기록을 서버 장부에 자동으로 합치지 않는다 ──
{
  const rel = 'src/lib/portfolio/legacyPaper.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    for (const bad2 of ['import', 'migrate', 'merge']) {
      if (new RegExp(`export function \\w*${bad2}`, 'i').test(code)) {
        err(`${rel} — 예전 로컬 기록을 옮기는 함수가 있습니다`
          + '\n     원화·체결·TP/SL 규칙이 달라 합치면 성적표가 오염됩니다'
          + '\n     있으면 언젠가 누가 부릅니다');
      }
    }
  }
}

// ── ⑤ 정규화기가 로컬 저장소를 읽지 않는다 ──
{
  const rel = 'src/lib/portfolio/paperView.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (/localStorage|sessionStorage/.test(code)) {
      err(`${rel} — 정규화기가 브라우저 저장소를 읽습니다`
        + '\n     읽지 않는 것이 "로컬이 서버를 덮을 수 없다"의 구현입니다');
    }
  }
}

// ── ⑥ **서버에 PAPER 청산 주체가 있다** ──
//
// "브라우저 청산이 없다"만 검사하면 부족하다. 브라우저에서 걷어내고
// 서버에 아무도 없으면, 모의 자동매매는 **진입만 하고 자동청산이 안 되는**
// 시스템이 된다. 두 조건을 같이 고정한다.
{
  const rel = 'src/app/api/paper/exit-monitor/route.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    if (!/paperExitPlan\s*\(/.test(code)) {
      err(`${rel} — 청산 판정을 부르지 않습니다`);
    }
    if (!/closePaperPosition\s*\(/.test(code)) {
      err(`${rel} — 청산을 실행하지 않습니다`);
    }
    // **모의 청산이 거래소를 건드릴 통로를 두지 않는다.**
    for (const banned of ['executeOrder', 'placeOrder', 'orderExecutor', 'futuresAdapter']) {
      if (code.includes(banned)) {
        err(`${rel} — 모의 청산 경로에 거래소 주문(${banned})이 있습니다`
          + '\n     MOCK 조작이 TESTNET/LIVE로 새는 통로입니다');
      }
    }
  }
}

{
  const rel = 'worker/src/index.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    // **정의가 아니라 호출을 본다.**
    if (!/await\s+pollPaperExit\s*\(/.test(code)) {
      err(`${rel} — 워커가 모의 청산 감시를 깨우지 않습니다`
        + '\n     브라우저에서 걷어냈는데 서버에서 아무도 안 부르면'
        + '\n     **모의 자동매매는 진입만 하고 손절이 안 걸립니다**');
    }
  }
}

// ── ⑦ 같은 포지션을 두 번 닫아 계좌가 두 번 반영되지 않는다 ──
{
  const rel = 'src/lib/engine/paperStore.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);
    // 조건부 UPDATE로 선점하고, 돌아온 줄을 봐야 한다.
    if (!/\.eq\('status',\s*'open'\)[\s\S]{0,40}\.select\(/.test(code)) {
      err(`${rel} — 청산에 선점(조건부 UPDATE)이 없습니다`
        + '\n     read → status 확인 → update 구조는 경쟁을 막지 못합니다'
        + '\n     두 실행기가 같은 줄을 집으면 **계좌가 두 번 반영됩니다**');
    }
  }
}

if (bad === 0) {
  console.log('✅ 모의계좌 단일화 유지 — 진실은 서버 PAPER 하나 · 진입도 청산도 서버가 한다');
} else {
  console.error('');
  console.error('   같은 계좌를 두 화면이 다르게 보여 주는 것이 가장 나쁩니다.');
  console.error('   사용자는 둘 중 어느 쪽도 믿을 수 없게 됩니다.');
}
process.exit(bad ? 1 : 0);
