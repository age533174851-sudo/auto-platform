// scripts/test-order-cap-unknown.mjs
//
// **금액을 모르는 주문이 1회 상한을 통과하지 않는다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 무엇이 실제로 이랬나 (기준 main 1543d4b8, 실행해서 얻은 값)
// ───────────────────────────────────────────────────────────
//   LIVE_SMALL · 0        → SEND
//   LIVE_SMALL · NaN      → SEND   (NaN 비교는 항상 거짓)
//   LIVE_SMALL · null     → SEND
//   LIVE_SMALL · 500      → BLOCK  (상한 100달러)
//
// 상한은 **아는 값이 너무 클 때만** 막고 **모르면 열렸다.** 그리고 호출부
// 여덟 곳이 금액을 모를 때 `: 0` · `|| 0` · `?? 0`으로 채워 넘기고 있었다 —
// 그중 둘(`webhook/tradingview`, `binance/futures/order`)은 **시세를 못
// 읽었을 때** 그 경로를 탄다.
//
// 그래서 판정 쪽을 fail-closed로 바꿨다. 호출부가 앞으로 또 0을 넘겨도
// 판정이 막는다 — 호출부의 기억에 의존하지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const src = ts.transpileModule(
  readFileSync(new URL('src/lib/engine/operatingMode.ts', root), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const mod = {};
runInNewContext(src, {
  exports: mod,
  require(id) { throw new Error(`예상 못 한 import: ${id}`); },
});
const { gateOrder } = mod;

const SENDING = ['TESTNET', 'LIVE_SMALL', 'LIVE_LIMITED'];
const UNKNOWN = [['0', 0], ['NaN', NaN], ['null', null], ['undefined', undefined],
                 ['음수', -5], ['문자열', 'abc'], ['빈 문자열', '']];

// ══ 모르면 막는다 ══

test('★ 주문을 보내는 모드에서 금액을 모르면 BLOCK이다', () => {
  for (const mode of SENDING) {
    for (const [label, v] of UNKNOWN) {
      const r = gateOrder(mode, v, { overrideMaxNotionalUsd: null });
      assert.equal(r.disposition, 'BLOCK', `${mode} · ${label}`);
      assert.match(r.reason, /금액을 확인하지 못해/, `${mode} · ${label} 사유`);
    }
  }
});

test('★ 그 BLOCK은 확인을 요구하는 것이 아니라 보내지 않는 것이다', () => {
  const r = gateOrder('LIVE_SMALL', null);
  assert.equal(r.disposition, 'BLOCK');
  assert.equal(r.needsConfirmation, false, '확인 창으로 넘기면 사람이 통과시킨다');
});

// ══ 아는 값은 그대로 ══

test('정상 금액은 그대로 SEND다 — 막는 수정이 아니다', () => {
  for (const mode of SENDING) {
    const r = gateOrder(mode, 50, { overrideMaxNotionalUsd: null });
    assert.equal(r.disposition, 'SEND', mode);
  }
});

test('상한을 넘으면 여전히 BLOCK이고 사유에 요청 금액이 적힌다', () => {
  const r = gateOrder('LIVE_SMALL', 500, { overrideMaxNotionalUsd: null });
  assert.equal(r.disposition, 'BLOCK');
  assert.match(r.reason, /1회 상한/);
  assert.match(r.reason, /500\.00/, '요청 금액을 적어야 한다');
});

test('아주 작지만 아는 금액은 통과한다 — 0만 특별하다', () => {
  const r = gateOrder('LIVE_SMALL', 0.01, { overrideMaxNotionalUsd: null });
  assert.equal(r.disposition, 'SEND');
});

// ══ 보내지 않는 모드는 영향 0 ══
//
// 모의·Shadow는 상한 검사 **전에** 끝난다. 금액을 몰라도 모의 주문이
// 막히면 안 된다 — 모의는 돈이 아니라 데이터를 쌓는 자리다.

test('★ 모의 모드는 금액을 몰라도 기존 동작 그대로다', () => {
  for (const [label, v] of UNKNOWN) {
    const paper = gateOrder('PAPER', v);
    assert.notEqual(paper.disposition, 'BLOCK', `PAPER · ${label} — 모의가 막히면 안 된다`);
    const shadow = gateOrder('SHADOW_LIVE', v);
    assert.equal(shadow.disposition, 'RECORD', `SHADOW_LIVE · ${label}`);
  }
});

test('UI_DEMO는 금액과 무관하게 BLOCK이다 (기존 그대로)', () => {
  for (const [, v] of UNKNOWN) {
    assert.equal(gateOrder('UI_DEMO', v).disposition, 'BLOCK');
  }
  assert.equal(gateOrder('UI_DEMO', 50).disposition, 'BLOCK');
});

// ══ 배선 ══

test('★ operatingMode.ts가 유한·양수만 통과시킨다 (소스 확인)', () => {
  const s = readFileSync(new URL('src/lib/engine/operatingMode.ts', root), 'utf8');
  assert.match(s, /Number\.isFinite\(known\)/, '유한성을 봐야 한다');
  assert.match(s, /known <= 0/, '0과 음수를 걸러야 한다');
  assert.ok(
    !/if \(limit !== null && notionalUsd > limit\)/.test(s),
    '상한 비교가 아직 원시 인자를 쓰고 있으면 NaN이 그대로 통과한다',
  );
});
