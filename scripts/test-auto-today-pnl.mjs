// scripts/test-auto-today-pnl.mjs
//
// **자동매매 화면이 아무도 채우지 않는 칸을 「오늘 PnL +0」으로 그리지 않는다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 「리스크 가드」 카드의 오늘 손익 줄은 localStorage `tg_today_pnl_v1`을
// 읽었다. 그 칸을 채우는 `recordTradePnL`은 부르는 곳이 0곳이라, 화면은
// 언제나 「오늘 PnL (0건) +0」 · 「한도까지 남음: 한도 전액」이었다.
// 손실일 때는 `Math.abs`로 부호까지 지웠다.
//
// 이 시험은 두 가지를 본다:
//   ① 판정(`todayPnlRow`) — 서버 모의 장부 값만 숫자로 적고, 모르면 「확인 불가」
//   ② 배선 — `recordTradePnL`을 부르는 곳이 없는 한, AutoPage가 가드의
//      오늘 손익(`todayPnL.pnl`)을 숫자로 그리지 않는다.
//      거래 갈래가 그 배선을 하면 ②는 저절로 풀린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = 'src/lib/ui/todayPnlView.ts';
const OUT = mkdtempSync(join(tmpdir(), 'todaypnl-'));

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

test('① 판정 모듈이 컴파일되고 todayPnlRow를 내보낸다', () => {
  assert.ok(M && typeof M.todayPnlRow === 'function', `모듈을 불러오지 못했다 — ${loadErr}`);
});

if (M && typeof M.todayPnlRow === 'function') {
  const { todayPnlRow } = M;

  test('② 손실은 부호를 지우지 않는다', () => {
    const r = todayPnlRow({ code: 'READY', todayPnl: -12.3 });
    assert.equal(r.known, true);
    assert.match(r.text, /^[-−]/, `손실인데 부호가 없다: ${r.text}`);
    assert.match(r.text, /12\.3/);
    assert.match(r.text, /USDT/);
    assert.equal(r.tone, 'bad');
  });

  test('③ 이익은 + 부호다', () => {
    const r = todayPnlRow({ code: 'READY', todayPnl: 5 });
    assert.equal(r.known, true);
    assert.match(r.text, /^\+/);
    assert.equal(r.tone, 'good');
  });

  test('④ 서버가 오늘 기준점을 못 냈으면 0이 아니라 확인 불가다', () => {
    const r = todayPnlRow({ code: 'READY', todayPnl: null });
    assert.equal(r.known, false);
    assert.doesNotMatch(r.text, /\d/, `모르는 값에 숫자가 있다: ${r.text}`);
    assert.ok(r.reason.length > 0);
  });

  test('⑤ 장부를 못 읽었거나 시작 전이면 확인 불가이고 그 이유를 단다', () => {
    for (const code of ['UNREADABLE', 'NOT_STARTED', 'LOADING', '']) {
      const r = todayPnlRow({ code, todayPnl: 0, note: '모의 계좌를 확인하지 못했습니다' });
      assert.equal(r.known, false, `${code || '(빈 코드)'}인데 값을 안다고 했다`);
      assert.doesNotMatch(r.text, /\d/);
      assert.ok(r.reason.length > 0);
    }
    assert.equal(todayPnlRow(null).known, false);
  });

  test('⑥ 진짜 0은 0이다 (모르는 것과 구분)', () => {
    const r = todayPnlRow({ code: 'READY', todayPnl: 0 });
    assert.equal(r.known, true);
    assert.match(r.text, /0/);
  });
}

// ── 배선 ──
function walk(d, out = []) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) { walk(p, out); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test('⑦ 가드의 오늘 손익이 채워지지 않는 동안 AutoPage는 그것을 숫자로 그리지 않는다', () => {
  const files = walk(join(ROOT, 'src'));
  assert.ok(files.length > 100, `src를 제대로 훑지 못했다 (${files.length}개) — 못 본 것은 통과가 아니다`);
  const callers = files.filter(f => {
    if (f.endsWith(join('src', 'lib', 'risk', 'guard.ts'))) return false;
    // import 줄은 부르는 것이 아니다.
    return readFileSync(f, 'utf8').split('\n')
      .some(l => /\brecordTradePnL\s*\(/.test(l) && !/^\s*(import|\/\/|\*)/.test(l));
  });
  const page = readFileSync(join(ROOT, 'src/components/pages/AutoPage.tsx'), 'utf8');
  if (callers.length === 0) {
    assert.doesNotMatch(page, /todayPnL\.pnl/,
      'recordTradePnL을 부르는 곳이 없는데 AutoPage가 todayPnL.pnl을 그린다 — 언제나 +0이다');
    assert.match(page, /todayPnlRow\(/, 'AutoPage가 서버 장부의 오늘 손익(todayPnlRow)을 쓰지 않는다');
  }
});
