// src/lib/portfolio/performance.test.ts
//
// **입금해서 늘어난 것을 수익으로 읽으면 안 된다.**
//
// $1,000으로 시작해 $2,000이 됐다고 +100%가 아니다. $900을 입금했으면
// 매매로는 +$100이고 그건 +10%다. 이 구분이 없으면 사용자는 자기 성과를
// 열 배 좋게 읽는다.

import { test, eq, assert } from '../../test/harness';
import {
  equityPerformanceOf, cashFlowOf, tradeStatsOf, elapsedText,
  type EquitySnapshot,
} from './performance';
import { snapshotVerdict, snapshotRow, SNAPSHOT_INTERVAL_MS } from './snapshotPlan';

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const S = (over: Partial<EquitySnapshot> = {}): EquitySnapshot =>
  ({ takenAt: T0, totalEquity: 1000, ...over });

export function runPerformanceTests() {
  console.log('[성과 — 잔고 증가는 수익이 아니다]');

  test('입금분을 빼야 매매 손익이 나온다', () => {
    // $1,000 → $2,000인데 $900을 넣었다. **번 것은 $100이다.**
    // 자산 증가를 그대로 수익이라고 적으면 +100%로 보인다.
    const p = equityPerformanceOf([
      S({ takenAt: T0, totalEquity: 1000, deposit: 0, withdrawal: 0 }),
      S({ takenAt: T0 + DAY, totalEquity: 2000, deposit: 900, withdrawal: 0 }),
    ]);
    eq(p.equityChange, 1000, '자산 증가');
    eq(p.tradingPnl, 100, '매매 손익 — 입금을 수익으로 읽었다');
    // 분모는 넣은 돈 전부(시작 1000 + 순입금 900)다. 시작 자산만 쓰면
    // 중간에 입금했을 때 수익률이 부풀려진다.
    eq(p.tradingReturnPct, 5.2632);
  });

  test('입출금을 모르면 매매 손익도 모른다', () => {
    // **자산 증가를 수익이라고 적지 않는다.**
    const p = equityPerformanceOf([
      S({ takenAt: T0, totalEquity: 1000 }),
      S({ takenAt: T0 + DAY, totalEquity: 2000 }),
    ]);
    eq(p.equityChange, 1000);
    eq(p.tradingPnl, null, '입출금을 모르는데 매매 손익을 만들었다');
    eq(p.tradingReturnPct, null);
    assert(p.note.includes('구분하지 못했'), p.note);
  });

  test('출금도 반영한다', () => {
    const c = cashFlowOf([S({ deposit: 500, withdrawal: 0 }), S({ deposit: 0, withdrawal: 200 })]);
    eq(c.deposit, 500); eq(c.withdrawal, 200); eq(c.net, 300);
  });

  test('입출금 기록이 하나도 없으면 0이 아니라 null이다', () => {
    const c = cashFlowOf([S(), S()]);
    eq(c.deposit, null); eq(c.net, null);
  });

  console.log('[성과 — 지금 잔고로 과거를 역산하지 않는다]');

  test('기록이 없으면 아무 숫자도 만들지 않는다', () => {
    const p = equityPerformanceOf([]);
    eq(p.code, 'NO_SNAPSHOTS');
    eq(p.startEquity, null); eq(p.currentEquity, null); eq(p.maxDrawdownPct, null);
    assert(p.note.includes('역산하지 않습니다'), p.note);
  });

  test('한 시점뿐이면 곡선도 낙폭도 없다', () => {
    const p = equityPerformanceOf([S()]);
    eq(p.code, 'ONE_SNAPSHOT');
    eq(p.startEquity, 1000); eq(p.currentEquity, 1000);
    eq(p.maxDrawdownPct, null, '두 점이 없는데 낙폭을 만들었다');
  });

  test('자산을 못 읽은 시점은 곡선에서 뺀다 — 0으로 그리지 않는다', () => {
    // 0으로 그리면 그래프가 바닥으로 떨어지고 사용자는 전액을 잃은 줄 안다.
    const p = equityPerformanceOf([
      S({ takenAt: T0, totalEquity: 1000 }),
      S({ takenAt: T0 + DAY, totalEquity: null }),
      S({ takenAt: T0 + 2 * DAY, totalEquity: 1200 }),
    ]);
    eq(p.startEquity, 1000); eq(p.currentEquity, 1200);
    eq(p.maxDrawdownPct, 0, '못 읽은 시점이 낙폭으로 계산됐다');
  });

  test('기록은 있는데 자산을 하나도 못 읽었으면 그렇게 말한다', () => {
    const p = equityPerformanceOf([S({ totalEquity: null }), S({ totalEquity: null })]);
    eq(p.code, 'EQUITY_UNKNOWN');
    eq(p.currentEquity, null);
  });

  test('최대 낙폭은 고점 대비로 잰다', () => {
    const p = equityPerformanceOf([
      S({ takenAt: T0, totalEquity: 1000 }),
      S({ takenAt: T0 + DAY, totalEquity: 1500 }),
      S({ takenAt: T0 + 2 * DAY, totalEquity: 900 }),      // 고점 1500 → −40%
      S({ takenAt: T0 + 3 * DAY, totalEquity: 1200 }),
    ]);
    eq(p.peakEquity, 1500); eq(p.troughEquity, 900);
    eq(p.maxDrawdownPct, 40);
  });

  test('운용 경과를 잰다', () => {
    const p = equityPerformanceOf([
      S({ takenAt: T0 }), S({ takenAt: T0 + 4 * DAY + 13 * 3_600_000 }),
    ]);
    eq(p.elapsedMs, 4 * DAY + 13 * 3_600_000);
    eq(elapsedText(p.elapsedMs), '4일 13시간');
    eq(elapsedText(null), '확인하지 못했습니다');
  });

  console.log('[성과 — 거래 통계]');

  test('승률·손익비·기대값을 낸다', () => {
    const s = tradeStatsOf([
      { pnl: 100 }, { pnl: 100 }, { pnl: -50 }, { pnl: -50 },
    ]);
    eq(s.wins, 2); eq(s.losses, 2);
    eq(s.winRatePct, 50);
    eq(s.avgWin, 100); eq(s.avgLoss, 50);
    eq(s.profitFactor, 2); eq(s.payoffRatio, 2);
    eq(s.expectancy, 25);
  });

  test('손익을 못 읽은 거래를 0으로 세지 않는다', () => {
    // 0으로 세면 그 거래가 본전이 되어 승률과 기대값이 둘 다 틀린다.
    const s = tradeStatsOf([{ pnl: 100 }, { pnl: null }, { pnl: null }]);
    eq(s.counted, 1); eq(s.total, 3);
    eq(s.winRatePct, 100, '못 읽은 거래가 패배로 세어졌다');
    assert(s.note.includes('손익을 읽은 1건 기준'), s.note);
  });

  test('손실이 없으면 Profit Factor를 만들지 않는다', () => {
    // Infinity를 "무한대 수익"으로 그리면 표본 3건짜리가 최고 성적이 된다.
    const s = tradeStatsOf([{ pnl: 10 }, { pnl: 20 }]);
    eq(s.profitFactor, null);
    eq(s.payoffRatio, null);
  });

  test('거래가 없으면 0%가 아니라 없음이다', () => {
    const s = tradeStatsOf([]);
    eq(s.winRatePct, null); eq(s.expectancy, null);
    assert(s.note.includes('닫힌 거래가 없습니다'), s.note);
  });

  console.log('[스냅샷 — 표는 있는데 채우는 코드가 없었다]');

  test('첫 기록은 무조건 찍는다 — 안 찍으면 영원히 안 찍힌다', () => {
    const v = snapshotVerdict({ nowMs: T0, lastTakenMs: null, connections: 1, totalEquity: 1000 });
    eq(v.take, true); eq(v.code, 'TAKE');
  });

  test('자산을 못 읽었으면 0으로 찍지 않는다', () => {
    // **되돌릴 수 없는 기록이다.** 0을 남기면 곡선이 바닥으로 떨어진다.
    const v = snapshotVerdict({ nowMs: T0, lastTakenMs: null, connections: 1, totalEquity: null });
    eq(v.take, false); eq(v.code, 'EQUITY_UNKNOWN');
    assert(v.reason.includes('0으로 찍지 않습니다'), v.reason);
  });

  test('연결이 없으면 찍을 자산이 없다', () => {
    eq(snapshotVerdict({ nowMs: T0, lastTakenMs: null, connections: 0, totalEquity: 1000 }).code, 'NO_ACCOUNT');
  });

  test('간격 안에는 다시 찍지 않는다 — 표가 부풀지 않게', () => {
    eq(snapshotVerdict({ nowMs: T0, lastTakenMs: T0 - 1000, connections: 1, totalEquity: 1 }).code, 'TOO_SOON');
    eq(snapshotVerdict({ nowMs: T0, lastTakenMs: T0 - SNAPSHOT_INTERVAL_MS, connections: 1, totalEquity: 1 }).take, true);
  });

  test('못 읽은 칸은 행에 넣지 않는다 — 0으로 기록되면 성과가 틀린다', () => {
    const row = snapshotRow({
      userId: 'u1', env: 'TESTNET', takenAtMs: T0, totalEquity: 1000,
      unrealizedPnl: null, fees: null,
    });
    eq(row.total_equity, 1000);
    eq('unrealized_pnl' in row, false, '못 읽은 값이 0으로 기록된다');
    eq('fees' in row, false);
    eq(row.env, 'TESTNET');
  });

  test('읽은 칸은 넣는다', () => {
    const row = snapshotRow({
      userId: 'u1', env: 'LIVE', takenAtMs: T0, totalEquity: 500, unrealizedPnl: -3,
    });
    eq(row.unrealized_pnl, -3);
  });
}
