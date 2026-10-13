#!/usr/bin/env node
// scripts/check-testnet-diagnose.mjs
//
// **TESTNET 진단 — 읽기만 하고, 모르는 것을 통과로 적지 않는다.**
//
// 이 검사기가 지키는 다섯 가지:
//
//   ① **진단이 설정을 바꾸지 않는다.** 배율·마진 모드·포지션 모드의
//      변경 API를 부르지 않는다. 진단이 설정을 고쳐 놓으면 사람은
//      "진단했더니 통과"를 보는데 실제로는 진단이 그렇게 만든 것이다.
//   ② **UNKNOWN이 READY가 되지 않는다.** 조회 실패·빈 값·모르는 값은
//      전부 UNKNOWN이고, 하나라도 있으면 전체 판정이 READY가 아니다.
//   ③ **관문이 그대로다.** TESTNET 전용 관문과 사용자 JWT 인증이
//      거래소 호출보다 **앞에** 있다.
//   ④ **배선이 끊기지 않았다.** 판정 정본을 import만 하고 부르지 않는
//      상태를 잡는다 — 그 상태에서 단위 시험은 그대로 초록이다.
//   ⑤ **요구 배율이 두 곳에 있지 않다.** 라우트가 100을 적지 않고
//      프리셋 정본에서 읽는다.
//
// 실주문·DB 변경·거래소 조회를 하지 않는다. 소스 읽기와 순수 함수 호출뿐이다.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const V = 'src/lib/engine/testnetDiagnoseVerdict.ts';
const ROUTE = 'src/app/api/binance/futures/diagnose/route.ts';
const FUT = 'src/lib/exchanges/binanceFutures.ts';

const errors = [];
const err = (m) => errors.push(m);
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };

/** 주석을 벗긴 소스. **자기 설명 주석을 근거로 통과하면 안 된다** */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

/** `fn(` 호출의 인자 전체를 괄호를 세어 떼어 온다. 없으면 null */
const callArgsOf = (src, fn) => {
  const at = src.indexOf(`${fn}(`);
  if (at < 0) return null;
  const i = at + fn.length;
  let depth = 0;
  for (let k = i; k < src.length; k += 1) {
    if (src[k] === '(') depth += 1;
    else if (src[k] === ')') { depth -= 1; if (depth === 0) return src.slice(i + 1, k); }
  }
  return null;
};

/**
 * 최상위 함수 `name`의 **선언부터 끝까지**를 떼어 온다.
 *
 * 중괄호를 세는 방식을 쓰지 않는 이유: 반환형이
 * `Promise<{ ok: boolean; … }>`처럼 객체 리터럴이면 첫 `{`가 **본문이
 * 아니라 타입**이다. 그걸 본문으로 읽으면 `'GET'`이 없다고 잡는다 —
 * 이 검사기를 처음 돌릴 때 실제로 그렇게 오진했다.
 *
 * 이 저장소의 최상위 함수는 0열의 `}`로 끝난다. 그 지점까지 자른다.
 *
 * `\n}`만 찾으면 **반환형의 닫는 `}>`가 0열에 올 때 거기서 잘린다** —
 * 그러면 본문을 한 줄도 못 본 채 "GET이 없다"고 잡는다. 그래서 `}`
 * 다음이 줄바꿈(또는 파일 끝)인 자리만 함수의 끝으로 인정한다.
 */
const topLevelBodyOf = (src, name) => {
  const at = src.indexOf(name);
  if (at < 0) return null;
  const m = /\n\}(?:\n|$)/.exec(src.slice(at));
  return m ? src.slice(at, at + m.index + m[0].length) : src.slice(at);
};

