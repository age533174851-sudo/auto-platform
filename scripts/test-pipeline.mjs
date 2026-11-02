#!/usr/bin/env node
/**
 * 통합 테스트 — DB → Calendar → 5v5 → Veto → Risk Manager
 *
 * 단위 테스트는 각 부품이 맞는지만 본다.
 * 이 테스트는 부품들이 실제로 연결되어 있는지, 특히
 * "캘린더가 없으면 고배율이 실제로 차단되는지"를 확인한다.
 *
 * 실행: node scripts/test-pipeline.mjs
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, normalize } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
let pass = 0, fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 필요한 모듈을 **따라가서** 모은다 ──
//
// 예전에는 복사할 파일 목록과 import 치환 목록을 **손으로** 적었다.
// 그 목록이 코드보다 늦게 늘어서, `tradingPipeline`이 새로 import한
// `expansionMode`·`ladderGate`·`safety`가 목록에 없었고 — **이 시험은
// `Cannot find module`로 죽어 있었다.** 즉 캘린더 차단·FOMC 차단·웹훅
// Veto 우회 금지를 보는 통합 시험이 **한 번도 돌지 않았다.**
// (`node --test scripts/test-pipeline.mjs` → pass 0 / fail 1)
//
// 그래서 목록을 없앤다. 진입점에서 상대 import를 **따라가며** 닫힘을
// 모으고, 각 파일의 상대 지정자를 평탄화한 이름으로 바꾼다. 코드가
// 새 모듈을 import하면 목록을 고칠 필요 없이 자동으로 따라온다.
const ROOTS = [
  'src/lib/engine/tradingPipeline.ts',
  'src/lib/calendar/econCalendar.ts',
];

/** `src/lib/strategies/expansionMode.ts` → `strategies__expansionMode` */
const flatName = (repoPath) => repoPath
  .replace(/^src\/lib\//, '').replace(/\.tsx?$/, '').replace(/\//g, '__');

/** 상대 지정자를 실제 파일로 푼다. 못 풀면 **조용히 넘기지 않는다** */
function resolveSpec(importer, spec) {
  const base = normalize(join(dirname(importer), spec));
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const SPEC = /(['"])(\.\.?\/[^'"]+)\1/g;
const collected = new Map();   // repoPath → flatName
const unresolved = [];
{
  const queue = [...ROOTS];
  while (queue.length) {
    const f = queue.pop();
    if (collected.has(f)) continue;
    if (!existsSync(f)) { unresolved.push(['(진입점)', f]); continue; }
    collected.set(f, flatName(f));
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(SPEC)) {
      const target = resolveSpec(f, m[2]);
      if (target == null) unresolved.push([f, m[2]]);
      else if (!collected.has(target)) queue.push(target);
    }
  }
}
if (unresolved.length) {
  // 못 푼 import를 "없음"으로 보지 않는다 — 그대로 두면 또 조용히 죽는다.
  console.log('  ✗ 상대 import를 풀지 못했습니다 — 시험을 돌릴 수 없습니다');
  for (const [from, spec] of unresolved) console.log(`     ${from} → ${spec}`);
  process.exit(1);
}

// 평탄화한 이름으로 복사하면서 지정자를 바꾼다
for (const [repoPath, name] of collected) {
  const src = readFileSync(repoPath, 'utf8').replace(SPEC, (whole, q, spec) => {
    const target = resolveSpec(repoPath, spec);
    return target ? `'./${collected.get(target)}.js'` : whole;
  });
  writeFileSync(join(dir, `${name}.ts`), src);
}

const ENTRY_PIPELINE = `${flatName(ROOTS[0])}.js`;
const ENTRY_CALENDAR = `${flatName(ROOTS[1])}.js`;

console.log('통합 테스트: DB → Calendar → 5v5 → Veto → Risk Manager\n');

// 타입 에러 **개수**로는 실패시키지 않는다(저장소가 기준선을 안고 있다).
// 그러나 **emit이 안 된 것**은 실패다 — 예전에는 그것을 삼켜서,
// 컴파일이 안 된 사실이 `Cannot find module`이라는 엉뚱한 모양으로만
// 드러났다. 무엇이 왜 안 됐는지 여기서 적는다.
let tscOut = '';
try {
  tscOut = execSync(
    `cd ${dir} && npx tsc *.ts --module commonjs --target es2020 --skipLibCheck --lib es2020,dom 2>&1 || true`,
    { encoding: 'utf8' });
} catch (e) { tscOut = String(e?.stdout ?? e?.message ?? e); }

const notEmitted = [...collected.values()].filter((n) => !existsSync(join(dir, `${n}.js`)));
if (notEmitted.length) {
  console.log(`  ✗ 컴파일 산출물이 없습니다 (${notEmitted.length}개) — 시험을 돌릴 수 없습니다`);
  for (const n of notEmitted) console.log(`     ${n}.js`);
  for (const line of tscOut.split('\n').filter((l) => l.includes('error TS')).slice(0, 10)) {
    console.log(`     ${line.trim()}`);
  }
  process.exit(1);
}

const { runTradingPipeline, describePipeline } = await import(join(dir, ENTRY_PIPELINE));
const { clearCalendarCache } = await import(join(dir, ENTRY_CALENDAR));

// ── 테스트 데이터 ──
function makeDaily(n, trend, vol, seed) {
  const c = [], h = [], l = [], v = [];
  let p = 65000, s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s % 2147483648) / 2147483648; };
  for (let i = 0; i < n; i++) {
    const r = trend + (rnd() - 0.5) * 2 * vol;
    const close = p * (1 + r);
    c.push(close); h.push(Math.max(p, close) * (1 + vol * 0.4)); l.push(Math.min(p, close) * (1 - vol * 0.4));
    v.push(1000 + rnd() * 300); p = close;
  }
  return { c, h, l, v };
}

// Supabase 목 — 캘린더 있음/없음을 제어
function mockSb(events) {
  // updated_at은 이벤트 중 가장 최근 값 (없으면 지금)
  const latest = events.length
    ? events.map(e => e.updated_at).filter(Boolean).sort().pop() || new Date().toISOString()
    : null;
  return {
    from: () => ({
      select: () => ({
        gte: () => ({ lte: () => ({ order: async () => ({ data: events, error: null }) }) }),
        // freshness 조회: .select('updated_at').order().limit().maybeSingle()
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: latest ? { updated_at: latest } : null }) }) }),
        eq: () => ({
          eq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }),
          maybeSingle: async () => ({ data: null }),
        }),
      }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'x' } }) }) }),
      update: () => ({ eq: async () => ({}) }),
    }),
  };
}

