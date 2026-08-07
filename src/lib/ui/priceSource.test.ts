// src/lib/ui/priceSource.test.ts
//
// 막으려는 것:
//  1. **실시간 시세가 끊겼는데 조용히 가상 가격으로 이어가는 것.**
//     사용자는 실제 시장으로 검증하고 있다고 믿는데 ±0.2% 난수를
//     보고 있다. 그 승률은 아무 뜻이 없고 화면에는 한 글자도 안 뜬다
//  2. '실제 시세'라는 말이 실제 주문으로 읽히는 것
//  3. 실시간을 골랐다고 MOCK 배지가 사라지는 것 — 가격이 진짜여도
//     주문은 여전히 가짜다
import { test, assert, eq } from '../../test/harness';
import {
  feedStatusOf, sourceBadge, sourceOf, SOURCE_LABEL, SOURCE_DESC, SOURCE_SUMMARY,
} from './priceSource';

export function runPriceSourceTests() {
  console.log('[시세 소스 — 끊기면 멈춘다]');

  test('실시간을 골랐는데 못 읽으면 매매를 멈춘다', () => {
    // 자동 전환은 사용자가 고른 것과 다른 것을 돌리는 일이다.
    const v = feedStatusOf('LIVE_MARKET', null);
    eq(v.status, 'DISCONNECTED');
    eq(v.canTrade, false);
    assert(v.reason.includes('가상 가격으로 바꾸지 않고'), v.reason);
    assert(v.reason.includes('난수로 만든 승률'), v.reason);
  });

  test('0이나 음수도 못 읽은 것이다', () => {
    eq(feedStatusOf('LIVE_MARKET', 0).canTrade, false);
    eq(feedStatusOf('LIVE_MARKET', -1).canTrade, false);
    eq(feedStatusOf('LIVE_MARKET', NaN).canTrade, false);
  });

  test('값이 있으면 진행한다', () => {
    const v = feedStatusOf('LIVE_MARKET', 65000);
    eq(v.status, 'OK');
    eq(v.canTrade, true);
  });

  test('가상 시세는 끊길 것이 없다', () => {
    // 바깥을 안 보므로 연결이라는 개념이 없다.
    eq(feedStatusOf('SIMULATED', 65000).status, 'OK');
    // 다만 시작 가격을 아직 못 만든 상태는 있다.
    eq(feedStatusOf('SIMULATED', null).status, 'PENDING');
    eq(feedStatusOf('SIMULATED', null).canTrade, false);
  });

  console.log('[시세 소스 — 말이 오해를 만들지 않게]');

  test("'실제 시세'라고 쓰지 않는다", () => {
    // 그 말은 실제 주문으로 읽힌다.
    eq(SOURCE_LABEL.LIVE_MARKET, '실시간 시장 시세');
    eq(SOURCE_LABEL.SIMULATED, '가상 시세');
    assert(!SOURCE_LABEL.LIVE_MARKET.startsWith('실제'), SOURCE_LABEL.LIVE_MARKET);
  });

  test('실시간을 골라도 MOCK 표시가 안 사라진다', () => {
    // 가격이 진짜라고 주문까지 진짜인 것이 아니다.
    assert(sourceBadge('LIVE_MARKET').includes('MOCK'), sourceBadge('LIVE_MARKET'));
    assert(sourceBadge('SIMULATED').includes('MOCK'), sourceBadge('SIMULATED'));
  });

  test('설명이 주문은 안 나간다는 것을 말한다', () => {
    assert(SOURCE_DESC.LIVE_MARKET.includes('거래소로 나가지'), SOURCE_DESC.LIVE_MARKET);
    assert(SOURCE_DESC.SIMULATED.includes('무관한'), SOURCE_DESC.SIMULATED);
  });

  test('선택 아래에 늘 붙는 한 줄이 있다', () => {
    for (const k of ['SIMULATED', 'LIVE_MARKET'] as const) {
      assert(SOURCE_SUMMARY[k].length > 0, k);
    }
    assert(SOURCE_SUMMARY.LIVE_MARKET.includes('MOCK'), SOURCE_SUMMARY.LIVE_MARKET);
  });

  console.log('[시세 소스 — 모르는 값]');

  test('모르는 값은 가상으로 — 실제 쪽으로 기울지 않는다', () => {
    eq(sourceOf(null), 'SIMULATED');
    eq(sourceOf('아무거나'), 'SIMULATED');
    eq(sourceOf(''), 'SIMULATED');
    eq(sourceOf('live_market'), 'LIVE_MARKET', '대소문자는 가리지 않는다');
  });
}
