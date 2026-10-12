#!/usr/bin/env node
// scripts/check-hold-extension.mjs
//
// **보유 연장 — 실주문 없이 확인할 수 있는 것을 전부 확인한다.**
//
// 이 검사기가 지키는 것은 수익성이 아니다. 네 가지다:
//
//   ① **기본값은 꺼짐이다.** 승인 없이는 아무것도 달라지지 않는다.
//   ② **소급 적용하지 않는다.** 승인 전에 연 포지션은 대상이 아니다.
//   ③ **주문을 낼 수단이 없다.** 판정 모듈과 증거 수집기는 거래소를
//      바꾸지 못한다.
//   ④ **배선이 끊기지 않았다.** 관문을 우회하는 경로가 없다.
//
// 왜 시험만으로 부족한가: 시험은 "지금 이렇게 동작한다"를 확인한다.
// 이 검사기는 **"그렇게만 동작할 수 있다"**를 확인한다 — 관문을 우회하는
// 호출이 새로 생기면 시험은 그대로 초록인 채로 남는다. 이 저장소가
// 반복해서 당한 "경로가 둘인데 한쪽만 고침"이 그 모양이다.
//
// 실주문·DB 변경·거래소 조회를 하지 않는다. 소스 읽기와 순수 함수 호출뿐이다.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HX = 'src/lib/engine/holdExtension.ts';
const HXR = 'src/lib/engine/holdEvidenceReader.ts';
const RUN = 'src/lib/engine/exitAuthorityRun.ts';
const AUTH = 'src/lib/engine/exitAuthority.ts';
const MON = 'src/app/api/autotrade/exit-monitor/route.ts';
const COV = 'src/lib/engine/exitCoverage.ts';
const DOC = 'docs/EXACT100X_HOLD_EXTENSION_RISK.md';

const errors = [];
const err = (m) => errors.push(m);
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };

/** 주석을 벗긴 소스. **검사기가 자기 설명 주석을 근거로 통과하면 안 된다** */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

