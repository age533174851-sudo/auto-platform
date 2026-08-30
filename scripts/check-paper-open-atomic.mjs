#!/usr/bin/env node
// scripts/check-paper-open-atomic.mjs
//
// **모의 진입에 '부분 성공'이 없다.**
//
// 무엇이 있었나
// ─────────────
// 진입은 두 단계였다:
//
//   ① paper_positions  INSERT
//   ② paper_apply_entry_fee  RPC (balance −= fee, total_fees += fee)
//
// 서로 다른 트랜잭션이라 ②만 실패할 수 있다. 그러면 포지션은 존재하고
// 그 줄에 `entry_fee`가 적혀 있는데, 계좌 잔고는 수수료만큼 **영구히
// 높게** 남는다. 수익률은 `(balance − initial) / initial`로 나오므로 한 번
// 어긋나면 **그 뒤의 모든 수익률과 다음 주문 크기가 그 위에서 계산된다.**
//
// 더 나쁜 것: `openPaperPosition`이 `feeApplied`를 돌려주고 있었는데
// **읽는 호출자가 한 곳도 없었다.** 실패가 기록도, 재시도도, 대조도 되지
// 않았다.
//
// 반대 방향(수수료만 빠지고 포지션 없음)은 순서상 일어날 수 없었다. 즉
// 고장은 언제나 "장부가 실제보다 부자로 보이는" 쪽이었다.
//
// 이 검사가 지키는 것
// ───────────────────
//   · 정본 진입 경로가 원자 RPC 하나를 지난다
//   · 그 RPC 안에서 계좌를 잠그고, 포지션을 넣고, 수수료를 뺀다
//   · 잔고는 읽고 고쳐 쓰지 않고 SQL이 증가시킨다
//   · 계좌가 없으면 아무것도 만들지 않는다 (071의 생성 정책 유지)
//   · 중복은 signal_id 충돌만이다
//   · 실패에서 옛 두 단계 경로로 되돌아가지 않는다
//   · 부분 성공을 표현하는 칸(feeApplied)이 없다
//
// 사용: node scripts/check-paper-open-atomic.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `paper_apply_entry_fee`와 `feeApplied`를 그대로 적는다.
function stripJs(src) {
  let out = '', i = 0, quote = null;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) quote = null;
      out += c === '\n' ? '\n' : c;
      i++; continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/** SQL의 `--` 주석을 뗀다. 문자열 리터럴 안의 `--`는 건드리지 않는다. */
function stripSql(src) {
  let out = '', i = 0, inStr = false, dollar = false;
  while (i < src.length) {
    const c = src[i];
    if (dollar) { if (src.startsWith('$$', i)) { dollar = false; out += '$$'; i += 2; continue; } out += c; i++; continue; }
    if (inStr) { if (c === "'") inStr = false; out += c; i++; continue; }
    if (src.startsWith('$$', i)) { dollar = true; out += '$$'; i += 2; continue; }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') i++; continue; }
    out += c; i++;
  }
  return out;
}

function fnBodyAt(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return '';
  const paren = src.indexOf('(', at);
  if (paren < 0) return '';
  let depth = 0, i = paren;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  // ── 반환 타입을 본문으로 읽지 않는다 ──
  //
  // `): Promise<{ ... }> {` 처럼 서명 뒤에 중괄호가 하나 더 있다. 그냥
  // 첫 `{`를 잡으면 **타입 블록**을 함수 본문으로 읽는다 — 이 저장소에서
  // 이미 두 번 겪은 고장이다. 닫힌 뒤에 `>`가 오면 타입이니 건너뛴다.
  let from = i;
  for (;;) {
    const open = src.indexOf('{', from);
    if (open < 0) return '';
    depth = 0;
    let close = -1;
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) { close = k; break; } }
    }
    if (close < 0) return src.slice(open);
    const after = src.slice(close + 1).match(/^\s*(.)/)?.[1] ?? '';
    if (after === '>' || after === ',' || after === '|' || after === '&') { from = close + 1; continue; }
    return src.slice(open, close + 1);
  }
}

const STORE = 'src/lib/engine/paperStore.ts';
const MIG_DIR = 'supabase/migrations';
const TEST = 'src/lib/engine/paperOpenAtomic.test.ts';

