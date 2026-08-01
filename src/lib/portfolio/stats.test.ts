// src/lib/portfolio/stats.test.ts
//
// 이 계산이 전략 점수의 **입력**이다. 여기서 틀리면 점수판은 멀쩡해 보이는
// 채로 엉뚱한 전략에 돈을 준다.
//
// 실수하기 쉬운 자리 셋:
//   · 최대 낙폭은 자산 곡선에서 잰다 (거래별 최대 손실이 아니다)
//   · 지는 거래가 없으면 손익비는 정의되지 않는다 (큰 수를 넣으면 1등이 된다)
//   · 자산을 모르면 낙폭·수익률은 null이다 (0을 넣으면 만점을 받는다)

import { test, eq, assert, close } from '../../test/harness';
import { aggregateStrategies, sharpeOf, paperRowToTrade, MIN_DAYS_FOR_SHARPE, type ClosedTrade } from './stats';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** n일 전 청산 */
const t = (strategyId: string, pnl: number, daysAgo: number): ClosedTrade =>
  ({ strategyId, realizedPnl: pnl, closedAtMs: NOW - daysAgo * DAY });

const one = (rows: ClosedTrade[], equityUsd: number | null = 10_000) =>
  aggregateStrategies(rows, { nowMs: NOW, equityUsd })[0];

