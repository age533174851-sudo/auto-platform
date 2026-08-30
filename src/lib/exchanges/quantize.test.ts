import { test, eq, assert } from '../../test/harness';
import { quantizeOrder, floorToStep, roundToTick, decimalsOf } from './quantize';

export function runQuantizeTests() {
  console.log('[수량 단위 — [-1111] Precision is over the maximum]');

  // ── 실제로 났던 거부 ────────────────────────────────────
  test('0.09906 BTC는 0.099로 내려간다', () => {
    // 비율 버튼이 만든 값이 그대로 나가서 거래소가 -1111로 거부했다.
    const r = quantizeOrder(0.09906, null, { stepSize: 0.001, minQty: 0.001 });
    eq(r.ok, true);
    eq(r.quantity, 0.099);
    eq(r.changed, true);
  });

  test('바뀌었으면 반드시 말한다', () => {
    // 말없이 크기를 줄이면 "100%를 눌렀는데 왜 잔고가 남지"가 설명
    // 안 되는 상태로 남는다.
    const r = quantizeOrder(0.09906, null, { stepSize: 0.001 });
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
    const r = quantizeOrder(1, 63093.05, { stepSize: 0.001, tickSize: 0.1 });
    eq(r.price, 63093.1);
    eq(r.changed, true);
  });

  // ── 규격을 못 읽었을 때 ─────────────────────────────────
  test('규격을 못 읽으면 그대로 보낸다 — 기본값을 지어내지 않는다', () => {
    // 종목마다 단위가 다르다. 틀린 기본값으로 반올림하면 **맞는 수량을
    // 틀린 수량으로 바꾼다.** 거부당하는 것보다 나쁘다.
    const r = quantizeOrder(0.09906, null, null);
    eq(r.ok, true);
    eq(r.quantity, 0.09906);
    eq(r.applied, false);
    assert(r.reason.includes('읽지 못'), r.reason);
  });

  test('규격을 적용했는지 구분해서 돌려준다', () => {
    eq(quantizeOrder(1, null, { stepSize: 0.001 }).applied, true);
    eq(quantizeOrder(1, null, null).applied, false);
  });

  // ── 최소값 ──────────────────────────────────────────────
  test('내림했더니 0이면 주문하지 않는다', () => {
    const r = quantizeOrder(0.0005, null, { stepSize: 0.001 });
    eq(r.ok, false);
    eq(r.quantity, null);
    assert(r.reason.includes('최소 단위'), r.reason);
  });

  test('최소 수량보다 적으면 막는다', () => {
    const r = quantizeOrder(0.002, null, { stepSize: 0.001, minQty: 0.01 });
    eq(r.ok, false);
    assert(r.reason.includes('0.01'), r.reason);
  });

  test('최소 금액보다 적으면 막는다', () => {
    // 수량은 되는데 금액이 안 되는 경우가 따로 있다 (MIN_NOTIONAL).
    const r = quantizeOrder(0.001, 100, { stepSize: 0.001, minNotional: 5 });
    eq(r.ok, false);
    assert(r.reason.includes('최소 금액'), r.reason);
  });

  test('가격을 모르면 최소 금액은 못 본다 — 통과시킨다', () => {
    // 시장가 주문은 체결가를 모른다. 추측한 가격으로 막으면 멀쩡한
    // 주문이 막힌다. 거래소가 최종 판단한다.
    eq(quantizeOrder(0.001, null, { stepSize: 0.001, minNotional: 5 }).ok, true);
  });

  // ── 입력 ────────────────────────────────────────────────
  test('수량이 이상하면 막는다', () => {
    eq(quantizeOrder(0, null, { stepSize: 0.001 }).ok, false);
    eq(quantizeOrder(-1, null, { stepSize: 0.001 }).ok, false);
    eq(quantizeOrder(NaN, null, { stepSize: 0.001 }).ok, false);
  });

  test('안 바뀌었으면 changed는 false다', () => {
    const r = quantizeOrder(0.099, null, { stepSize: 0.001 });
    eq(r.changed, false);
    eq(r.quantity, 0.099);
  });

  test('큰 단위 종목도 맞춘다', () => {
    // 어떤 종목은 stepSize가 1이다 (계약 수).
    const r = quantizeOrder(3.7, null, { stepSize: 1, minQty: 1 });
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
    const r = quantizeOrder(0.0015, null, { stepSize: 0.001, minQty: 0.001 });
    eq(r.ok, true);
    eq(r.quantity, 0.001);
    assert((r.quantity as number) <= 0.0015, '수량이 커졌습니다');
  });

  test('한 단위보다 작으면 거절한다 — 올려서 만들지 않는다', () => {
    const r = quantizeOrder(0.0006, null, { stepSize: 0.001, minQty: 0.001 });
    eq(r.ok, false);
    eq(r.quantity, null);
    assert(/최소 단위/.test(String(r.reason)), String(r.reason));
  });

  test('단위에 딱 맞으면 그대로 둔다', () => {
    const r = quantizeOrder(0.002, null, { stepSize: 0.001, minQty: 0.001 });
    eq(r.ok, true);
    eq(r.quantity, 0.002);
    eq(r.changed, false);
  });

  test('Gate 계약 배수도 정수 계약으로 내림한다', () => {
    // Gate BTC_USDT는 1계약 = 0.0001 BTC. 배수를 stepSize로 놓으면
    // "기초자산 수량을 배수로 내림"이 곧 "정수 계약으로 내림"이 된다.
    const r = quantizeOrder(0.00035, null, { stepSize: 0.0001, minQty: 0.0001 });
    eq(r.ok, true);
    eq(r.quantity, 0.0003);                    // 3계약 — 3.5계약을 4로 올리지 않는다
    assert((r.quantity as number) <= 0.00035, '계약 수가 올라갔습니다');
  });

  test('**어떤 수량·단위를 넣어도 커지지 않는다**', () => {
    const steps = [0.001, 0.0001, 0.01, 0.1, 1, 25];
    const qtys = [0.0015, 0.0006, 0.09906, 1.9999, 3.7, 123.456, 0.5, 49.9];
    for (const step of steps) {
      for (const q of qtys) {
        const r = quantizeOrder(q, null, { stepSize: step });
        if (!r.ok) continue;                   // 거절은 커지는 것이 아니다
        assert((r.quantity as number) <= q,
          `수량이 커졌습니다: ${q} → ${r.quantity} (step ${step})`);
      }
    }
  });

  test('규격을 못 읽으면 지어내지 않는다 — 그대로 보내고 그렇다고 말한다', () => {
    const r = quantizeOrder(0.0015, null, null);
    eq(r.ok, true);
    eq(r.quantity, 0.0015);                    // 3자리로 반올림하지 않는다
    eq(r.applied, false);
    assert(/읽지 못했습니다/.test(String(r.reason)), String(r.reason));
  });
}