// ── 단독 컴파일 ──
//
// `holdExtension.ts`는 의존이 **없다**(순수 판정). 그래서 한 파일만
// 컴파일해서 실제로 불러 볼 수 있다. 소스 패턴만 보는 검사는 "그렇게
// 적혀 있다"까지만 말하고, 불러 보는 검사는 "그렇게 답한다"를 말한다.
let mod = null;
{
  const src = read(HX);
  if (src == null) err(`${HX}을(를) 읽지 못했습니다`);
  else {
    const dir = mkdtempSync(join(tmpdir(), 'traigo-hx-'));
    process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    const dest = join(dir, HX);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, src);
    const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) err(`TypeScript가 없습니다 (${tsc}) — 먼저 npm ci`);
    else {
      // 이 파일은 승인 값을 읽는 얇은 래퍼 하나에서만 `process.env`를 본다.
      // 탐침 디렉터리에는 node_modules가 없으므로 그 한 칸만 선언해 준다 —
      // **@types/node를 끌어오지 않는다.** 끌어오면 이 파일이 조용히
      // Node API를 쓰게 되어도 컴파일이 통과한다.
      writeFileSync(join(dir, 'probe-env.d.ts'),
        'declare const process: { env: Record<string, string | undefined> };\n');
      writeFileSync(join(dir, 'tsconfig.probe.json'), JSON.stringify({
        compilerOptions: { module: 'commonjs', target: 'es2019', skipLibCheck: true },
        files: ['probe-env.d.ts', HX],
      }));
      try {
        execFileSync(process.execPath, [tsc, '-p', 'tsconfig.probe.json'],
          { cwd: dir, stdio: 'pipe', timeout: 180_000 });
        mod = await import(`file://${join(dir, HX.replace(/\.ts$/, '.js'))}`);
      } catch (e) {
        err(`${HX}이(가) 단독으로 컴파일되지 않습니다 — 순수 판정 모듈이 아니게 됐습니다`
          + `\n${String(e.stdout || e.message).trim().slice(0, 300)}`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// ① 기본값은 꺼짐이다
// ══════════════════════════════════════════════════════════
if (mod) {
  const j = mod.judgeHoldExtensionActivation;
  if (typeof j !== 'function') err(`${HX}: judgeHoldExtensionActivation을 찾지 못했습니다`);
  else {
    for (const [label, env] of [
      ['빈 환경', {}], ['null', null], ['undefined', undefined],
      ['빈 문자열', { EXACT100X_HOLD_EXTENSION_APPROVED_AT: '' }],
      ['공백', { EXACT100X_HOLD_EXTENSION_APPROVED_AT: '   ' }],
    ]) {
      const a = j(env);
      if (a?.enabled !== false) {
        err(`보유 연장이 ${label}에서 켜져 있습니다 — 운영 기본값은 꺼짐이어야 합니다`);
      }
      if (a?.approvedAtMs != null) {
        err(`보유 연장이 ${label}에서 승인 시각을 들고 있습니다 (${a.approvedAtMs})`);
      }
    }
    // 오타 한 자가 승인이 되면 소급 금지가 통째로 무력화된다.
    for (const v of ['yes', 'true', 'ON', '2', '0', '-5', '1760000000',
      '2019-12-31T23:59:59Z', '2100-01-01T00:00:00Z', 'tomorrow']) {
      if (j({ EXACT100X_HOLD_EXTENSION_APPROVED_AT: v })?.enabled !== false) {
        err(`보유 연장 승인 값 ${JSON.stringify(v)}이(가) 켜짐으로 읽힙니다`
          + ' — ms epoch 또는 ISO 날짜(2020~2100)만 승인입니다');
      }
    }
    const ok = j({ EXACT100X_HOLD_EXTENSION_APPROVED_AT: '2026-10-20T00:00:00Z' });
    if (ok?.enabled !== true || ok?.approvedAtMs !== Date.parse('2026-10-20T00:00:00Z')) {
      err('정상 ISO 승인 값이 켜지지 않습니다 — 승인 경로 자체가 막혀 있습니다');
    }
  }
}

// ══════════════════════════════════════════════════════════
// ② 소급 적용하지 않는다
// ══════════════════════════════════════════════════════════
if (mod) {
  const gate = mod.holdExtensionGate;
  const EID = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X' };
  const APPROVED_AT = Date.parse('2026-10-20T00:00:00Z');
  const env = { EXACT100X_HOLD_EXTENSION_APPROVED_AT: String(APPROVED_AT) };
  if (typeof gate !== 'function') err(`${HX}: holdExtensionGate를 찾지 못했습니다`);
  else {
    const before = gate({ executionIdentity: EID, openedAtMs: APPROVED_AT - 1, env });
    if (before?.policy != null || before?.code !== 'OPENED_BEFORE_APPROVAL') {
      err('승인 **전에** 연 포지션이 연장 대상이 됩니다'
        + ` (code=${before?.code}) — 이미 운영 중인 자리의 종료 규칙을 소급해서`
        + ' 바꾸면 사용자가 고르지 않은 보유 한도로 포지션을 들고 있게 됩니다');
    }
    const at = gate({ executionIdentity: EID, openedAtMs: APPROVED_AT, env });
    if (at?.policy == null) {
      err('승인 시각에 연 포지션이 대상에서 빠집니다 — 승인 경로가 막혀 있습니다');
    }
    for (const v of [null, undefined, 0, NaN]) {
      const g = gate({ executionIdentity: EID, openedAtMs: v, env });
      if (g?.policy != null || g?.code !== 'OPENED_AT_UNUSABLE') {
        err(`진입 시각이 ${String(v)}인 포지션이 연장 대상이 됩니다`
          + ' — 소급인지 아닌지 모르면 열지 않아야 합니다');
      }
    }
    // 승인하지 않으면 선언된 계약도 열리지 않는다
    const off = gate({ executionIdentity: EID, openedAtMs: APPROVED_AT, env: {} });
    if (off?.policy != null) err('승인 없이 연장 정책이 열립니다');
    // 선언되지 않은 계약은 승인해도 열리지 않는다
    const other = gate({
      executionIdentity: { profileId: 'SCALP_HIGH_LEV', presetId: 'BALANCED' },
      openedAtMs: APPROVED_AT, env });
    if (other?.policy != null) {
      err('선언되지 않은 실행 계약에 연장이 열립니다 — 다른 전략의 종료 의미가 바뀝니다');
    }
  }
}

// ══════════════════════════════════════════════════════════
// ②-b 정책이 없으면 연장하지 않는다 (판정 자체)
// ══════════════════════════════════════════════════════════
if (mod && typeof mod.decideHoldExtension === 'function') {
  const d = mod.decideHoldExtension({
    policy: null, evidence: null, side: 'LONG', heldMs: 4 * 3600_000, nowMs: Date.now(),
  });
  if (d?.extend !== false || d?.code !== 'CLOSE_DISABLED') {
    err(`정책 없이 연장됩니다 (extend=${d?.extend}, code=${d?.code})`);
  }
}

// ══════════════════════════════════════════════════════════
// ③ 주문을 낼 수단이 없다
// ══════════════════════════════════════════════════════════
{
  const s = read(HX);
  if (s) {
    const c = code(s);
    // 판정 모듈은 **아무것도 import하지 않는다.** import가 생기는 순간
    // 거래소·DB가 이 파일에 들어올 수 있고, 그러면 시험이 네트워크 없이
    // 경계를 재현할 수 없다.
    const imports = c.match(/^\s*import\s/gm) || [];
    if (imports.length > 0) {
      err(`${HX}에 import가 ${imports.length}개 있습니다 — 순수 판정 모듈이어야 합니다`
        + ' (거래소·DB가 들어오면 시험이 네트워크 없이 경계를 재현할 수 없습니다)');
    }
    // ★ `process.env`를 **한 번도** 읽지 않는다.
    //
    //   읽는 순간 이 파일(과 이 파일을 쓰는 사슬)이 Node 타입 없이
    //   컴파일되지 않고, `check-100x-contract.mjs`의 탐침이 일곱 개 모듈에서
    //   "컴파일되지 않습니다"로 멈춘다 — 실제로 그렇게 깨졌다.
    //   환경을 읽는 일은 `holdExtensionEnv.ts` 하나가 맡는다.
    const envHits = (c.match(/process\.env/g) || []).length;
    if (envHits > 0) {
      err(`${HX}에서 process.env를 ${envHits}번 읽습니다`
        + ' — 순수 판정 모듈은 주변 상태를 집지 않습니다'
        + ' (환경은 holdExtensionEnv.ts가 읽어 인자로 넘깁니다)');
    }
  }
  for (const f of [HX, HXR]) {
    const s2 = read(f);
    if (!s2) { err(`${f}을(를) 읽지 못했습니다`); continue; }
    const c = code(s2);
    for (const bad of ['placeFuturesOrder', 'sendSymbolClose', 'prepareSymbolClose',
      'closePosition', 'cancelOrder', 'placeFuturesTPSL', "method: 'POST'", 'method:"POST"']) {
      if (c.includes(bad)) {
        err(`${f}이(가) ${bad}을(를) 부릅니다 — 이 둘은 거래소를 바꾸지 못해야 합니다`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// ④ 배선 — 관문을 우회하는 경로가 없다
// ══════════════════════════════════════════════════════════
{
  const s = read(RUN);
  if (!s) err(`${RUN}을(를) 읽지 못했습니다`);
  else {
    const c = code(s);
    if (!c.includes('holdExtensionGate(')) {
      err(`${RUN}이(가) holdExtensionGate를 부르지 않습니다 — 승인 관문이 배선되지 않았습니다`);
    }
    // 관문을 거치지 않고 정책을 직접 집으면 **승인 없이도 켜진다.**
    if (/resolveHoldExtensionPolicy\s*\(/.test(c)) {
      err(`${RUN}이(가) resolveHoldExtensionPolicy를 직접 부릅니다`
        + ' — 그 경로는 승인·소급 금지 관문을 지나지 않습니다');
    }
    if (!/decision\.authorized\s*&&/.test(c)) {
      err(`${RUN}: 연장을 묻기 전에 권한 승인을 확인하지 않습니다`
        + ' — 막힌 판정이 연장 경로로 들어가면 거래소를 매 주기 조회합니다');
    }
  }
  const a = read(AUTH);
  if (!a) err(`${AUTH}을(를) 읽지 못했습니다`);
  else {
    const c = code(a);
    if (!c.includes('decideHoldExtension(')) {
      err(`${AUTH}이(가) decideHoldExtension을 부르지 않습니다 — 연장 거부권이 끊겼습니다`);
    }
    if (!c.includes("'HOLD_EXTENDED'")) {
      err(`${AUTH}에 HOLD_EXTENDED 코드가 없습니다`);
    }
  }
  const m = read(MON);
  if (!m) err(`${MON}을(를) 읽지 못했습니다`);
  else {
    const c = code(m);
    if (!c.includes('readHoldEvidence')) {
      err(`${MON}이(가) 증거 조회를 주입하지 않습니다 — 기능이 있는데 화면·경로에 연결이 없습니다`);
    }
    if (!c.includes('holdExtensionGate')) {
      err(`${MON}이(가) 관문 판정을 기록하지 않습니다`
        + ' — 왜 연장되지 않았는지를 사람이 로그에서 찾게 됩니다');
    }
  }
  const cov = read(COV);
  if (cov && !code(cov).includes('judgeHoldExtensionActivation')) {
    err(`${COV}이(가) 켜짐 여부를 보지 않습니다`
      + ' — 선언된 기능을 "돈다"고 적으면 승인하지 않은 기능이 화면에서 켜져 보입니다');
  }
  if (cov && /process\.env/.test(code(cov))) {
    err(`${COV}이(가) process.env를 읽습니다 — 검사기 탐침이 이 파일을 컴파일할 수`
      + ' 없게 됩니다. 승인 환경은 호출부가 인자로 넣어야 합니다');
  }

  // ── 환경을 읽는 자리는 **하나뿐**이어야 한다 ──
  {
    const envFile = 'src/lib/engine/holdExtensionEnv.ts';
    const e = read(envFile);
    if (!e) err(`${envFile}이 없습니다 — 승인 값을 읽는 정본이 사라졌습니다`);
    else if (!code(e).includes('EXACT100X_HOLD_EXTENSION_APPROVED_AT')) {
      err(`${envFile}이 승인 환경변수를 읽지 않습니다`);
    }
    // 엔진 쪽 사슬은 환경을 집지 않는다
    for (const f of [RUN, AUTH, HXR]) {
      const src = read(f);
      if (src && /process\.env\.EXACT100X_HOLD_EXTENSION/.test(code(src))) {
        err(`${f}이(가) 승인 값을 직접 읽습니다 — 호출부가 인자로 넣어야 합니다`);
      }
    }
    // 라우트는 **반드시** 넣어야 한다. 안 넣으면 영구 꺼짐이고,
    // 그러면 승인해도 아무 일이 일어나지 않는다(조용한 영구 OFF).
    const m2 = read(MON);
    if (m2 && !code(m2).includes('holdExtensionEnvFromProcess')) {
      err(`${MON}이(가) 승인 환경을 넣지 않습니다`
        + ' — 승인해도 연장이 영구히 꺼진 채로 남습니다');
    }
  }
}

// ══════════════════════════════════════════════════════════
// ⑤ 문서가 코드와 같은 숫자를 적고 있는가
// ══════════════════════════════════════════════════════════
//
// 문서는 생성물이 아니지만, **숫자가 갈리면 문서가 거짓말을 한다.**
// 정책에서 값을 뽑아 문서에 그 숫자가 있는지만 본다.
if (mod && typeof mod.resolveHoldExtensionPolicy === 'function') {
  const p = mod.resolveHoldExtensionPolicy({ profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X' });
  const doc = read(DOC);
  if (p == null) err('Exact100X 연장 정책 선언이 사라졌습니다');
  else if (doc == null) err(`${DOC}이 없습니다 — 위험 분석 없이 연장을 들고 있지 않습니다`);
  else {
    const want = [
      [`${p.minNetRoePct}%`, 'minNetRoePct'],
      [`${p.minLiquidationHeadroomPct}%`, 'minLiquidationHeadroomPct'],
      [`${p.givebackArmRoePct}%`, 'givebackArmRoePct'],
      [`${p.givebackFraction}`, 'givebackFraction'],
      [`${p.atrGivebackFloorMultiple}`, 'atrGivebackFloorMultiple'],
      [`${Math.round(p.absoluteMaxHoldMs / 3_600_000)}시간`, 'absoluteMaxHoldMs'],
      [`${Math.round(p.maxEvidenceAgeMs / 1000)}초`, 'maxEvidenceAgeMs'],
    ];
    for (const [needle, field] of want) {
      if (!doc.includes(needle)) {
        err(`${DOC}에 ${field}의 현재 값(${needle})이 없습니다`
          + ' — 상수를 바꾸고 위험 분석을 그대로 두면 문서가 거짓말을 합니다');
      }
    }
  }
  // 선언된 계약은 하나뿐이어야 한다
  if (typeof mod.holdExtensionContractKeys === 'function') {
    const keys = mod.holdExtensionContractKeys();
    if (keys.length !== 1 || keys[0] !== 'MAX_LEV_100X/EXACT_100X') {
      err(`연장이 선언된 계약이 ${JSON.stringify(keys)}입니다`
        + ' — Exact100X 하나만 열려 있어야 합니다');
    }
  }
}

if (errors.length) {
  console.error('❌ 보유 연장 검사 실패\n');
  for (const e of errors) console.error(`  · ${e}`);
  console.error(`\n총 ${errors.length}건`);
  process.exit(1);
}
console.log('✅ 보유 연장 — 기본 꺼짐 · 소급 금지 · 주문 수단 없음 · 배선 확인');
