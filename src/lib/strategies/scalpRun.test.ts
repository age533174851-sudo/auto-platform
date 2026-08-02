// src/lib/strategies/scalpRun.test.ts
//
// 단타를 주문 경로에 붙일 때 틀리기 쉬운 것들:
//  1. 거래소가 모르는 봉 주기를 보내는 것
//  2. 손절이 진입가와 같은 편에 있는 것 (riskManager가 음수 거리를 읽는다)
//  3. 재진입 간격을 안 보고 매 분 들어가는 것
//
// 3번이 가장 비싸다. 조건이 맞는 동안 계속 진입하면 수수료만으로 계좌가
// 녹는다. 그리고 그건 '버그'처럼 보이지 않고 '전략이 나쁜 것'처럼 보인다.

import { test, eq, assert } from '../../test/harness';
import {
  klineInterval, toStandardSignal, reentryCheck, barsNeeded, SUPPORTED_INTERVALS,
} from './scalpRun';
import type { ScalpSignal } from './scalpSignal';

const sig = (o: Partial<ScalpSignal> = {}): ScalpSignal => ({
  side: 'LONG', entry: 100, stop: 99, target: 102,
  stopPct: 1, targetPct: 2, atr: 1, notes: [], ...o,
});

export function runScalpRunTests() {
  console.log('[단타 실행 — 거래소가 모르는 값을 보내지 않는다]');

  // ── 봉 주기 ──────────────────────────────────────────
  test('지원하는 주기는 문자열로 바뀐다', () => {
    eq(klineInterval(1), '1m');
    eq(klineInterval(15), '15m');
    eq(klineInterval(60), '1h');
    eq(klineInterval(240), '4h');
    eq(klineInterval(1440), '1d');
  });

  // '7m'을 만들어 보내면 거래소가 400을 준다. 그 시점에는 이미 사용자가
  // 7분을 골라 저장한 뒤라 왜 안 도는지 알기 어렵다.
  test('지원하지 않는 주기는 null — 만들어내지 않는다', () => {
    eq(klineInterval(7), null);
    eq(klineInterval(45), null);
    eq(klineInterval(0), null);
    eq(klineInterval(-5), null);
    eq(klineInterval(NaN), null);
  });

  test('목록에 있는 값은 전부 변환된다', () => {
    for (const m of SUPPORTED_INTERVALS) {
      assert(klineInterval(m) != null, `${m}분이 목록에 있는데 변환이 안 된다`);
    }
  });

  // ── StandardSignal 변환 ──────────────────────────────
  test('LONG 신호가 그대로 넘어간다', () => {
    const s = toStandardSignal(sig(), 'btcusdt', 60);
    assert(s != null, '변환 실패');
    eq(s!.signal, 'LONG');
    eq(s!.symbol, 'BTCUSDT');
    eq(s!.timeframe, '1h');
    eq(s!.entryPrice, 100);
    eq(s!.stopLoss, 99);
  });

  test('SHORT는 손절이 위에 있어야 통과한다', () => {
    const good = toStandardSignal(sig({ side: 'SHORT', stop: 101, target: 98 }), 'BTCUSDT', 60);
    assert(good != null, '정상 숏이 막혔다');
    eq(good!.signal, 'SHORT');
  });

  // 손절이 뒤집히면 riskManager가 손절 거리를 음수로 읽고, 그 뒤 계산이
  // 전부 무의미해진다. 여기서 막는다.
  test('손절이 진입가와 같은 편이면 거부한다', () => {
    eq(toStandardSignal(sig({ side: 'LONG', stop: 101 }), 'BTCUSDT', 60), null, '롱인데 손절이 위인데 통과했다');
    eq(toStandardSignal(sig({ side: 'SHORT', stop: 99 }), 'BTCUSDT', 60), null, '숏인데 손절이 아래인데 통과했다');
  });

  test('지원하지 않는 주기면 신호를 안 만든다', () => {
    eq(toStandardSignal(sig(), 'BTCUSDT', 7), null);
  });

  test('값이 숫자가 아니면 거부한다', () => {
    eq(toStandardSignal(sig({ entry: NaN }), 'BTCUSDT', 60), null);
    eq(toStandardSignal(sig({ stop: NaN }), 'BTCUSDT', 60), null);
  });

  // **주기가 짧을수록 위험을 줄인다.** 짧은 봉일수록 신호가 잦고, 같은
  // 위험을 걸면 하루 손실이 몇 배가 된다.
  test('15분 이하는 초단타, 그 위는 단타로 분류한다', () => {
    eq(toStandardSignal(sig(), 'BTCUSDT', 5)!.bucket, 'scalping');
    eq(toStandardSignal(sig(), 'BTCUSDT', 15)!.bucket, 'scalping');
    eq(toStandardSignal(sig(), 'BTCUSDT', 30)!.bucket, 'daytrading');
    eq(toStandardSignal(sig(), 'BTCUSDT', 240)!.bucket, 'daytrading');
  });

  // 이 모듈은 시계를 읽지 않는다 — 그래야 테스트가 시간에 안 흔들린다.
  test('시각은 호출자가 채운다', () => {
    eq(toStandardSignal(sig(), 'BTCUSDT', 60)!.timestamp, 0);
  });

  // ── **재진입 간격** ──────────────────────────────────
  //
  // 조건이 맞는 동안 매 분 진입하면 수수료만으로 계좌가 녹는다. 그리고
  // 그건 버그처럼 보이지 않고 '전략이 나쁜 것'처럼 보인다.
  test('한 번도 안 돌았으면 통과한다', () => {
    const r = reentryCheck(null, 1_000_000, 60);
    eq(r.allowed, true);
  });

  test('간격이 안 됐으면 막고 남은 시간을 알려준다', () => {
    const now = 1_000_000_000;
    const r = reentryCheck(now - 10 * 60_000, now, 60);
    eq(r.allowed, false);
    eq(r.waitMin, 50);
    assert(r.reason.includes('50분'), r.reason);
  });

  test('간격이 지났으면 통과한다', () => {
    const now = 1_000_000_000;
    eq(reentryCheck(now - 61 * 60_000, now, 60).allowed, true);
    eq(reentryCheck(now - 60 * 60_000, now, 60).allowed, true, '정확히 간격만큼 지나면 통과다');
  });

  // **못 읽은 것은 통과가 아니다.** 언제 마지막으로 냈는지 모르는 채로
  // 또 내면 중복 진입이 된다.
  test('마지막 실행 시각을 못 읽으면 막는다 — 0으로 읽지 않는다', () => {
    const r = reentryCheck(NaN, 1_000_000_000, 60);
    eq(r.allowed, false);
    assert(r.reason.includes('읽지 못'), r.reason);
  });

  test('마지막 실행이 미래면 막는다', () => {
    const now = 1_000_000_000;
    const r = reentryCheck(now + 60_000, now, 60);
    eq(r.allowed, false);
    assert(r.reason.includes('미래'), r.reason);
  });

  test('1분 간격도 간격이다 — 같은 분에 두 번 안 낸다', () => {
    const now = 1_000_000_000;
    eq(reentryCheck(now - 30_000, now, 1).allowed, false, '30초 만에 또 냈다');
    eq(reentryCheck(now - 61_000, now, 1).allowed, true);
  });

  // ── 봉 개수 ──────────────────────────────────────────
  test('필요한 봉은 기준선보다 넉넉하다', () => {
    assert(barsNeeded(20, 14) > 20 + 2, '돌파 기준선을 만들 여유가 없다');
    assert(barsNeeded(5, 50) > 50, 'ATR 기간이 더 길 때도 충분해야 한다');
  });
}
