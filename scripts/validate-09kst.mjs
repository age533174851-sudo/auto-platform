#!/usr/bin/env node
// BTC_09KST_DAILY_100X 전략의 실데이터 검증.
//
// 사용: node scripts/validate-09kst.mjs [심볼] [일수]
//
// 전략 규칙 (사용자 확정 명세)
// ────────────────────────────
//   기준 시각  매일 09:00 KST = 00:00 UTC (Binance 일봉 전환 시점)
//   관찰       새 일봉이 열린 뒤 10 / 20 / 30분
//   판단       관찰 구간의 방향·몸통·꼬리·거래량
//   진입       관찰 종료 시점 가격에 한 방향으로 1회
//   보유       다음 날 09:00까지 (약 23시간 30분)
//   청산       다음 날 09:00
//   빈도       하루 최대 1포지션, 장중 재진입 없음
//
// 앞서 돌린 validate-real-data.mjs는 "전일 종가 진입"을 가정했다. 이 전략은
// 관찰이 끝난 뒤에 들어가므로 진입가가 다르고, 따라서 MAE도 다르다.
// 초기 움직임이 지난 뒤 들어가면 역행 폭이 줄어들 수 있다 — 그것을 잰다.
//
// 배율은 고정 100배다. 이 스크립트는 배율을 바꿔 제안하지 않는다.
// 비교용으로 다른 배율도 함께 출력하지만, 전략 자체는 100배다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYMBOL = (process.argv[2] || 'BTCUSDT').toUpperCase();
const DAYS = Math.max(10, Math.min(365, Number(process.argv[3] || 90)));

const root = process.cwd();
const tscPath = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tscPath)) {
  console.error("TypeScript를 찾을 수 없습니다. 먼저 'npm install'을 실행하세요.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'traigo-09kst-'));
cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });

