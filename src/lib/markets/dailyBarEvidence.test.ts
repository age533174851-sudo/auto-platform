// src/lib/markets/dailyBarEvidence.test.ts
//
// **거짓 일봉으로 변동성 관문을 통과하던 길을 닫는다.**
//
// 가짜 거래소가 20일 지난 1시간봉을 일봉 응답으로 돌려줬는데 100배
// 진입의 변동성 관문이 통과했다. 관문은 켜져 있었고 입력이 거짓이었다.

import { test, eq, assert } from '../../test/harness';
import {
  dailyBarEvidence, DAY_MS, MIN_DAILY_BARS, MAX_NEWEST_AGE_DAYS,
} from './dailyBarEvidence';

const NOW = Date.parse('2026-10-21T02:00:00Z');

/** 간격을 정해 봉을 만든다. `endMs`는 **마지막 봉이 열린** 시각 */
function series(n: number, stepMs: number, endMs: number) {
  const highs: number[] = [], lows: number[] = [], closes: number[] = [], openTimes: number[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const t = endMs - k * stepMs;
    const c = 60000 + (k % 7) * 50;
    highs.push(c + 300); lows.push(c - 300); closes.push(c); openTimes.push(t);
  }
  return { highs, lows, closes, openTimes };
}

/** 어제 00:00 UTC에 열린 봉이 마지막인 정상 일봉 */
const yesterdayOpen = Math.floor(NOW / DAY_MS) * DAY_MS - DAY_MS;

export function runDailyBarEvidenceTests() {
  console.log('[일봉 증거 — 일봉이 맞는지 시각으로 확인한다]');

  test('정상 일봉은 통과하고 배열을 돌려준다', () => {
    const v = dailyBarEvidence({ bars: series(60, DAY_MS, yesterdayOpen), nowMs: NOW });
    eq(v.ok, true); eq(v.code, 'OK');
    eq(v.bars!.closes.length, 60);
    assert(v.ageDays! >= 1 && v.ageDays! <= 2, String(v.ageDays));
  });

  test('★★ 1시간봉을 일봉 자리에 넣으면 막는다 (재현된 결함)', () => {
    const v = dailyBarEvidence({ bars: series(200, 3_600_000, NOW - 3_600_000), nowMs: NOW });
    eq(v.ok, false);
    eq(v.code, 'NOT_DAILY');
    eq(v.bars, null, '거짓 일봉인데 배열을 돌려줬습니다');
    assert(/1\.00시간/.test(v.reason), v.reason);
  });

  test('★★ 멈춘 피드(오래된 마지막 봉)를 막는다', () => {
    const v = dailyBarEvidence({ bars: series(60, DAY_MS, yesterdayOpen - 20 * DAY_MS), nowMs: NOW });
    eq(v.ok, false); eq(v.code, 'STALE'); eq(v.bars, null);
    assert(v.ageDays! > 20, String(v.ageDays));
  });

  test('★ 하루가 빠진 series를 막는다', () => {
    const b = series(60, DAY_MS, yesterdayOpen);
    // 가운데 한 봉을 빼면 그 자리 간격이 이틀이 된다.
    b.highs.splice(30, 1); b.lows.splice(30, 1); b.closes.splice(30, 1); b.openTimes.splice(30, 1);
    const v = dailyBarEvidence({ bars: b, nowMs: NOW });
    eq(v.ok, false); eq(v.code, 'GAPPED'); eq(v.bars, null);
  });

  test('★ 표본이 모자라면 막는다 — 중앙값 기준선이 의미가 없다', () => {
    const v = dailyBarEvidence({ bars: series(MIN_DAILY_BARS - 1, DAY_MS, yesterdayOpen), nowMs: NOW });
    eq(v.ok, false); eq(v.code, 'TOO_FEW'); eq(v.bars, null);
    eq(dailyBarEvidence({ bars: series(MIN_DAILY_BARS, DAY_MS, yesterdayOpen), nowMs: NOW }).ok, true);
  });

  test('★ 못 읽은 것을 "없음"으로 바꾸지 않는다', () => {
    for (const bad of [
      null, undefined, {},
      { highs: [1], lows: [1], closes: [1] },                       // 시각 없음
      { highs: [1, 2], lows: [1], closes: [1, 2], openTimes: [1, 2] }, // 길이 어긋남
      { highs: [NaN], lows: [1], closes: [1], openTimes: [1] },
    ]) {
      const v = dailyBarEvidence({ bars: bad as any, nowMs: NOW });
      eq(v.ok, false, JSON.stringify(bad));
      eq(v.code, 'UNREADABLE', JSON.stringify(bad));
      eq(v.bars, null);
    }
  });

  test('★ 판정 시각을 못 읽으면 막는다', () => {
    const v = dailyBarEvidence({ bars: series(60, DAY_MS, yesterdayOpen), nowMs: NaN });
    eq(v.ok, false); eq(v.code, 'UNREADABLE'); eq(v.bars, null);
  });

  test('★ UTC 자정 직후에도 어제 봉은 거짓 STALE이 되지 않는다', () => {
    // 가장 최근 **완성** 일봉은 어제 00:00에 열린 것이라 이미 24시간이
    // 넘는다. 허용치를 좁히면 매일 자정마다 거짓 차단이 난다.
    const justAfterMidnight = Math.floor(NOW / DAY_MS) * DAY_MS + 60_000;
    const v = dailyBarEvidence({
      bars: series(60, DAY_MS, justAfterMidnight - 60_000 - DAY_MS), nowMs: justAfterMidnight,
    });
    eq(v.ok, true, `${v.code} · ${v.reason}`);
    assert(MAX_NEWEST_AGE_DAYS >= 2);
  });

  test('★ 마지막 봉이 미래면 막는다 — 시각을 신뢰할 수 없다', () => {
    const v = dailyBarEvidence({ bars: series(60, DAY_MS, NOW + 3 * DAY_MS), nowMs: NOW });
    eq(v.ok, false); eq(v.code, 'STALE'); eq(v.bars, null);
  });

  test('★ 1분 어긋남은 허용한다 — 반올림 하나로 전체를 거짓으로 만들지 않는다', () => {
    const b = series(60, DAY_MS, yesterdayOpen);
    b.openTimes[40] += 30_000;   // 30초 어긋남
    eq(dailyBarEvidence({ bars: b, nowMs: NOW }).ok, true);
    b.openTimes[40] += 10 * 60_000;  // 10분 어긋남 → 간격이 깨진다
    eq(dailyBarEvidence({ bars: b, nowMs: NOW }).code, 'GAPPED');
  });
}
