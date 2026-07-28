// src/lib/strategies/combined.test.ts
//
// 막으려는 사고:
//  1. 반쪽 실행을 조용히 넘겨 "헤지했다"고 믿게 하는 것
//  2. 이미 걸린 선물 포지션을 무시하고 또 숏을 얹는 것 (헤지가 아니라 반대 베팅)
//  3. 증거금이 모자라 헤지가 절반만 걸리는 것 — 안 건 것보다 나쁘다
//  4. 펀딩 비용을 숨겨 헤지를 무료 보험으로 여기게 하는 것
import { test, assert, eq } from '../../test/harness';
import {
  hedgeDelta, checkHedgeHealth, estimateFundingCost,
  planCombined, summarizeExecution, COMBINED_IDS, COMBINED_LABEL,
  type CombinedContext, type Leg,
} from './combined';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const ctx = (over: Partial<CombinedContext> = {}): CombinedContext => ({
  symbol: 'BTCUSDT',
  price: 50_000,
  spotQty: 1,
  futuresQty: 0,
  futuresPnlUsd: 0,
  spotAvgPrice: 40_000,
  fundingPct: 0.01,
  overheatScore: 50,
  futuresMarginUsd: 100_000,
  ...over,
});

export function runCombinedTests() {
  console.log('[결합 전략 — 헤지 비율]');

  test('완전 헤지는 현물만큼 숏을 낸다', () => {
    const h = hedgeDelta({ spotQty: 1, futuresQty: 0, targetExposureRatio: 0 });
    eq(h.ok, true);
    assert(near(h.deltaFutures, -1), String(h.deltaFutures));
  });

  test('이미 걸린 선물을 반영한다 — 무시하면 반대 베팅이 된다', () => {
    // 현물 1, 이미 숏 0.6 → 목표 0 노출이면 0.4만 더 팔면 된다
    const h = hedgeDelta({ spotQty: 1, futuresQty: -0.6, targetExposureRatio: 0 });
    assert(near(h.deltaFutures, -0.4), `기존 숏을 무시하고 또 1을 팔았다: ${h.deltaFutures}`);
  });

  test('절반만 노출하려면 절반만 숏', () => {
    const h = hedgeDelta({ spotQty: 2, futuresQty: 0, targetExposureRatio: 0.5 });
    assert(near(h.deltaFutures, -1), String(h.deltaFutures));
    assert(near(h.targetFuturesQty, -1));
  });

  test('이미 목표면 아무것도 하지 않는다', () => {
    const h = hedgeDelta({ spotQty: 1, futuresQty: -1, targetExposureRatio: 0 });
    assert(near(h.deltaFutures, 0), String(h.deltaFutures));
  });

  test('선물 포지션을 모르면 계산하지 않는다', () => {
    eq(hedgeDelta({ spotQty: 1, futuresQty: NaN, targetExposureRatio: 0 }).ok, false);
    eq(hedgeDelta({ spotQty: 1, futuresQty: 0, targetExposureRatio: 1.5 }).ok, false);
    eq(hedgeDelta({ spotQty: -1, futuresQty: 0, targetExposureRatio: 0 }).ok, false);
  });

  console.log('[결합 전략 — 헤지가 살아 있는가]');

  test('한쪽을 못 읽으면 정상이라고 하지 않는다', () => {
    const h = checkHedgeHealth(null, -1, 0);
    eq(h.status, 'UNKNOWN', '확인 불가를 정상으로 처리했다');
    assert(h.message.includes('정상이라는 뜻이 아닙니다'), h.message);
    eq(checkHedgeHealth(1, null, 0).status, 'UNKNOWN');
  });

  test('선물 다리가 사라지면 깨진 것으로 본다', () => {
    const h = checkHedgeHealth(1, 0, 0);
    eq(h.status, 'BROKEN');
    assert(h.message.includes('전액 노출'), h.message);
  });

  test('의도대로면 INTACT', () => {
    eq(checkHedgeHealth(1, -1, 0).status, 'INTACT');
  });

  test('조금 어긋난 것과 깨진 것을 구분한다', () => {
    // 10% 어긋남 → DRIFTED
    eq(checkHedgeHealth(1, -0.9, 0).status, 'DRIFTED');
    // 50% 어긋남 → BROKEN
    eq(checkHedgeHealth(1, -0.5, 0).status, 'BROKEN');
  });

  console.log('[결합 전략 — 헤지는 공짜가 아니다]');

  test('숏이 펀딩을 받으면 양수', () => {
    const f = estimateFundingCost(0.01, 100_000, 30, 'SHORT')!;
    assert(f.totalUsd > 0, String(f.totalUsd));
    eq(f.receiving, true);
  });

  test('펀딩이 음수면 숏이 낸다 — 그 사실을 말한다', () => {
    const f = estimateFundingCost(-0.02, 100_000, 30, 'SHORT')!;
    assert(f.totalUsd < 0, String(f.totalUsd));
    assert(f.note.includes('공짜가 아닙니다'), f.note);
  });

  test('오래 들수록 비용이 커진다', () => {
    const a = estimateFundingCost(-0.01, 100_000, 7, 'SHORT')!;
    const b = estimateFundingCost(-0.01, 100_000, 90, 'SHORT')!;
    assert(Math.abs(b.totalUsd) > Math.abs(a.totalUsd) * 10, '기간이 반영되지 않았다');
  });

  test('펀딩을 모르면 계산하지 않는다', () => {
    eq(estimateFundingCost(null, 100_000, 30, 'SHORT'), null);
    eq(estimateFundingCost(0.01, 0, 30, 'SHORT'), null);
  });

  console.log('[결합 전략 — 반쪽 정보로 계획하지 않는다]');

  test('현물이나 선물을 못 읽으면 어떤 전략도 계획하지 않는다', () => {
    for (const id of COMBINED_IDS) {
      eq(planCombined(id, ctx({ spotQty: null })).ok, false, `${id}가 현물 없이 계획했다`);
      eq(planCombined(id, ctx({ futuresQty: null })).ok, false, `${id}가 선물 없이 계획했다`);
      eq(planCombined(id, ctx({ price: null })).ok, false, `${id}가 가격 없이 계획했다`);
    }
  });

  test('전략 6종이 있고 이름이 겹치지 않는다', () => {
    eq(COMBINED_IDS.length, 6);
    eq(new Set(Object.values(COMBINED_LABEL)).size, 6);
  });

  console.log('[결합 전략 — 증거금이 모자라면 아예 안 건다]');

  test('헤지 증거금이 부족하면 계획하지 않는다', () => {
    // 1 BTC × 50,000 = 50,000 명목. 2배면 증거금 25,000 필요.
    const r = planCombined('hold-hedge', ctx({ futuresMarginUsd: 1000 }), { leverage: 2 });
    eq(r.ok, false, '일부만 걸리면 헤지된 줄 알고 더 위험해진다');
    assert(r.reason.includes('이체'), r.reason);
  });

  test('증거금을 모르면 경고하되 막지는 않는다', () => {
    const r = planCombined('hold-hedge', ctx({ futuresMarginUsd: null }), { leverage: 2 });
    eq(r.ok, true);
    assert(r.warnings.some(w => w.includes('일부만')), r.warnings.join(' '));
  });

  console.log('[결합 전략 — 개별 동작]');

  test('현물 보유 + 헤지는 숏 다리를 만든다', () => {
    const r = planCombined('hold-hedge', ctx(), { targetExposureRatio: 0 });
    eq(r.ok, true);
    eq(r.legs.length, 1);
    eq(r.legs[0].market, 'USDT_FUTURES');
    eq(r.legs[0].side, 'SELL');
    assert(near(r.targetNetExposure, 0), String(r.targetNetExposure));
    // 실패했을 때의 상태를 반드시 적는다
    assert(r.legs[0].ifThisFails.includes('전액 노출'), r.legs[0].ifThisFails);
  });

  test('현물이 없으면 헤지하지 않는다', () => {
    eq(planCombined('hold-hedge', ctx({ spotQty: 0 })).ok, false);
  });

  test('과열이 기준 미만이면 숏을 내지 않는다', () => {
    eq(planCombined('overheat-short', ctx({ overheatScore: 50 }), { overheatAbove: 75 }).ok, false);
    eq(planCombined('overheat-short', ctx({ overheatScore: 80 }), { overheatAbove: 75 }).ok, true);
  });

  test('이미 숏이 있으면 더 얹지 않는다', () => {
    const r = planCombined('overheat-short', ctx({ overheatScore: 90, futuresQty: -0.5 }));
    eq(r.ok, false, '헤지가 아니라 반대 베팅이 된다');
    assert(r.reason.includes('반대 베팅'), r.reason);
  });

  test('과열 지표를 모르면 판단을 보류한다', () => {
    eq(planCombined('overheat-short', ctx({ overheatScore: null })).ok, false);
  });

  test('펀딩이 높으면 헤지를 늘린다', () => {
    const r = planCombined('funding-tilt', ctx({ fundingPct: 0.1 }), { fundingThresholdPct: 0.05 });
    eq(r.ok, true);
    eq(r.legs[0].side, 'SELL');
  });

  test('펀딩이 낮고 숏이 있으면 헤지를 줄인다', () => {
    const r = planCombined('funding-tilt',
      ctx({ fundingPct: -0.1, futuresQty: -1 }), { fundingThresholdPct: 0.05 });
    eq(r.ok, true);
    eq(r.legs[0].side, 'BUY');
  });

  test('펀딩이 중간이면 조절하지 않는다', () => {
    eq(planCombined('funding-tilt', ctx({ fundingPct: 0.01 }), { fundingThresholdPct: 0.05 }).ok, false);
  });

  test('선물 수익 적립은 미실현이라는 사실을 경고한다', () => {
    const r = planCombined('sweep-to-spot', ctx({ futuresPnlUsd: 500 }), { sweepAboveUsd: 100 });
    eq(r.ok, true);
    eq(r.legs[0].market, 'SPOT');
    eq(r.legs[0].side, 'BUY');
    assert(r.warnings.some(w => w.includes('아직 확정되지 않았습니다')), r.warnings.join(' '));
  });

  test('현물 수익 이동은 노출이 줄어든다고 경고한다', () => {
    const r = planCombined('spot-to-fund', ctx(), { sweepAboveUsd: 100 });
    eq(r.ok, true);
    eq(r.legs[0].side, 'SELL');
    assert(r.warnings.some(w => w.includes('순노출')), r.warnings.join(' '));
  });

  test('평균가를 모르면 현물 수익을 계산하지 않는다', () => {
    eq(planCombined('spot-to-fund', ctx({ spotAvgPrice: null })).ok, false);
  });

  console.log('[결합 전략 — 반쪽 실행]');

  const leg = (order: 1 | 2, fails: string): Leg => ({
    market: 'USDT_FUTURES', side: 'SELL', qty: 1, order, ifThisFails: fails, label: 'x',
  });

  test('전부 성공이면 조용하다', () => {
    const r = summarizeExecution([
      { leg: leg(1, 'a'), ok: true, message: '' },
      { leg: leg(2, 'b'), ok: true, message: '' },
    ]);
    eq(r.allOk, true);
    eq(r.needsAttention, false);
  });

  test('전부 실패면 포지션이 그대로다', () => {
    const r = summarizeExecution([{ leg: leg(1, 'a'), ok: false, message: '' }]);
    eq(r.needsAttention, false, '아무것도 안 나갔으면 위험 상태가 아니다');
    assert(r.resultingState.includes('그대로'), r.resultingState);
  });

  test('반쪽 실행이면 지금 상태를 말하고 사람을 부른다', () => {
    const r = summarizeExecution([
      { leg: leg(1, '현물이 남습니다'), ok: true, message: '' },
      { leg: leg(2, '헤지가 걸리지 않습니다 — 전액 노출입니다'), ok: false, message: '' },
    ]);
    eq(r.allOk, false);
    eq(r.needsAttention, true, '반쪽 실행이 조용히 넘어갔다');
    assert(r.resultingState.includes('전액 노출'), r.resultingState);
    assert(r.resultingState.includes('직접 정리'), r.resultingState);
  });
}
