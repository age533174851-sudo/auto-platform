#!/usr/bin/env node
// scripts/check-paper-capacity.mjs
//
// **모의 계좌의 크기는 모의 계좌에서 나오고, 잔고보다 크게 열 수 없다.**
//
// 무엇이 있었나
// ─────────────
// `buildRiskContext`에 PAPER 분기가 없었다. 그래서 모의 자동매매의 포지션
// 크기가 **거래소 잔고**에서, 그것도 못 읽으면 **폴백 $10,000**에서 나왔다.
// 계좌가 3,000으로 줄어도 크기는 10,000 기준이었다.
//
//   복리    번 만큼 커지고 잃은 만큼 작아져야 하는데 아무 일도 없었다
//   수익률  `(balance − initial)/initial`은 실제 계좌에서 나오는데
//           크기는 다른 숫자에서 나왔다 — 같은 세계를 말하지 않는다
//
// 그리고 잔고 검사 자체가 없어 계좌보다 큰 포지션이 열릴 수 있었다. 앱에서
// 검사를 붙여도 부족하다 — 동시에 들어온 두 신호는 같은 가용 증거금을 보고
// **둘 다 통과**한다. 계좌 줄을 잠근 트랜잭션만이 차례를 세운다.
//
// 이 검사가 지키는 것
// ───────────────────
//   · PAPER 자산·가용 증거금이 모의 장부에서 나온다
//   · PAPER 경로에 폴백 자산·거래소 조회가 없다
//   · 0과 '모름'이 갈린다
//   · 최종 용량 판정이 계좌 잠금 안에 있고, 중복 판정보다 뒤다
//   · 용량 식에 **진입 수수료가 들어간다**
//   · 용량 미달이면 포지션도 수수료도 쓰지 않는다
//
// 사용: node scripts/check-paper-capacity.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `FALLBACK_EQUITY`와 `getFuturesBalance`를 그대로 적는다.
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

/** SQL의 `--` 주석을 뗀다. `$$ … $$` 안도 똑같이 뗀다 — 함수 본문이 그 안이다. */
function stripSql(src) {
  let out = '', i = 0, inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) { if (c === "'") inStr = false; out += c; i++; continue; }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') i++; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * 함수 **본문**을 뗀다.
 *
 * 서명 괄호를 넘긴 뒤에 본다. 그냥 첫 `{`를 잡으면
 * `capacityVerdict(i: { … })`의 **매개변수 타입 블록**을 본문으로 읽는다 —
 * 이 저장소에서 네 번째로 만난 같은 고장이다. 반환 타입
 * `): Promise<{ … }> {`도 같은 이유로 건너뛴다.
 */
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

function braceBodyAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

const CTX = 'src/lib/engine/riskContext.ts';
const CAP = 'src/lib/engine/paperCapacity.ts';
const STORE = 'src/lib/engine/paperStore.ts';
const MIG_DIR = 'supabase/migrations';
const TEST = 'src/lib/engine/paperCapacity.test.ts';

