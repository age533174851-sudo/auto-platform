// src/lib/engine/entry100x.test.ts
//
// **막힐 요청은 거래소 상태를 바꾸지 않는다** — 그 하나를 센다.
//
// 왜 "주문이 안 나갔다"로 부족한가
// ────────────────────────────────
// 이 경로는 크기를 만들기 위해 거래소에 **쓴다**(배율 설정). 주문보다
// 앞선 단계다. 그래서 주문 건수만 세면, 어차피 막힐 요청이 계좌 설정을
// 먼저 바꾸는 것을 못 잡는다. 계좌 설정이 바뀌면 그 자리에 있던 다른
// 포지션의 청산가가 함께 움직인다 — 주문 0건이어도 사용자는 손해를 본다.
//
// 그래서 쓰기를 **따로 센다**. 배율 설정 하나를 이름으로 세지 않고
// `MUTATING_DEPS` 분류를 따라 센다 — 나중에 쓰기가 하나 더 붙어도 같은
// 카운터에 들어온다.
import { test, assert, eq } from '../../test/harness';
import { planEntry100x, MUTATING_DEPS, READONLY_DEPS } from './entry100x';
import { validateMarginAllocation } from './sizing100x';

const C = { leverage: 100, sizingPolicy: 'MARGIN_ALLOCATION' as const, marginModes: ['isolated'] };

const baseDeps = () => ({
  observeMarginMode: async () => 'isolated' as const,
  applyLeverage: async (lev: number) => ({ ok: true, observed: lev, message: '' }),
  availableUsd: async () => 1000,
  referencePrice: async () => 50_000,
  quantize: async (q: number) => ({ qty: q, message: '' }),
});

/** 의존을 감싸서 읽기/쓰기를 나눠 센다. 분류에 없는 의존은 즉시 실패다. */
function counted(over: Partial<ReturnType<typeof baseDeps>> = {}) {
  const c = { exchangeReads: 0, exchangeWrites: 0 };
  const base: any = { ...baseDeps(), ...over };
  const deps: any = {};
  for (const k of Object.keys(base)) {
    const fn = base[k];
    deps[k] = async (...a: any[]) => {
      if ((MUTATING_DEPS as readonly string[]).includes(k)) c.exchangeWrites++;
      else if ((READONLY_DEPS as readonly string[]).includes(k)) c.exchangeReads++;
      else throw new Error(`분류되지 않은 의존 ${k} — 통합 카운터 밖으로 샙니다`);
      return fn(...a);
    };
  }
  return { deps, c };
}

export function runEntry100xTests() {
  test('교차 마진이면 배율을 걸지 않는다 — 쓰기 0', async () => {
    const { deps, c } = counted({ observeMarginMode: async () => 'cross' as const });
    const v = await planEntry100x(C as any, 10, deps);
    assert(!v.ok, '교차 마진인데 통과했다');
    eq(v.code, 'MARGIN_MODE_NOT_ISOLATED');
    eq(c.exchangeWrites, 0, '막힐 요청이 계좌 설정을 바꿨다');
    assert(c.exchangeReads > 0, '마진 모드를 읽지도 않고 막았다 — 판정이 아니라 우연이다');
  });

  test('마진 모드를 못 읽으면 배율을 걸지 않는다 — 쓰기 0', async () => {
    const { deps, c } = counted({ observeMarginMode: async () => null });
    const v = await planEntry100x(C as any, 10, deps);
    assert(!v.ok);
    eq(v.code, 'MARGIN_MODE_UNKNOWN');
    eq(c.exchangeWrites, 0);
  });

  // ── 이 시험이 잡은 실제 결함 ──
  //
  // 배정 비율은 사용자가 넣은 숫자 하나라 거래소에 물어볼 것이 없다.
  // 그런데 그 검사가 `planSize100x` 안에만 있어서 **배율을 건 뒤에**
  // 불렸다. 비율이 비어 있으면 반드시 막히는데, 그 전에 계좌의 배율이
  // 이미 바뀌었다.
  test('배정 비율이 없으면 배율을 걸지 않는다 — 쓰기 0', async () => {
    const { deps, c } = counted();
    const v = await planEntry100x(C as any, null, deps);
    assert(!v.ok, '배정 비율이 없는데 통과했다');
    eq(c.exchangeWrites, 0, '어차피 막힐 요청이 계좌 배율을 먼저 바꿨다');
  });

  test('배정 비율이 범위 밖이면 배율을 걸지 않는다 — 쓰기 0', async () => {
    for (const bad of [0, -5, 101, NaN]) {
      const { deps, c } = counted();
      const v = await planEntry100x(C as any, bad, deps);
      assert(!v.ok, `배정 비율 ${bad}인데 통과했다`);
      eq(c.exchangeWrites, 0, `배정 비율 ${bad}로 막힐 요청이 계좌 설정을 바꿨다`);
    }
  });

  test('통과하는 요청은 거래소에 정확히 한 번 쓴다', async () => {
    const { deps, c } = counted();
    const v = await planEntry100x(C as any, 10, deps);
    assert(v.ok, `정상 입력이 막혔다 — ${v.message}`);
    eq(c.exchangeWrites, 1, '0이면 되읽기 없이 통과한 것이고, 2 이상이면 두 번 건다');
  });

  // 규칙이 두 벌이 되지 않았는가. 앞당긴 검사와 뒤의 검사가 같은 함수를
  // 써야 한다 — 갈리면 한쪽만 고쳐지는 고장이 그대로 돌아온다.
  test('배정 비율 검사는 한 벌이다', () => {
    assert(validateMarginAllocation(null) !== null, 'null을 통과시킨다');
    assert(validateMarginAllocation(0) !== null, '0을 통과시킨다');
    assert(validateMarginAllocation(101) !== null, '100 초과를 통과시킨다');
    eq(validateMarginAllocation(10), null, '정상 값을 막는다');
    eq(validateMarginAllocation(100), null, '경계값 100을 막는다');
  });

  test('되읽은 배율이 요청과 다르면 크기를 만들지 않는다', async () => {
    const { deps } = counted({
      applyLeverage: async () => ({ ok: true, observed: 75, message: '거래소가 낮춤' }),
    });
    const v = await planEntry100x(C as any, 10, deps);
    assert(!v.ok, '75배로 통과했다 — 사용자가 검증한 것과 다른 크기다');
    eq(v.code, 'LEVERAGE_NOT_EXACT');
  });
}
