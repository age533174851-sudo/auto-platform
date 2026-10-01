// src/lib/engine/liquidationDistance.test.ts
//
// **청산당할 자리를 모른 채 들어가지 않는다.**
//
// 이 파일은 판정 하나만 시험한다. "손절이 청산보다 먼저인가"는 여기 없다 —
// `NO_FIXED_SL`에는 손절이 없고, 그 질문은 다른 판정(leverageLadder ·
// preTradeChecklist)의 일이다. 두 곳에서 같은 것을 시험하면 한쪽만
// 고쳐지고 그때 두 답이 갈린다.
//
// ★ 이것은 **진입 전 보호**다. 열린 포지션을 닫는 권한이 아니다.
import { test, eq, assert, close } from '../../test/harness';
import {
  assessLiquidationDistance, tierFromBrackets,
  type LiquidationDistanceInput,
} from './liquidationDistance';

/** 거래소 브래킷 첫 구간(소액): MMR 0.4% · 공제액 0 */
const TIER = { mmr: 0.004, maintAmount: 0, source: 'EXCHANGE_BRACKET' as const, notional: 10_000 };

/** 통과하는 입력 한 벌. 시험마다 한 칸씩만 바꾼다 */
const ok = (over: Partial<LiquidationDistanceInput> = {}): LiquidationDistanceInput => ({
  side: 'LONG',
  referencePrice: 50_000,
  quantity: 0.2,            // 명목가 10,000 · 증거금 100 · 100배
  leverage: 100,
  marginMode: 'isolated',
  tier: TIER,
  adverseDistancePct: 0.3,
  ...over,
});

