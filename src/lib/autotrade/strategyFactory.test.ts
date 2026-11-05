// src/lib/autotrade/strategyFactory.test.ts
//
// **데모 숫자로 "승격 권장"이 나오고 있었다.**
//
// `StrategyFactoryPanel`은 하드코딩된 `DEMO_STATS`로 개선안을 만들고,
// 버튼 한 번에 `pnlSeries()`가 만든 가상 손익 두 줄(승률 45 대 63)을
// `updateShadow(..., p.shadowTarget)`에 넣는다. 날짜가 목표치와 같으니
// 검증이 끝난 것으로 취급되고, 숫자가 좋으니 `promoted` + "승격 권장"이
// 나온다. 화면에는 그 직전에 "2주간 실시간 병렬 검증을 시작해요"가 떠 있다.
//
// 즉 **측정한 적 없는 입력이 측정 결과처럼 승격 판정을 받는다.** 반환된
// 객체 어디에도 그것이 데모였다는 흔적이 없어서, 호출자도 화면도 검토자도
// 데모 판정과 실측 판정을 구분할 수 없다.
//
// CLAUDE.md: 실제 증거 없이 PASS를 적지 않는다 · UNKNOWN을 0으로 적지
// 않는다. 그래서 출처를 **태어날 때 적고**, 실측이 아니면 승격 판정을
// 하지 않는다. 데모 화면은 그대로 두고 라벨만 정확해진다.
import { test, eq, assert } from '../../test/harness';
import { diagnoseAndPropose, updateShadow } from './strategyFactory';

// 화면이 쓰는 것과 같은 하드코딩 데모 입력 (StrategyFactoryPanel.tsx)
const DEMO_STATS: any = {
  RANGE: { trend: { trades: 8, wins: 2, winRate: 25, totalPnl: -180000, adjust: 0.68 } },
  TREND_UP: { trend: { trades: 10, wins: 8, winRate: 80, totalPnl: 620000, adjust: 1.45 } },
};

// 화면이 쓰는 것과 같은 가상 손익 생성기
function pnlSeries(n: number, wr: number, seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(((i * 31 + seed) % 100) < wr ? 120000 : -95000);
  return out;
}

function demoProposal() {
  const p = diagnoseAndPropose({
    strategyId: 's1', name: 'BTC EMA 추세 추종', type: 'ema_cross', params: {},
    regimeStats: DEMO_STATS, evidence: 'DEMO',
  });
  assert(p !== null, '데모 입력에서 개선안이 나와야 이 시험이 성립한다');
  return p!;
}

export function runStrategyFactoryTests() {
  console.log('[전략 공장 — 데모 숫자를 실측 판정으로 적지 않는다]');

  test('개선안은 태어날 때 출처를 적는다', () => {
    eq(demoProposal().evidence, 'DEMO');
  });

  test('★ 데모 입력은 승격 판정을 받지 않는다 (화면과 같은 숫자)', () => {
    // 화면의 simulateComplete가 넣는 값 그대로.
    const p = demoProposal();
    const r = updateShadow(p, pnlSeries(20, 45, 3), pnlSeries(20, 63, 7), p.shadowTarget, 'DEMO');
    assert(r.status !== 'promoted', `데모 입력이 promoted가 됐다: ${r.verdict}`);
    assert(!/승격/.test(r.verdict || ''), `데모 판정문에 승격이 들어갔다: ${r.verdict}`);
  });

  test('★ 판정 결과에도 출처가 남는다', () => {
    const p = demoProposal();
    const r = updateShadow(p, pnlSeries(20, 45, 3), pnlSeries(20, 63, 7), p.shadowTarget, 'DEMO');
    eq(r.evidence, 'DEMO');
  });

  test('★ 데모 개선안을 실측이라고 다시 부르는 것으로 승격되지 않는다', () => {
    // 출처 세탁 방지: 태어날 때 DEMO였던 것은 호출 인자로 바꿀 수 없다.
    const p = demoProposal();
    const r = updateShadow(p, pnlSeries(20, 45, 3), pnlSeries(20, 63, 7), p.shadowTarget, 'MEASURED');
    assert(r.status !== 'promoted', `출처 세탁으로 승격됐다: ${r.verdict}`);
    eq(r.evidence, 'DEMO');
  });

  test('데모 판정은 숫자를 지우지 않는다 — 라벨만 붙인다', () => {
    const p = demoProposal();
    const r = updateShadow(p, pnlSeries(20, 45, 3), pnlSeries(20, 63, 7), p.shadowTarget, 'DEMO');
    assert(r.baseMetrics != null && r.shadowMetrics != null, '데모 성과 표시는 그대로 둔다');
    assert(/데모/.test(r.verdict || ''), `데모라고 말해야 한다: ${r.verdict}`);
  });

  test('실측 출처는 기존대로 승격될 수 있다', () => {
    const p = diagnoseAndPropose({
      strategyId: 's1', name: 'BTC EMA 추세 추종', type: 'ema_cross', params: {},
      regimeStats: DEMO_STATS, evidence: 'MEASURED',
    })!;
    const r = updateShadow(p, pnlSeries(20, 45, 3), pnlSeries(20, 63, 7), p.shadowTarget, 'MEASURED');
    eq(r.status, 'promoted');
    eq(r.evidence, 'MEASURED');
  });

  test('실측이어도 개선 폭이 부족하면 승격하지 않는다', () => {
    const p = diagnoseAndPropose({
      strategyId: 's1', name: 'BTC EMA 추세 추종', type: 'ema_cross', params: {},
      regimeStats: DEMO_STATS, evidence: 'MEASURED',
    })!;
    const same = pnlSeries(20, 45, 3);
    const r = updateShadow(p, same, same, p.shadowTarget, 'MEASURED');
    eq(r.status, 'rejected');
  });

  test('검증 기간이 남았으면 어느 출처든 판정하지 않는다', () => {
    const p = demoProposal();
    const r = updateShadow(p, pnlSeries(20, 45, 3), pnlSeries(20, 63, 7), 1, 'DEMO');
    eq(r.status, 'shadow');
  });
}
