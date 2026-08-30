import { test, eq, assert } from '../../test/harness';
import {
  quantizeOrder, floorToStep, roundToTick, decimalsOf, qtyGridFor,
  type SymbolFilters,
} from './quantize';

/**
 * 옛 한 벌짜리 규격을 새 모양으로 적는다.
 *
 * 두 격자에 같은 값을 넣는 것은 "주문유형과 무관한 규격"이라는 뜻이고,
 * 아래 주문유형 시험들은 **일부러 두 값을 다르게** 준다.
 */
const flat = (f: {
  stepSize?: number | null; minQty?: number | null;
  tickSize?: number | null; minNotional?: number | null;
}): SymbolFilters => ({
  limitQty: { stepSize: f.stepSize ?? null, minQty: f.minQty ?? null },
  marketQty: { stepSize: f.stepSize ?? null, minQty: f.minQty ?? null },
  tickSize: f.tickSize ?? null,
  minNotional: f.minNotional ?? null,
});

export function runQuantizeTests() {
  console.log('[수량 단위 — [-1111] Precision is over the maximum]');

  // ── 실제로 났던 거부 ────────────────────────────────────
  test('0.09906 BTC는 0.099로 내려간다', () => {
    // 비율 버튼이 만든 값이 그대로 나가서 거래소가 -1111로 거부했다.
    const r = quantizeOrder(0.09906, null, flat({ stepSize: 0.001, minQty: 0.001 }));
    eq(r.ok, true);
    eq(r.quantity, 0.099);
    eq(r.changed, true);
  });

  test('바뀌었으면 반드시 말한다', () => {
    // 말없이 크기를 줄이면 "100%를 눌렀는데 왜 잔고가 남지"가 설명
    // 안 되는 상태로 남는다.
    const r = quantizeOrder(0.09906, null, flat({ stepSize: 0.001 }));
    assert(r.reason.includes('0.09906'), r.reason);
    assert(r.reason.includes('0.099'), r.reason);
  });

  // ── 내림 ────────────────────────────────────────────────
  test('올리지 않고 내린다', () => {
    // 올리면 가진 것보다 많이 사려다 거부당한다.
    eq(floorToStep(0.0999, 0.001), 0.099);
    eq(floorToStep(1.9999, 1), 1);
  });

  test('딱 맞는 값은 그대로 둔다', () => {
    // 0.3 / 0.1 = 2.9999… 부동소수 문제로 한 칸 내려가면 안 된다.
    eq(floorToStep(0.3, 0.1), 0.3);
    eq(floorToStep(0.099, 0.001), 0.099);
    eq(floorToStep(7, 1), 7);
  });

  test('단위가 없으면 건드리지 않는다', () => {
    eq(floorToStep(0.09906, 0), 0.09906);
    eq(floorToStep(0.09906, NaN), 0.09906);
  });

  test('소수 자리를 단위에서 뽑는다', () => {
    eq(decimalsOf(0.001), 3);
    eq(decimalsOf(1), 0);
    eq(decimalsOf(0.00100), 3);   // 뒤쪽 0은 안 센다
    eq(decimalsOf(0.1), 1);
  });

  // ── 가격 ────────────────────────────────────────────────
  test('가격은 가까운 쪽으로 반올림한다', () => {
    // 지정가는 내려도 올려도 되고, 가까운 쪽이 의도에 맞다.
    eq(roundToTick(63093.05, 0.1), 63093.1);
    eq(roundToTick(63093.04, 0.1), 63093.0);
  });

  test('가격 단위가 없으면 건드리지 않는다', () => {
    eq(roundToTick(63093.05, 0), 63093.05);
  });

  test('지정가 주문에서 가격도 맞춘다', () => {
    const r = quantizeOrder(1, 63093.05, flat({ stepSize: 0.001, tickSize: 0.1 }));
    eq(r.price, 63093.1);
    eq(r.changed, true);
  });

  // ── 규격을 못 읽었을 때: **신규 진입과 청산이 다르다** ──
  //
  // 예전에는 둘 다 그대로 보냈다. 규격을 모르는 채로 새 포지션을 여는 것은
  // 거부당하는 것보다 나쁘다 — 실제 돈이 나간다. 반대로 청산까지 막으면
  // 포지션에서 빠져나갈 길이 없어진다.
  test('규격을 못 읽으면 신규 진입은 막는다', () => {
    const r = quantizeOrder(0.09906, null, null);
    eq(r.ok, false);
    eq(r.code, 'FILTERS_UNKNOWN');
    eq(r.quantity, null);
    assert(r.reason.includes('읽지 못'), r.reason);
  });

  test('**규격을 못 읽어도 청산은 보낸다** — 못 닫는 것이 더 위험하다', () => {
    const r = quantizeOrder(0.09906, null, null, { reduceOnly: true });
    eq(r.ok, true);
    eq(r.quantity, 0.09906);     // 기본값으로 반올림하지 않는다
    eq(r.applied, false);
    eq(r.code, null);
    assert(r.reason.includes('청산'), r.reason);
  });

  test('규격을 적용했는지 구분해서 돌려준다', () => {
    eq(quantizeOrder(1, null, flat({ stepSize: 0.001 })).applied, true);
    eq(quantizeOrder(1, null, null, { reduceOnly: true }).applied, false);
  });

  // ── 최소값 ──────────────────────────────────────────────
  test('내림했더니 0이면 주문하지 않는다', () => {
    const r = quantizeOrder(0.0005, null, flat({ stepSize: 0.001 }));
    eq(r.ok, false);
    eq(r.quantity, null);
    assert(r.reason.includes('최소 단위'), r.reason);
  });

  test('최소 수량보다 적으면 막는다', () => {
    const r = quantizeOrder(0.002, null, flat({ stepSize: 0.001, minQty: 0.01 }));
    eq(r.ok, false);
    assert(r.reason.includes('0.01'), r.reason);
  });

  test('지정가는 지정가로 최소 금액을 본다', () => {
    // 수량은 되는데 금액이 안 되는 경우가 따로 있다 (MIN_NOTIONAL).
    const r = quantizeOrder(0.001, 100, flat({ stepSize: 0.001, minNotional: 5 }),
      { orderType: 'LIMIT' });
    eq(r.ok, false);
    eq(r.code, 'BELOW_MIN_NOTIONAL');
    assert(r.reason.includes('최소 금액'), r.reason);
  });

  test('시장가는 **서버가 읽은 마크가**로 최소 금액을 본다', () => {
    const f = flat({ stepSize: 0.001, minNotional: 5 });
    const bad = quantizeOrder(0.001, null, f, { marketReferencePrice: 100 });
    eq(bad.ok, false);
    eq(bad.code, 'BELOW_MIN_NOTIONAL');
    const ok = quantizeOrder(0.001, null, f, { marketReferencePrice: 9000 });
    eq(ok.ok, true);
  });

  test('시장가인데 기준가를 못 읽으면 **지어내지 않고 막는다**', () => {
    const r = quantizeOrder(0.001, null, flat({ stepSize: 0.001, minNotional: 5 }));
    eq(r.ok, false);
    eq(r.code, 'REFERENCE_PRICE_UNKNOWN');
  });

  test('청산에는 최소 금액을 적용하지 않는다', () => {
    // 남은 포지션이 최소 금액보다 작아졌다고 닫지 못하게 하면 빠져나갈
    // 길이 없다.
    const r = quantizeOrder(0.001, 100, flat({ stepSize: 0.001, minNotional: 5 }),
      { orderType: 'LIMIT', reduceOnly: true });
    eq(r.ok, true);
    eq(r.quantity, 0.001);
  });

  test('최소 금액 규칙이 없으면 그 검사는 하지 않는다 — Gate가 그렇다', () => {
    eq(quantizeOrder(0.001, null, flat({ stepSize: 0.001 })).ok, true);
  });

  // ── 주문유형마다 수량 격자가 다르다 (바이낸스 LOT_SIZE / MARKET_LOT_SIZE) ──

  const TWO_GRID: SymbolFilters = {
    limitQty: { stepSize: 0.001, minQty: 0.001 },
    marketQty: { stepSize: 0.01, minQty: 0.01 },
    tickSize: 0.1,
    minNotional: 5,
  };

  test('**시장가는 MARKET_LOT_SIZE로, 지정가는 LOT_SIZE로 자른다**', () => {
    eq(qtyGridFor(TWO_GRID, 'LIMIT')!.stepSize, 0.001);
    eq(qtyGridFor(TWO_GRID, 'MARKET')!.stepSize, 0.01);

    // 시장가: 0.015 → 0.01 → 4 USDT → 최소 5 미달
    const m = quantizeOrder(0.015, null, TWO_GRID,
      { orderType: 'MARKET', marketReferencePrice: 400 });
    eq(m.ok, false);
    eq(m.code, 'BELOW_MIN_NOTIONAL');

    // 지정가: 0.015 그대로 → 6 USDT → 통과
    const l = quantizeOrder(0.015, 400, TWO_GRID, { orderType: 'LIMIT' });
    eq(l.ok, true);
    eq(l.quantity, 0.015);
  });

  test('시장가 격자가 없으면 지정가 격자를 대신 쓰지 않는다', () => {
    const onlyLimit: SymbolFilters = {
      limitQty: { stepSize: 0.001, minQty: 0.001 }, marketQty: null,
      tickSize: 0.1, minNotional: null,
    };
    eq(qtyGridFor(onlyLimit, 'MARKET'), null);
    // 거래소가 시장가 격자를 두지 않았으므로 깎지 않는다.
    const r = quantizeOrder(0.0159, null, onlyLimit, { orderType: 'MARKET' });
    eq(r.ok, true);
    eq(r.quantity, 0.0159);
  });

  test('**자른 뒤의 수량으로 최소 금액을 본다** — 원본으로 통과시키지 않는다', () => {
    // 원본 0.0016666… × 60,000 = 100으로 최소를 넘지만,
    // stepSize 0.001로 내리면 0.001 × 60,000 = 60이 되어 미달이다.
    const f = flat({ stepSize: 0.001, minNotional: 100 });
    const r = quantizeOrder(100 / 60_000, null, f, { marketReferencePrice: 60_000 });
    eq(r.ok, false);
    eq(r.code, 'BELOW_MIN_NOTIONAL');
    assert(r.reason.includes('60.00'), r.reason);
  });

  // ── 입력 ────────────────────────────────────────────────
  test('수량이 이상하면 막는다', () => {
    eq(quantizeOrder(0, null, flat({ stepSize: 0.001 })).ok, false);
    eq(quantizeOrder(-1, null, flat({ stepSize: 0.001 })).ok, false);
    eq(quantizeOrder(NaN, null, flat({ stepSize: 0.001 })).ok, false);
  });

  test('안 바뀌었으면 changed는 false다', () => {
    const r = quantizeOrder(0.099, null, flat({ stepSize: 0.001 }));
    eq(r.changed, false);
    eq(r.quantity, 0.099);
  });

  test('큰 단위 종목도 맞춘다', () => {
    // 어떤 종목은 stepSize가 1이다 (계약 수).
    const r = quantizeOrder(3.7, null, flat({ stepSize: 1, minQty: 1 }));
    eq(r.quantity, 3);
  });

  // ── 신규 진입에서 수량은 **절대 커지지 않는다** ────────────
  //
  // 화면이 `Number(qty.toFixed(3))`으로 보내고 있었다. 소수 3자리
  // *반올림*이라 의도한 0.0015가 **0.002로 커져서** 나갔고, 서버가 그 뒤에
  // stepSize 0.001로 정상 내림해도 이미 0.002라 되돌아갈 이유가 없다 —
  // 사용자가 누른 것보다 큰 주문이 체결된다.
  //
  // 이제 화면은 의도한 수량을 그대로 보내고, 규격은 여기서만 정한다.
  // 이 묶음이 지키는 것은 하나다: **최종 수량 ≤ 의도 수량.**

  test('0.0015는 0.001로 내려간다 — 0.002가 되지 않는다', () => {
    const r = quantizeOrder(0.0015, null, flat({ stepSize: 0.001, minQty: 0.001 }));
    eq(r.ok, true);
    eq(r.quantity, 0.001);
    assert((r.quantity as number) <= 0.0015, '수량이 커졌습니다');
  });

  test('한 단위보다 작으면 거절한다 — 올려서 만들지 않는다', () => {
    const r = quantizeOrder(0.0006, null, flat({ stepSize: 0.001, minQty: 0.001 }));
    eq(r.ok, false);
    eq(r.quantity, null);
    assert(/최소 단위/.test(String(r.reason)), String(r.reason));
  });

  test('단위에 딱 맞으면 그대로 둔다', () => {
    const r = quantizeOrder(0.002, null, flat({ stepSize: 0.001, minQty: 0.001 }));
    eq(r.ok, true);
    eq(r.quantity, 0.002);
    eq(r.changed, false);
  });

  test('Gate 계약 배수도 정수 계약으로 내림한다', () => {
    // Gate BTC_USDT는 1계약 = 0.0001 BTC. 배수를 stepSize로 놓으면
    // "기초자산 수량을 배수로 내림"이 곧 "정수 계약으로 내림"이 된다.
    const r = quantizeOrder(0.00035, null, flat({ stepSize: 0.0001, minQty: 0.0001 }));
    eq(r.ok, true);
    eq(r.quantity, 0.0003);                    // 3계약 — 3.5계약을 4로 올리지 않는다
    assert((r.quantity as number) <= 0.00035, '계약 수가 올라갔습니다');
  });

  test('**어떤 수량·단위를 넣어도 커지지 않는다**', () => {
    const steps = [0.001, 0.0001, 0.01, 0.1, 1, 25];
    const qtys = [0.0015, 0.0006, 0.09906, 1.9999, 3.7, 123.456, 0.5, 49.9];
    for (const step of steps) {
      for (const q of qtys) {
        const r = quantizeOrder(q, null, flat({ stepSize: step }));
        if (!r.ok) continue;                   // 거절은 커지는 것이 아니다
        assert((r.quantity as number) <= q,
          `수량이 커졌습니다: ${q} → ${r.quantity} (step ${step})`);
      }
    }
  });

  // ── Gate: 최소 주문 정본은 **계약 수**다 ──
  test('Gate는 1계약 미만이면 막고, 금액이 작다는 이유로는 막지 않는다', () => {
    // BTC_USDT는 1계약 = 0.0001 BTC. minNotional은 Gate가 주지 않으므로 null이다.
    const gate: SymbolFilters = {
      limitQty: { stepSize: 0.0001, minQty: 0.0001 },
      marketQty: { stepSize: 0.0001, minQty: 0.0001 },
      tickSize: 0.1, minNotional: null,
    };
    // 1계약 미만
    const tooSmall = quantizeOrder(0.00005, null, gate, { marketReferencePrice: 60_000 });
    eq(tooSmall.ok, false);
    // 1계약 이상이면 통과한다. 명목가 6 USDT는 20 USDT 미만이지만
    // **그 이유로는 막지 않는다** — Gate에 그런 규칙이 없다.
    const ok = quantizeOrder(0.0001, null, gate, { marketReferencePrice: 60_000 });
    eq(ok.ok, true);
    eq(ok.quantity, 0.0001);
    eq(ok.code, null);
  });

  test('규격을 못 읽으면 지어내지 않는다 — 청산은 그대로, 신규는 막는다', () => {
    const exit = quantizeOrder(0.0015, null, null, { reduceOnly: true });
    eq(exit.ok, true);
    eq(exit.quantity, 0.0015);                 // 3자리로 반올림하지 않는다
    eq(exit.applied, false);
    eq(quantizeOrder(0.0015, null, null).ok, false);
  });
}