// ══════════════════════════════════════════════════════════
// 단독 컴파일 — "그렇게 적혀 있다"가 아니라 "그렇게 답한다"를 본다
// ══════════════════════════════════════════════════════════
let mod = null;
{
  const src = read(V);
  if (src == null) err(`${V}을(를) 읽지 못했습니다`);
  else {
    if (/^import /m.test(code(src))) {
      err(`${V}: import이 생겼습니다 — 이 파일을 쓰는 사슬의 탐침 컴파일이 꺼집니다`);
    }
    if (code(src).includes('process.env')) {
      err(`${V}: process.env를 직접 집습니다 — 주변 상태는 부르는 쪽이 넘깁니다`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'traigo-tnd-'));
    process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    const dest = join(dir, V);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, src);
    const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) err(`TypeScript가 없습니다 (${tsc}) — 먼저 npm ci`);
    else {
      // **@types/node를 끌어오지 않는다.** 끌어오면 이 파일이 조용히
      // Node API를 쓰게 되어도 컴파일이 통과한다.
      writeFileSync(join(dir, 'tsconfig.probe.json'), JSON.stringify({
        compilerOptions: { module: 'commonjs', target: 'es2019', skipLibCheck: true },
        files: [V],
      }));
      try {
        execFileSync(process.execPath, [tsc, '-p', 'tsconfig.probe.json'],
          { cwd: dir, stdio: 'pipe', timeout: 180_000 });
        mod = await import(`file://${join(dir, V.replace(/\.ts$/, '.js'))}`);
      } catch (e) {
        err(`${V}이(가) 단독으로 컴파일되지 않습니다 — 순수 판정 모듈이 아니게 됐습니다`
          + `\n${String(e.stdout || e.message).trim().slice(0, 300)}`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// ② UNKNOWN이 READY가 되지 않는다 (정본을 실제로 불러 본다)
// ══════════════════════════════════════════════════════════
if (mod) {
  const { positionModeVerdict: pm, isolationVerdict: iv,
    withdrawalEvidence: we, overallDiagnoseVerdict: ov, statusToOk: ok } = mod;

  for (const [n, f] of [['positionModeVerdict', pm], ['isolationVerdict', iv],
    ['withdrawalEvidence', we], ['overallDiagnoseVerdict', ov], ['statusToOk', ok]]) {
    if (typeof f !== 'function') err(`${V}: ${n}을(를) 찾지 못했습니다`);
  }

  if (typeof pm === 'function') {
    // 모르는 모드를 단방향으로 메우지 않는다.
    for (const [label, i] of [
      ['null', { mode: null }], ['undefined', { mode: undefined }],
      ['입력 없음', null], ['빈 객체', {}],
      ['소문자', { mode: 'one_way' }], ['엉뚱한 값', { mode: 'BOTH' }],
    ]) {
      const v = pm(i);
      if (v?.status !== 'UNKNOWN') {
        err(`포지션 모드: ${label}에서 UNKNOWN이 아닙니다 (${v?.status}) — 모르는 모드를 추정합니다`);
      }
    }
    if (pm({ mode: 'HEDGE' })?.status !== 'FAIL') {
      err('포지션 모드: HEDGE가 FAIL이 아닙니다 — 긴급 종료가 멈추는 모드입니다');
    }
    if (pm({ mode: 'ONE_WAY' })?.status !== 'PASS') {
      err('포지션 모드: ONE_WAY가 PASS가 아닙니다');
    }
  }

  if (typeof iv === 'function') {
    const base = { read: true, marginType: 'isolated', leverage: 100, expectedLeverage: 100 };
    if (iv(base)?.status !== 'PASS') err('격리: 격리+요구배율이 PASS가 아닙니다');
    for (const [label, over] of [
      ['조회 실패', { read: false }],
      ['read 누락', { read: undefined }],
      ['빈 마진타입', { marginType: '' }],
      ['마진타입 null', { marginType: null }],
      ['모르는 마진타입', { marginType: 'future_mode' }],
      ['배율 null', { leverage: null }],
      ['배율 NaN', { leverage: Number.NaN }],
      ['요구배율 0', { expectedLeverage: 0, leverage: 0 }],
      ['요구배율 NaN', { expectedLeverage: Number.NaN }],
      ['요구배율 누락', { expectedLeverage: undefined }],
    ]) {
      const v = iv({ ...base, ...over });
      if (v?.status !== 'UNKNOWN') {
        err(`격리: ${label}에서 UNKNOWN이 아닙니다 (${v?.status}/${v?.code})`);
      }
    }
    for (const mt of ['cross', 'crossed']) {
      if (iv({ ...base, marginType: mt })?.status !== 'FAIL') {
        err(`격리: ${mt}가 FAIL이 아닙니다`);
      }
    }
    if (iv({ ...base, leverage: 20 })?.status !== 'FAIL') {
      err('격리: 배율 불일치가 FAIL이 아닙니다');
    }
    if (iv(null)?.status !== 'UNKNOWN') err('격리: 입력이 없을 때 UNKNOWN이 아닙니다');
  }

  if (typeof we === 'function') {
    // 거래소에 묻는 경로가 없는 동안은 **어떤 입력에서도 PASS가 없다.**
    for (const d of [true, false, null, undefined]) {
      const v = we({ testnet: true, declaredHasWithdrawal: d });
      if (v?.status === 'PASS') {
        err(`출금 권한: declared=${String(d)}에서 PASS가 나왔습니다`
          + ' — 거래소가 확인해 준 적 없는 값을 통과로 적습니다');
      }
    }
    if (we({ testnet: true, declaredHasWithdrawal: false })?.code
        !== 'NOT_VERIFIED_TESTNET_CONSTANT') {
      err('출금 권한: 기록된 false를 "확인되지 않음"으로 적지 않습니다');
    }
    if (we({ testnet: true, declaredHasWithdrawal: true })?.status !== 'FAIL') {
      err('출금 권한: 권한이 켜진 키가 FAIL이 아닙니다');
    }
  }

  if (typeof ov === 'function') {
    if (ov([{ status: 'PASS' }, { status: 'UNKNOWN' }])?.verdict === 'READY') {
      err('전체 판정: UNKNOWN이 있는데 READY입니다 — 모르는 것을 통과로 적습니다');
    }
    if (ov([{ status: 'PASS' }, { status: 'FAIL' }])?.verdict !== 'BLOCKED') {
      err('전체 판정: FAIL이 있는데 BLOCKED가 아닙니다');
    }
    for (const [label, x] of [['빈 배열', []], ['null', null], ['undefined', undefined]]) {
      if (ov(x)?.verdict === 'READY') {
        err(`전체 판정: ${label}에서 READY입니다 — 아무것도 확인하지 않은 것은 통과가 아닙니다`);
      }
    }
    if (ov([{ status: 'PASS' }, {}])?.verdict === 'READY') {
      err('전체 판정: 상태 칸이 없는 항목이 통과로 셉니다');
    }
  }

  if (typeof ok === 'function' && ok('UNKNOWN') !== false) {
    err('statusToOk: UNKNOWN을 ok로 넘깁니다');
  }
}

// ══════════════════════════════════════════════════════════
// ① 진단이 설정을 바꾸지 않는다
// ══════════════════════════════════════════════════════════
{
  const src = read(ROUTE);
  if (src == null) err(`${ROUTE}을(를) 읽지 못했습니다`);
  else {
    const c = code(src);
    // 변경 수단을 **부르지 않는다.** 경로 문자열과 래퍼 이름 양쪽을 본다.
    for (const bad of [
      '/fapi/v1/leverage', '/fapi/v1/marginType', '/fapi/v1/positionSide/dual',
      'setFuturesLeverage', 'setMarginType', 'setFuturesMarginType',
      'setPositionMode', 'changePositionMode', 'futuresLeverage(',
    ]) {
      if (c.includes(bad)) {
        err(`${ROUTE}: 설정 변경 수단이 보입니다 (${bad})`
          + ' — 진단은 읽기만 합니다. 진단이 설정을 고치면 원래 상태를 영영 못 봅니다');
      }
    }
    // 주문을 내지 않는다.
    for (const bad of ['placeFuturesOrder', 'futuresOrder(', 'createOrder', "method: 'POST'"]) {
      if (c.includes(bad)) err(`${ROUTE}: 주문·쓰기 수단이 보입니다 (${bad})`);
    }

    // ── ③ 관문이 거래소 호출보다 앞에 있다 ──
    const gateAt = c.indexOf('binanceTestnetDiagnoseGate(');
    const authAt = c.indexOf('resolveUserId(');
    const firstCall = Math.min(...[
      'testFuturesConnection(', 'getFuturesPositionMode(', 'getFuturesSymbolSettings(',
      'diagnoseFutures(', 'getFuturesBalance(',
    ].map(n => { const at = c.indexOf(n); return at < 0 ? Number.MAX_SAFE_INTEGER : at; }));
    if (gateAt < 0) err(`${ROUTE}: TESTNET 전용 관문(binanceTestnetDiagnoseGate)이 없습니다`);
    if (authAt < 0) err(`${ROUTE}: 사용자 인증(resolveUserId)이 없습니다`);
    if (gateAt >= 0 && firstCall !== Number.MAX_SAFE_INTEGER && gateAt > firstCall) {
      err(`${ROUTE}: 관문보다 거래소 호출이 먼저 있습니다 — LIVE 키로 요청이 나갈 수 있습니다`);
    }
    if (authAt >= 0 && gateAt >= 0 && authAt > gateAt) {
      err(`${ROUTE}: 인증이 관문보다 뒤에 있습니다`);
    }

    // ── ④ 판정 정본을 **부른다** (import만 하고 안 부르는 상태를 잡는다) ──
    for (const fn of ['positionModeVerdict', 'isolationVerdict',
      'withdrawalEvidence', 'overallDiagnoseVerdict']) {
      const args = callArgsOf(c, fn);
      if (args == null) {
        err(`${ROUTE}: ${fn}을(를) 부르지 않습니다 — import만 남으면 단위 시험은 그대로 초록입니다`);
      }
    }
    // 모드 판정에 **실제 조회 결과**가 들어가는가. 지어낸 객체를 넘기면
    // 형태는 맞지만 거래소를 본 적이 없는 판정이 된다.
    if (c.includes('getFuturesPositionMode(') === false) {
      err(`${ROUTE}: getFuturesPositionMode를 부르지 않습니다 — 모드를 확인할 수 없습니다`);
    }
    if (c.includes('getFuturesSymbolSettings(') === false) {
      err(`${ROUTE}: getFuturesSymbolSettings를 부르지 않습니다 — 격리·배율을 확인할 수 없습니다`);
    }
    // 전체 판정이 응답에 실리는가.
    if (!/readiness/.test(c)) {
      err(`${ROUTE}: 전체 판정(readiness)을 응답에 싣지 않습니다`);
    }

    // ── ⑤ 요구 배율을 라우트가 스스로 적지 않는다 ──
    const isoArgs = callArgsOf(c, 'isolationVerdict') || '';
    if (/expectedLeverage\s*:\s*\d/.test(isoArgs)) {
      err(`${ROUTE}: 요구 배율을 숫자로 적었습니다 — 프리셋 정본과 갈립니다`);
    }
    if (!c.includes('overrideOf(')) {
      err(`${ROUTE}: 요구 배율을 프리셋 정본(overrideOf)에서 읽지 않습니다`);
    }
    const ovArgs = callArgsOf(c, 'overrideOf') || '';
    if (!/EXACT_100X/.test(ovArgs)) {
      err(`${ROUTE}: overrideOf가 EXACT_100X 프리셋을 보지 않습니다 (${ovArgs.trim().slice(0, 60)})`);
    }
  }
}

// ══════════════════════════════════════════════════════════
// 설정 조회가 플랫 심볼을 **걸러내지 않는다**
// ══════════════════════════════════════════════════════════
{
  const src = read(FUT);
  if (src == null) err(`${FUT}을(를) 읽지 못했습니다`);
  else {
    const body = topLevelBodyOf(code(src), 'export async function getFuturesSymbolSettings');
    if (body == null) err(`${FUT}: getFuturesSymbolSettings를 찾지 못했습니다`);
    else {
      // 포지션이 없을 때가 **바로 확인해야 하는 시점**이다. 거르면 그때
      // marginType·leverage를 못 본다.
      if (/positionAmt\s*\)\s*!==\s*0|!==\s*0\s*\)/.test(body) && /filter\s*\(/.test(body)) {
        err(`${FUT}: getFuturesSymbolSettings가 수량 0을 걸러냅니다`
          + ' — 포지션이 없을 때 격리·배율을 못 읽게 됩니다');
      }
      if (!/'GET'/.test(body)) {
        err(`${FUT}: getFuturesSymbolSettings가 GET으로 조회하지 않습니다`);
      }
      for (const bad of ["'POST'", 'leverage\x27, key', '/fapi/v1/marginType']) {
        if (body.includes(bad)) err(`${FUT}: getFuturesSymbolSettings에 쓰기 수단이 있습니다 (${bad})`);
      }
    }
  }
}

if (errors.length) {
  console.error('❌ TESTNET 진단 계약 위반\n');
  for (const e of errors) console.error(`  · ${e}`);
  console.error(`\n${errors.length}건`);
  process.exit(1);
}
console.log('✅ TESTNET 진단 — 읽기 전용 · UNKNOWN이 READY가 되지 않음 · 관문·배선 확인');
