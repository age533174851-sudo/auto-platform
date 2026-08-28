// src/lib/engine/paperDispatch.test.ts
//
// **모의 자동매매를 켜면 모의 계좌에 실제로 체결되는가.**
//
// 전수 추적에서 나온 것: 세 전략이 모의 모드에서 서로 다른 세 가지 일을
// 했고, 그중 어느 것도 "모의 계좌에 체결한다"가 아니었다.
//
//   daily-ladder   live_orders에 INTENT 한 줄. 모의 계좌는 그대로
//   scalp          아무것도 안 함. 기록조차 없음
//   my-original-v1 **모드 관문이 없어 테스트넷 실주문**
import { test, eq, assert } from '../../test/harness';
import { paperDispatchVerdict, ledgerEnvOfMode, dispatchPaperEntry } from './paperDispatch';

const PLAN: any = {
  symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, positionSize: 1000,
  leverage: 10, requiredMargin: 100, approved: true,
  stopDistancePct: 2, effectiveStopPct: 2, riskAmount: 20,
  riskAmountWithCosts: 21, liquidationPrice: 0, liquidationDistancePct: 9, notes: [],
};

export function runPaperDispatchTests() {
  console.log('\n🧪 모의 자동매매 실행 어댑터 (같은 전략 · 다른 체결처)');

  // ══ ① 모의 모드는 모의 계좌에 체결한다 ══
  test('PAPER는 모의 계좌에 체결한다', () => {
    const v = paperDispatchVerdict({ mode: 'PAPER', hasPlan: true, entryPrice: 100_000 });
    eq(v.code, 'FILL_PAPER');
    eq(v.fill, true);
  });

  // ══ ② 거래소로 나가는 모드는 여기 오면 안 된다 ══
  test('TESTNET·LIVE는 모의 장부에 적지 않는다 — 같은 거래가 두 장부에 생긴다', () => {
    for (const m of ['TESTNET', 'LIVE_SMALL', 'LIVE_LIMITED'] as const) {
      const v = paperDispatchVerdict({ mode: m, hasPlan: true, entryPrice: 100_000 });
      eq(v.code, 'NOT_PAPER');
      eq(v.fill, false);
    }
  });

  test('Shadow Live는 기록만 한다 — 모의 잔고를 건드리지 않는다', () => {
    const v = paperDispatchVerdict({ mode: 'SHADOW_LIVE', hasPlan: true, entryPrice: 100_000 });
    eq(v.code, 'RECORD_ONLY');
    eq(v.fill, false);
    assert(v.reason.includes('기록'), '무엇을 하는지 말한다');
  });

  test('UI 데모는 주문도 장부도 만들지 않는다', () => {
    const v = paperDispatchVerdict({ mode: 'UI_DEMO', hasPlan: true, entryPrice: 100_000 });
    eq(v.code, 'NOTHING');
    eq(v.fill, false);
  });

  // ══ ③ 값이 없으면 체결을 지어내지 않는다 ══
  test('계획이 없으면 체결하지 않는다', () => {
    eq(paperDispatchVerdict({ mode: 'PAPER', hasPlan: false, entryPrice: 100_000 }).code, 'NO_PLAN');
  });

  test('체결 기준가를 못 구했으면 0으로 적지 않는다', () => {
    for (const px of [null, undefined, 0, -1, NaN]) {
      const v = paperDispatchVerdict({ mode: 'PAPER', hasPlan: true, entryPrice: px as any });
      eq(v.code, 'NO_PLAN');
      eq(v.fill, false);
    }
  });

  // ══ ④ 장부 환경을 섞지 않는다 ══
  test('PAPER·UI_DEMO의 장부는 MOCK이다 — TESTNET으로 눕히지 않는다', () => {
    eq(ledgerEnvOfMode('PAPER'), 'MOCK');
    eq(ledgerEnvOfMode('UI_DEMO'), 'MOCK');
  });

  test('TESTNET은 TESTNET · LIVE 계열과 SHADOW_LIVE는 LIVE다', () => {
    eq(ledgerEnvOfMode('TESTNET'), 'TESTNET');
    eq(ledgerEnvOfMode('LIVE_SMALL'), 'LIVE');
    eq(ledgerEnvOfMode('LIVE_LIMITED'), 'LIVE');
    // 샤도우는 실계좌로 판단한다 — 그 기록은 실전 쪽 장부다.
    eq(ledgerEnvOfMode('SHADOW_LIVE'), 'LIVE');
  });

  test('모르는 값을 MOCK이나 LIVE로 승격하지 않는다', () => {
    eq(ledgerEnvOfMode(''), 'TESTNET');
    eq(ledgerEnvOfMode(null), 'TESTNET');
    eq(ledgerEnvOfMode('오타'), 'TESTNET');
  });

  // ══ ⑤ 실패를 성공으로 적지 않는다 ══
  const fakeSb = (result: any) => {
    (globalThis as any).__paperStoreStub = result;
    return {} as any;
  };

  test('체결에 실패하면 executed로 적지 않는다', async () => {
    // openPaperPosition이 실패를 돌려주는 상황을 흉내 낸다.
    const sb: any = {
      from() {
        const b: any = {
          insert() { return b; },
          select() { return b; },
          single() { return Promise.resolve({ data: null, error: { message: 'boom', code: '500' } }); },
          update() { return b; }, eq() { return b; },
          maybeSingle() { return Promise.resolve({ data: null }); },
        };
        return b;
      },
    };
    const r = await dispatchPaperEntry(sb, {
      userId: 'u', mode: 'PAPER', strategyId: 'scalp', signalId: 's1',
      plan: PLAN, entryPrice: 100_000,
    });
    eq(r.ok, false);
    eq(r.code, 'FAILED');
    eq(r.positionId, null);
    assert(r.reason.includes('실패'), '실패라고 적는다');
  });

  test('거래소 모드는 모의 체결을 시도조차 하지 않는다', async () => {
    let touched = false;
    const sb: any = { from() { touched = true; return {}; } };
    const r = await dispatchPaperEntry(sb, {
      userId: 'u', mode: 'TESTNET', strategyId: 'scalp', signalId: 's1',
      plan: PLAN, entryPrice: 100_000,
    });
    eq(r.code, 'NOT_PAPER');
    eq(r.ok, true);
    assert(!touched, '거래소 모드에서 모의 장부를 건드리면 안 된다');
  });

  test('계획이 없으면 DB를 건드리지 않는다', async () => {
    let touched = false;
    const sb: any = { from() { touched = true; return {}; } };
    const r = await dispatchPaperEntry(sb, {
      userId: 'u', mode: 'PAPER', strategyId: 'scalp', signalId: 's1',
      plan: null, entryPrice: 100_000,
    });
    eq(r.code, 'NO_PLAN');
    assert(!touched, '체결할 것이 없으면 쓰지 않는다');
  });

  // ══ ⑥ 같은 신호는 두 번 체결되지 않는다 ══
  test('중복 신호는 성공이되 새로 생긴 것처럼 적지 않는다', async () => {
    const sb: any = {
      from() {
        const b: any = {
          insert() { return b; },
          select() { return b; },
          // 23505 = UNIQUE 충돌. paperStore가 duplicate로 바꿔 준다.
          single() { return Promise.resolve({ data: null, error: { message: 'duplicate key', code: '23505' } }); },
          update() { return b; }, eq() { return b; },
          maybeSingle() { return Promise.resolve({ data: null }); },
        };
        return b;
      },
    };
    const r = await dispatchPaperEntry(sb, {
      userId: 'u', mode: 'PAPER', strategyId: 'scalp', signalId: 's1',
      plan: PLAN, entryPrice: 100_000,
    });
    eq(r.ok, true);
    eq(r.code, 'DUPLICATE');
    eq(r.positionId, null);
  });
}
