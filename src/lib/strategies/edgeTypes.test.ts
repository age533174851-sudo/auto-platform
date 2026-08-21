// src/lib/strategies/edgeTypes.test.ts
//
// **"우위 +10%p를 켜면 돈을 벌고 끄면 청산이 쏟아진다"**는 관찰은 맞다.
// 다만 그건 전략의 성질이 아니라 산수의 성질이다 — 승률을 올려 넣었으니
// 결과가 좋아지는 게 당연하다.
//
// 이 시험이 지키는 것: **증거가 없으면 "검증된 우위 없음"이라고 적는다.**

import { test, eq, assert } from '../../test/harness';
import {
  assumedEdge, measuredEdgeOf, edgeDisplay, MIN_TRADES, MIN_OOS_TRADES,
} from './edgeTypes';

const good = { trades: 300, wins: 150, expectancyAfterCost: 0.012, oosTrades: 90 };

export function runEdgeTypesTests() {
  console.log('[우위 — 가정한 것과 잰 것을 섞지 않는다]');

  test('가정값은 그냥 숫자를 감싼 것이다', () => {
    eq(assumedEdge(10) as number, 10);
    eq(assumedEdge(NaN as any) as number, 0);
  });

  test('충분한 표본 + 비용 차감 후 양수면 잰 값이 나온다', () => {
    const m = measuredEdgeOf(good);
    eq(m.code, 'MEASURED');
    eq(m.winRate, 0.5);
  });

  test('**표본이 적으면 우위를 쟀다고 말하지 않는다**', () => {
    // 20번 이겨서 나온 60% 승률은 우연과 구분되지 않는다.
    const m = measuredEdgeOf({ ...good, trades: MIN_TRADES - 1, wins: 30 });
    eq(m.code, 'NOT_ENOUGH_SAMPLE');
    eq(m.edge, null);
  });

  test('**표본 밖 거래가 없으면 과최적화와 구분되지 않는다**', () => {
    const m = measuredEdgeOf({ ...good, oosTrades: MIN_OOS_TRADES - 1 });
    eq(m.code, 'NO_OOS');
    eq(m.edge, null);
    assert(/과최적화/.test(m.reason), m.reason);
  });

  test('**비용을 뺀 뒤가 아니면 우위가 아니다**', () => {
    // 100배로 자주 들어가면 수수료가 손익보다 커지는 구간이 있다.
    const m = measuredEdgeOf({ ...good, expectancyAfterCost: 0 });
    eq(m.code, 'NEGATIVE_AFTER_COST');
    eq(m.edge, null);
  });

  test('읽지 못한 것을 0으로 적지 않는다', () => {
    eq(measuredEdgeOf(null).code, 'UNKNOWN');
    eq(measuredEdgeOf({ trades: null, wins: null, expectancyAfterCost: null }).code, 'UNKNOWN');
  });

  // ── 화면 ──

  test('**증거가 없으면 "검증된 우위 없음"이다**', () => {
    const d = edgeDisplay(measuredEdgeOf({ ...good, trades: 10, wins: 6 }));
    eq(d.label, '검증된 우위 없음');
    eq(d.isEvidence, false);
    // 왜 못 쟀는지는 말한다
    assert(d.detail.length > 0, d.detail);
  });

  test('아무것도 안 주면 그것도 "검증된 우위 없음"이다', () => {
    eq(edgeDisplay(null).label, '검증된 우위 없음');
    eq(edgeDisplay(null).isEvidence, false);
  });

  test('잰 값이 있을 때만 숫자를 적는다', () => {
    const d = edgeDisplay(measuredEdgeOf(good));
    eq(d.isEvidence, true);
    assert(/측정된 승률/.test(d.label), d.label);
    // **가정이라는 말이 붙지 않는다** — 이건 실제로 잰 값이다
    assert(!/가정/.test(d.label), d.label);
  });

  test('가정값은 화면 라벨로 새 나가지 않는다', () => {
    // edgeDisplay는 MeasuredEdgeResult만 받는다. 가정값을 넣을 자리가 없다.
    const d = edgeDisplay(measuredEdgeOf({ ...good, expectancyAfterCost: -1 }));
    assert(!/%p/.test(d.label), d.label);
  });
}