// ── 1. 모의 자산 조회 ──
if (!existsSync(CAP)) fail(`${CAP}이 없습니다`);
else {
  const cap = stripJs(readFileSync(CAP, 'utf8'));
  for (const fn of ['paperCapacityOf', 'capacityVerdict', 'readPaperCapacity']) {
    if (!new RegExp(`export (async )?function ${fn}\\b`).test(cap)) fail(`${CAP}에 ${fn}이 없습니다`);
  }
  // 모의 장부만 읽는다.
  for (const bad of ['getFuturesBalance', 'getAccountGateFutures', 'loadConnection', 'exchange_connections']) {
    if (cap.includes(bad)) fail(`${CAP}이 ${bad}를 씁니다 — 모의 계좌를 거래소로 재지 않습니다`);
  }
  if (!/paper_accounts/.test(cap) || !/paper_positions/.test(cap)) {
    fail(`${CAP}이 모의 장부를 읽지 않습니다`);
  }
  // 열린 포지션만 센다.
  if (!/'status'\s*,\s*'open'/.test(cap)) {
    fail(`${CAP}이 열린 포지션만 세지 않습니다 — 닫힌 포지션의 증거금까지 물고 있는 것으로 셉니다`);
  }
  if (!/'user_id'\s*,\s*userId/.test(cap)) {
    fail(`${CAP}이 사용자로 좁히지 않습니다 — 남의 포지션이 예산에 들어갑니다`);
  }
  // 0과 모름.
  if (!/v\s*==\s*null\s*\|\|\s*v\s*===\s*''/.test(cap)) {
    fail(`${CAP}이 빈 값을 0으로 접습니다 — Number(null)도 Number('')도 0입니다`);
  }
  // 용량 식에 수수료가 들어간다.
  const verdict = fnBodyAt(cap, 'export function capacityVerdict');
  if (!verdict) fail(`${CAP}에서 capacityVerdict 본문을 찾지 못했습니다`);
  else if (!/usedMargin\s*\+\s*margin\s*\+\s*fee/.test(verdict.replace(/\bcap\./g, ''))) {
    fail(`${CAP}의 용량 식에 진입 수수료가 없습니다`
      + ' — 수수료는 같은 트랜잭션에서 잔고에서 빠집니다');
  }
  notes.push(`${CAP}이 모의 장부만 읽고 0과 모름을 가릅니다`);
}

