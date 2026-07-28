// src/lib/ai/pricing.test.ts
//
// 막으려는 사고:
//  1. 단가표에 없는 모델을 0원으로 적는 것 — 화면에 "$0.00"이 뜨면
//     사용자는 '무료'로 읽지 '모른다'로 읽지 않는다
//  2. 접두사 매칭을 짧은 쪽이 이겨 gpt-4o-mini에 gpt-4o 요금을 매기는 것
//     — 16배 차이다
//  3. 0.0004달러를 $0.00으로 적어 '안 썼다'로 보이게 하는 것
//  4. 일부만 계산한 합계를 전부인 것처럼 보여주는 것
import { test, assert, eq } from '../../test/harness';
import { priceOf, estimateCost, fmtUsd, sumCost, PRICING_AS_OF } from './pricing';

const near = (a: number | null, b: number, eps = 1e-9) =>
  a != null && Math.abs(a - b) < eps;

export function runPricingTests() {
  console.log('[AI 비용 — 단가 찾기]');

  test('긴 접두사가 이긴다', () => {
    // gpt-4o가 먼저 잡히면 미니 요금이 16배로 계산된다
    const mini = priceOf('gpt-4o-mini')!;
    const full = priceOf('gpt-4o')!;
    eq(mini.inPerM, 0.15);
    eq(full.inPerM, 2.50);
    assert(mini.inPerM < full.inPerM, '미니가 더 비싸게 잡혔다');
  });

  test('날짜 붙은 모델 ID도 찾는다', () => {
    eq(priceOf('gpt-4o-mini-2024-07-18')!.inPerM, priceOf('gpt-4o-mini')!.inPerM);
    eq(priceOf('claude-sonnet-4-20250514')!.inPerM, priceOf('claude-sonnet')!.inPerM);
  });

  test('대소문자를 가리지 않는다', () => {
    eq(priceOf('GPT-4O-MINI')!.inPerM, 0.15);
  });

  test('모르는 모델은 null — 0이 아니다', () => {
    eq(priceOf('llama-3'), null);
    eq(priceOf(''), null);
    eq(priceOf(null), null);
    eq(priceOf(undefined), null);
  });

  console.log('[AI 비용 — 한 번의 호출]');

  test('토큰 수로 금액을 낸다', () => {
    // gpt-4o-mini: 100만 입력 $0.15, 100만 출력 $0.60
    const c = estimateCost('gpt-4o-mini', 1_000_000, 1_000_000);
    assert(near(c.usd, 0.75), String(c.usd));
    eq(c.unknownModel, false);
  });

  test('모르는 모델은 금액을 만들지 않는다', () => {
    const c = estimateCost('llama-3', 1000, 1000);
    eq(c.usd, null, '0으로 두면 무료로 읽힌다');
    eq(c.unknownModel, true);
    assert(c.label.includes('단가 미등록'), c.label);
  });

  test('토큰 수를 모르면 금액을 만들지 않는다', () => {
    // usage가 응답에 안 실려 온 것이지 공짜로 부른 게 아니다
    eq(estimateCost('gpt-4o-mini', null, null).usd, null);
    eq(estimateCost('gpt-4o-mini', 100, undefined).usd, null);
    assert(estimateCost('gpt-4o-mini', null, null).label.includes('확인 불가'));
  });

  test('음수 토큰은 받지 않는다', () => {
    eq(estimateCost('gpt-4o-mini', -5, 100).usd, null);
  });

  test('0 토큰은 0원이 맞다', () => {
    eq(estimateCost('gpt-4o-mini', 0, 0).usd, 0);
  });

  console.log('[AI 비용 — 표기]');

  test('아주 작은 금액을 $0.00으로 적지 않는다', () => {
    // $0.00은 '안 썼다'로 읽힌다
    eq(fmtUsd(0.0004), '<$0.01');
    eq(fmtUsd(0), '$0');
  });

  test('구간별로 자릿수를 바꾼다', () => {
    eq(fmtUsd(0.123), '$0.123');
    eq(fmtUsd(12.3), '$12.30');
  });

  test('모르면 확인 불가라고 쓴다', () => {
    eq(fmtUsd(null), '확인 불가');
    eq(fmtUsd(NaN), '확인 불가');
  });

  console.log('[AI 비용 — 합계]');

  test('아는 것만 더하고 빠진 개수를 알린다', () => {
    const t = sumCost([
      { model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 },   // $0.15
      { model: 'llama-3', inputTokens: 1000, outputTokens: 1000 },          // 단가 모름
      { model: 'gpt-4o-mini', inputTokens: null, outputTokens: null },      // 토큰 모름
    ]);
    assert(near(t.usd, 0.15), String(t.usd));
    eq(t.counted, 1);
    eq(t.unpriced, 1);
    eq(t.untokened, 1);
  });

  test('일부만 계산했으면 이상이라고 적는다', () => {
    // 금액만 쓰면 그게 전부인 줄 안다
    const t = sumCost([
      { model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 },
      { model: 'llama-3', inputTokens: 1000, outputTokens: 1000 },
    ]);
    eq(t.isPartial, true);
    assert(t.label.includes('이상'), t.label);
  });

  test('전부 계산했으면 이상을 붙이지 않는다', () => {
    const t = sumCost([{ model: 'gpt-4o', inputTokens: 100, outputTokens: 100 }]);
    eq(t.isPartial, false);
    assert(!t.label.includes('이상'), t.label);
  });

  test('빈 목록이면 0원이고 부분이 아니다', () => {
    const t = sumCost([]);
    eq(t.usd, 0);
    eq(t.isPartial, false);
  });

  test('단가 기준일을 노출한다', () => {
    // 단가는 낡는다. 언제 기준인지 화면이 보여줘야 한다.
    assert(/^\d{4}-\d{2}$/.test(PRICING_AS_OF), PRICING_AS_OF);
  });
}