// 5v5가 실제로 진입 판정을 내는 데이터를 찾는다 (NO_TRADE면 Veto를 테스트할 수 없다)
let d = null, baseInput = null;
for (let seed = 1; seed <= 200; seed++) {
  const cand = makeDaily(60, ((seed % 5) - 2) * 0.005, 0.013, seed * 17);
  const probe = {
    symbol: 'BTCUSDT',
    dailyCloses: cand.c, dailyHighs: cand.h, dailyLows: cand.l, dailyVolumes: cand.v,
    fearGreed: 30 + (seed % 40),
    riskConfig: { accountEquity: 10000, maxLeverage: 20, riskPerTradePct: 1 },
  };
  clearCalendarCache();
  // 캘린더를 정상으로 두고 5v5가 진입하는지만 본다
  const far = [{ id: 'x', timestamp_utc: new Date(Date.now() + 20 * 3600000).toISOString(),
                 event: 'far', impact: 'low', source: 'api' }];
  const r = await runTradingPipeline(mockSb(far), probe);
  if (r.battle && r.battle.side !== 'NO_TRADE') { d = cand; baseInput = probe; break; }
}
if (!baseInput) {
  console.log('  ⚠️ 진입 판정을 내는 데이터를 못 찾음 — 테스트 불가');
  process.exit(1);
}
console.log(`테스트 데이터 확보 (5v5가 진입 판정)\n`);

