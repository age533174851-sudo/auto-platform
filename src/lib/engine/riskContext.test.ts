// src/lib/engine/riskContext.test.ts
//
// 이 테스트가 막는 것 하나
// ────────────────────────
// **화면에 넣은 값이 엔진에 도착하지 않는 것.**
//
// 실제로 있었던 일이다. 자동매매 카드에 '배율 상한 100', '1회 위험 10%'를
// 넣으면 저장까지 됐다. 화면에는 100이 떠 있었다. 그런데 진입 엔진은 그
// 칸을 읽지 않았고 기본값으로 돌았다. 에러도 안 났다 — 저장은 진짜로
// 됐으니까.
//
// 이런 결함은 "안 된다"가 아니라 "된 줄 안다"로 나타나서 아무도 못 찾는다.
// 그래서 여기서 고정한다.

import { test, eq, assert } from '../../test/harness';
import { buildRiskContext } from './riskContext';

export function runRiskContextTests() {
  console.log('[위험 설정 — 화면에 넣은 값이 엔진까지 도착하는가]');

  test('아무것도 안 주면 기본값이다', async () => {
    const ctx = await buildRiskContext(null, {});
    eq(ctx.config.maxLeverage, 100, '기본 상한이 바뀌었다');
    eq(ctx.config.riskPerTradePct, undefined, '기본은 전략군 기본값(undefined)이어야 한다');
  });

  test('배율 상한이 엔진 설정까지 간다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: 25 });
    eq(ctx.config.maxLeverage, 25);
    assert(ctx.warnings.some(w => w.includes('25배')), '적용했다는 말이 없다: ' + ctx.warnings.join(' / '));
  });

  test('1회 위험이 엔진 설정까지 간다', async () => {
    const ctx = await buildRiskContext(null, { riskPct: 10 });
    eq(ctx.config.riskPerTradePct, 10);
  });

  test('둘 다 동시에 간다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: 100, riskPct: 10 });
    eq(ctx.config.maxLeverage, 100);
    eq(ctx.config.riskPerTradePct, 10);
  });

  // ── **0은 '모름'이 아니다. 그리고 '모름'을 0으로 읽으면 안 된다** ──
  //
  // 마이그레이션 034 전이면 이 칸이 아예 없어서 undefined가 온다. 그걸
  // 0으로 읽으면 배율 상한 0이 되어 주문이 통째로 막힌다 — 기능이 안
  // 켜진 것이 아니라 전부 죽는다.
  test('null이면 안 건드린다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: null, riskPct: null });
    eq(ctx.config.maxLeverage, 100);
    eq(ctx.config.riskPerTradePct, undefined);
  });

  test('undefined면 안 건드린다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: undefined, riskPct: undefined });
    eq(ctx.config.maxLeverage, 100);
    eq(ctx.config.riskPerTradePct, undefined);
  });

  test('0을 받으면 무시하고 이유를 남긴다 — 상한 0은 전면 차단이다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: 0 });
    eq(ctx.config.maxLeverage, 100, '0을 상한으로 썼다 — 주문이 전부 막힌다');
    assert(ctx.warnings.some(w => w.includes('쓰지 못했습니다')), '조용히 무시했다');
  });

  test('위험 0%를 받으면 무시한다 — 수량이 0이 된다', async () => {
    const ctx = await buildRiskContext(null, { riskPct: 0 });
    eq(ctx.config.riskPerTradePct, undefined);
    assert(ctx.warnings.some(w => w.includes('쓰지 못했습니다')), '조용히 무시했다');
  });

  // ── 범위 밖은 조용히 자르지 않는다 ──
  //
  // 125배 상한을 넘겨도 clamp해서 쓰면, 사용자가 200을 넣고 200으로
  // 도는 줄 안다. 안 쓴 것은 안 썼다고 말한다.
  test('거래소 상한(125배)을 넘으면 무시하고 말한다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: 200 });
    eq(ctx.config.maxLeverage, 100);
    assert(ctx.warnings.some(w => w.includes('1~125')), ctx.warnings.join(' / '));
  });

  test('위험 100% 초과는 무시한다', async () => {
    const ctx = await buildRiskContext(null, { riskPct: 150 });
    eq(ctx.config.riskPerTradePct, undefined);
  });

  test('숫자가 아니면 무시한다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: NaN, riskPct: NaN });
    eq(ctx.config.maxLeverage, 100);
    eq(ctx.config.riskPerTradePct, undefined);
  });

  test('경계값은 받는다 — 1배와 125배, 위험 100%', async () => {
    eq((await buildRiskContext(null, { leverageCap: 1 })).config.maxLeverage, 1);
    eq((await buildRiskContext(null, { leverageCap: 125 })).config.maxLeverage, 125);
    eq((await buildRiskContext(null, { riskPct: 100 })).config.riskPerTradePct, 100);
  });

  // 배율 상한은 상한이지 적용 배율이 아니다. 화면에도 그렇게 적혀 있고,
  // 설명이 어긋나면 사용자가 100배가 나가는 줄 안다.
  test('상한이라고 말한다 — 적용 배율이라고 말하지 않는다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: 100 });
    assert(ctx.warnings.some(w => w.includes('상한') && w.includes('역산')),
      '상한/역산 설명이 없다: ' + ctx.warnings.join(' / '));
  });
}