// ── 1. SQL 함수 ──
let sqlFile = null;
if (existsSync(MIG_DIR)) {
  for (const name of readdirSync(MIG_DIR)) {
    if (!name.endsWith('.sql')) continue;
    const raw = readFileSync(`${MIG_DIR}/${name}`, 'utf8');
    if (/CREATE OR REPLACE FUNCTION public\.paper_open_position/.test(raw)) { sqlFile = `${MIG_DIR}/${name}`; break; }
  }
}
if (!sqlFile) fail('paper_open_position 함수를 정의하는 마이그레이션이 없습니다');
else {
  const sql = stripSql(readFileSync(sqlFile, 'utf8'));
  const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.paper_open_position');
  const end = sql.indexOf('$$;', at);
  const body = end > at ? sql.slice(at, end) : '';
  if (!body) fail(`${sqlFile}에서 함수 본문을 뜯지 못했습니다`);
  else {
    // ── 셋이 **같은 함수 안**에 있어야 한다 ──
    //
    // 이름이 파일 어딘가에 있는 것으로는 부족하다. 함수 밖에 있으면
    // 트랜잭션이 갈라지고, 그게 고치려던 고장 그 자체다.
    for (const [re, what] of [
      [/FOR UPDATE/, '계좌 줄 잠금'],
      [/INSERT INTO public\.paper_positions/, '포지션 INSERT'],
      [/UPDATE public\.paper_accounts/, '수수료 갱신'],
    ]) {
      if (!re.test(body)) fail(`${sqlFile}의 paper_open_position 안에 ${what}이 없습니다`);
    }
    // 잠금이 **INSERT보다 앞**이어야 한다. 뒤면 동시 진입에서 중복 검사가 샌다.
    const lockAt = body.search(/FOR UPDATE/);
    const insAt = body.search(/INSERT INTO public\.paper_positions/);
    if (lockAt >= 0 && insAt >= 0 && lockAt > insAt) {
      fail(`${sqlFile}이 포지션을 넣은 뒤에 계좌를 잠급니다 — 순서가 뒤집혔습니다`);
    }
    // 잔고는 읽고 고쳐 쓰지 않는다.
    if (!/balance\s*=\s*balance\s*-\s*p_entry_fee/.test(body)) {
      fail(`${sqlFile}이 잔고를 차감식(balance = balance - fee)으로 갱신하지 않습니다`);
    }
    if (!/total_fees\s*=\s*total_fees\s*\+\s*p_entry_fee/.test(body)) {
      fail(`${sqlFile}이 수수료 누계를 증가식으로 갱신하지 않습니다`);
    }
    // 계좌를 만들지 않는다 (071).
    if (/INSERT INTO public\.paper_accounts/.test(body)) {
      fail(`${sqlFile}의 진입 함수가 계좌를 만듭니다 — 시작한 적 없는 계좌가 거래로 생깁니다`);
    }
    for (const code of ['NO_ACCOUNT', 'DUPLICATE', 'OPENED']) {
      if (!body.includes(code)) fail(`${sqlFile}이 ${code} 상태를 돌려주지 않습니다`);
    }
    // 중복은 signal_id 충돌만.
    if (!/paper_pos_signal_uniq/.test(body)) {
      fail(`${sqlFile}이 signal_id 유니크만 중복으로 보지 않습니다 — 다른 충돌까지 삼킵니다`);
    }
    if (!/RAISE\s*;/.test(body)) {
      fail(`${sqlFile}이 알 수 없는 유니크 위반을 다시 던지지 않습니다`);
    }
    // 수수료 갱신이 0행이면 되돌린다.
    if (!/GET DIAGNOSTICS/.test(body) || !/RAISE EXCEPTION/.test(body)) {
      fail(`${sqlFile}이 계좌 갱신 실패에서 진입을 되돌리지 않습니다`);
    }
    // **금액을 SQL이 다시 계산하지 않는다.** 공식이 두 벌이 되면 갈린다.
    for (const bad of ['fee_rate', 'slippage', '* p_quantity', '* p_notional']) {
      if (body.includes(bad)) fail(`${sqlFile}의 함수가 금액을 계산합니다: ${bad}`);
    }
    // 남의 계좌를 움직일 통로를 만들지 않는다.
    if (/SECURITY DEFINER/.test(body)) {
      fail(`${sqlFile}이 SECURITY DEFINER입니다 — authenticated가 남의 계좌를 움직일 수 있습니다`);
    }
    notes.push(`${sqlFile}이 잠금·진입·수수료를 한 함수 안에서 처리합니다`);
  }
}

