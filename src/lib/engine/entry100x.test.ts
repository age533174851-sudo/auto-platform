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
import {
  prepareEntry100x, commitEntry100x, MUTATING_DEPS, READONLY_DEPS,
} from './entry100x';
import { validateMarginAllocation, planSize100x, verifyLeverageExact } from './sizing100x';

const C = { leverage: 100, sizingPolicy: 'MARGIN_ALLOCATION' as const, marginModes: ['isolated'] };

const baseDeps = () => ({
  observeMarginMode: async (): Promise<'isolated' | 'cross' | null> => 'isolated',
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

/** 두 단계를 이어 부르는 시험용 합성 — 최종 판정 기대는 그대로여야 한다. */
const planEntry100x = async (c: any, pct: number | null, deps: any) =>
  commitEntry100x(await prepareEntry100x(c, pct, deps), deps);

export function runEntry100xTests() {
  test('교차 마진이면 배율을 걸지 않는다 — 쓰기 0', async () => {
    const { deps, c } = counted({ observeMarginMode: async () => 'cross' });
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

  // ── 규칙은 그 함수 안에서도 살아 있어야 한다 ──
  //
  // 위 시험들은 `planEntry100x`를 통해 본다. 그런데 `planSize100x`는
  // 따로 내보내는 함수라 다른 곳에서 직접 불릴 수 있다. 호출부가 먼저
  // 막아 준다는 이유로 이 함수 안의 규칙이 느슨해지면, 그 다른 호출부는
  // 보호받지 못한다.
  test('planSize100x 자체가 배정 비율 미지정을 막는다 — 기본값을 빌리지 않는다', () => {
    const v = planSize100x({
      requiredLeverage: 100,
      availableUsd: 1000, marginAllocationPct: null, referencePrice: 50_000,
    });
    assert(!v.ok, '배정 비율이 없는데 수량을 냈다 — 화면 기본값을 빌려 쓴 것이다');
    eq(v.code, 'MARGIN_ALLOCATION_UNSET');
    eq(v.quantity, null);
  });

  test('planSize100x 자체가 범위 밖 배정 비율을 막는다', () => {
    for (const bad of [0, -1, 101]) {
      const v = planSize100x({
        requiredLeverage: 100,
        availableUsd: 1000, marginAllocationPct: bad, referencePrice: 50_000,
      });
      assert(!v.ok, `배정 비율 ${bad}로 수량을 냈다`);
      eq(v.code, 'MARGIN_ALLOCATION_INVALID');
    }
  });

  // ══════════════════════════════════════════════════════════
  // 순서를 이름으로 기록해서 직접 확인한다
  // ══════════════════════════════════════════════════════════
  //
  // 앞의 시험들은 "쓰기가 몇 번인가"를 센다. 그것만으로는 **쓰기가 어느
  // 자리에 있는가**를 못 본다. 잔고를 읽기 전에 배율을 걸어도 쓰기는
  // 여전히 1번이다.
  //
  // 그래서 호출을 일어난 순서대로 적고, 그 배열을 그대로 비교한다.

  /**
   * 호출을 순서대로 적는 가짜 어댑터.
   *
   * 덮어쓴 구현도 **여전히 기록된다.** 처음엔 `...over`를 뒤에 폈더니
   * 덮어쓴 칸이 기록을 안 남겨서, 실패 경로의 순서가 빈 배열로 나왔다 —
   * 기록이 빠지면 "안 불렸다"와 구분되지 않는다.
   */
  function logged(over: any = {}) {
    const log: string[] = [];
    const base: any = {
      observeMarginMode: async () => 'isolated',
      availableUsd: async () => 1000,
      referencePrice: async () => 50_000,
      quantize: async (q: number) => ({ qty: q, message: '' }),
      applyLeverage: async (lev: number) => ({ ok: true, observed: lev, message: '' }),
      ...over,
    };
    const label: Record<string, string[]> = {
      observeMarginMode: ['marginMode:read'],
      availableUsd: ['balance:read'],
      referencePrice: ['price:read'],
      quantize: ['quantize'],
      applyLeverage: ['leverage:write', 'leverage:readback'],
    };
    const d: any = {};
    for (const k of Object.keys(base)) {
      const fn = base[k];
      d[k] = async (...a: any[]) => {
        for (const t of label[k] || [k]) log.push(t);
        return fn(...a);
      };
    }
    return { d, log };
  }

  test('정상 경로의 호출 순서 — 배율 쓰기는 모든 읽기 뒤에 있다', async () => {
    const { d, log } = logged();
    const prep = await prepareEntry100x(C as any, 10, d);
    assert(prep.ok, `준비 단계가 막혔다 — ${prep.message}`);

    // 준비 단계가 끝난 시점에 쓰기는 하나도 없어야 한다.
    eq(log.join(' > '), 'marginMode:read > balance:read > price:read > quantize',
      '준비 단계의 호출 순서가 다르다 — 쓰기가 섞여 있으면 여기서 드러난다');

    const done = await commitEntry100x(prep, d);
    assert(done.ok, `확정 단계가 막혔다 — ${done.message}`);
    eq(log.join(' > '),
      'marginMode:read > balance:read > price:read > quantize > leverage:write > leverage:readback',
      '전체 호출 순서가 계약과 다르다');
  });

  // 읽기 실패는 전부 쓰기 0이어야 한다. 하나씩 실패시켜 순서를 확인한다.
  for (const [label, over, wantLog] of [
    ['잔고를 못 읽음', { availableUsd: async () => null },
      'marginMode:read > balance:read > price:read'],
    ['기준가를 못 읽음', { referencePrice: async () => null },
      'marginMode:read > balance:read > price:read'],
    ['규격에 못 맞춤', { quantize: async () => ({ qty: null, message: '규격 없음' }) },
      'marginMode:read > balance:read > price:read > quantize'],
    ['마진 모드가 교차', { observeMarginMode: async () => 'cross' },
      'marginMode:read'],
    ['마진 모드를 못 읽음', { observeMarginMode: async () => null },
      'marginMode:read'],
  ] as const) {
    test(`${label} → 배율을 걸지 않는다 (순서까지 확인)`, async () => {
      const { d, log } = logged(over);
      const prep = await prepareEntry100x(C as any, 10, d);
      assert(!prep.ok, `${label}인데 통과했다`);
      assert(!log.includes('leverage:write'),
        `${label}으로 막힐 요청이 거래소에 배율을 걸었다 — ${log.join(' > ')}`);
      eq(log.join(' > '), wantLog, '막히기까지의 호출 순서가 다르다');

      // 확정 단계를 잘못 불러도 쓰지 않는다 — 호출부가 순서를 어겨도 막는다.
      await commitEntry100x(prep, d);
      assert(!log.includes('leverage:write'),
        '막힌 계획으로 확정 단계를 불렀더니 거래소에 썼다');
    });
  }

  test('다듬은 수량의 증거금이 배정을 넘으면 배율을 걸지 않는다', async () => {
    // 올림 때문에 필요 증거금이 배정을 넘는 경우.
    const { d, log } = logged({ quantize: async (q: number) => ({ qty: q * 2, message: '' }) });
    const prep = await prepareEntry100x(C as any, 10, d);
    assert(!prep.ok, '배정을 넘는데 통과했다');
    eq(prep.code, 'MARGIN_EXCEEDED');
    assert(!log.includes('leverage:write'),
      '배정 초과로 막힐 요청이 계좌 배율을 먼저 바꿨다');
  });

  // ── 확정 단계에서만 남는 차단 ──
  //
  // 걸어 봐야 아는 것 하나뿐이다. 느슨해진 것이 없는지 확인한다.
  for (const [label, observed] of [['75배', 75], ['99배', 99], ['못 읽음', null]] as const) {
    test(`되읽은 배율이 ${label}이면 확정이 실패한다 — 주문으로 가지 않는다`, async () => {
      const { d } = logged({
        applyLeverage: async () => ({ ok: true, observed: observed as any, message: '되읽음' }),
      });
      const prep = await prepareEntry100x(C as any, 10, d);
      assert(prep.ok);
      const done = await commitEntry100x(prep, d);
      assert(!done.ok, `${label}인데 주문 단계로 갔다`);
      eq(done.code, 'LEVERAGE_NOT_EXACT');
    });
  }

  test('배율 설정 자체가 실패하면 확정이 실패한다', async () => {
    const { d } = logged({
      applyLeverage: async () => ({ ok: false, observed: 100, message: '거래소 거절' }),
    });
    const prep = await prepareEntry100x(C as any, 10, d);
    const done = await commitEntry100x(prep, d);
    assert(!done.ok, '설정이 실패했는데 통과했다');
    eq(done.code, 'LEVERAGE_NOT_EXACT');
  });

  // 후보 수량은 요구 배율로 계산된다 — 되읽은 값이 없어도 나와야 한다.
  // 그것이 쓰기 전에 계산할 수 있게 된 이유다.
  test('후보 수량은 되읽은 배율 없이도 계산된다', () => {
    const v = planSize100x({
      requiredLeverage: 100, availableUsd: 1000,
      marginAllocationPct: 10, referencePrice: 50_000,
    });
    assert(v.ok, `후보 수량이 안 나왔다 — ${v.message}`);
    eq(v.allocatedMargin, 100);
    eq(v.targetNotional, 10_000);
    eq(v.quantity, 0.2);
  });

  test('정확 배율 확인은 한 곳에 있다', () => {
    eq(verifyLeverageExact(100, 100), null);
    assert(verifyLeverageExact(100, 75) !== null, '75배를 통과시킨다');
    assert(verifyLeverageExact(100, 99) !== null, '99배를 통과시킨다');
    assert(verifyLeverageExact(100, null) !== null, '못 읽었는데 통과시킨다');
  });
}
