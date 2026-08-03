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

  // ── **오늘 실현손익 — 0과 '모름'을 구분한다** ──
  //
  // 여기는 원래 `orders` 표를 읽고 있었다. 그런 표는 없다. supabase-js는
  // 없는 표에 던지지 않고 { data: null, error }를 돌려주는데 error를 안
  // 봤다. 그래서 dailyPnl이 언제나 0이었고, "오늘 -3% 넘으면 중단"이 한
  // 번도 걸린 적이 없다. 0은 '안 잃었다'로 읽히니까.
  test('읽지 못하면 dailyPnlKnown이 false다 — 0이 아니다', async () => {
    const ctx = await buildRiskContext(null, {});
    eq(ctx.config.dailyPnlKnown, false, '못 읽었는데 확인했다고 했다');
  });

  test('못 읽었으면 이유를 남긴다', async () => {
    const ctx = await buildRiskContext(null, {});
    assert(ctx.warnings.some(w => w.includes('실현손익')),
      '조용히 넘어갔다: ' + ctx.warnings.join(' / '));
  });

  test('읽은 값과 읽지 못한 상태가 같은 숫자(0)로 보이지 않는다', async () => {
    // 못 읽었을 때의 dailyPnl은 0이지만, 그 0을 믿으면 안 된다는 표시가
    // 반드시 함께 온다. 이 두 값이 한 몸으로 움직여야 riskManager가
    // 구분할 수 있다.
    const ctx = await buildRiskContext(null, {});
    eq(ctx.config.dailyPnl, 0);
    eq(ctx.config.dailyPnlKnown, false);
  });

  // 배율 상한은 상한이지 적용 배율이 아니다. 화면에도 그렇게 적혀 있고,
  // 설명이 어긋나면 사용자가 100배가 나가는 줄 안다.
  test('상한이라고 말한다 — 적용 배율이라고 말하지 않는다', async () => {
    const ctx = await buildRiskContext(null, { leverageCap: 100 });
    assert(ctx.warnings.some(w => w.includes('상한') && w.includes('역산')),
      '상한/역산 설명이 없다: ' + ctx.warnings.join(' / '));
  });

  // ── **모의 손익을 실전 한도에 섞지 않는다** ──
  //
  // 모의는 연습이다. 연습에서 잃었다고 실전 진입이 막히면, 연습을 할수록
  // 실전을 못 하게 된다. 반대로 실전 손실이 모의 한도에 잡히면 연습조차
  // 막힌다. 한도는 그 돈이 실제로 오간 장부에서만 계산한다.
  test('모드에 따라 다른 장부를 본다', async () => {
    const seen: string[] = [];
    const sb: any = {
      from(t: string) {
        seen.push(t);
        const chain: any = {
          select: () => chain, eq: () => chain, gte: () => chain,
          order: () => chain, limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (res: any) => res({ data: [], error: null }),
        };
        return chain;
      },
    };
    seen.length = 0;
    await buildRiskContext(sb, { userId: 'u1', mode: 'PAPER' });
    assert(seen.includes('paper_positions'), '모의인데 모의 장부를 안 봤다');
    assert(!seen.includes('daily_slot_uses'), '모의인데 실전 장부를 봤다');

    seen.length = 0;
    await buildRiskContext(sb, { userId: 'u1', mode: 'LIVE' });
    assert(seen.includes('daily_slot_uses'), '실전인데 실전 장부를 안 봤다');
    // paper_positions는 연속 손실 계산에도 쓰이므로 등장 자체는 막지 않는다.
    // 중요한 것은 **손익 합계**에 안 섞이는 것이고, 그건 위 소스 선택으로 정해진다.
  });

  // ══ 100배가 30배로 잘리던 자리 ══
  //
  // 배율은 명목가 ÷ 증거금 예산으로 역산된다. 그런데 명목가에는 따로
  // 상한이 있고(기본 자산의 300%), 그게 증거금 상한보다 **먼저** 걸린다.
  //
  //   증거금 10% · 배율 상한 100배 → 필요한 명목가 = 자산의 1000%
  //   명목가 상한 300% → 명목가가 잘림 → 역산 배율 30배
  //
  // 화면에는 100이 적혀 있고, 저장도 됐고, 에러도 안 났다. 30배가 나갔다.
  test('증거금 10% · 배율 100배면 명목가 상한이 1000%까지 열린다', async () => {
    const ctx = await buildRiskContext(null, { marginPct: 10, leverageCap: 100 });
    eq(ctx.config.maxNotionalPct, 1000, '명목가 상한이 배율보다 먼저 걸린다 — 100배가 안 나온다');
  });

  test('올렸으면 올렸다고 말한다 — 조용히 바꾸지 않는다', async () => {
    const ctx = await buildRiskContext(null, { marginPct: 10, leverageCap: 100 });
    assert(ctx.warnings.some(w => w.includes('명목가 상한을') && w.includes('1000%')),
      '상한을 바꿨는데 말이 없다: ' + ctx.warnings.join(' / '));
  });

  test('필요한 만큼만 올린다 — 기본값보다 작으면 그대로 둔다', async () => {
    // 증거금 10% × 배율 20배 = 200% < 기본 300%
    const ctx = await buildRiskContext(null, { marginPct: 10, leverageCap: 20 });
    eq(ctx.config.maxNotionalPct, 300, '필요 없는데 상한을 내렸다');
  });

  test('증거금을 안 정하면 안 건드린다', async () => {
    eq((await buildRiskContext(null, { leverageCap: 100 })).config.maxNotionalPct, 300);
  });

  test('증거금이 범위 밖이면 안 건드린다', async () => {
    eq((await buildRiskContext(null, { marginPct: 0, leverageCap: 100 })).config.maxNotionalPct, 300);
    eq((await buildRiskContext(null, { marginPct: 150, leverageCap: 100 })).config.maxNotionalPct, 300);
  });

  // **사용자가 그어 둔 선은 올리지 않는다.**
  // 대신 그 선 때문에 배율이 얼마까지만 나오는지 정확히 말한다.
  test('직접 설정한 명목가 상한은 안 올리고, 실제 배율을 알려준다', async () => {
    const sb: any = {
      from: () => {
        const chain: any = {
          select: () => chain, eq: () => chain, gte: () => chain,
          order: () => chain, limit: () => chain,
          maybeSingle: async () => ({
            data: { max_leverage: 100, max_notional_pct: 400, max_account_risk_pct: 5,
                    max_daily_loss_pct: 3, risk_per_trade_pct: null }, error: null }),
          then: (res: any) => res({ data: [], error: null }),
        };
        return chain;
      },
    };
    const ctx = await buildRiskContext(sb, { userId: 'u1', marginPct: 10, leverageCap: 100 });
    eq(ctx.config.maxNotionalPct, 400, '사용자가 그어 둔 선을 올려 버렸다');
    // 400% ÷ 증거금 10% = 40배
    assert(ctx.warnings.some(w => w.includes('40배')),
      '실제로 몇 배까지 나가는지 안 알려줬다: ' + ctx.warnings.join(' / '));
  });
}