// ── ① 캘린더 없음 + 고배율 → 차단되어야 함 ──
console.log('① 캘린더 없음 + 20배');
clearCalendarCache();
const r1 = await runTradingPipeline(mockSb([]), baseInput);
describePipeline(r1).forEach(l => console.log('   ' + l));
check('캘린더 미가용 감지', r1.calendar.available === false);
check('고배율 차단', !r1.approved && r1.stage === 'veto', r1.blockedBy);
check('차단 사유가 캘린더', String(r1.blockedBy || '').includes('CALENDAR_UNAVAILABLE'));

// ── ② 캘린더 없음 + 저배율 → 통과 가능 ──
console.log('\n② 캘린더 없음 + 3배 (저배율은 허용)');
clearCalendarCache();
const r2 = await runTradingPipeline(mockSb([]), {
  ...baseInput, riskConfig: { ...baseInput.riskConfig, maxLeverage: 3 },
});
check('저배율은 캘린더 차단 안 됨', !String(r2.blockedBy || '').includes('CALENDAR_UNAVAILABLE'),
  r2.stage);

// ── ③ 캘린더 있음 + FOMC 임박 → 차단 ──
console.log('\n③ 캘린더 있음 + FOMC 2시간 후');
const fomcSoon = [{
  id: 'f1', timestamp_utc: new Date(Date.now() + 2 * 3600000).toISOString(),
  event: 'FOMC 금리 결정', impact: 'high', source: 'api',
}];
clearCalendarCache();
const r3 = await runTradingPipeline(mockSb(fomcSoon), baseInput);
describePipeline(r3).forEach(l => console.log('   ' + l));
check('캘린더 로드됨', r3.calendar.available === true, `${r3.calendar.eventCount}건`);
check('임박 고영향 감지', r3.calendar.upcomingHighImpact === 1);
check('FOMC로 차단', !r3.approved && String(r3.blockedBy || '').includes('HIGH_IMPACT_EVENT'));

// ── ④ 캘린더 있음 + 이벤트 멀리 → 통과 ──
console.log('\n④ 캘린더 있음 + FOMC 20시간 후 (범위 밖)');
const fomcFar = [{
  id: 'f2', timestamp_utc: new Date(Date.now() + 20 * 3600000).toISOString(),
  event: 'FOMC 금리 결정', impact: 'high', source: 'api',
}];
clearCalendarCache();
const r4 = await runTradingPipeline(mockSb(fomcFar), baseInput);
describePipeline(r4).forEach(l => console.log('   ' + l));
check('먼 이벤트는 차단 안 함', !String(r4.blockedBy || '').includes('HIGH_IMPACT_EVENT'));

// ── ⑤ 변동성 기준선이 median으로 계산되는지 ──
console.log('\n⑤ 변동성 기준선');
check('median 방식 사용', r4.volatility.method === 'median', r4.volatility.note);
check('기준선이 0이 아님', r4.volatility.baselineAtrPct > 0,
  `${r4.volatility.baselineAtrPct.toFixed(2)}%`);

// ── ⑥ Risk Manager까지 도달 ──
console.log('\n⑥ 전체 경로 도달 확인');
const reached = [r1, r2, r3, r4].some(r => r.plan != null || r.stage === 'approved' || r.stage === 'risk');
check('Risk Manager 단계 도달', reached);
const anyApproved = [r2, r4].some(r => r.approved);
check('승인 경로 존재', anyApproved || r4.stage === 'risk',
  anyApproved ? '승인됨' : `${r4.stage}에서 중단`);

