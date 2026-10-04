// src/lib/engine/postEntryRisk.test.ts
//
// **⑤B-0/1 — 재는 것과 판단하는 것을 섞지 않는다.**
//
// 여기서 지키는 것 대부분은 "하지 않는다"다: 평균하지 않는다, 대체하지
// 않는다, 0으로 바꾸지 않는다, 임의 문턱을 두지 않는다. 이런 금지는
// 시험이 없으면 다음 사람이 "편의상" 되살린다.
import { test, assert, eq } from '../../test/harness';
import { measurePostEntryRisk, type PostEntryRiskInput } from './postEntryRisk';
import type { MarketObservation } from './marketFreshness';
import type { BracketTier } from '../safety/liquidationPrice';

const NOW = 1_780_000_000_000;

/** `[cap, mmr, maintAmount]` — 정본의 모양 그대로다 */
const BRACKETS: BracketTier[] = [
  [50_000, 0.004, 0],
  [250_000, 0.005, 50],
];

const mark = (px: number, over: Partial<MarketObservation> = {}): MarketObservation => ({
  kind: 'MARK', source: 'EXCHANGE_PREMIUM_INDEX', value: px,
  exchangeTimeMs: NOW - 200, receivedAtMs: NOW - 150, observedAtMs: NOW - 150,
  cache: 'FRESH', ...over,
});

/** `value`가 **없다.** 브래킷은 숫자 하나가 아니라 구간 표다 */
const bracket = (over: Partial<MarketObservation> = {}): MarketObservation => ({
  kind: 'BRACKET', source: 'EXCHANGE_LEVERAGE_BRACKET',
  exchangeTimeMs: null, receivedAtMs: NOW - 60_000, observedAtMs: NOW - 60_000,
  cache: 'FRESH', ...over,
});

const input = (over: Partial<PostEntryRiskInput> = {}): PostEntryRiskInput => ({
  side: 'LONG',
  mark: mark(50_000),
  bracket: bracket(),
  exchangeLiquidationPrice: 49_700,
  entryPrice: 50_000,
  quantity: 0.2,
  leverage: 100,
  marginMode: 'isolated',
  brackets: BRACKETS,
  entryAdverseDistancePct: 0.4,
  entryLiquidationDistancePctRaw: 0.6,
  provenance: {
    positionReceivedAtMs: NOW - 100, positionUpdateTimeMs: NOW - 3_600_000,
    markExchangeTimeMs: NOW - 200, markReceivedAtMs: NOW - 150,
    markObservedAtMs: NOW - 150, bracketObservedAtMs: NOW - 60_000,
  },
  nowMs: NOW,
  ...over,
});