// ── 2. 정본 진입 경로 ──
if (!existsSync(STORE)) fail(`${STORE}이 없습니다`);
else {
  const store = stripJs(readFileSync(STORE, 'utf8'));
  const open = fnBodyAt(store, 'export async function openPaperPosition');
  if (!open) fail(`${STORE}에서 openPaperPosition 본문을 찾지 못했습니다`);
  else {
    if (!/rpc\s*\(\s*'paper_open_position'/.test(open)) {
      fail(`${STORE}의 openPaperPosition이 원자 RPC를 쓰지 않습니다`);
    }
    // ── 옛 두 단계가 돌아오면 안 된다 ──
    if (/from\s*\(\s*'paper_positions'\s*\)[\s\S]{0,80}insert/.test(open)) {
      fail(`${STORE}의 정본 진입이 포지션을 직접 INSERT합니다 — 수수료와 갈라집니다`);
    }
    if (/paper_apply_entry_fee/.test(open)) {
      fail(`${STORE}의 정본 진입이 수수료를 따로 부릅니다`
        + ' — 두 트랜잭션으로 갈라지면 부분 성공이 되살아납니다');
    }
    // 실패에서 옛 경로로 되돌아가지 않는다.
    if (/(catch|error)[\s\S]{0,200}paper_apply_entry_fee/.test(open)) {
      fail(`${STORE}이 RPC 실패에서 옛 두 단계 경로로 되돌아갑니다`);
    }
    for (const code of ['OPENED', 'DUPLICATE', 'NO_ACCOUNT']) {
      if (!open.includes(code)) fail(`${STORE}이 ${code}를 옮기지 않습니다`);
    }
  }
  // 부분 성공을 표현하는 칸이 남아 있으면 안 된다.
  if (/feeApplied/.test(store)) {
    fail(`${STORE}에 feeApplied가 남아 있습니다`
      + ' — "포지션은 있고 수수료는 모름"이 표현 가능한 상태가 됩니다');
  }
  notes.push(`${STORE}의 진입이 원자 RPC 하나만 지납니다`);
}

// 저장소 전체에서 정본 외의 진입 경로가 없는지.
for (const dir of ['src/app/api', 'src/lib']) {
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${name.name}`;
      if (name.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ts') && !p.endsWith('.tsx')) continue;
      if (p.endsWith('.test.ts')) continue;
      if (p === STORE) continue;
      const src = stripJs(readFileSync(p, 'utf8'));
      if (/paper_apply_entry_fee/.test(src)) {
        fail(`${p}이 진입 수수료를 따로 부릅니다 — 정본은 paper_open_position 하나입니다`);
      }
      if (/from\s*\(\s*'paper_positions'\s*\)[\s\S]{0,80}\.insert/.test(src)) {
        fail(`${p}이 모의 포지션을 직접 INSERT합니다 — openPaperPosition을 쓰세요`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
}

// ── 3. 시험 ──
const reg = existsSync('scripts/run-tests.mjs') ? readFileSync('scripts/run-tests.mjs', 'utf8') : '';
if (!existsSync(TEST)) fail(`${TEST}이 없습니다`);
else {
  if (!reg.includes('runPaperOpenAtomicTests()')) fail('run-tests.mjs에 runPaperOpenAtomicTests()가 없습니다');
  const t = readFileSync(TEST, 'utf8');
  for (const [needle, label] of [
    ['옛 두 단계 경로로 되돌아가지 않는다', '실패 시 fallback 금지'],
    ['계좌가 없으면 NO_ACCOUNT', '계좌 없음'],
    ['중복 신호는 포지션을 만들지 않는다', '멱등'],
    ['부분 성공을 표현하는 칸이 남아 있지 않다', 'feeApplied 제거'],
  ]) {
    if (!t.includes(needle)) fail(`${TEST}에 ${label} 시험이 없습니다`);
  }
}

console.log('모의 진입 원자성 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 포지션과 진입 수수료는 함께 남거나 함께 없습니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
