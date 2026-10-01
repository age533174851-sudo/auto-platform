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
import { assessLiquidationDistance, type LiquidationDistanceInput } from './liquidationDistance';
import { solveLiquidationPrice, type BracketTier } from '../safety/liquidationPrice';

/** 바이낸스 BTCUSDT 대표 구간 — `[상한, MMR, 공제액]` */
const BRACKETS: BracketTier[] = [
  [50_000, 0.004, 0], [500_000, 0.005, 50], [1_000_000, 0.010, 2_550],
];

/** 통과하는 입력 한 벌. 시험마다 한 칸씩만 바꾼다 */
const ok = (over: Partial<LiquidationDistanceInput> = {}): LiquidationDistanceInput => ({
  side: 'LONG',
  referencePrice: 50_000,
  quantity: 0.2,            // 명목가 10,000 · 증거금 100 · 100배
  leverage: 100,
  marginMode: 'isolated',
  brackets: BRACKETS,
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
    ['브래킷 없음', { brackets: null }, 'MAINTENANCE_TIER_MISSING'],
    ['브래킷이 빈 표', { brackets: [] }, 'MAINTENANCE_TIER_MISSING'],
  ] as const) {
    test(`${why} → 거부한다`, () => {
      const v = assessLiquidationDistance(ok(over as any));
      eq(v.ok, false, `★ ${why}인데 통과했다`);
      eq(v.code, code, `${why}의 사유`);
      assert(v.reason.length > 0, '거부에는 사유가 있어야 한다');
    });
  }

  test('MMR이 1 이상이면 거부한다 — 비율이 아니라 퍼센트를 넣은 경우다', () => {
    // 0.4(=40%)와 0.004(=0.4%)를 헷갈리면 청산가가 통째로 달라진다.
    const v = assessLiquidationDistance(ok({ brackets: [[Infinity, 1, 0]] }));
    eq(v.ok, false);
    eq(v.code, 'MAINTENANCE_TIER_MISSING');
  });

  test('구간에 쓸 수 없는 값이 있으면 거부한다', () => {
    eq(assessLiquidationDistance(ok({ brackets: [[NaN, 0.004, 0]] })).code,
      'MAINTENANCE_TIER_MISSING');
    eq(assessLiquidationDistance(ok({ brackets: [[Infinity, 0.004, -1]] })).code,
      'MAINTENANCE_TIER_MISSING');
  });

  test('계정별 브래킷 조정 배수(notionalCoef)가 걸려 있으면 막는다', () => {
    // 적용 방식을 확인하지 못했다. **추측해서 곱하지 않고 막는다.**
    const v = assessLiquidationDistance(ok({ brackets: [[Infinity, 0.004, 0, 1.5]] }));
    eq(v.ok, false, '★ 모르는 브래킷 조정이 걸린 계정에서 청산가를 아는 척했다');
    eq(v.code, 'BRACKET_COEF_UNSUPPORTED');
  });

  test('조정 배수가 1이거나 없으면 그대로 간다 — 기존 응답을 막지 않는다', () => {
    eq(assessLiquidationDistance(ok({ brackets: [[Infinity, 0.004, 0, 1]] })).ok, true);
    eq(assessLiquidationDistance(ok({ brackets: [[Infinity, 0.004, 0]] })).ok, true);
  });

  test('계산이 안 되면 0을 청산가로 적지 않는다', () => {
    // 공제액이 명목가를 통째로 먹으면 식이 0 이하를 낸다.
    const v = assessLiquidationDistance(ok({ brackets: [[Infinity, 0.004, 1_000_000]] }));
    eq(v.ok, false, '★ 계산 못 한 청산가로 통과했다');
    assert(v.code === 'LIQUIDATION_PRICE_UNCOMPUTABLE' || v.code === 'TIER_NOT_SELF_CONSISTENT',
      `사유가 ${v.code}다`);
    eq(v.estimatedLiquidationPrice, null, '★ 0을 청산가로 적었다 — 거리가 100%가 된다');
  });

  // ── 구간 자기일관성 (②A) ──
  //
  // **한 번 고른 구간으로 끝내면 틀린다.** 100배에서는 청산까지 0.x%만
  // 움직이면 되므로, 진입 명목가가 구간 경계 근처면 그 사이에 경계를
  // 넘는다. 넘었는데 처음 구간으로 계산하면 청산거리가 실제보다 **멀게**
  // 나온다 — 틀리는 방향이 낙관적이다.

  test('LONG: 청산가가 아래 구간으로 넘어가면 그 구간으로 다시 계산한다', () => {
    // 진입 명목가 50,100 → 2구간. 청산가(≈49,699)에서 명목가 49,798 → 1구간.
    const v = assessLiquidationDistance(ok({ side: 'LONG', quantity: 1.002 }));
    eq(v.ok, true, `★ 경계를 넘는 정상 케이스가 막혔다 — ${v.reason}`);
    eq(v.entryTierIndex, 1, '진입 명목가는 2구간이어야 한다');
    eq(v.tier!.index, 0, '★ 청산가에서의 구간으로 다시 계산하지 않았다');
    eq(v.tier!.mmr, 0.004, '★ 최초 구간의 MMR을 그대로 썼다');
    eq(v.tier!.maintAmount, 0, '★ 최초 구간의 공제액을 그대로 썼다');
    // 자기일관: 청산가에서의 명목가가 **그 구간 안**이다.
    assert(v.tier!.notional <= 50_000, '★ 고른 구간과 청산 명목가가 어긋난다');
    close(v.estimatedLiquidationPrice as number, 49_698.795, 1e-2, '청산가');
  });

  test('SHORT: 청산가가 위 구간으로 넘어가면 그 구간으로 다시 계산한다', () => {
    // 진입 명목가 499,500 → 2구간. 청산가(≈50,253)에서 명목가 502,025 → 3구간.
    const v = assessLiquidationDistance(ok({ side: 'SHORT', quantity: 9.99 }));
    eq(v.ok, true, `★ 경계를 넘는 정상 케이스가 막혔다 — ${v.reason}`);
    eq(v.entryTierIndex, 1, '진입 명목가는 2구간이어야 한다');
    eq(v.tier!.index, 2, '★ 청산가에서의 구간으로 다시 계산하지 않았다');
    eq(v.tier!.mmr, 0.010);
    eq(v.tier!.maintAmount, 2_550);
    assert(v.tier!.notional > 500_000, '★ 고른 구간과 청산 명목가가 어긋난다');
    close(v.estimatedLiquidationPrice as number, 50_252.728, 1e-2, '청산가');
  });

  test('경계를 넘으면 예전 계산보다 청산거리가 **짧게** 나온다', () => {
    // 예전(진입 구간 고정)은 더 멀게 적었다 = 낙관적. 이 방향이 중요하다.
    const q = 1.002;
    const nowPct = assessLiquidationDistance(ok({ side: 'LONG', quantity: q }))
      .liquidationDistancePct as number;
    // 진입 구간(2구간)으로 고정했을 때의 옛 값
    const oldLp = (50_000 * (1 - 1 / 100) - 50 / q) / (1 - 0.005);
    const oldPct = (50_000 - oldLp) / 50_000 * 100;
    assert(nowPct < oldPct,
      `★ 고친 값(${nowPct})이 옛 값(${oldPct})보다 멀다 — 낙관적인 방향으로 틀렸다`);
  });

  test('구간 한가운데는 넘지 않는다 — 과도 수정이 아니다', () => {
    const v = assessLiquidationDistance(ok({ quantity: 0.2 }));
    eq(v.ok, true);
    eq(v.entryTierIndex, 0);
    eq(v.tier!.index, 0, '★ 넘지 않아야 하는데 구간이 바뀌었다');
  });

  test('자기일관 해가 없으면 거부한다 — 진입 구간으로 답을 지어내지 않는다', () => {
    // **두 구간이 서로를 가리킨다.** 1구간으로 풀면 청산가가 2구간에,
    // 2구간으로 풀면 1구간에 떨어진다.
    //
    //   1구간(상한 99 · cum 0)   → 청산가 99.398 → 명목가 99.398 → 2구간
    //   2구간(상한 ∞  · cum 1)   → 청산가 98.394 → 명목가 98.394 → 1구간
    //
    // ★ 퇴화한 표(청산가가 0 이하가 되는)로 시험하면 안 된다. 그러면
    //   "해가 없다"가 아니라 "계산 불가"로 잡히고, 진입 구간으로 답을
    //   지어내는 변이가 그 catch-all 뒤에 숨는다 — 실제로 그렇게 샜다.
    //   여기서는 진입 구간(2구간)의 답이 **양수이고 방향도 맞다**(98.394).
    //   그래서 지어내면 그대로 통과해 버린다.
    const broken: BracketTier[] = [[99, 0.004, 0], [Infinity, 0.004, 1]];
    const v = assessLiquidationDistance(ok({
      referencePrice: 100, quantity: 1, brackets: broken,
    }));
    eq(v.ok, false, '★ 자기일관 해가 없는데 통과했다');
    eq(v.code, 'TIER_NOT_SELF_CONSISTENT',
      '★ 사유가 "해가 없다"가 아니다 — 계산 불가와 구별되지 않는다');
  });

  test('solver는 경계 해석을 한 곳에서만 한다 — 판정과 같은 답을 낸다', () => {
    // 판정이 solver를 쓰지 않고 자기 식을 가지면 두 답이 갈린다.
    const v = assessLiquidationDistance(ok({ side: 'LONG', quantity: 1.002 }));
    const s = solveLiquidationPrice({
      entryPrice: 50_000, leverage: 100, side: 'buy', quantity: 1.002, brackets: BRACKETS,
    });
    eq(s.code, 'OK');
    eq(v.estimatedLiquidationPrice, s.liquidationPrice, '★ 판정과 solver의 답이 다르다');
    eq(v.tier!.index, s.tierIndex);
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
}
