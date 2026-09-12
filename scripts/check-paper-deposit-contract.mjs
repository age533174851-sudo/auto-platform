#!/usr/bin/env node
// scripts/check-paper-deposit-contract.mjs
//
// **SQL이 돌려주는 모양을 코드가 실제로 성공으로 읽는가.**
//
// 무엇이 있었나
// ─────────────
// `072`의 `paper_deposit`은 표를 돌려줬다:
//
//   RETURNS TABLE (applied BOOLEAN, new_balance NUMERIC, new_initial NUMERIC)
//
// `082`가 계좌 인자를 붙이며 **반환을 바꿨다** (옛 오버로드는 DROP했다):
//
//   RETURNS NUMERIC
//
// 부르는 쪽은 그대로 `row.applied !== true`를 봤다. 스칼라에는 `applied`가
// 없으므로 늘 참이고, 라우트는 409 `not_started`를 냈다. 그런데 RPC는 제
// 트랜잭션에서 이미 커밋됐다 — **잔고는 늘고 화면은 실패**다. 사용자가 다시
// 누르면 두 번 들어간다.
//
// 시험이 잡지 못하는 것
// ─────────────────────
// 시험은 `src`를 임시 디렉터리로 복사해서 돌기 때문에 `supabase/migrations`를
// **읽을 수 없다.** 그래서 시험이 아는 "SQL이 돌려주는 모양"은 시험이 그렇게
// 적어 둔 모양일 뿐이다. SQL이 또 바뀌면 시험은 옛 모양에 대해 초록으로 남는다.
//
// 여기서 하는 일
// ──────────────
// 글자를 맞춰 보지 않는다. **마이그레이션에서 실제 반환 타입을 읽고, 그 타입이
// 만들어 낼 값을 소비 함수에 그대로 먹여서 성공이라고 답하는지 본다.**
// 소비 함수는 제품이 쓰는 바로 그 파일을 컴파일해서 부른다 — 판정을 베끼지
// 않는다 (`gen-migration-manifest.mjs`의 `loadPlan()`과 같은 방식).

import { readFileSync, existsSync, readdirSync, mkdtempSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(root, 'supabase', 'migrations');
const TS_FILE = 'src/lib/engine/paperDeposit.ts';
const ROUTE = 'src/app/api/paper/account/route.ts';

let bad = 0;
const err = (m) => { console.error(`::error::${m}`); bad += 1; };
const notes = [];

/**
 * 주석을 걷어낸 **실행되는 TypeScript**.
 *
 * 문자열·템플릿 안의 `//`는 주석이 아니다(URL이 그렇다). 따옴표를 세면서
 * 지운다. 완전한 파서는 아니지만, 이 검사가 보는 것은 "이 판정이 코드에
 * 남아 있는가"뿐이라 이 정도면 충분하고 **틀리는 방향이 안전하다** —
 * 주석을 코드로 잘못 읽는 쪽만 막으면 된다.
 */
function stripTsComments(src) {
  let out = '';
  let i = 0;
  let quote = null;      // ' " ` 중 하나
  let block = false;     // /* ... */ 안인가
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (block) {
      if (c === '*' && d === '/') { block = false; i += 2; continue; }
      if (c === '\n') out += c;   // 줄 수를 유지한다
      i += 1; continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1; continue;
    }
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') { block = true; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

// ── ① 지금 정본인 paper_deposit은 무엇을 돌려주는가 ──
//
// 번호가 큰 파일이 나중에 실행된다. **마지막으로 정의한 파일이 정본이다.**
function currentDeposit() {
  const files = readdirSync(MIG_DIR)
    .filter(n => /^[0-9]+_.*\.sql$/.test(n))
    .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
  let found = null;
  for (const name of files) {
    const sql = readFileSync(join(MIG_DIR, name), 'utf8');
    const at = sql.search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.paper_deposit\s*\(/i);
    if (at < 0) continue;
    // 인자 목록을 건너뛴 뒤의 RETURNS 절.
    const after = sql.slice(at);
    const m = after.match(/\)\s*RETURNS\s+([A-Za-z ]+?)(\s*\(|\s+LANGUAGE|\s*\n)/i);
    if (!m) continue;
    found = { file: name, returns: m[1].trim().toUpperCase() };
  }
  return found;
}

const dep = currentDeposit();
if (!dep) {
  err('paper_deposit을 정의하는 마이그레이션을 찾지 못했습니다 — 이 검사가 무엇을 지키는지 다시 봐야 합니다');
  process.exit(1);
}
notes.push(`정본: ${dep.file} — RETURNS ${dep.returns}`);

// ── ② 그 타입이 만들어 내는 값 ──
//
// PostgREST는 스칼라 반환 함수의 결과를 **값 하나**로 준다. 표를 돌려주면
// 행 배열로 준다. 여기서는 그 둘을 실제 모양대로 만든다.
const NEW_BALANCE = 1500;
function sampleFor(returns) {
  if (returns === 'NUMERIC' || returns === 'BIGINT' || returns === 'INTEGER' || returns === 'INT') {
    return { data: NEW_BALANCE, why: '스칼라 하나' };
  }
  if (returns === 'TABLE') {
    return {
      data: [{ applied: true, new_balance: NEW_BALANCE, new_initial: NEW_BALANCE }],
      why: '행 배열',
    };
  }
  if (returns === 'VOID') return null;
  return undefined;
}

const sample = sampleFor(dep.returns);
if (sample === undefined) {
  err(`${dep.file}: paper_deposit의 반환 타입 ${dep.returns}을 이 검사가 모릅니다 `
    + '— 반환을 바꿨다면 이 검사기도 같이 고쳐야 합니다. 모르는 것을 통과로 적지 않습니다');
} else if (sample === null) {
  err(`${dep.file}: paper_deposit이 아무것도 돌려주지 않습니다 — 부르는 쪽이 새 잔고를 알 수 없습니다`);
}

// ── ③ 제품이 쓰는 그 함수에 먹여 본다 ──
async function loadConsumer() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-dep-'));
  cpSync(join(root, TS_FILE), join(dir, 'paperDeposit.ts'));
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`TypeScript를 찾을 수 없습니다: ${tsc} — 먼저 npm install`);
  execFileSync(process.execPath, [tsc, 'paperDeposit.ts', '--module', 'commonjs',
    '--target', 'es2019', '--skipLibCheck'], { cwd: dir, stdio: 'pipe' });
  return await import(`file://${join(dir, 'paperDeposit.js')}`);
}