export function runPostEntryRiskTests() {
  console.log('\n📐 ⑤B-0/1 열린 100배 포지션 위험 측정 (재기만 한다)');

  test('두 청산가가 다 있으면 둘을 **나란히** 적는다', () => {
    const m = measurePostEntryRisk(input());
    eq(m.status, 'MEASURED');
    eq(m.liquidationSources, 'BOTH_AVAILABLE');
    eq(m.exchangeLiquidationPrice, 49_700);
    assert(m.estimatedLiquidationPrice != null, '내부 추정이 비어 있다');
    assert(m.exchangeHeadroomPct != null && m.estimatedHeadroomPct != null);
    // ★ 두 칸은 **서로 다른 값**이어야 한다. 같아지면 한쪽이 다른 쪽을
    //   덮어쓴 것일 수 있다.
    assert(m.absoluteDelta != null && m.deltaPct != null, '차이를 기록하지 않았다');
  });

  test('★ 두 청산가를 **평균하지 않는다**', () => {
    const m = measurePostEntryRisk(input());
    const avg = (m.exchangeLiquidationPrice! + m.estimatedLiquidationPrice!) / 2;
    assert(m.exchangeLiquidationPrice !== avg,
      '★ 거래소 칸에 평균이 들어갔다 — 근거 없는 숫자를 만든 것이다');
    assert(m.estimatedLiquidationPrice !== avg, '★ 내부 칸에 평균이 들어갔다');
  });

  test('★ 거래소 청산가가 없으면 내부 값으로 **대체하지 않는다**', () => {
    const m = measurePostEntryRisk(input({ exchangeLiquidationPrice: null }));
    eq(m.liquidationSources, 'INTERNAL_ONLY');
    eq(m.exchangeLiquidationPrice, null, '★ 내부 추정이 거래소 칸으로 승격됐다');
    eq(m.exchangeHeadroomPct, null, '★ 없는 출처의 여유를 적었다');
    assert(m.estimatedLiquidationPrice != null, '내부 값은 그대로 남는다');
    eq(m.absoluteDelta, null, '★ 한쪽이 없는데 차이를 지어냈다');
    eq(m.deltaPct, null);
    // 측정 자체는 여전히 성립한다 — 못 쓴다고 적지 않는다.
    eq(m.status, 'MEASURED');
  });

  test('★ 거래소가 0을 주면 "없음"이다 — 0원 청산이 아니다', () => {
    const m = measurePostEntryRisk(input({ exchangeLiquidationPrice: 0 }));
    eq(m.exchangeLiquidationPrice, null);
    eq(m.liquidationSources, 'INTERNAL_ONLY');
    // 0을 그대로 썼으면 여유가 100%가 되어 가장 위험한 자리가 가장
    // 안전해 보인다.
    assert((m.exchangeHeadroomPct ?? 0) !== 100, '★ 0을 청산가로 읽었다');
  });

  test('★ 브래킷을 못 읽으면 내부 추정만 비고 거래소 값은 남는다', () => {
    const m = measurePostEntryRisk(input({ brackets: null, bracket: null }));
    eq(m.liquidationSources, 'EXCHANGE_ONLY');
    eq(m.estimatedLiquidationPrice, null);
    eq(m.estimatedHeadroomPct, null);
    eq(m.exchangeLiquidationPrice, 49_700, '★ 내부가 비었다고 거래소 값까지 버렸다');
    eq(m.status, 'MEASURED');
  });

  test('★ 둘 다 없으면 RISK_DATA_UNUSABLE이다 — 위험하다는 뜻이 아니다', () => {
    const m = measurePostEntryRisk(input({
      exchangeLiquidationPrice: null, brackets: null, bracket: null,
    }));
    eq(m.status, 'RISK_DATA_UNUSABLE');
    eq(m.liquidationSources, 'BOTH_UNAVAILABLE');
    assert(m.reason.length > 0, '왜 못 쟀는지 적어야 한다');
    // ★ 종료 사유로 읽힐 칸이 하나도 없어야 한다.
    assert(!('action' in (m as any)) && !('close' in (m as any)),
      '★ 측정기가 행동을 돌려준다 — 판단이 섞였다');
  });

  test('★ 마크가가 없으면 측정 불가다. 거리를 잴 기준이 없다', () => {
    const m = measurePostEntryRisk(input({ mark: null }));
    eq(m.status, 'RISK_DATA_UNUSABLE');
    eq(m.markPrice, null);
    eq(m.exchangeHeadroomPct, null, '★ 기준 없이 여유를 계산했다');
  });

  test('★ 마크가가 낡으면 ④ 정본이 막는다 — 새 문턱을 만들지 않는다', () => {
    const stale = measurePostEntryRisk(input({
      mark: mark(50_000, {
        exchangeTimeMs: NOW - 60_000, receivedAtMs: NOW - 59_000,
        observedAtMs: NOW - 59_000,
      }),
    }));
    eq(stale.status, 'RISK_DATA_UNUSABLE');
    assert(stale.freshness != null, '신선도 판정을 남겨야 한다');
    eq(stale.freshness!.ok, false);
  });

  test('★ 090 스냅숏은 그대로 들고 다닌다 — null은 null이다', () => {
    const m = measurePostEntryRisk(input({
      entryAdverseDistancePct: null, entryLiquidationDistancePctRaw: null,
    }));
    eq(m.entryAdverseDistancePct, null,
      '★ 없는 위험 예산을 0으로 바꿨다 — 어떤 청산여유든 통과한다');
    eq(m.entryLiquidationDistancePctRaw, null);
    // 스냅숏이 없어도 **측정은 된다.** 판단만 못 한다.
    eq(m.status, 'MEASURED');
  });

  test('★ 스냅숏 값을 다시 계산하지 않는다 — 받은 값이 그대로 나온다', () => {
    const m = measurePostEntryRisk(input({
      entryAdverseDistancePct: 0.37, entryLiquidationDistancePctRaw: 0.58,
    }));
    eq(m.entryAdverseDistancePct, 0.37);
    eq(m.entryLiquidationDistancePctRaw, 0.58);
  });

  test('★ `positionRisk.updateTime`을 신선도에 쓰지 않는다 — 기록만 한다', () => {
    // 포지션 갱신 시각이 **한 시간 전**인데도 측정은 성립한다.
    // 그 값이 신선도에 들어가면 여기서 막혔을 것이다.
    const m = measurePostEntryRisk(input());
    eq(m.status, 'MEASURED');
    eq(m.provenance.positionUpdateTimeMs, NOW - 3_600_000, '기록은 남는다');
    // 마크가의 시각과 **다른 칸**이다. 섞으면 출처를 잃는다.
    assert(m.provenance.markExchangeTimeMs !== m.provenance.positionUpdateTimeMs);
  });

  test('★ 거래소 청산가에 exchangeTimeMs를 지어내지 않는다', () => {
    const m = measurePostEntryRisk(input());
    // 포지션 응답에는 받은 시각만 있다.
    assert(m.provenance.positionReceivedAtMs != null, '받은 시각은 적는다');
    // provenance에 "청산가의 거래소 시각" 칸 자체가 없어야 한다.
    assert(!('liquidationExchangeTimeMs' in (m.provenance as any)),
      '★ 청산가에 거래소 시각 칸을 만들었다 — 문서에 없는 값이다');
  });

  test('★ SHORT는 청산가가 **위**다', () => {
    const m = measurePostEntryRisk(input({
      side: 'SHORT', exchangeLiquidationPrice: 50_300,
    }));
    eq(m.side, 'SHORT');
    assert((m.exchangeHeadroomPct ?? -1) > 0,
      '★ SHORT 방향을 LONG 식으로 계산해 여유가 음수가 됐다');
  });

  test('★ 이미 청산가를 지났으면 음수를 그대로 적는다', () => {
    // LONG인데 마크가가 청산가 아래다 — 0으로 깎으면 "닿았다"가
    // "여유 없음"으로 흐려진다.
    const m = measurePostEntryRisk(input({
      mark: mark(49_600), exchangeLiquidationPrice: 49_700,
    }));
    assert((m.exchangeHeadroomPct ?? 0) < 0,
      `★ 지난 거리를 0으로 깎았다 (${m.exchangeHeadroomPct})`);
  });

  test('★ `assessLiquidationDistance.ok`를 정본으로 쓰지 않는다', () => {
    const m = measurePostEntryRisk(input());
    // adverse를 넘기지 않으므로 내부 판정은 ok:false다.
    eq(m.internal!.ok, false);
    eq(m.internal!.code, 'ADVERSE_DISTANCE_UNKNOWN');
    // 그런데 측정은 성립하고 trustworthy다 — 그 구분이 요점이다.
    eq(m.status, 'MEASURED');
    eq(m.trustworthy, true,
      '★ 비교 기준이 없다는 이유로 측정값까지 못 믿는다고 적었다');
  });

  test('★ 측정기는 거래소를 바꿀 수단이 없다', async () => {
    const src = await import('./postEntryRisk');
    const names = Object.keys(src);
    for (const bad of ['sendClose', 'closePosition', 'sendPreparedClose',
                       'runExitAuthority', 'sendSymbolClose']) {
      eq(names.includes(bad), false, `★ 측정기가 ${bad}를 내보낸다`);
    }
    eq(names.includes('measurePostEntryRisk'), true);
  });

  test('★ CONSISTENT/INCONSISTENT로 나누지 않는다 — 근거가 없다', () => {
    const m = measurePostEntryRisk(input());
    const s = String(m.liquidationSources);
    assert(!/CONSISTENT/i.test(s),
      '★ 가용성 분류에 일치 판정이 섞였다 — 그러려면 문턱이 필요하다');
    for (const k of Object.keys(m)) {
      assert(!/tolerance|consistent|threshold|ratio/i.test(k),
        `★ 측정 결과에 문턱성 칸이 있다 (${k})`);
    }
  });

  test('★ 입력이 비어도 터지지 않고 측정 불가로 적는다', () => {
    for (const bad of [null, undefined, {} as any]) {
      const m = measurePostEntryRisk(bad);
      eq(m.status, 'RISK_DATA_UNUSABLE');
      eq(m.entryAdverseDistancePct, null);
    }
  });
}