// ── ⑦ 외부 신호(웹훅) Veto 게이트 — 우회 불가 증명 ──
console.log('\n⑦ 외부 신호 Veto 게이트 (웹훅 경로)');
const { applyVetoToSignal } = await import(join(dir, ENTRY_PIPELINE));

// 캘린더 없음 + 고배율 외부 신호 → 차단되어야 함
clearCalendarCache();
const g1 = await applyVetoToSignal(mockSb([]), {
  side: 'LONG', symbol: 'BTCUSDT', leverage: 20,
});
check('외부 신호도 캘린더 미가용 시 차단', !g1.allowed, g1.blockedBy);

// 캘린더 없음 + 저배율 → 허용
clearCalendarCache();
const g2 = await applyVetoToSignal(mockSb([]), {
  side: 'LONG', symbol: 'BTCUSDT', leverage: 2,
});
check('저배율 외부 신호는 허용', g2.allowed);

// FOMC 임박 + 외부 신호 → 차단
clearCalendarCache();
const g3 = await applyVetoToSignal(mockSb([{
  id: 'f3', timestamp_utc: new Date(Date.now() + 1.5 * 3600000).toISOString(),
  event: 'FOMC', impact: 'high', source: 'api', updated_at: new Date().toISOString(),
}]), { side: 'LONG', symbol: 'BTCUSDT', leverage: 10 });
check('외부 신호도 FOMC로 차단', !g3.allowed,
  String(g3.blockedBy || '').includes('HIGH_IMPACT_EVENT') ? 'HIGH_IMPACT_EVENT' : g3.blockedBy);

// 가격 히스토리 없음 + 고배율 → 변동성 fail-closed
clearCalendarCache();
const g4 = await applyVetoToSignal(mockSb([{
  id: 'f4', timestamp_utc: new Date(Date.now() + 20 * 3600000).toISOString(),
  event: 'far', impact: 'low', source: 'api', updated_at: new Date().toISOString(),
}]), { side: 'LONG', symbol: 'BTCUSDT', leverage: 20 });
check('변동성 데이터 없으면 고배율 차단', !g4.allowed,
  String(g4.blockedBy || '').includes('VOLATILITY_DATA_MISSING') ? 'VOLATILITY_DATA_MISSING' : g4.blockedBy);

// 펀딩 과밀 + 같은 방향 → 차단
clearCalendarCache();
const g5 = await applyVetoToSignal(mockSb([{
  id: 'f5', timestamp_utc: new Date(Date.now() + 20 * 3600000).toISOString(),
  event: 'far', impact: 'low', source: 'api', updated_at: new Date().toISOString(),
}]), {
  side: 'LONG', symbol: 'BTCUSDT', leverage: 3,
  fundingRate: 0.15,
  dailyHighs: d.h, dailyLows: d.l, dailyCloses: d.c,
});
check('펀딩 과밀 방향 진입 차단', !g5.allowed,
  String(g5.blockedBy || '').includes('FUNDING_EXTREME') ? 'FUNDING_EXTREME' : g5.blockedBy);

// ── ⑧ 캘린더 freshness — 오래된 캘린더는 stale ──
console.log('\n⑧ 캘린더 freshness (updated_at 기준)');
clearCalendarCache();
const staleCal = await applyVetoToSignal(mockSb([{
  id: 'old', timestamp_utc: new Date(Date.now() + 20 * 3600000).toISOString(),
  event: 'far', impact: 'low', source: 'api',
  updated_at: new Date(Date.now() - 72 * 3600000).toISOString(),   // 3일 전 갱신
}]), { side: 'LONG', symbol: 'BTCUSDT', leverage: 20 });
check('3일 전 갱신 캘린더는 stale 처리', !staleCal.calendar.available,
  staleCal.calendar.reason?.slice(0, 40));

// 정리
try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
if (fail > 0) {
  console.log('❌ 파이프라인 배선에 문제가 있습니다');
  process.exit(1);
}
console.log('✅ 전체 파이프라인 연결 확인');
