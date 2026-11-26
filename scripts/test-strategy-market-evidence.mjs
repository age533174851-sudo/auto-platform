// scripts/test-strategy-market-evidence.mjs
//
// **지어낸 가격으로 만든 "AI 배정"을 실측처럼 그리지 않는다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// `StrategyMarketPanel`(자동매매 → AI 의사결정)은 종목마다 `demoPrices()`가
// 사인파로 **지어낸** 40개 가격을 `assignPortfolio`에 넣는다. 그런데 화면은
// "AI가 종목별 국면·변동성·위원회를 종합해 시간프레임을 배정합니다"라고 적고
// "확신 NN%"·자금 배분 %를 그린다. 반환 객체 어디에도 그것이 데모라는 흔적이
// 없어서 화면도 검토자도 실측 배정과 구분할 수 없었다.
//
// 토글은 이 컴포넌트의 로컬 상태만 바꾸는데 `notifySuccess('전략 켜짐')`을
// 띄웠다 — 아무 전략도 켜지지 않았다.
//
// `strategyFactory`(5f56efd0)와 같은 방식으로 고친다: 출처를 **값으로**
// 태어날 때 적고(필수 인자 — 기본값이면 잊었을 때 조용히 실측이 된다),
// 화면은 그 값을 보고 라벨을 단다. 숫자는 지우지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = 'src/lib/autotrade/strategyMarket.ts';
const PANEL = 'src/components/StrategyMarketPanel.tsx';
const OUT = mkdtempSync(join(tmpdir(), 'stratmarket-'));

let tscOut = '';
try {
  tscOut = execFileSync(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'),
    ENTRY, '--outDir', OUT, '--rootDir', '.',
    '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--esModuleInterop', '--lib', 'es2020,dom',
  ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  tscOut = String(e?.stdout || '') + String(e?.stderr || '');
}
const entryJs = join(OUT, ENTRY.replace(/\.ts$/, '.js'));
let M = null, loadErr = '';
if (existsSync(entryJs)) {
  try { M = await import(entryJs); } catch (e) { loadErr = String(e?.message || e); }
} else {
  loadErr = `컴파일 산출물이 없다: ${entryJs}\n${tscOut}`;
}

// 화면이 쓰는 것과 같은 지어낸 가격 (StrategyMarketPanel.tsx의 demoPrices)
function demoPrices(symbol) {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const trend = ((seed % 5) - 2) * 0.6;
  const volMul = 0.5 + (seed % 4) * 0.7;
  const out = []; let p = 100;
  for (let i = 0; i < 40; i++) { p += trend + Math.sin(seed + i * 1.4) * 1.2 * volMul; out.push(Math.max(1, p)); }
  return out;
}
const SYMS = ['BTC', 'ETH', 'SOL', 'DOGE'].map(s => ({ symbol: s, prices: demoPrices(s) }));

test('① 판정 모듈이 컴파일되고 assignPortfolio를 내보낸다', () => {
  assert.ok(M && typeof M.assignPortfolio === 'function', `모듈을 불러오지 못했다 — ${loadErr}`);
});

if (M && typeof M.assignPortfolio === 'function') {
  const { assignPortfolio } = M;

  test('② 데모 입력의 배정은 출처 DEMO를 값으로 들고 나온다', () => {
    const p = assignPortfolio(SYMS, 'DEMO', 50, 5);
    assert.equal(p.evidence, 'DEMO', `배정 결과에 출처가 없다: ${JSON.stringify(p.evidence)}`);
    for (const a of p.assignments) {
      assert.equal(a.evidence, 'DEMO', `${a.symbol} 배정에 출처가 없다`);
    }
  });

  test('③ 데모 배정의 요약은 데모라고 말한다', () => {
    const p = assignPortfolio(SYMS, 'DEMO', 50, 5);
    assert.match(p.summary, /데모/, `요약이 데모라고 말하지 않는다: ${p.summary}`);
  });

  test('④ 숫자는 지우지 않는다 — 데모 화면은 그대로, 라벨만 정확해진다', () => {
    const p = assignPortfolio(SYMS, 'DEMO', 50, 5);
    assert.equal(p.assignments.length, 4);
    for (const a of p.assignments) assert.ok(Number.isFinite(a.confidence));
    if (p.allocation.length) {
      assert.equal(p.allocation.reduce((s, x) => s + x.pct, 0), 100);
    }
  });

  test('⑤ 실측 입력은 MEASURED로 남고 요약에 데모 표시가 없다', () => {
    const p = assignPortfolio(SYMS, 'MEASURED', 50, 5);
    assert.equal(p.evidence, 'MEASURED');
    for (const a of p.assignments) assert.equal(a.evidence, 'MEASURED');
    assert.doesNotMatch(p.summary, /데모/);
  });

  test('⑥ 출처를 안 넘기면 실측으로 취급하지 않는다', () => {
    const p = assignPortfolio(SYMS, undefined, 50, 5);
    assert.notEqual(p.evidence, 'MEASURED', '출처를 잊었는데 실측이 됐다');
  });
}

// ── 배선: 화면이 실제로 그 값을 쓰는가 ──
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const panel = existsSync(join(ROOT, PANEL)) ? code(readFileSync(join(ROOT, PANEL), 'utf8')) : '';

test('⑦ 화면 파일을 읽었다 (못 읽으면 통과가 아니다)', () => {
  assert.ok(panel.length > 0, `${PANEL}을 읽지 못했다`);
});

test('⑧ 지어낸 가격을 넣는 화면은 출처 DEMO를 명시한다', () => {
  assert.match(panel, /demoPrices\(/, '화면이 더 이상 demoPrices를 쓰지 않는다면 이 시험을 실측 배선에 맞게 고쳐라');
  assert.match(panel, /assignPortfolio\([^;]*'DEMO'/s, '지어낸 가격을 넣으면서 출처 DEMO를 넘기지 않는다');
});

test('⑨ 화면이 데모 배지를 출처 값에서 그린다', () => {
  assert.match(panel, /evidence\s*===\s*'DEMO'/, '화면이 출처 값을 보고 라벨을 달지 않는다');
});

test('⑩ 아무것도 켜지 않는 토글이 "전략 켜짐" 성공 알림을 띄우지 않는다', () => {
  assert.doesNotMatch(panel, /notifySuccess\(/, '로컬 표시만 바뀌는데 성공 알림을 띄운다');
  assert.doesNotMatch(panel, /'전략 켜짐'|'전략 꺼짐'/, '켜지지 않은 전략을 "켜짐"이라고 적는다');
});