if (bad === 0) {
  const D = await loadConsumer();
  let rpcCalls = 0;
  const sb = {
    rpc: () => { rpcCalls += 1; return Promise.resolve({ data: sample.data, error: null }); },
    from: () => {
      const q = {
        select: () => q, eq: () => q,
        maybeSingle: () => Promise.resolve({ data: { initial_balance: NEW_BALANCE }, error: null }),
      };
      return q;
    },
  };

  const r = await D.applyPaperDeposit(sb, 'user-1', 500);
  if (r?.code !== 'APPLIED') {
    err(`${TS_FILE}: ${dep.file}의 반환(${dep.returns} — ${sample.why})을 성공으로 읽지 않습니다 `
      + `— 실제 ${r?.code}. 돈은 이미 들어간 뒤이므로 사용자가 다시 눌러 이중 입금이 됩니다`);
  } else if (r.balance !== NEW_BALANCE) {
    err(`${TS_FILE}: 새 잔고를 ${NEW_BALANCE}가 아니라 ${r.balance}로 읽습니다`);
  } else if (rpcCalls !== 1) {
    err(`${TS_FILE}: 충전 한 번에 RPC를 ${rpcCalls}번 부릅니다 — 두 번 들어갑니다`);
  } else {
    notes.push(`소비 함수가 ${dep.returns}(${sample.why})을 성공으로 읽는다 · RPC 1회 · 잔고 ${r.balance}`);
  }

  // 성공 뒤의 읽기 실패를 충전 실패로 답하면 사용자가 다시 누른다.
  const sb2 = {
    rpc: () => Promise.resolve({ data: sample.data, error: null }),
    from: () => { throw new Error('boom'); },
  };
  const r2 = await D.applyPaperDeposit(sb2, 'user-1', 500);
  if (r2?.code !== 'APPLIED') {
    err(`${TS_FILE}: 충전이 커밋된 뒤의 조회 실패를 충전 실패(${r2?.code})로 답합니다 `
      + '— 사용자가 다시 눌러 두 번 들어갑니다');
  } else {
    notes.push('커밋된 뒤의 조회 실패를 충전 실패로 답하지 않는다');
  }

  // 계좌가 없을 때는 아무것도 움직이면 안 되고, 서버 오류도 아니다.
  const sb3 = {
    rpc: () => Promise.reject(new Error('paper_deposit: 계좌를 찾지 못했습니다')),
    from: () => { throw new Error('불려서는 안 된다'); },
  };
  const r3 = await D.applyPaperDeposit(sb3, 'user-1', 500);
  if (r3?.code !== 'NO_ACCOUNT') {
    err(`${TS_FILE}: 계좌 없음을 ${r3?.code}로 읽습니다 — "아직 시작하지 않았습니다"가 서버 오류로 나갑니다`);
  } else {
    notes.push('계좌 없음을 서버 오류로 읽지 않는다');
  }
}

// ── ④ 라우트가 실제로 이 함수를 쓰는가 ──
//
// 만들어 놓고 배선을 안 하면 라우트는 옛 코드를 그대로 쓴다.
{
  const p = join(root, ROUTE);
  const raw = existsSync(p) ? readFileSync(p, 'utf8') : '';
  // **주석을 걷어내고 본다.**
  //
  // 이 라우트의 주석은 "예전에는 `row.applied !== true`를 봤다"처럼 **없앤
  // 코드**를 설명한다. 주석까지 훑으면 검사기가 그 설명을 현재 코드로 읽고
  // 엉뚱한 곳에서 멈춘다 — 실제로 그렇게 한 번 멈췄다.
  const src = stripTsComments(raw);
  if (!raw) {
    err(`${ROUTE}을 읽지 못했습니다`);
  } else {
    if (!/applyPaperDeposit/.test(src)) {
      err(`${ROUTE}: applyPaperDeposit을 쓰지 않습니다 — 반환 모양을 읽는 판단이 두 곳이 됩니다`);
    } else {
      notes.push('충전 라우트가 소비 함수를 통해 부른다');
    }
    // 라우트가 RPC 결과를 직접 해석하면 판단이 둘이 되고, 그때 한쪽만 고쳐진다.
    if (/rpc\(\s*['"]paper_deposit['"]/.test(src)) {
      err(`${ROUTE}: paper_deposit RPC를 직접 부릅니다 — 반환 모양 해석은 ${TS_FILE} 한 곳입니다`);
    }
    if (/\.applied\s*!==\s*true/.test(src)) {
      err(`${ROUTE}: RPC 결과를 .applied로 판정합니다 — 지금 정본은 ${dep.returns}이라 항상 실패가 됩니다`);
    }
  }
}

if (bad === 0) {
  console.log('모의 충전 계약 확인');
  for (const n of notes) console.log(`  · ${n}`);
  console.log('통과');
}
process.exit(bad ? 1 : 0);