// ── 2. 위험 컨텍스트 ──
if (!existsSync(CTX)) fail(`${CTX}이 없습니다`);
else {
  const ctx = stripJs(readFileSync(CTX, 'utf8'));
  if (!/readPaperCapacity/.test(ctx)) {
    fail(`${CTX}이 모의 자산을 읽지 않습니다 — 크기가 거래소 잔고·폴백에서 나옵니다`);
  }
  const paperAt = ctx.search(/const\s+isPaper\s*=/);
  if (paperAt < 0) fail(`${CTX}에 PAPER 분기가 없습니다`);
  else {
    // ── PAPER 판정이 거래소 분기보다 **앞**이어야 한다 ──
    //
    // 뒤에 두면 연결이 우연히 붙어 있는 순간 모의 크기가 거래소 잔고에서
    // 나온다.
    const exAt = ctx.search(/loadConnection/);
    if (exAt >= 0 && paperAt > exAt) {
      fail(`${CTX}이 거래소 조회 뒤에 모의를 갈라냅니다 — 연결이 있으면 모의가 거래소를 읽습니다`);
    }
    // 거래소 분기가 PAPER를 제외하는가.
    if (!/if\s*\(\s*!\s*isPaper\s*&&/.test(ctx)) {
      fail(`${CTX}의 거래소 잔고 분기가 모의를 제외하지 않습니다`);
    }
  }
  // PAPER가 폴백을 쓰면 안 된다.
  const paperBlockAt = ctx.indexOf('if (isPaper) {');
  if (paperBlockAt >= 0) {
    const blk = braceBodyAt(ctx, paperBlockAt);
    for (const bad of ['FALLBACK_EQUITY', 'getFuturesBalance', 'getAccountGateFutures', 'loadConnection']) {
      if (blk.includes(bad)) fail(`${CTX}의 모의 분기가 ${bad}를 씁니다`);
    }
    if (!/availableMargin\s*=/.test(blk)) {
      fail(`${CTX}의 모의 분기가 가용 증거금을 넣지 않습니다`
        + ' — 열린 포지션이 물고 있는 증거금이 예산에서 빠지지 않습니다');
    }
  }
  // equityKnown이 모드별 정본으로 판정되는가.
  if (!/equityKnown:\s*equityConfirmed/.test(ctx)) {
    fail(`${CTX}이 자산 확인 여부를 모드별 정본으로 판정하지 않습니다`);
  }
  if (/source !== 'exchange'/.test(ctx)) {
    fail(`${CTX}이 아직 '거래소인가'로 성공을 판단합니다`
      + ' — 모의 자산을 정확히 읽어도 실패처럼 말하게 됩니다');
  }
  notes.push(`${CTX}이 모드별 정본으로 자산을 읽습니다`);
}

// ── 3. 최종 용량 판정은 트랜잭션 안이다 ──
//
// 같은 함수를 여러 마이그레이션이 다시 정의한다. **마지막 정의가 실제로
// 도는 것**이므로 파일 이름 순으로 마지막을 본다.
let sqlFile = null;
if (existsSync(MIG_DIR)) {
  for (const name of readdirSync(MIG_DIR).sort()) {
    if (!name.endsWith('.sql')) continue;
    const raw = readFileSync(`${MIG_DIR}/${name}`, 'utf8');
    if (/CREATE OR REPLACE FUNCTION public\.paper_open_position/.test(raw)) sqlFile = `${MIG_DIR}/${name}`;
  }
}
if (!sqlFile) fail('paper_open_position을 정의하는 마이그레이션이 없습니다');
else {
  const sql = stripSql(readFileSync(sqlFile, 'utf8'));
  const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.paper_open_position');
  const end = sql.indexOf('$$;', at);
  const body = end > at ? sql.slice(at, end) : '';
  if (!body) fail(`${sqlFile}에서 함수 본문을 뜯지 못했습니다`);
  else {
    const lockAt = body.search(/FOR UPDATE/);
    const dupAt = body.search(/'DUPLICATE'/);
    const capAt = body.search(/'INSUFFICIENT_MARGIN'/);
    const sumAt = body.search(/SUM\s*\(\s*margin\s*\)/);
    const insAt = body.search(/INSERT INTO public\.paper_positions/);
    const feeAt = body.search(/UPDATE public\.paper_accounts/);

    if (capAt < 0) fail(`${sqlFile}에 가용 증거금 판정이 없습니다 — 동시 진입이 잔고를 넘습니다`);
    if (sumAt < 0) fail(`${sqlFile}이 사용 중 증거금을 합산하지 않습니다`);
    // 잠금 안에서 봐야 한다.
    if (lockAt < 0) fail(`${sqlFile}이 계좌를 잠그지 않습니다`);
    else if (sumAt >= 0 && sumAt < lockAt) {
      fail(`${sqlFile}이 계좌를 잠그기 전에 사용 증거금을 셉니다 — 동시 진입에서 둘 다 통과합니다`);
    }
    // **중복 판정이 용량 판정보다 앞이다.** 뒤면 재시도 답이 흔들린다.
    if (dupAt >= 0 && capAt >= 0 && dupAt > capAt) {
      fail(`${sqlFile}이 용량을 먼저 봅니다 — 이미 성공한 신호의 재시도가`
        + ' DUPLICATE 대신 INSUFFICIENT_MARGIN이 되어 멱등이 깨집니다');
    }
    // 용량 판정이 쓰기보다 앞이다.
    if (capAt >= 0 && insAt >= 0 && capAt > insAt) {
      fail(`${sqlFile}이 포지션을 넣은 뒤에 용량을 봅니다`);
    }
    if (capAt >= 0 && feeAt >= 0 && capAt > feeAt) {
      fail(`${sqlFile}이 수수료를 뺀 뒤에 용량을 봅니다`);
    }
    // 합산 조건.
    if (!/status\s*=\s*'open'/.test(body)) {
      fail(`${sqlFile}이 열린 포지션만 세지 않습니다`);
    }
    if (!/user_id\s*=\s*p_user_id/.test(body)) {
      fail(`${sqlFile}이 사용자로 좁히지 않습니다 — 남의 포지션이 예산에 들어갑니다`);
    }
    // **용량 식에 수수료가 들어간다.**
    if (!/\+\s*p_entry_fee\s*>\s*v_balance/.test(body)
        && !/>\s*v_balance\s*-\s*p_entry_fee/.test(body)) {
      fail(`${sqlFile}의 용량 식에 진입 수수료가 없습니다`
        + ' — 잔고 100·기존 90·신규 10·수수료 0.1이 통과해 버립니다');
    }
    if (!/v_used\s*\+\s*p_margin/.test(body)) {
      fail(`${sqlFile}이 사용 중 증거금과 새 증거금을 함께 보지 않습니다`);
    }
    // P1 계약이 남아 있는가.
    for (const [re, what] of [
      [/NO_ACCOUNT/, '계좌 없음'],
      [/GET STACKED DIAGNOSTICS[\s\S]{0,80}CONSTRAINT_NAME/, '제약 이름 진단'],
      [/=\s*'paper_pos_signal_uniq'/, 'signal_id 유니크 비교'],
      [/RAISE\s*;/, '알 수 없는 위반 재던지기'],
      [/balance\s*=\s*balance\s*-\s*p_entry_fee/, '수수료 차감식'],
      [/GET DIAGNOSTICS/, '계좌 갱신 행수 확인'],
    ]) {
      if (!re.test(body)) fail(`${sqlFile}이 P1 계약을 잃었습니다: ${what}`);
    }
    if (/SECURITY DEFINER/.test(body)) fail(`${sqlFile}이 SECURITY DEFINER입니다`);
    if (/INSERT INTO public\.paper_accounts/.test(body)) {
      fail(`${sqlFile}의 진입 함수가 계좌를 만듭니다`);
    }
    // SQL이 금액을 계산하지 않는다.
    for (const bad of ['fee_rate', 'slippage', 'risk_pct', '* p_quantity']) {
      if (body.includes(bad)) fail(`${sqlFile}의 함수가 금액을 계산합니다: ${bad}`);
    }
    notes.push(`${sqlFile}이 잠금 안에서 용량을 최종 판정합니다`);
  }
}

// ── 4. 용량 미달을 오류로 뭉개지 않는가 ──
if (existsSync(STORE)) {
  const store = stripJs(readFileSync(STORE, 'utf8'));
  if (!/INSUFFICIENT_MARGIN/.test(store)) {
    fail(`${STORE}이 가용 증거금 부족을 구분하지 않습니다 — 사용자가 이유를 알 수 없습니다`);
  }
}

// ── 5. 시험 ──
const reg = existsSync('scripts/run-tests.mjs') ? readFileSync('scripts/run-tests.mjs', 'utf8') : '';
if (!existsSync(TEST)) fail(`${TEST}이 없습니다`);
else {
  if (!reg.includes('runPaperCapacityTests()')) fail('run-tests.mjs에 runPaperCapacityTests()가 없습니다');
  const t = readFileSync(TEST, 'utf8');
  for (const [needle, label] of [
    ['수수료를 빼먹으면 통과하는 경계', '수수료 포함 경계'],
    ['잔고 0은 확인된 사실이다', '0과 모름'],
    ['포지션 조회가 실패하면 사용 증거금을 0으로 두지 않는다', '조회 실패'],
  ]) {
    if (!t.includes(needle)) fail(`${TEST}에 ${label} 시험이 없습니다`);
  }
}
{
  const ct = 'src/lib/engine/riskContext.test.ts';
  if (existsSync(ct)) {
    const t = readFileSync(ct, 'utf8');
    for (const [needle, label] of [
      ['PAPER는 폴백 10,000을 쓰지 않는다', '폴백 금지'],
      ['PAPER는 연결이 있어도 거래소를 부르지 않는다', '거래소 호출 0'],
    ]) {
      if (!t.includes(needle)) fail(`${ct}에 ${label} 시험이 없습니다`);
    }
  }
}

console.log('모의 계좌 용량 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 모의 크기는 모의 장부에서 나오고, 최종 용량은 트랜잭션이 정합니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
