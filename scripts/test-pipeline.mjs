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
import { mkdtempSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
let pass = 0, fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// 필요한 모듈을 **tsc가 import를 따라가게** 해서 모은다.
//
// 예전에는 복사할 파일 목록과 경로 치환 목록을 여기 손으로 적어 뒀다.
// 그 표는 `tradingPipeline.ts`의 import를 베낀 사본이라, import가 하나
// 늘면 이 스크립트만 모르고 깨졌다. 실제로 `expansionMode`와 `ladderGate`가
// 추가되자 이 시험은 `MODULE_NOT_FOUND`로 죽었고, CI 필수 검사에 안 들어가
// 있어서 그 RED가 가려져 있었다.
// (`CLAUDE.md`: 같은 판단이 두 곳에 있으면 언젠가 갈린다.)
//
// 표를 한 줄 더 늘리면 다음에 또 같은 자리에서 깨진다. 그래서 **표 자체를
// 없앴다.** tsc에 진입 파일만 주면 import 그래프를 스스로 따라가 필요한
// 파일을 전부 컴파일하고, 디렉터리 구조를 그대로 내보낸다. 상대 import는
// 그대로 맞으므로 치환할 것이 없고, 평탄화하지 않으니 `safety/types.ts`와
// `exchanges/types.ts`처럼 이름이 같은 파일이 서로를 덮을 일도 없다.
const ENTRY = 'src/lib/engine/tradingPipeline.ts';
const CALENDAR = 'src/lib/calendar/econCalendar.ts';

// 타입 오류는 **적되** 여기서 멈추지 않는다. tsc는 타입 오류가 있어도
// JS를 내보내고, 이 시험이 보는 것은 배선이지 타입이 아니다. 저장소의
// 타입 기준선은 프로젝트 tsconfig로 재는 `npx tsc --noEmit`이 본다 —
// 여기 오류 개수를 그 기준선으로 읽으면 안 된다(설정이 다르다).
let tscOut = '';
try {
  tscOut = execSync(
    `npx tsc ${ENTRY} ${CALENDAR} --outDir ${dir} --rootDir . `
    + `--module commonjs --target es2020 --skipLibCheck --lib es2020,dom`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { tscOut = String(e?.stdout || '') + String(e?.stderr || ''); }
const tscErrors = (tscOut.match(/error TS/g) || []).length;
if (tscErrors) console.log(`  (tsc 타입 오류 ${tscErrors}건 — 이 시험의 판정 대상은 아니다)`);

// **산출물이 없으면 멈춘다.** 빠진 모듈로 돌린 결과는 통과도 실패도 아니다.
const entryJs = join(dir, ENTRY.replace(/\.ts$/, '.js'));
const calendarJs = join(dir, CALENDAR.replace(/\.ts$/, '.js'));
for (const [label, f] of [[ENTRY, entryJs], [CALENDAR, calendarJs]]) {
  if (!existsSync(f)) {
    console.log(`  \u2717 ${label} 컴파일 산출물이 없습니다 — 시험을 돌리지 않습니다`);
    if (tscOut.trim()) console.log(tscOut.trim().split('\n').slice(0, 20).map(l => '      ' + l).join('\n'));
    process.exit(1);
  }
}

console.log('통합 테스트: DB → Calendar → 5v5 → Veto → Risk Manager\n');

const { runTradingPipeline, describePipeline } = await import(entryJs);
const { clearCalendarCache } = await import(calendarJs);

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
const { applyVetoToSignal } = await import(entryJs);

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
