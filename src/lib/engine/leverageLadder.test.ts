// src/lib/engine/leverageLadder.test.ts
//
// 실제로 있었던 화면:
//
//   배율 상한 100x · 1회 위험 10% · 손절 1.00%
//   100배 청산거리 0.60%          ← 손절보다 청산이 먼저다
//   "이 손절이면 71배까지가 안전"  ← 화면이 스스로 계산해 놓고
//   그런데 설정은 여전히 100배 허용 ← 막지 않았다
//
//   거래소 실제 5배 · TRAIGO 의도 49배
//
// 막으려는 것:
//  1. 화면이 71배가 한계라고 계산해 놓고 100배를 허용하는 것
//  2. 거래소 배율과 의도가 다른데 주문이 나가는 것
//  3. 청산가를 못 읽었는데 '안전'으로 넘어가는 것
//  4. 모르는 상한을 무한대로 치는 것
//  5. 연구용 100배/10%가 실전으로 그대로 승격되는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  leverageLadder, DEFAULT_SAFETY_BUFFER_PCT,
  venueMatch, stopBeforeLiquidation,
  TIER_LIMITS, tierAllowedIn, withinTier,
} from './leverageLadder';

export function runLeverageLadderTests() {
  console.log('[배율 사다리 — 가장 낮은 것이 이긴다]');

  test('화면이 71배라고 계산했으면 100배를 허용하지 않는다', () => {
    // 이게 실제로 났던 고장이다. 손절 1% · 유지증거금 0.4%면
    // 이론 상한이 100/(1+0.4) = 71배다.
    const r = leverageLadder({ userCap: 100, stopPct: 1 });
    eq(r.blocked, false);
    eq(Math.floor(r.liquidationTheoreticalCap!), 71);
    // 안전 버퍼 20%를 **자르기 전 값(71.43)에** 적용한다 → 57배.
    // 이론값을 먼저 잘라 놓고 곱하면 버퍼가 두 번 들어간다.
    eq(r.liquidationSafeCap, 57);
    eq(r.allowed, 57);
    eq(r.boundBy, '청산안전 최대');
    assert(r.allowed! < 100, '사용자 상한 100배가 그대로 나오면 안 된다');
  });

  test('이론값을 그대로 쓰지 않는다 — 안전 버퍼가 있다', () => {
    // 이론값에 딱 붙이면 정상적인 시장 소음에도 청산된다.
    eq(DEFAULT_SAFETY_BUFFER_PCT, 20);
    const withBuf = leverageLadder({ userCap: 200, stopPct: 1 });
    const noBuf = leverageLadder({ userCap: 200, stopPct: 1, safetyBufferPct: 0 });
    assert(withBuf.allowed! < noBuf.allowed!, `${withBuf.allowed} vs ${noBuf.allowed}`);
    eq(noBuf.allowed, 71);
  });

  test('다섯 상한 중 가장 낮은 것이 최종값이다', () => {
    const r = leverageLadder({
      userCap: 100, strategyCap: 20, venueCap: 125,
      riskEngineLeverage: 49, stopPct: 1,
    });
    eq(r.allowed, 20);
    eq(r.boundBy, '전략 최대');
  });

  test('위험엔진이 가장 낮으면 그것이 이긴다', () => {
    const r = leverageLadder({ userCap: 100, strategyCap: 50, riskEngineLeverage: 8, stopPct: 0.5 });
    eq(r.allowed, 8);
    eq(r.boundBy, '위험엔진 허용');
  });

  test('손절을 모르면 막는다 — 무한대로 치지 않는다', () => {
    // 청산까지 얼마나 남았는지 모르는 채로 주문을 낼 수 없다.
    const r = leverageLadder({ userCap: 100, strategyCap: 20 });
    eq(r.blocked, true);
    eq(r.allowed, null);
    assert(r.blockReason.includes('청산안전 최대'), r.blockReason);
  });

  test('없는 상한과 모르는 상한을 가른다', () => {
    // 전략 상한이 없는 것은 정말로 제한이 없는 것이다 — 그건 막지 않는다.
    const r = leverageLadder({ userCap: 10, stopPct: 0.5 });
    eq(r.blocked, false);
    eq(r.allowed, 10);
    eq(r.rows.find(x => x.id === 'strategy')!.known, false);
    eq(r.rows.find(x => x.id === 'strategy')!.required, false);
  });

  test('어떤 배율도 안전하지 않으면 막는다', () => {
    // 손절이 아주 멀면 1배도 안 되는 상한이 나온다.
    const r = leverageLadder({ userCap: 100, stopPct: 200 });
    eq(r.blocked, true);
    eq(r.allowed, null);
  });

  test('상한을 하나도 못 읽으면 막는다', () => {
    eq(leverageLadder(null).blocked, true);
    eq(leverageLadder({}).blocked, true);
  });

  test('0과 음수는 배율이 아니다', () => {
    const r = leverageLadder({ userCap: 0, strategyCap: -5, stopPct: 0.5 });
    eq(r.rows.find(x => x.id === 'user')!.known, false);
    eq(r.rows.find(x => x.id === 'strategy')!.known, false);
  });

  console.log('[배율 사다리 — 의도와 거래소 실제]');

  test('의도 49배 · 거래소 5배면 주문을 막는다', () => {
    // 이 상태로 주문이 나가면 화면의 손실도 청산거리도 전부 틀린 숫자다.
    const v = venueMatch(49, 5);
    eq(v.ok, false);
    eq(v.code, 'MISMATCH');
    assert(v.reason.includes('49배'), v.reason);
    assert(v.reason.includes('5배'), v.reason);
    assert(v.badge.includes('49x'), v.badge);
  });

  test('거래소 값을 못 읽어도 막는다', () => {
    // 같은지 다른지 모르는 것이고, 그때 통과시키면 확인하지 못한 것을
    // 통과로 세는 것이다.
    for (const bad of [null, undefined, 0, NaN, '']) {
      const v = venueMatch(20, bad);
      eq(v.ok, false, String(bad));
      eq(v.code, 'VENUE_UNKNOWN', String(bad));
    }
  });

  test('낼 배율을 못 정해도 막는다', () => {
    eq(venueMatch(null, 20).code, 'INTENDED_UNKNOWN');
  });

  test('같으면 통과한다', () => {
    const v = venueMatch(20, 20);
    eq(v.ok, true);
    eq(v.code, 'MATCH');
    eq(v.badge, '20x ✓');
  });

  test('소수점 반올림 차이로는 막지 않는다', () => {
    // 거래소는 정수로 돌려준다.
    eq(venueMatch(20.0001, 20).ok, true);
    eq(venueMatch(20.6, 20).ok, false, '0.6 차이는 반올림하면 21과 20이라 다르다');
  });

  console.log('[배율 사다리 — 손절이 청산보다 먼저인가]');

  test('LONG은 청산가 < 손절가 < 진입가여야 한다', () => {
    const ok = stopBeforeLiquidation({ side: 'LONG', entryPrice: 65000, stopPrice: 64350, liquidationPrice: 62000 });
    eq(ok.ok, true);
    eq(ok.code, 'SAFE');
    close(ok.bufferPct!, (64350 - 62000) / 65000 * 100, 1e-9);
  });

  test('LONG에서 청산이 먼저면 차단한다', () => {
    const v = stopBeforeLiquidation({ side: 'LONG', entryPrice: 65000, stopPrice: 64350, liquidationPrice: 64600 });
    eq(v.ok, false);
    eq(v.code, 'LIQUIDATION_FIRST');
    assert(v.reason.includes('증거금이 전액 사라집니다'), v.reason);
  });

  test('SHORT은 방향이 반대다', () => {
    const ok = stopBeforeLiquidation({ side: 'SHORT', entryPrice: 65000, stopPrice: 65650, liquidationPrice: 68000 });
    eq(ok.ok, true);
    const bad = stopBeforeLiquidation({ side: 'SHORT', entryPrice: 65000, stopPrice: 65650, liquidationPrice: 65400 });
    eq(bad.code, 'LIQUIDATION_FIRST');
  });

  test('손절이 진입가 반대편이면 차단한다', () => {
    const v = stopBeforeLiquidation({ side: 'LONG', entryPrice: 65000, stopPrice: 66000, liquidationPrice: 62000 });
    eq(v.code, 'STOP_WRONG_SIDE');
  });

  test('청산가를 못 읽으면 안전이 아니다', () => {
    const v = stopBeforeLiquidation({ side: 'LONG', entryPrice: 65000, stopPrice: 64350 });
    eq(v.ok, false);
    eq(v.code, 'LIQUIDATION_UNKNOWN');
    assert(v.reason.includes('모르는 채로 주문할 수 없습니다'), v.reason);
  });

  test('방향을 모르면 판정하지 않는다', () => {
    eq(stopBeforeLiquidation({ entryPrice: 1, stopPrice: 2, liquidationPrice: 3 }).code, 'INPUT_UNKNOWN');
    eq(stopBeforeLiquidation(null).code, 'INPUT_UNKNOWN');
  });

  console.log('[배율 사다리 — 연구용이 실전으로 승격되면 안 된다]');

  test('스트레스 테스트 등급은 모의에서만 쓴다', () => {
    // 1회 위험 10% · 100배는 매매 설정이 아니라 망가지는 지점을 보는 것이다.
    eq(TIER_LIMITS.STRESS.maxRiskPct, 10);
    eq(TIER_LIMITS.STRESS.maxLeverage, 100);
    eq(tierAllowedIn('STRESS', 'MOCK').ok, true);
    eq(tierAllowedIn('STRESS', 'TESTNET').ok, false);
    eq(tierAllowedIn('STRESS', 'LIVE').ok, false);
  });

  test('연구용은 실전에서 막힌다', () => {
    // 테스트넷에서 잘 돌던 설정을 그대로 올리는 것이 가장 자연스럽고,
    // 그래서 가장 위험하다.
    eq(tierAllowedIn('RESEARCH', 'TESTNET').ok, true);
    const live = tierAllowedIn('RESEARCH', 'LIVE');
    eq(live.ok, false);
    eq(live.suggested, 'AGGRESSIVE', '실전에서 쓸 수 있는 것 중 가장 가까운 것을 권한다');
  });

  test('안정화는 어디서나 쓸 수 있다', () => {
    for (const e of ['MOCK', 'TESTNET', 'LIVE']) {
      eq(tierAllowedIn('STABILIZE', e).ok, true, e);
    }
    assert(TIER_LIMITS.STABILIZE.maxRiskPct <= 0.5, String(TIER_LIMITS.STABILIZE.maxRiskPct));
  });

  test('모르는 등급은 안정화로 다룬다', () => {
    const v = tierAllowedIn('아무거나', 'LIVE');
    eq(v.ok, false);
    eq(v.suggested, 'STABILIZE');
  });

  test('환경을 모르면 통과시키지 않는다', () => {
    eq(tierAllowedIn('STABILIZE', null).ok, false);
  });

  console.log('[배율 사다리 — 등급을 골랐다고 끝이 아니다]');

  test('안정화를 골라 놓고 위험 10%를 넣으면 막는다', () => {
    const v = withinTier('STABILIZE', 10, 5);
    eq(v.ok, false);
    assert(v.reason.includes('1회 위험 10%'), v.reason);
  });

  test('배율도 같이 본다', () => {
    const v = withinTier('STABILIZE', 0.5, 100);
    eq(v.ok, false);
    assert(v.reason.includes('배율 100배'), v.reason);
  });

  test('둘 다 넘으면 둘 다 적는다', () => {
    const v = withinTier('STABILIZE', 10, 100);
    assert(v.reason.includes('1회 위험'), v.reason);
    assert(v.reason.includes('배율'), v.reason);
  });

  test('모르는 값을 통과시키지 않는다', () => {
    eq(withinTier('STABILIZE', null, 5).ok, false);
    eq(withinTier('STABILIZE', 0.5, null).ok, false);
  });

  test('상한 안이면 통과한다', () => {
    const v = withinTier('STABILIZE', 0.5, 20);
    eq(v.ok, true);
    eq(v.reason, '');
  });
}
