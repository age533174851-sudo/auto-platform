#!/usr/bin/env node
// scripts/check-practice-boundary.mjs
//
// **연습 장부는 모의투자 계좌가 아니다 — 화면도 그렇게 말해야 한다.**
//
// 무슨 일이 있었나
// ────────────────
// 매매 화면의 로컬 장부(`tg_paper_balance_v1`, 원화, localStorage)가
// "모의 포지션 · MOCK"이라는 이름으로 떠 있었다. 서버의 정본 모의투자
// (PAPER · `paper_accounts` · USDT)와 **같은 이름**이었다. 두 화면이 다른
// 숫자를 말하는데 이름이 같으면 사용자는 어느 쪽도 못 믿는다.
//
// 더 나쁜 것은 SL/TP였다. 로컬 장부에는 손절·익절을 입력하는 자리가 있었고
// 값도 저장됐다. 그런데 그 값을 보고 청산하는 실행자가 **없었다** —
// 브라우저 감시기(`checkPaperExits`)는 남아 있었지만 부르는 곳이 0이었다.
// 손절선을 적어 두고 잠들면 아침에 손절되지 않은 포지션을 본다. 화면이
// 없는 기능을 있는 것처럼 말한 것이다.
//
// 여기서 보는 것
// ──────────────
//   ① 브라우저 청산 감시기가 되살아나지 않았는가
//   ② 죽은 SL/TP 칸이 장부와 화면에서 사라졌는가
//   ③ 저장 키(`tg_paper_balance_v1`)를 그대로 두는가 — 이름도 값도
//   ④ 화면이 "이건 이 브라우저의 연습 장부다"라고 말하는가
//   ⑤ 연습 모드 주문 폼에 자동 SL/TP 입력칸이 없는가
//
// **값도 비밀도 읽지 않는다.** 이 검사가 보는 것은 파일의 모양뿐이다.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
let bad = 0;
const fail = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };
const read = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { fail(`${rel}을 읽지 못했습니다 — 검사가 대상을 잃었습니다`); return null; }
  return readFileSync(p, 'utf8');
};

/**
 * 주석을 걷어낸다.
 *
 * **안 걷어내면 검사가 제 설명을 코드로 읽는다.** 이 저장소는 그 고장을
 * 여러 번 겪었다. 이 PR이 손대는 파일들은 하나같이 "예전에는 이랬다"는
 * 역사를 주석으로 남긴다 — 그 역사가 위반으로 읽히면 안 되고, 반대로
 * 위반을 주석 뒤에 숨길 수도 없어야 한다.
 */
function stripComments(src) {
  let out = ''; let i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c; i += 1;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') { out += s[i]; i += 1; } out += s[i] ?? ''; i += 1; }
      out += q; i += 1; continue;
    }
    out += c; i += 1;
  }
  return out;
}

/**
 * 함수·인터페이스 본문을 떼어 낸다.
 *
 * **서명 괄호를 먼저 지나간다.** 그러지 않으면 매개변수 타입 블록
 * (`fn(i: { … })`)이나 반환 타입 블록(`): Promise<{ … }> {`)을 본문으로
 * 읽는다 — 이 저장소에서 실제로 네 번 그랬다.
 */
function bodyAt(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  let i = at + anchor.length;
  // 서명 괄호를 건너뛴다
  const paren = src.indexOf('(', at);
  const brace0 = src.indexOf('{', at);
  if (paren >= 0 && (brace0 < 0 || paren < brace0)) {
    let d = 0;
    for (i = paren; i < src.length; i += 1) {
      if (src[i] === '(') d += 1;
      else if (src[i] === ')') { d -= 1; if (d === 0) { i += 1; break; } }
    }
  }
  // 반환 타입 안의 `{…}`는 본문이 아니다.
  //
  // **여기서 한 번 뚫렸다.** 처음엔 뒤따르는 글자가 `> , | &`일 때만
  // 타입으로 봤다. 그런데 `): { ok: boolean } {` 꼴에서는 반환 타입 블록
  // 다음에 오는 것이 **본문을 여는 `{`**다 — 그래서 검사가 반환 타입을
  // 본문으로 읽었고, 본문에 `slPrice: 1`을 적어 넣어도 통과했다.
  for (;;) {
    const open = src.indexOf('{', i);
    if (open < 0) return null;
    let d = 0, end = -1;
    for (let j = open; j < src.length; j += 1) {
      if (src[j] === '{') d += 1;
      else if (src[j] === '}') { d -= 1; if (d === 0) { end = j; break; } }
    }
    if (end < 0) return null;
    const after = src.slice(end + 1).match(/^\s*(.)/)?.[1] ?? '';
    if ('>,|&{'.includes(after)) { i = end + 1; continue; }
    return src.slice(open, end + 1);
  }
}