export function runStatsTests() {
  console.log('[통계 — 묶기]');

  test('전략별로 묶는다', () => {
    const r = aggregateStrategies([t('a', 10, 1), t('b', -5, 1), t('a', 20, 2)], { nowMs: NOW, equityUsd: 10_000 });
    eq(r.length, 2);
    eq(r[0].id, 'a');
    eq(r[0].trades, 2);
    eq(r[1].trades, 1);
  });

  test('전략 id가 없으면 manual로 묶는다 — 버리지 않는다', () => {
    const r = aggregateStrategies(
      [{ strategyId: null, realizedPnl: 5, closedAtMs: NOW }], { nowMs: NOW, equityUsd: 100 });
    eq(r[0].id, 'manual');
    eq(r[0].label, '수동 주문');
  });

  test('숫자가 아닌 행은 버린다 — 0으로 치면 승률·낙폭이 조용히 틀어진다', () => {
    const r = aggregateStrategies([
      t('a', 10, 1),
      { strategyId: 'a', realizedPnl: NaN, closedAtMs: NOW },
      { strategyId: 'a', realizedPnl: 5, closedAtMs: NaN },
    ] as any, { nowMs: NOW, equityUsd: 10_000 });
    eq(r[0].trades, 1);
  });

  test('빈 입력', () => {
    eq(aggregateStrategies([], { nowMs: NOW }).length, 0);
    eq(aggregateStrategies(null, { nowMs: NOW }).length, 0);
  });

  console.log('[통계 — 승률 · 손익비]');

  test('승률', () => {
    const s = one([t('a', 10, 3), t('a', 10, 2), t('a', -5, 1)]);
    close(s.winRatePct as number, 66.667, 0.01);
  });

  test('본전 거래는 승률의 분모에서 뺀다', () => {
    // 1승 1패 + 본전 2 → 50%. 본전을 패로 세면 25%가 된다
    const s = one([t('a', 10, 4), t('a', -10, 3), t('a', 0, 2), t('a', 0, 1)]);
    eq(s.winRatePct, 50);
    eq(s.trades, 4, '표본 수에서는 빼지 않는다');
  });

  test('손익비 = 평균이익 ÷ 평균손실', () => {
    const s = one([t('a', 30, 3), t('a', 10, 2), t('a', -10, 1)]);
    eq(s.payoffRatio, 2, '평균이익 20 ÷ 평균손실 10');
  });

  test('**지는 거래가 없으면 손익비는 null이다** — 큰 수를 넣으면 1등이 된다', () => {
    const s = one([t('a', 10, 3), t('a', 20, 2), t('a', 5, 1)]);
    eq(s.payoffRatio, null);
    eq(s.winRatePct, 100, '승률은 계산된다 — 이건 정의되는 값이다');
  });

  test('이기는 거래가 없어도 null', () => {
    eq(one([t('a', -10, 2), t('a', -5, 1)]).payoffRatio, null);
  });

  console.log('[통계 — 최대 낙폭은 자산 곡선에서]');

  test('연속 손실은 합쳐서 잰다 — 거래별 최대 손실이 아니다', () => {
    // 자산 1000에서 −10이 여덟 번 = −80 → 8%.
    // 거래별 최대 손실(10 → 1%)로 재면 8배 작게 나온다.
    const rows = Array.from({ length: 8 }, (_, i) => t('a', -10, 10 - i));
    const s = one(rows, 920);   // 지금 자산 920 = 시작 1000 − 80
    close(s.maxDrawdownPct as number, 8, 0.01);
  });

  test('고점 이후 되돌림을 잰다', () => {
    // 1000 → +200(1200, 고점) → −300(900). 낙폭 = 300/1200 = 25%
    const s = one([t('a', 200, 3), t('a', -300, 1)], 900);
    close(s.maxDrawdownPct as number, 25, 0.01);
  });

  test('계속 오르기만 하면 낙폭 0', () => {
    eq(one([t('a', 10, 3), t('a', 10, 2), t('a', 10, 1)], 1030).maxDrawdownPct, 0);
  });

  test('**자산을 모르면 낙폭은 null이다** — 0을 넣으면 만점을 받는다', () => {
    const s = one([t('a', -100, 2), t('a', -100, 1)], null);
    eq(s.maxDrawdownPct, null);
    eq(s.return30dPct, null);
    eq(s.sharpe, null);
    eq(s.winRatePct, 0, '자산과 무관한 값은 그대로 나온다');
  });

  test('누적손익이 지금 자산보다 크면(출금 등) 낙폭은 null', () => {
    // 지금 자산 50인데 누적이 +500 → 시작 자산이 음수가 된다
    eq(one([t('a', 500, 1)], 50).maxDrawdownPct, null);
  });

  console.log('[통계 — 최근 30일]');

  test('30일 안의 거래만 센다', () => {
    const s = one([t('a', 500, 60), t('a', 100, 10)], 10_600);
    // 최근 30일 손익 100, 30일 전 자산 10,500 → 약 0.952%
    close(s.return30dPct as number, 0.952, 0.01);
  });

  test('30일간 거래가 없으면 0%다 — 이건 모름이 아니라 관측이다', () => {
    eq(one([t('a', 500, 60)], 10_500).return30dPct, 0);
  });

  console.log('[통계 — 샤프]');

  test('거래일이 모자라면 숫자를 만들지 않는다', () => {
    const rows = Array.from({ length: 10 }, (_, i) => t('a', i % 2 ? 10 : -5, 10 - i));
    eq(one(rows, 10_000).sharpe, null, `${MIN_DAYS_FOR_SHARPE}일 미만`);
  });

  test('꾸준히 오르면 샤프가 높다', () => {
    const rows = Array.from({ length: 40 }, (_, i) => t('a', i % 4 === 0 ? -2 : 6, 40 - i));
    const s = one(rows, 10_000).sharpe as number;
    assert(s > 3, `${s}`);
  });

  test('같은 수익이라도 들쭉날쭉하면 샤프가 낮다', () => {
    const steady = Array.from({ length: 40 }, (_, i) => t('a', 5, 40 - i));
    const wild = Array.from({ length: 40 }, (_, i) => t('a', i % 2 ? 105 : -95, 40 - i));
    const a = one(steady, 10_000).sharpe as number;
    const b = one(wild, 10_000).sharpe as number;
    assert(a > b, `꾸준 ${a} vs 들쭉 ${b}`);
  });

  test('거래가 없던 날은 0인 날로 채운다 — 빼면 변동성이 실제보다 크게 나온다', () => {
    // 40일 동안 20일만 거래. 빈 날을 빼면 표본이 20개가 되고 분산이 커진다.
    const rows = Array.from({ length: 20 }, (_, i) => t('a', 5, 40 - i * 2));
    const s = one(rows, 10_000).sharpe;
    assert(s != null, '40일 구간이므로 계산돼야 한다');
  });

  test('변동이 0이면 null — 무한대를 만들지 않는다', () => {
    eq(sharpeOf([t('a', 0, 30), t('a', 0, 1)], 10_000, 20), null);
  });

  test('시작 자산이 없거나 0 이하면 null', () => {
    eq(sharpeOf([t('a', 5, 30)], null, 20), null);
    eq(sharpeOf([t('a', 5, 30)], 0, 20), null);
  });

  console.log('[통계 — DB 행 변환]');

  test('paper_positions 행을 옮긴다', () => {
    const r = paperRowToTrade({
      strategy_id: 'demo-runner', realized_pnl: '12.5',
      closed_at: new Date(NOW).toISOString(),
    });
    eq(r?.strategyId, 'demo-runner');
    eq(r?.realizedPnl, 12.5);
    eq(r?.closedAtMs, NOW);
  });

  test('손익이나 청산 시각이 없으면 버린다 — 아직 안 닫힌 포지션이다', () => {
    eq(paperRowToTrade({ strategy_id: 'a', realized_pnl: null, closed_at: null }), null);
    eq(paperRowToTrade({ strategy_id: 'a', realized_pnl: 5, closed_at: null }), null);
  });
}