export function runLiquidationDistanceTests() {
  console.log('\n💥 청산거리 — 진입 전 보호 (pre-entry, 종료 권한이 아니다)');

  // ── 통과 경로 ──

  test('정상 입력은 통과하고 청산가·거리를 모두 적는다', () => {
    const v = assessLiquidationDistance(ok());
    eq(v.ok, true, `★ 정상 100배 진입이 막혔다 — ${v.reason}`);
    eq(v.code, 'OK');
    eq(v.trustworthy, true);
    // 100배 · MMR 0.4% → 약 0.6%. leverageMath 머리말의 손계산과 같은 자리다.
    close(v.liquidationDistancePct as number, 0.6024, 1e-3, '청산거리 %');
    close(v.estimatedLiquidationPrice as number, 49_698.795, 1e-2, '청산가');
    eq(v.headroomKind, 'RAW', '★ 비용 반영 전 값이라는 표시가 없다');
  });

  test('LONG 청산가는 기준가 아래, SHORT는 위다', () => {
    const l = assessLiquidationDistance(ok({ side: 'LONG' }));
    const s = assessLiquidationDistance(ok({ side: 'SHORT' }));
    assert((l.estimatedLiquidationPrice as number) < 50_000, '★ LONG 청산가가 기준가 위에 있다');
    assert((s.estimatedLiquidationPrice as number) > 50_000, '★ SHORT 청산가가 기준가 아래에 있다');
    // 거리는 **둘 다 양수**다. 부호로 방향을 표현하지 않는다 —
    // 의미는 "불리한 방향으로 남은 거리" 하나다.
    assert((l.liquidationDistance as number) > 0, 'LONG 거리가 양수가 아니다');
    assert((s.liquidationDistance as number) > 0, 'SHORT 거리가 양수가 아니다');
  });

  test('LONG과 SHORT는 거울상이 아니다 — 거래소 식이 비대칭이다', () => {
    const l = assessLiquidationDistance(ok({ side: 'LONG' })).liquidationDistancePct as number;
    const s = assessLiquidationDistance(ok({ side: 'SHORT' })).liquidationDistancePct as number;
    // (1−mmr)로 나누는 쪽과 (1+mmr)로 나누는 쪽이라 값이 다르다.
    // 같은 값이 나오면 한쪽 식을 다른 쪽에 쓰고 있다는 뜻이다.
    assert(Math.abs(l - s) > 1e-4, `★ LONG(${l})과 SHORT(${s})가 같다 — 한쪽 식을 복사했다`);
    close(s, 0.5976, 1e-3, 'SHORT 청산거리 %');
  });

  // ── 입력을 믿을 수 없으면 거부 (fail-closed) ──

  for (const [why, over, code] of [
    ['방향 없음', { side: null }, 'SIDE_UNKNOWN'],
    ['방향이 이상함', { side: 'UP' as any }, 'SIDE_UNKNOWN'],
    ['기준가 0', { referencePrice: 0 }, 'REFERENCE_PRICE_UNUSABLE'],
    ['기준가 음수', { referencePrice: -1 }, 'REFERENCE_PRICE_UNUSABLE'],
    ['기준가 NaN', { referencePrice: NaN }, 'REFERENCE_PRICE_UNUSABLE'],
    ['기준가 Infinity', { referencePrice: Infinity }, 'REFERENCE_PRICE_UNUSABLE'],
    ['기준가 없음', { referencePrice: null }, 'REFERENCE_PRICE_UNUSABLE'],
    ['수량 0', { quantity: 0 }, 'QUANTITY_UNUSABLE'],
    ['수량 없음', { quantity: null }, 'QUANTITY_UNUSABLE'],
    ['수량 NaN', { quantity: NaN }, 'QUANTITY_UNUSABLE'],
    ['배율 1', { leverage: 1 }, 'LEVERAGE_UNUSABLE'],
    ['배율 없음', { leverage: null }, 'LEVERAGE_UNUSABLE'],
    ['배율 Infinity', { leverage: Infinity }, 'LEVERAGE_UNUSABLE'],
    ['마진 모드 없음', { marginMode: null }, 'MARGIN_MODE_UNKNOWN'],
    ['마진 모드가 교차', { marginMode: 'cross' as const }, 'MARGIN_MODE_UNSUPPORTED'],
    ['브래킷 없음', { tier: null }, 'MAINTENANCE_TIER_MISSING'],
  ] as const) {
    test(`${why} → 거부한다`, () => {
      const v = assessLiquidationDistance(ok(over as any));
      eq(v.ok, false, `★ ${why}인데 통과했다`);
      eq(v.code, code, `${why}의 사유`);
      assert(v.reason.length > 0, '거부에는 사유가 있어야 한다');
    });
  }

  test('추정 출처의 구간은 받지 않는다 — 추정 표로 100배를 정하지 않는다', () => {
    const v = assessLiquidationDistance(ok({
      tier: { mmr: 0.004, maintAmount: 0, source: 'GUESS' as any, notional: 10_000 },
    }));
    eq(v.ok, false, '★ 추정 구간으로 100배 청산가를 계산했다');
    eq(v.code, 'MAINTENANCE_TIER_MISSING');
  });

  test('MMR이 1 이상이면 거부한다 — 비율이 아니라 퍼센트를 넣은 경우다', () => {
    // 0.4(=40%)와 0.004(=0.4%)를 헷갈리면 청산가가 통째로 달라진다.
    const v = assessLiquidationDistance(ok({
      tier: { ...TIER, mmr: 1 },
    }));
    eq(v.ok, false);
    eq(v.code, 'MAINTENANCE_TIER_MISSING');
  });

  test('계산이 안 되면 0을 청산가로 적지 않는다', () => {
    // 공제액이 명목가를 통째로 먹으면 식이 0 이하를 낸다.
    const v = assessLiquidationDistance(ok({
      tier: { ...TIER, maintAmount: 1_000_000 },
    }));
    eq(v.ok, false, '★ 계산 못 한 청산가로 통과했다');
    eq(v.code, 'LIQUIDATION_PRICE_UNCOMPUTABLE');
    eq(v.estimatedLiquidationPrice, null, '★ 0을 청산가로 적었다 — 거리가 100%가 된다');
  });

  // ── 계산은 됐는데 여유가 모자람 ──

  test('변동성 위험 거리를 모르면 거부하되, 청산거리는 신뢰한다고 말한다', () => {
    const v = assessLiquidationDistance(ok({ adverseDistancePct: null }));
    eq(v.ok, false, '★ 비교 기준 없이 통과했다');
    eq(v.code, 'ADVERSE_DISTANCE_UNKNOWN');
    // 계산 자체는 됐다 — 운영자가 "무엇이 없는지"를 구별할 수 있어야 한다.
    eq(v.trustworthy, true, '★ 계산 실패와 기준 없음이 구별되지 않는다');
    assert(v.liquidationDistancePct != null, '★ 계산한 거리를 버렸다');
  });

  test('평소 움직임이 청산을 넘으면 거부한다', () => {
    const v = assessLiquidationDistance(ok({ adverseDistancePct: 1.0 }));
    eq(v.ok, false, '★ 변동성이 청산을 넘는데 진입했다');
    eq(v.code, 'ADVERSE_REACHES_LIQUIDATION');
    eq(v.trustworthy, true);
    eq(v.adverseDistancePct, 1.0, '비교에 쓴 값을 남겨야 한다');
  });

  test('경계: 정확히 같으면 거부다 (> 이지 >= 가 아니다)', () => {
    const d = assessLiquidationDistance(ok()).liquidationDistancePct as number;
    // 딱 닿는 것은 여유가 아니다.
    const same = assessLiquidationDistance(ok({ adverseDistancePct: d }));
    eq(same.ok, false, '★ 예상 움직임이 정확히 청산에 닿는데 통과했다');
    eq(same.code, 'ADVERSE_REACHES_LIQUIDATION');
    // 아주 조금만 작으면 통과한다 — 경계가 실제로 그 자리에 있다는 증거다.
    const under = assessLiquidationDistance(ok({ adverseDistancePct: d - 1e-6 }));
    eq(under.ok, true, `★ 경계 바로 안쪽이 막혔다 — ${under.reason}`);
  });

  test('입력이 아예 없으면 거부한다', () => {
    eq(assessLiquidationDistance(null).ok, false);
    eq(assessLiquidationDistance(undefined).ok, false);
    eq(assessLiquidationDistance({} as any).ok, false);
  });

  // ── 구간 고르기 ──

  test('명목가로 브래킷 구간을 고른다', () => {
    const tiers: Array<[number, number, number]> = [
      [50_000, 0.004, 0], [500_000, 0.005, 50], [1_000_000, 0.01, 2_550],
    ];
    eq(tierFromBrackets(10_000, tiers)!.mmr, 0.004);
    eq(tierFromBrackets(100_000, tiers)!.mmr, 0.005);
    eq(tierFromBrackets(100_000, tiers)!.maintAmount, 50);
    // 마지막 구간을 넘으면 마지막 구간을 쓴다 (거래소도 그렇다)
    eq(tierFromBrackets(9_000_000, tiers)!.mmr, 0.01);
  });

  test('브래킷이 없으면 구간도 없다 — 추정 표로 떨어지지 않는다', () => {
    eq(tierFromBrackets(10_000, null), null);
    eq(tierFromBrackets(10_000, []), null);
    eq(tierFromBrackets(0, [[50_000, 0.004, 0]]), null);
    eq(tierFromBrackets(null, [[50_000, 0.004, 0]]), null);
  });

  test('고른 구간은 출처를 거래소로 적는다', () => {
    const t = tierFromBrackets(10_000, [[50_000, 0.004, 0]])!;
    eq(t.source, 'EXCHANGE_BRACKET');
    eq(t.notional, 10_000);
  });
}
