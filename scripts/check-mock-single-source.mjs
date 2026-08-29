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

/**
 * SQL 주석(`--`)을 지운다.
 *
 * **주석을 안 지우면 검사가 내 설명문을 읽는다.** 실제로 그랬다 —
 * 마이그레이션 머리말에 `balance = balance + delta`라고 적어 뒀더니,
 * 함수 본문에서 그 연산을 걷어내도 검사가 통과했다. 통과해도 거짓인
 * 검사다.
 */
function stripSqlComments(src) {
  return String(src)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
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

// ── ⑦ 청산과 계좌 정산이 **하나의 트랜잭션**이다 ──
//
// 조건부 UPDATE만으로는 부족하다. 그것은 **같은 포지션**을 두 번 닫는
// 것만 막는다. 포지션은 닫혔는데 계좌 갱신이 실패하는 경우와, 서로
// **다른** 두 포지션이 같은 계좌를 동시에 덮어써서 한쪽 손익이 사라지는
// 경우는 못 막는다.
{
  const rel = 'src/lib/engine/paperStore.ts';
  const src = read(rel);
  if (src) {
    const code = stripComments(src);

    // 청산은 정산 함수로만 나간다.
    if (!/\.rpc\(\s*'paper_settle_close'/.test(code)) {
      err(`${rel} — 청산이 원자적 정산 함수를 거치지 않습니다`
        + '\n     포지션 UPDATE와 계좌 UPDATE가 따로면, 포지션만 닫히고'
        + '\n     **손익·수수료·매매횟수가 반영되지 않는 상태**가 만들어집니다');
    }

    // 계좌를 JS에서 읽어 덮어쓰면 lost update가 남는다.
    const readModifyWrite =
      /from\(\s*'paper_accounts'\s*\)[\s\S]{0,400}?\.update\(/.test(code);
    if (readModifyWrite) {
      err(`${rel} — 계좌를 JS에서 직접 UPDATE합니다`
        + '\n     `balance = 읽은 balance + 손익` 구조는 두 포지션이 동시에'
        + '\n     닫히면 **한쪽 손익이 사라집니다**. SQL 증분 연산으로 미세요');
    }
  }
}

// ── ⑧ 정산 함수가 실제로 존재하고 원자적인가 ──
//
// 코드가 부르는 함수가 마이그레이션에 없으면 청산은 런타임에 통째로
// 실패한다. **만들어 놓고 배선을 안 함**의 반대 방향 고장이다.
//
// **함수 하나씩 따로 본다.** 파일 전체를 한 덩어리로 보면 옆 함수에 있는
// `RAISE EXCEPTION` 하나가 이 함수의 것인 양 통과한다 — 실제로 처음에
// 그렇게 새서, 정산 함수에서 예외를 걷어내도 검사가 초록이었다.
{
  const rel = 'supabase/migrations/072_paper_settle_atomic.sql';
  const sql = read(rel);
  if (!sql) {
    err(`${rel} — 정산 함수 마이그레이션이 없습니다`);
  } else {
    const body = stripSqlComments(sql);

    /** `CREATE OR REPLACE FUNCTION public.<name>` 하나의 본문만 잘라 낸다 */
    const bodyOf = (name) => {
      const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\b`, 'i');
      const m = re.exec(body);
      if (!m) return null;
      const rest = body.slice(m.index + m[0].length);
      const next = /CREATE\s+OR\s+REPLACE\s+FUNCTION/i.exec(rest);
      return next ? rest.slice(0, next.index) : rest;
    };

    const settle = bodyOf('paper_settle_close');
    if (!settle) {
      err(`${rel} — 청산 정산 함수(paper_settle_close)가 없습니다`);
    } else {
      for (const [re, why] of [
        [/WHERE[\s\S]{0,80}status\s*=\s*'open'/i,
         "선점 조건(status='open')이 없습니다 — 같은 포지션을 두 번 닫습니다"],
        [/RETURNING\s+user_id\s+INTO/i,
         '정산 대상을 포지션 줄의 user_id로 정하지 않습니다 — 인자를 믿으면 남의 계좌를 움직입니다'],
        [/balance\s*=\s*balance\s*[+-]/i,
         '잔고를 증분 연산으로 갱신하지 않습니다 — 동시 청산에서 손익이 사라집니다'],
        [/total_pnl\s*=\s*total_pnl\s*\+/i, '손익을 증분으로 더하지 않습니다'],
        [/total_fees\s*=\s*total_fees\s*\+/i, '수수료를 증분으로 더하지 않습니다'],
        [/trade_count\s*=\s*trade_count\s*\+\s*1/i, '매매횟수를 증분으로 올리지 않습니다'],
        [/win_count\s*=\s*win_count\s*\+/i, '승수를 증분으로 올리지 않습니다'],
        [/RAISE\s+EXCEPTION/i,
         '정산 실패 시 예외를 던지지 않습니다 — 포지션만 닫힌 채로 남습니다'],
      ]) {
        if (!re.test(settle)) err(`${rel} — paper_settle_close: ${why}`);
      }
    }

    // 계좌를 만지는 나머지 함수들도 **덮어쓰지 않고 더한다.**
    for (const [name, need] of [
      ['paper_apply_entry_fee', /balance\s*=\s*balance\s*-/i],
      ['paper_deposit', /balance\s*=\s*balance\s*\+/i],
    ]) {
      const fn = bodyOf(name);
      if (!fn) err(`${rel} — ${name} 함수가 없습니다`);
      else if (!need.test(fn)) {
        err(`${rel} — ${name}: 잔고를 증분 연산으로 갱신하지 않습니다`
          + '\n     읽어서 덮어쓰면 같은 계좌를 동시에 건드릴 때 한쪽이 사라집니다');
      }
    }

    // SECURITY DEFINER로 만들면 authenticated가 남의 계좌를 움직인다.
    if (/SECURITY\s+DEFINER/i.test(body)) {
      err(`${rel} — SECURITY DEFINER를 쓰고 있습니다`
        + '\n     이 표들은 service_role 전용입니다(010의 정책). 문을 넓히지 마세요');
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
