// src/lib/risk/dailyLoss.test.ts
//
// 막으려는 것: **한도가 걸려 있다고 믿는 채로 계속 잃는 것.**
//
// 예전 구현은 localStorage에 오늘 손익을 들고 있어서, 저장소를 지우거나
// 다른 기기로 열면 한도가 리셋됐고 서버 경로에는 아예 적용되지 않았다.
// 그런 실패는 화면에 '제한 켜짐'으로 보인다.

import { test, eq, assert } from '../../test/harness';
import {
  sumTodayIncome, judgeDailyLoss, readDailyLossConfig, utcDayStart,
  DEFAULT_DAILY_LOSS, type DailyLossConfig,
} from './dailyLoss';

const DAY = Date.UTC(2026, 6, 31);          // 2026-07-31 00:00 UTC
const t = (h: number) => DAY + h * 3_600_000;

const cfgUsd: DailyLossConfig = { maxLossUsd: 100, maxLossPct: null, profitTargetPct: null };
const cfgPct: DailyLossConfig = { maxLossUsd: null, maxLossPct: 5, profitTargetPct: null };

export function runDailyLossTests() {
  console.log('[일일 한도 — 오늘 손익 합산]');

  test('실현손익·수수료·펀딩을 모두 센다 — 수수료를 빼면 다른 질문의 답이다', () => {
    const r = sumTodayIncome([
      { incomeType: 'REALIZED_PNL', income: '50', time: t(1) },
      { incomeType: 'COMMISSION', income: '-12', time: t(2) },
      { incomeType: 'FUNDING_FEE', income: '-3', time: t(3) },
    ], DAY);
    eq(r.realizedPnl, 50);
    eq(r.commission, -12);
    eq(r.funding, -3);
    eq(r.net, 35);
    eq(r.count, 3);
  });

  test('어제 것은 세지 않는다', () => {
    const r = sumTodayIncome([
      { incomeType: 'REALIZED_PNL', income: '-500', time: DAY - 1 },
      { incomeType: 'REALIZED_PNL', income: '10', time: t(1) },
    ], DAY);
    eq(r.net, 10);
    eq(r.count, 1);
  });

  test('시각이나 금액을 못 읽는 줄은 세지 않는다 — 0으로 치면 조용히 틀린다', () => {
    const r = sumTodayIncome([
      { incomeType: 'REALIZED_PNL', income: '-100' },              // time 없음
      { incomeType: 'REALIZED_PNL', income: 'abc', time: t(1) },
      { incomeType: 'REALIZED_PNL', income: '-20', time: t(2) },
    ], DAY);
    eq(r.net, -20);
    eq(r.count, 1);
  });

  test('모르는 종류는 other로 모으되 합계에는 넣는다', () => {
    const r = sumTodayIncome([{ incomeType: 'INSURANCE_CLEAR', income: '-7', time: t(1) }], DAY);
    eq(r.other, -7);
    eq(r.net, -7);
  });

  test('목록이 없거나 비면 0건이다', () => {
    eq(sumTodayIncome(null, DAY).count, 0);
    eq(sumTodayIncome([], DAY).count, 0);
  });

  console.log('[일일 한도 — 판정]');

  test('한도 안이면 통과하고 남은 여유를 알려준다', () => {
    const v = judgeDailyLoss({ todayNetUsd: -30, dayStartEquityUsd: 1000, cfg: cfgUsd });
    eq(v.status, 'ok');
    eq(v.blockEntries, false);
    eq(v.remainingUsd, 70);
  });

  test('한도에 닿으면 잠근다', () => {
    const v = judgeDailyLoss({ todayNetUsd: -100, dayStartEquityUsd: 1000, cfg: cfgUsd });
    eq(v.status, 'locked');
    eq(v.blockEntries, true);
    assert(v.reason.includes('청산은 계속'), `나갈 수 있다는 것을 말해야 한다: ${v.reason}`);
  });

  test('이익이면 손실 0으로 본다 — 부호를 뒤집으면 이익에 잠긴다', () => {
    const v = judgeDailyLoss({ todayNetUsd: 250, dayStartEquityUsd: 1000, cfg: cfgUsd });
    eq(v.status, 'ok');
    eq(v.remainingUsd, 100);
  });

  test('비율 한도는 시작 자산 기준이다', () => {
    // 1000의 5% = 50
    eq(judgeDailyLoss({ todayNetUsd: -49, dayStartEquityUsd: 1000, cfg: cfgPct }).status, 'ok');
    eq(judgeDailyLoss({ todayNetUsd: -50, dayStartEquityUsd: 1000, cfg: cfgPct }).status, 'locked');
  });

  test('두 한도가 다 있으면 더 작은 쪽이 이긴다', () => {
    const both: DailyLossConfig = { maxLossUsd: 100, maxLossPct: 5, profitTargetPct: null };
    // 1000의 5% = 50 < 100
    const v = judgeDailyLoss({ todayNetUsd: -60, dayStartEquityUsd: 1000, cfg: both });
    eq(v.limitUsd, 50);
    eq(v.status, 'locked');
  });

  console.log('[일일 한도 — 모르는 것은 통과가 아니다]');

  test('오늘 손익을 모르면 막는다', () => {
    const v = judgeDailyLoss({ todayNetUsd: null, dayStartEquityUsd: 1000, cfg: cfgUsd });
    eq(v.status, 'unknown');
    eq(v.blockEntries, true, '모른 채로 보내면 한도를 안 건 것과 같다');
  });

  test('비율 한도만 있는데 시작 자산을 모르면 막는다', () => {
    const v = judgeDailyLoss({ todayNetUsd: -10, dayStartEquityUsd: null, cfg: cfgPct });
    eq(v.status, 'unknown');
    eq(v.blockEntries, true);
  });

  test('금액 한도가 같이 있으면 자산을 몰라도 판단한다', () => {
    const both: DailyLossConfig = { maxLossUsd: 100, maxLossPct: 5, profitTargetPct: null };
    const v = judgeDailyLoss({ todayNetUsd: -120, dayStartEquityUsd: null, cfg: both });
    eq(v.status, 'locked');
    eq(v.limitUsd, 100);
  });

  test('한도를 아예 안 걸었으면 통과다 — 검사가 없는 것은 실패가 아니다', () => {
    const none: DailyLossConfig = { maxLossUsd: null, maxLossPct: null, profitTargetPct: null };
    const v = judgeDailyLoss({ todayNetUsd: null, dayStartEquityUsd: null, cfg: none });
    eq(v.status, 'ok');
    eq(v.blockEntries, false);
  });

  console.log('[일일 한도 — 이익 목표]');

  test('목표에 닿으면 잠그되 손실 때문이 아니라고 적는다', () => {
    const cfg: DailyLossConfig = { maxLossUsd: null, maxLossPct: 5, profitTargetPct: 10 };
    const v = judgeDailyLoss({ todayNetUsd: 120, dayStartEquityUsd: 1000, cfg });
    eq(v.status, 'locked');
    eq(v.byProfitTarget, true);
    assert(v.reason.includes('목표'), v.reason);
  });

  test('목표를 안 걸면 이익으로 잠기지 않는다', () => {
    eq(judgeDailyLoss({ todayNetUsd: 9999, dayStartEquityUsd: 1000, cfg: cfgPct }).status, 'ok');
  });

  console.log('[일일 한도 — 설정 읽기]');

  const envOf = (o: Record<string, string>) => (k: string) => o[k];

  test('아무것도 없으면 기본 비율 한도가 걸린다 — 한도 없이 도는 것을 막는다', () => {
    const c = readDailyLossConfig(envOf({}));
    eq(c.maxLossPct, DEFAULT_DAILY_LOSS.maxLossPct);
    eq(c.maxLossUsd, null);
  });

  test('값을 주면 그 값을 쓴다', () => {
    const c = readDailyLossConfig(envOf({ DAILY_MAX_LOSS_USD: '250', DAILY_PROFIT_TARGET_PCT: '8' }));
    eq(c.maxLossUsd, 250);
    eq(c.profitTargetPct, 8);
  });

  test('이상한 값은 무시한다 — 오타 하나로 한도가 사라지면 안 된다', () => {
    const c = readDailyLossConfig(envOf({ DAILY_MAX_LOSS_USD: 'abc', DAILY_MAX_LOSS_PCT: '-3' }));
    eq(c.maxLossUsd, null);
    // 둘 다 못 읽었으므로 기본 비율 한도로 떨어진다 (한도 없음이 아니다)
    eq(c.maxLossPct, DEFAULT_DAILY_LOSS.maxLossPct);
  });

  console.log('[일일 한도 — 하루 경계]');

  test('UTC 자정으로 자른다 — 거래소 기록과 펀딩 정산이 그 기준이다', () => {
    eq(utcDayStart(Date.UTC(2026, 6, 31, 15, 30)), DAY);
    eq(utcDayStart(Date.UTC(2026, 6, 31, 0, 0)), DAY);
    eq(utcDayStart(Date.UTC(2026, 6, 30, 23, 59)), DAY - 86_400_000);
  });
}
