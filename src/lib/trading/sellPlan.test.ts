// src/lib/trading/sellPlan.test.ts
//
// **매도 화면이 서버와 같은 규칙을 쓰는지 여기서 고정한다.**
//
// 제일 무서운 조합은 "비율과 수량을 둘 다 보낸다"이다. 서버는 그걸
// `AMBIGUOUS`로 거부하지만, 화면이 그 상태를 만들 수 있으면 사용자는
// 이유를 모른 채 실패만 본다. 그래서 **화면 상태에서 그 조합이 나올 수
// 없다**는 것을 값으로 본다.
import { test, eq, assert } from '../../test/harness';
import {
  holdingFor, sellRequestOf, sellGate, sellSubmitLabel,
  approxSellQuantity, newClientSellId,
  type SellHolding,
} from './sellPlan';
import { orderCapability } from './capability';

const H = (o: Partial<SellHolding>): SellHolding => ({
  symbol: 'BTCUSDT', market: 'SPOT', quantity: 10,
  totalNotional: 1000, entryFeeBasis: 0.5, avgPrice: 100, lots: 2, ...o,
});

const SPOT_OK = orderCapability('SPOT', 'PARTIAL_CLOSE');
const USDM_NO = orderCapability('USDM', 'PARTIAL_CLOSE');