writeFileSync(join(dir, 'run.ts'), `
import { measureExcursion, survivalAt, realizedAt, type Bar } from './src/lib/backtest/excursion';

const SYMBOL = ${JSON.stringify(SYMBOL)};
const DAYS = ${DAYS};
const FAPI = 'https://fapi.binance.com';
const DAY_MS = 86_400_000;

// 비용 — 실현손익에 반영한다
const FEE_ROUNDTRIP_PCT = 0.08;   // 왕복 taker
const SLIPPAGE_PCT = 0.03;
const FUNDING_PER_8H_PCT = 0.01;  // 기본값. 보유 23.5시간 = 약 3회 정산

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson(url: string, tries = 6): Promise<any> {
  let lastErr: any = new Error('요청 실패');
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status === 418) {
        // rate limit — 점점 오래 쉰다. 365일이면 요청이 730건이라 반드시 걸린다.
        lastErr = new Error('rate limit ' + r.status);
        await sleep(4000 * (i + 1));
        continue;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i === tries - 1) break;
      await sleep(1500 * (i + 1));
    }
  }
  // 재시도를 모두 소진한 경우. 예전에는 여기서 undefined가 반환돼
  // 호출부의 .map()이 터졌다 — 원인이 rate limit인데 다른 오류처럼 보였다.
  throw lastErr;
}

interface Min { high: number; low: number; close: number; open: number; vol: number; t: number }

function toMin(rows: any[]): Min[] {
  return rows.map((k: any) => ({
    t: Number(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), vol: parseFloat(k[5]),
  })).filter(m => Number.isFinite(m.close));
}

// ── 관찰 구간 판단 ──
// 몸통 방향을 1차 신호로, 꼬리와 거래량으로 확신도를 본다.
// 판단이 서지 않으면 NO_TRADE.
function judge(obs: Min[]): { side: 'LONG' | 'SHORT' | 'NO_TRADE'; note: string } {
  if (obs.length < 5) return { side: 'NO_TRADE', note: '관찰 봉 부족' };
  const open = obs[0].open;
  const close = obs[obs.length - 1].close;
  const high = Math.max(...obs.map(o => o.high));
  const low = Math.min(...obs.map(o => o.low));

  const range = high - low;
  if (range <= 0) return { side: 'NO_TRADE', note: '변동 없음' };

  const body = close - open;
  const bodyPct = Math.abs(body) / range;          // 몸통 비중
  const upWick = high - Math.max(open, close);
  const dnWick = Math.min(open, close) - low;

  // 몸통이 레인지의 30% 미만이면 방향이 서지 않은 것으로 본다
  if (bodyPct < 0.30) return { side: 'NO_TRADE', note: '몸통 ' + (bodyPct * 100).toFixed(0) + '% — 방향 불명확' };

  const isUp = body > 0;
  // 반대쪽 꼬리가 몸통보다 길면 되돌림 압력이 크다고 본다
  const against = isUp ? upWick : dnWick;
  if (against > Math.abs(body)) {
    return { side: 'NO_TRADE', note: '반대 꼬리가 몸통보다 김 — 되돌림 위험' };
  }
  return { side: isUp ? 'LONG' : 'SHORT', note: '몸통 ' + (bodyPct * 100).toFixed(0) + '% ' + (isUp ? '상승' : '하락') };
}

async function main() {
  console.log('════════ BTC_09KST_DAILY_100X 검증 ════════');
  console.log(SYMBOL + ' · 최근 ' + DAYS + '일 · 1분봉');
  console.log('규칙: 00:00 UTC(09:00 KST) 이후 N분 관찰 → 1회 진입 → 다음 09:00 청산');
  console.log('');

  // 최근 DAYS일의 00:00 UTC 목록
  const now = Date.now();
  const todayUtc0 = Math.floor(now / DAY_MS) * DAY_MS;
  const days: number[] = [];
  for (let i = DAYS; i >= 1; i--) days.push(todayUtc0 - i * DAY_MS);

  const OBS_WINDOWS = [10, 15, 20, 30];
  const results: Record<number, any[]> = { 10: [], 15: [], 20: [], 30: [] };
  const noTrade: Record<number, number> = { 10: 0, 15: 0, 20: 0, 30: 0 };

  let done = 0;
  for (const d0 of days) {
    // 체결가 1분봉 — 관찰 판단과 진입/청산 체결가에 쓴다
    const rows = await getJson(
      FAPI + '/fapi/v1/klines?symbol=' + SYMBOL + '&interval=1m&startTime=' + d0 + '&endTime=' + (d0 + DAY_MS) + '&limit=1500'
    );
    // Mark Price 1분봉 — 청산·MAE 판정에 쓴다.
    // Binance는 마지막 체결가가 아니라 Mark Price로 청산을 판단한다.
    // 체결가로 재면 순간적인 심지에 청산됐다고 잘못 세거나 그 반대가 된다.
    const markRows = await getJson(
      FAPI + '/fapi/v1/markPriceKlines?symbol=' + SYMBOL + '&interval=1m&startTime=' + d0 + '&endTime=' + (d0 + DAY_MS) + '&limit=1500'
    ).catch(() => null);

    const mins = toMin(rows);
    const marks = markRows ? toMin(markRows) : null;
    done++;
    if (done % 10 === 0) process.stdout.write('  ' + done + '/' + days.length + '\\r');
    if (mins.length < 300) continue;

    for (const w of OBS_WINDOWS) {
      const cutoff = d0 + w * 60_000;
      const obs = mins.filter(m => m.t < cutoff);
      const rest = mins.filter(m => m.t >= cutoff);
      if (obs.length < 5 || rest.length < 60) continue;

      const j = judge(obs);
      if (j.side === 'NO_TRADE') { noTrade[w]++; continue; }

      // 진입가는 체결가 기준 (실제로 그 가격에 체결된다)
      const entryPrice = obs[obs.length - 1].close;
      // 경로는 Mark Price 기준 (청산이 그것으로 판단된다). 없으면 체결가로 대체.
      const pathSrc = marks ? marks.filter(m => m.t >= cutoff) : rest;
      if (pathSrc.length < 60) continue;
      const bars: Bar[] = pathSrc.map(m => ({ high: m.high, low: m.low, close: m.close, t: m.t }));
      const ex = measureExcursion(j.side, entryPrice, bars);
      results[w].push({ ex, side: j.side, note: j.note, day: new Date(d0).toISOString().slice(0, 10), markUsed: !!marks });
    }
    await sleep(320);
  }
  console.log('  ' + done + '/' + days.length + ' 완료          ');
  console.log('');

  for (const w of OBS_WINDOWS) {
    const rs = results[w];
    console.log('════ 관찰 ' + w + '분 ════  진입 ' + rs.length + '일 · NO_TRADE ' + noTrade[w] + '일');
    if (!rs.length) { console.log('  표본 없음'); console.log(''); continue; }

    const maes = rs.map(r => r.ex.maePct).sort((a: number, b: number) => a - b);
    const p = (q: number) => maes[Math.min(maes.length - 1, Math.floor(maes.length * q))];
    console.log('  MAE  중앙값 ' + p(0.5).toFixed(2) + '%  75분위 ' + p(0.75).toFixed(2) + '%  90분위 ' + p(0.9).toFixed(2) + '%');

    // 방향 적중 (종가 기준)
    const hit = rs.filter(r => r.ex.closePct > 0).length;
    console.log('  방향 적중 ' + (hit / rs.length * 100).toFixed(1) + '%  (' + hit + '/' + rs.length + ')');

    console.log('  배율   생존률    실현(비용반영)   기대값(청산포함)');
    for (const lev of [100, 50, 25, 10]) {
      let survived = 0, sumSurv = 0, sumAll = 0;
      for (const r of rs) {
        const s = survivalAt(r.ex, lev, { slippagePct: SLIPPAGE_PCT });
        if (!s.survived) { sumAll += -100; continue; }
        const rz = realizedAt(r.ex, lev, { feePct: FEE_ROUNDTRIP_PCT, slippagePct: SLIPPAGE_PCT });
        // 펀딩: 보유 약 23.5시간 → 3회 정산. 방향에 따라 부호가 갈리지만
        // 보수적으로 항상 지불하는 것으로 본다.
        const funding = FUNDING_PER_8H_PCT * 3 * lev;
        const net = rz ? (rz.liquidated ? -100 : rz.returnPct - funding) : 0;
        if (rz?.liquidated) { sumAll += -100; continue; }
        survived++; sumSurv += net; sumAll += net;
      }
      const n = rs.length;
      const avgSurv = survived ? sumSurv / survived : 0;
      const ev = sumAll / n;
      console.log(
        '  ' + String(lev).padStart(4) + '배  ' +
        ((survived / n * 100).toFixed(1) + '%').padStart(7) + '  ' +
        ((avgSurv >= 0 ? '+' : '') + avgSurv.toFixed(1) + '%').padStart(13) + '  ' +
        ((ev >= 0 ? '+' : '') + ev.toFixed(1) + '%').padStart(14)
      );
    }
    console.log('');
  }

  console.log('※ 비용 반영: 왕복 수수료 ' + FEE_ROUNDTRIP_PCT + '% · 슬리피지 ' + SLIPPAGE_PCT + '% · 펀딩 ' + FUNDING_PER_8H_PCT + '%×3회');
  console.log('※ 청산 판정은 1분봉 경로 기준. 한 봉이 청산가와 익절가를 모두 스치면 청산을 먼저 적용한다.');
}

main().catch(e => { console.error('실패:', e?.message || e); (globalThis as any).process.exitCode = 1; });
`);

try {
  execFileSync(process.execPath, [
    tscPath, 'run.ts', '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--esModuleInterop', '--lib', 'es2020,dom',
  ], { cwd: dir, stdio: 'pipe' });
} catch { /* 타입 에러가 있어도 js는 생성된다 */ }

const entry = join(dir, 'run.js');
if (!existsSync(entry)) {
  console.error('컴파일 실패:');
  try {
    execFileSync(process.execPath, [
      tscPath, 'run.ts', '--module', 'commonjs', '--target', 'es2020',
      '--skipLibCheck', '--esModuleInterop', '--lib', 'es2020,dom',
    ], { cwd: dir, stdio: 'inherit' });
  } catch { /* 위에서 출력됨 */ }
  process.exit(1);
}

execFileSync(process.execPath, ['run.js'], { cwd: dir, stdio: 'inherit' });
