#!/usr/bin/env node
// 실제 Binance 1분봉으로 배율별 생존률·실현수익을 검증한다.
//
// 사용: node scripts/validate-real-data.mjs [심볼] [일수]
//   예: node scripts/validate-real-data.mjs BTCUSDT 90
//
// 왜 1분봉인가
// ────────────
// 일봉 OHLC만 보면 "그날 +5% 올랐다"는 것만 알 뿐, 그 전에 -1%를 찍었는지
// 알 수 없다. 고배율에서는 경로가 결과를 지배한다 — 최종 방향이 맞아도
// 중간에 청산되면 소용없다. MAE/MFE는 봉이 촘촘할수록 정확해진다.
//
// 15분봉으로도 대략은 보이지만, 100배(청산거리 0.5%)에서는 15분 안의 움직임이
// 결과를 바꾼다. 그래서 1분봉을 쓴다.
//
// 이 스크립트는 앱 번들에 포함되지 않는다. src를 임시 폴더에 복사해 컴파일한다
// (scripts/run-tests.mjs와 같은 방식).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYMBOL = (process.argv[2] || 'BTCUSDT').toUpperCase();
const DAYS = Math.max(5, Math.min(365, Number(process.argv[3] || 60)));

const root = process.cwd();
const tscPath = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tscPath)) {
  console.error("TypeScript를 찾을 수 없습니다. 먼저 'npm install'을 실행하세요.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'traigo-validate-'));
cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });

writeFileSync(join(dir, 'run.ts'), `
import { measureExcursion, survivalAt, realizedAt, analyzeExcursions, type Bar } from './src/lib/backtest/excursion';

const SYMBOL = ${JSON.stringify(SYMBOL)};
const DAYS = ${DAYS};
const FAPI = 'https://fapi.binance.com';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson(url: string, tries = 3): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status === 418) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

function toBars(rows: any[]): Bar[] {
  return rows
    .map((k: any) => ({ high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), t: Number(k[0]) }))
    .filter((b: Bar) => Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close));
}

async function main() {
  console.log('════════ 실데이터 검증 ════════');
  console.log(SYMBOL + ' · 최근 ' + DAYS + '일 · Binance 선물 1분봉');
  console.log('');

  // 1) 일봉 — 진입일과 방향을 정한다
  const daily = toBars(await getJson(FAPI + '/fapi/v1/klines?symbol=' + SYMBOL + '&interval=1d&limit=' + (DAYS + 2)));
  if (daily.length < 5) { console.log('일봉이 부족합니다'); return; }

  // 진입 규칙: 전일 종가 대비 방향을 그날의 시작 방향으로 삼는다.
  // (5v5 전략의 완전한 재현이 아니라, 경로 의존성 자체를 측정하기 위한 단순 규칙)
  const entries: { dayStart: number; dayEnd: number; side: 'LONG' | 'SHORT'; entryPrice: number }[] = [];
  for (let i = 1; i < daily.length - 1; i++) {
    const prev = daily[i - 1], cur = daily[i];
    const side: 'LONG' | 'SHORT' = cur.close >= prev.close ? 'LONG' : 'SHORT';
    entries.push({ dayStart: cur.t!, dayEnd: cur.t! + 86400000, side, entryPrice: prev.close });
  }

  console.log('진입 후보 ' + entries.length + '일. 1분봉을 내려받습니다 (요청당 약 0.3초)...');

  const excursions: any[] = [];
  let fetched = 0;
  for (const e of entries) {
    const rows = await getJson(
      FAPI + '/fapi/v1/klines?symbol=' + SYMBOL + '&interval=1m&startTime=' + e.dayStart + '&endTime=' + e.dayEnd + '&limit=1500'
    );
    const bars = toBars(rows);
    if (bars.length < 60) continue;
    excursions.push(measureExcursion(e.side, e.entryPrice, bars));
    fetched++;
    if (fetched % 10 === 0) process.stdout.write('  ' + fetched + '/' + entries.length + '\\r');
    await sleep(120);   // rate limit 여유
  }
  console.log('  ' + fetched + '/' + entries.length + ' 완료          ');
  console.log('');

  if (!excursions.length) { console.log('표본이 없습니다'); return; }

  // 2) MAE/MFE 분포
  const stats = analyzeExcursions(excursions, [100, 50, 25, 10, 5, 2]);
  console.log('── MAE 분포 (진입 후 최대 역행) ──');
  console.log('  중앙값 ' + stats.maeP50.toFixed(2) + '%   75분위 ' + stats.maeP75.toFixed(2) +
              '%   90분위 ' + stats.maeP90.toFixed(2) + '%   최대 ' + stats.maeMax.toFixed(2) + '%');
  console.log('── MFE 분포 (진입 후 최대 순행) ──');
  console.log('  중앙값 ' + stats.mfeP50.toFixed(2) + '%   90분위 ' + stats.mfeP90.toFixed(2) +
              '%   최대 ' + stats.mfeMax.toFixed(2) + '%');
  console.log('');

  // 3) 배율별 — 상한 대 실현
  console.log('── 배율별 결과 ──');
  console.log('배율   생존률    상한(MFE)      실현        실현/상한   청산');
  console.log('─────────────────────────────────────────────────────────────');
  for (const lev of [100, 50, 25, 10, 5, 2]) {
    let ubSum = 0, rzSum = 0, survived = 0, liq = 0;
    for (const ex of excursions) {
      const s = survivalAt(ex, lev);
      if (!s.survived) { liq++; continue; }
      survived++;
      ubSum += s.mfeUpperBoundPct ?? 0;
      const r = realizedAt(ex, lev);
      rzSum += r ? (r.liquidated ? -100 : r.returnPct) : 0;
      if (r?.liquidated) liq++;
    }
    const n = excursions.length;
    const ub = survived ? ubSum / survived : 0;
    const rz = survived ? rzSum / survived : 0;
    const ratio = ub > 0 ? (rz / ub * 100) : 0;
    console.log(
      String(lev).padStart(4) + '배  ' +
      ((survived / n * 100).toFixed(1) + '%').padStart(7) + '  ' +
      (ub >= 0 ? '+' : '') + ub.toFixed(1) + '%'.padEnd(2) + '  ' +
      ((rz >= 0 ? '+' : '') + rz.toFixed(1) + '%').padStart(10) + '  ' +
      (ratio.toFixed(0) + '%').padStart(9) + '  ' +
      String(liq).padStart(5)
    );
  }
  console.log('');

  // 4) 기대값 — 전체 표본 기준 (청산 = -100%)
  console.log('── 전체 기대값 (청산 포함, 표본 ' + excursions.length + '건) ──');
  for (const lev of [100, 50, 25, 10, 5, 2]) {
    let total = 0;
    for (const ex of excursions) {
      const s = survivalAt(ex, lev);
      if (!s.survived) { total += -100; continue; }
      const r = realizedAt(ex, lev);
      total += r ? (r.liquidated ? -100 : r.returnPct) : 0;
    }
    const ev = total / excursions.length;
    const verdict = ev > 0 ? '양수' : '음수 — 반복하면 계좌가 줄어듭니다';
    console.log('  ' + String(lev).padStart(3) + '배: 1회당 ' + (ev >= 0 ? '+' : '') + ev.toFixed(1) + '%  (' + verdict + ')');
  }
  console.log('');
  console.log(stats.note);
}

main().catch(e => { console.error('실패:', e?.message || e); (globalThis as any).process.exitCode = 1; });
`);

try {
  execFileSync(process.execPath, [
    tscPath, 'run.ts',
    '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--esModuleInterop', '--lib', 'es2020,dom',
  ], { cwd: dir, stdio: 'pipe' });
} catch {
  // 타입 에러가 있어도 js는 생성된다 (ignoreBuildErrors 정책과 동일)
}

const entry = join(dir, 'run.js');
if (!existsSync(entry)) {
  console.error('컴파일 실패 — run.js가 생성되지 않았습니다. tsc 출력:');
  try {
    execFileSync(process.execPath, [
      tscPath, 'run.ts', '--module', 'commonjs', '--target', 'es2020',
      '--skipLibCheck', '--esModuleInterop', '--lib', 'es2020,dom',
    ], { cwd: dir, stdio: 'inherit' });
  } catch { /* 위에서 출력됨 */ }
  process.exit(1);
}

execFileSync(process.execPath, ['run.js'], { cwd: dir, stdio: 'inherit' });