export function runSellPlanTests() {
  // ══════════ 보유 고르기 ══════════

  test('★ 시장까지 본다 — 같은 심볼이 두 시장에 있어도 안 섞인다', () => {
    const list = [H({ market: 'USDM', quantity: 99 }), H({ market: 'SPOT', quantity: 10 })];
    eq(holdingFor(list, 'BTCUSDT', 'SPOT')!.quantity, 10);
    eq(holdingFor(list, 'BTCUSDT', 'USDM')!.quantity, 99);
  });

  test('심볼 대소문자는 같게 읽는다', () => {
    eq(holdingFor([H({})], 'btcusdt', 'spot')!.quantity, 10);
  });

  test('★ 없으면 null — 수량 0짜리 가짜 줄을 만들지 않는다', () => {
    eq(holdingFor([H({})], 'ETHUSDT', 'SPOT'), null);
    eq(holdingFor([], 'BTCUSDT', 'SPOT'), null);
    eq(holdingFor(null, 'BTCUSDT', 'SPOT'), null);
    eq(holdingFor(undefined as any, 'BTCUSDT', 'SPOT'), null);
  });

  test('목록이 아니면 null — 던지지 않는다', () => {
    eq(holdingFor({} as any, 'BTCUSDT', 'SPOT'), null);
  });

  // ══════════ ★ 비율과 수량을 동시에 싣지 않는다 ══════════

  test('★ 비율 칸을 쓰면 요청에 비율만 실린다', () => {
    const r = sellRequestOf({ mode: 'PERCENT', percent: 50, quantityText: '3' });
    assert(r.ok === true, '거부됐습니다');
    eq((r as any).percent, 50);
    eq((r as any).quantity, null);
  });

  test('★ 수량 칸을 쓰면 요청에 수량만 실린다 (비율이 남아 있어도)', () => {
    const r = sellRequestOf({ mode: 'QUANTITY', percent: 50, quantityText: '3' });
    assert(r.ok === true, '거부됐습니다');
    eq((r as any).quantity, 3);
    eq((r as any).percent, null);
  });

  test('★ 어느 칸을 쓰든 AMBIGUOUS가 나올 수 없다', () => {
    for (const mode of ['PERCENT', 'QUANTITY'] as const) {
      const r = sellRequestOf({ mode, percent: 50, quantityText: '3' });
      assert(r.ok === true || (r as any).code !== 'AMBIGUOUS',
        `${mode}에서 AMBIGUOUS가 나왔습니다`);
    }
  });

  test('빈 칸은 "안 보낸 것"이다 — 0으로 읽지 않는다', () => {
    const r = sellRequestOf({ mode: 'QUANTITY', percent: null, quantityText: '' });
    assert(r.ok === false, '빈 수량이 통과했습니다');
  });

  test('전량은 비율 100으로 나간다 (088이 나눗셈을 건너뛰는 값)', () => {
    const r = sellRequestOf({ mode: 'PERCENT', percent: 100, quantityText: '' });
    assert(r.ok === true, '전량이 거부됐습니다');
    eq((r as any).percent, 100);
  });

  // ══════════ 잠금 ══════════

  const ready = { supported: SPOT_OK, holdingRead: true, holding: H({}) };

  test('보유가 있고 비율을 정했으면 열린다', () => {
    const g = sellGate({ ...ready, request: sellRequestOf({ mode: 'PERCENT', percent: 25, quantityText: '' }) });
    assert(g.ready, `잠겼습니다: ${g.reason}`);
    eq(g.block, 'NONE');
  });

  test('★ 못 읽은 것과 보유 0은 다른 사실이다', () => {
    const req = sellRequestOf({ mode: 'PERCENT', percent: 25, quantityText: '' });
    const unknown = sellGate({ supported: SPOT_OK, holdingRead: false, holding: null, request: req });
    const none = sellGate({ supported: SPOT_OK, holdingRead: true, holding: null, request: req });
    eq(unknown.block, 'HOLDING_UNKNOWN');
    eq(none.block, 'NO_HOLDING');
    assert(unknown.reason !== none.reason, '두 사실이 같은 문구로 나왔습니다');
    assert(/보유가 없다는 뜻이 아닙니다/.test(unknown.reason || ''),
      '못 읽음이 "보유 없음"으로 읽히는 문구입니다');
  });

  test('보유 수량이 0이면 팔 것이 없다', () => {
    const g = sellGate({
      supported: SPOT_OK, holdingRead: true, holding: H({ quantity: 0 }),
      request: sellRequestOf({ mode: 'PERCENT', percent: 25, quantityText: '' }),
    });
    eq(g.block, 'NO_HOLDING');
  });

  test('★ 가진 것보다 많이 팔려 하면 막는다', () => {
    const g = sellGate({ ...ready, request: sellRequestOf({ mode: 'QUANTITY', percent: null, quantityText: '11' }) });
    eq(g.block, 'OVERSELL');
    assert(!g.ready, '초과 매도가 열렸습니다');
  });

  test('정확히 보유량만큼은 판다', () => {
    const g = sellGate({ ...ready, request: sellRequestOf({ mode: 'QUANTITY', percent: null, quantityText: '10' }) });
    assert(g.ready, `잠겼습니다: ${g.reason}`);
  });

  test('★ 선물은 나눠 팔 수 없다 — 능력표가 막는다', () => {
    const g = sellGate({
      supported: USDM_NO, holdingRead: true, holding: H({ market: 'USDM' }),
      request: sellRequestOf({ mode: 'PERCENT', percent: 50, quantityText: '' }),
    });
    eq(g.block, 'UNSUPPORTED');
    assert(!g.ready, '선물 부분매도가 열렸습니다');
  });

  test('금액을 안 정했으면 그 사유가 나온다', () => {
    const g = sellGate({ ...ready, request: sellRequestOf({ mode: 'PERCENT', percent: null, quantityText: '' }) });
    eq(g.block, 'NO_AMOUNT');
  });

  test('★ 아무것도 안 고른 상태를 "하나만 보내세요"라고 말하지 않는다', () => {
    // 서버의 `sellAmountOf`는 "둘 다"와 "둘 다 아님"을 같은 코드로 묶는다.
    // 화면은 고른 칸 하나만 싣기 때문에 "둘 다"가 나올 수 없다 — 남는 뜻은
    // "아직 안 골랐다"뿐이고, 문구도 그렇게 나와야 한다.
    for (const mode of ['PERCENT', 'QUANTITY'] as const) {
      const g = sellGate({ ...ready, request: sellRequestOf({ mode, percent: null, quantityText: '' }) });
      eq(g.block, 'NO_AMOUNT');
      assert(!/하나만 보내세요/.test(g.reason || ''),
        `${mode}: 안 고른 상태에 "하나만 보내세요"가 나왔습니다 — ${g.reason}`);
      assert(/정하세요/.test(g.reason || ''), `${mode}: 무엇을 하라는 말이 없습니다 — ${g.reason}`);
    }
  });

  test('잠금마다 다른 라벨이 나온다 — 전부 "할 수 없음"이 아니다', () => {
    const labels = new Set<string>();
    for (const g of [
      { ready: false, block: 'NO_AMOUNT', reason: null },
      { ready: false, block: 'NO_HOLDING', reason: null },
      { ready: false, block: 'HOLDING_UNKNOWN', reason: null },
      { ready: false, block: 'OVERSELL', reason: null },
    ] as const) labels.add(sellSubmitLabel(g as any, 'BTCUSDT'));
    eq(labels.size, 4);
    assert(/BTCUSDT/.test(sellSubmitLabel({ ready: true, block: 'NONE', reason: null }, 'BTCUSDT')),
      '열렸을 때 종목이 안 보입니다');
  });

  // ══════════ 예상 수량은 장부가 아니다 ══════════

  test('전량은 보유 전부다 — 나눗셈을 하지 않는다', () => {
    eq(approxSellQuantity(H({ quantity: 3 }), 100), 3);
  });

  test('비율은 대략 수량을 준다', () => {
    eq(approxSellQuantity(H({ quantity: 10 }), 25), 2.5);
  });

  test('★ 못 구하면 null — 0을 보여 주지 않는다', () => {
    eq(approxSellQuantity(null, 50), null);
    eq(approxSellQuantity(H({ quantity: 0 }), 50), null);
    eq(approxSellQuantity(H({}), null), null);
    eq(approxSellQuantity(H({}), 0), null);
    eq(approxSellQuantity(H({}), 101), null);
  });

  // ══════════ 멱등 식별자 ══════════

  test('★ 매번 다른 식별자가 나온다 (새 매도는 새 id)', () => {
    const a = newClientSellId(1_700_000_000_000, 0.111);
    const b = newClientSellId(1_700_000_000_001, 0.222);
    assert(a !== b, '같은 식별자가 나왔습니다');
    assert(a.length > 0 && b.length > 0, '빈 식별자입니다');
  });

  test('★ 같은 입력이면 같은 식별자다 (재시도가 재현 가능하다)', () => {
    eq(newClientSellId(1_700_000_000_000, 0.5), newClientSellId(1_700_000_000_000, 0.5));
  });

  test('★ 식별자에 계좌 id가 들어가지 않는다', () => {
    const id = newClientSellId(Date.now(), Math.random());
    assert(/^sell-[0-9a-z]+-[0-9a-z]+$/.test(id), `모양이 다릅니다: ${id}`);
  });

  test('숫자가 아니면 빈 문자열 — 서버가 missing_params로 막는다', () => {
    eq(newClientSellId(NaN, 0.5), '');
  });
}