const STORE   = 'src/lib/autotrade/store.ts';
const PAGE    = 'src/components/pages/TradingPage.tsx';
const SETTING = 'src/components/pages/SettingsPage.tsx';
const LEDGER_KEY = 'tg_paper_balance_v1';

/** src 아래 모든 ts/tsx 파일 */
function srcFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, 'src'));
  return out;
}

// ── ① 브라우저 청산 감시기가 되살아나지 않았는가 ──
//
// **없앤 것으로 끝이 아니다.** 이 저장소는 "만들어 놓고 배선을 안 함"과
// "지웠는데 다시 들어옴"을 둘 다 겪었다. 정의도 호출도 없어야 한다.
{
  for (const rel of srcFiles()) {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    if (/(?:export\s+)?(?:async\s+)?function\s+checkPaperExits\b/.test(code)
      || /\bcheckPaperExits\s*[:=]\s*(?:async\s*)?\(/.test(code)) {
      fail(`${rel}: 브라우저 청산 감시기(checkPaperExits)가 다시 정의됐습니다`
        + '\n     이 장부에는 탭을 닫아도 도는 실행자가 없습니다 — 판정기만 두면'
        + '\n     화면은 "손절이 걸렸다"고 말하고 장부는 아무것도 하지 않습니다');
    }
    if (/\bcheckPaperExits\s*\(/.test(code)) {
      fail(`${rel}: checkPaperExits(…)를 부릅니다 — 브라우저가 연습 청산을 판정합니다`);
    }
  }
}

// ── ② 죽은 SL/TP 칸이 장부에서 사라졌는가 ──
{
  const src = read(STORE);
  if (src) {
    const code = stripComments(src);

    const pos = bodyAt(code, 'interface PaperPosition');
    if (!pos) fail(`${STORE}: PaperPosition 본문을 찾지 못했습니다 — 이름이 바뀌었다면 이 검사도 같이 고치세요`);
    else {
      for (const f of ['slPrice', 'tpPrice', 'tp1Price', 'tp1Done', 'highWater']) {
        if (new RegExp(`\\b${f}\\s*\\??\\s*:`).test(pos)) {
          fail(`${STORE}: PaperPosition에 ${f} 칸이 있습니다`
            + '\n     적을 수 있으면 화면은 그것을 "걸어 둔 것"으로 그립니다.'
            + '\n     읽어서 청산할 실행자가 생기기 전까지 칸을 두지 않습니다');
        }
      }
    }

    const buy = bodyAt(code, 'export function paperBuy');
    const sig = code.slice(code.indexOf('export function paperBuy'), code.indexOf('export function paperBuy') + 400);
    if (!buy) fail(`${STORE}: paperBuy 본문을 찾지 못했습니다`);
    else {
      for (const f of ['stopLossPct', 'takeProfitPct']) {
        if (new RegExp(`\\b${f}\\b`).test(sig) || new RegExp(`\\b${f}\\b`).test(buy)) {
          fail(`${STORE}: paperBuy가 ${f}을 받습니다 — 받아서 적기만 하는 값입니다`);
        }
      }
      for (const f of ['slPrice', 'tpPrice']) {
        if (new RegExp(`\\b${f}\\s*[:=]`).test(buy)) {
          fail(`${STORE}: paperBuy가 ${f}을 장부에 적습니다 — 아무도 읽지 않습니다`);
        }
      }
    }
  }
}

// ── ③ 저장 키를 그대로 두는가 ──
//
// **사용자의 기존 장부를 건드리지 않는 것이 이 작업의 조건이다.** 이름을
// 바꾸거나 옮기거나 지우면 그 순간 사흘 돌린 연습 성적이 사라진다 —
// 그리고 사용자는 그게 우리 쪽 정리였다는 것을 모른다.
{
  const src = read(STORE);
  if (src) {
    const code = stripComments(src);
    if (!new RegExp(`const\\s+PAPER_BAL_KEY\\s*=\\s*['"\`]${LEDGER_KEY}['"\`]`).test(code)) {
      fail(`${STORE}: 연습 장부 키가 '${LEDGER_KEY}'가 아닙니다`
        + '\n     키를 바꾸면 기존 사용자의 장부가 통째로 안 읽힙니다');
    }
    // 읽기가 값을 깎으면 그것도 마이그레이션이다.
    const load = bodyAt(code, 'export function loadPaperBalance');
    if (!load) fail(`${STORE}: loadPaperBalance 본문을 찾지 못했습니다`);
    else {
      if (!/parsed\.positions/.test(load)) {
        fail(`${STORE}: loadPaperBalance가 저장된 positions를 그대로 넘기지 않습니다`
          + '\n     칸을 골라 담으면 예전 값이 조용히 사라집니다');
      }
      if (/\bdelete\b/.test(load)) {
        fail(`${STORE}: loadPaperBalance가 저장된 칸을 지웁니다 — 읽기는 지우지 않습니다`);
      }
    }
  }

  // 어느 파일도 이 키를 지우거나 다른 판으로 옮기지 않는다.
  for (const rel of srcFiles()) {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    if (new RegExp(`removeItem\\s*\\(\\s*['"\`]${LEDGER_KEY}`).test(code)
      || /removeItem\s*\(\s*PAPER_BAL_KEY/.test(code)) {
      fail(`${rel}: 연습 장부 키를 지웁니다 — 사용자의 기존 잔고가 사라집니다`);
    }
    const versions = [...code.matchAll(/tg_paper_balance_v(\d+)/g)].map(m => m[1]);
    for (const v of versions) {
      if (v !== '1') fail(`${rel}: 연습 장부 키를 v${v}로 옮깁니다 — 키 rename/migration은 하지 않습니다`);
    }
  }
}

// ── ④ 화면이 어느 장부인지 말하는가 ──
{
  const src = read(PAGE);
  if (src) {
    const code = stripComments(src);

    // 서버 PAPER와 같은 이름으로 부르지 않는다.
    if (/모의 포지션\s*\(/.test(code)) {
      fail(`${PAGE}: 로컬 장부 카드를 '모의 포지션'이라 부릅니다`
        + '\n     서버 모의투자(PAPER)와 같은 이름입니다 — 두 화면이 다른 숫자를'
        + '\n     말하는데 이름이 같으면 사용자는 어느 쪽도 못 믿습니다');
    }
    if (!/연습 포지션\s*\(/.test(code)) {
      fail(`${PAGE}: 로컬 장부 카드가 '연습 포지션'으로 표시되지 않습니다`);
    }

    // 경계를 **항상** 말한다 — 모드에 따라 붙었다 떨어졌다 하면 안 된다.
    const NEEDED = [
      ['브라우저', '이 장부가 브라우저에만 있다는 사실'],
      ['모의투자(PAPER)', '서버 정본 계좌와 다른 장부라는 사실'],
      ['자동 손절·익절이 없습니다', '자동 SL/TP가 없다는 사실'],
    ];
    for (const [needle, why] of NEEDED) {
      if (!code.includes(needle)) {
        fail(`${PAGE}: 연습 장부 안내에 ${why}이 없습니다 (\`${needle}\`)`);
      }
    }

    // 죽은 SL/TP를 그리지 않는다.
    //
    // **연습 카드만 본다.** 같은 파일에 거래소 실포지션 카드가 있고, 거기
    // `p.tpPrice`·`p.slPrice`는 **거래소에 실제로 걸린 주문**이다 — 그것까지
    // 싸잡아 막으면 진짜 있는 기능을 지우게 된다. 파일 전체를 보는 검사는
    // 여기서 틀린 검사다.
    const cardAt = code.indexOf('연습 포지션 (');
    const card = cardAt < 0 ? '' : code.slice(cardAt, (() => {
      const e = code.indexOf('</Card>', cardAt);
      return e < 0 ? code.length : e;
    })());
    if (!card) fail(`${PAGE}: 연습 포지션 카드를 찾지 못했습니다`);
    for (const f of ['slPrice', 'tpPrice']) {
      if (new RegExp(`\\bp\\.${f}\\b`).test(card)) {
        fail(`${PAGE}: 연습 포지션 카드가 ${f}을 그립니다 — 아무도 감시하지 않는 값입니다`);
      }
    }
    // 그 카드에 TP/SL 편집 입구가 다시 생기지 않는다.
    if (/TP\/SL 편집/.test(card) || /quickActions\.includes\(\s*'tpsl'/.test(card)) {
      fail(`${PAGE}: 연습 포지션 카드에 TP/SL 편집 버튼이 있습니다`
        + '\n     그 편집기가 적던 값을 읽고 청산하는 실행자가 없습니다');
    }
    // 연습 장부에 SL/TP를 쓰는 통로도 없다.
    if (/savePaperBalance\s*\(/.test(code)) {
      fail(`${PAGE}: 화면이 연습 장부를 직접 저장합니다`
        + '\n     진입·청산·리버스 말고 장부를 쓰는 자리가 생기면, 그 자리가'
        + '\n     다시 "저장은 되는데 아무도 안 읽는 값"이 됩니다');
    }
    // 진입에도 죽은 비율을 넘기지 않는다.
    const bi = code.indexOf('paperBuy(tradeEnvOf(');
    if (bi < 0) fail(`${PAGE}: 연습 진입 호출(paperBuy)을 찾지 못했습니다`);
    else {
      const args = code.slice(bi, code.indexOf(');', bi));
      for (const f of ['stopLossPct', 'takeProfitPct']) {
        if (args.includes(f)) fail(`${PAGE}: 연습 진입에 ${f}을 넘깁니다 — 적히기만 하는 값입니다`);
      }
    }

    // ── ⑤ 연습 모드 주문 폼에 자동 SL/TP 입력칸이 없다 ──
    //
    // **칸이 있다는 것 자체가 "걸어 뒀다"는 뜻으로 읽힌다.** 안내문을
    // 붙여 두는 것으로는 부족하다 — 칸이 모드로 갈라져야 한다.
    const ti = code.indexOf('value={tp}');
    if (ti < 0) fail(`${PAGE}: 주문 폼의 TP 입력칸을 찾지 못했습니다 — 모양이 바뀌었다면 이 검사도 같이 고치세요`);
    else {
      const before = code.slice(Math.max(0, ti - 700), ti);
      if (!/tradeMode\s*===\s*'mock'/.test(before)) {
        fail(`${PAGE}: 주문 폼의 TP/SL 입력칸이 연습 모드에서도 보입니다`
          + '\n     연습 장부에는 그 값을 보고 청산할 실행자가 없습니다.'
          + '\n     입력칸을 모드로 갈라내세요');
      }
      if (!/자동 손절·익절\(TP\/SL\)이 없습니다/.test(before)) {
        fail(`${PAGE}: 연습 모드 주문 폼이 "자동 손절·익절이 없다"고 말하지 않습니다`);
      }
    }
  }
}

// ── ⑥ 설정에 없는 기능을 켜는 토글이 없다 ──
{
  const src = read(SETTING);
  if (src) {
    const code = stripComments(src);
    if (/k\s*:\s*'tpsl'/.test(code)) {
      fail(`${SETTING}: 연습 포지션 'TP/SL 편집' 토글이 남아 있습니다`
        + '\n     끌 수 있는 토글로 두면 "켜면 되는 기능"으로 읽힙니다 —'
        + '\n     그 버튼이 열던 편집기는 없습니다');
    }
  }
}

if (bad > 0) {
  console.error(`\n연습 장부 경계 검사 실패 ${bad}건`);
  console.error('로컬 연습 장부는 서버 모의투자(PAPER)가 아니고, 자동 청산 실행자도 없습니다.');
  console.error('화면이 그 사실을 말하지 않으면, 사용자는 없는 기능을 믿고 잠듭니다.');
  process.exit(1);
}
console.log('✅ 연습 장부 경계 — 로컬 연습(브라우저)과 서버 모의투자(PAPER)가 화면에서 갈라져 있고,');
console.log('   작동하지 않는 자동 SL/TP가 없으며, 저장 키 tg_paper_balance_v1은 그대로입니다');
