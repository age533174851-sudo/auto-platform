// src/lib/exchanges/closeQty.test.ts
//
// 부분 청산 수량 계산.
//
// 여기서 틀리면 조용하다. 조금 더 닫히거나 덜 닫히는 것은 화면에서 알 수 없고,
// 그 차이가 남은 포지션의 청산가를 바꾼다. 그리고 수량을 **올려서** 계산하면
// 보유량을 넘겨 거래소가 거부하거나 반대 포지션이 열린다.

import { test, eq, assert } from '../../test/harness';
import { closeQuantityFor, prepareClosePosition } from './binanceFutures';

export function runCloseQtyTests() {
  console.log('[부분 청산 수량]');

  test('50%는 절반이다', () => {
    const r = closeQuantityFor(1.0, 50, 0.001, 0.001);
    eq(r.qty, 0.5);
    eq(r.fullClose, false);
  });

  test('100%는 전량이고 fullClose다', () => {
    const r = closeQuantityFor(0.437, 100, 0.001, 0.001);
    eq(r.qty, 0.437);
    eq(r.fullClose, true);
  });

  test('내림한다 — 올리면 보유량을 넘긴다', () => {
    // 0.333 × 30% = 0.0999 → step 0.001로 내림하면 0.099
    const r = closeQuantityFor(0.333, 30, 0.001, 0.001);
    eq(r.qty, 0.099);
    assert(r.qty <= 0.333 * 0.3, '올림이 일어났다');
  });

  test('음수 수량도 절댓값으로 본다 — 숏 포지션은 음수로 온다', () => {
    eq(closeQuantityFor(-2.0, 50, 0.001, 0.001).qty, 1.0);
  });

  test('포지션이 없으면 0이고 이유를 적는다', () => {
    const r = closeQuantityFor(0, 50, 0.001, 0.001);
    eq(r.qty, 0);
    eq(r.fullClose, false);
    assert(r.reason.includes('포지션'), r.reason);
  });

  console.log('[부분 청산 — 최소 단위]');

  test('계산값이 최소 단위 미만이면 전량으로 올린다', () => {
    // 0.002의 10% = 0.0002 → minQty 0.001 미만 → 전량
    const r = closeQuantityFor(0.002, 10, 0.001, 0.001);
    eq(r.qty, 0.002);
    eq(r.fullClose, true, '전량 종료임을 알려야 한다');
  });

  test('전량으로 올렸다는 사실을 숨기지 않는다', () => {
    const r = closeQuantityFor(0.002, 10, 0.001, 0.001);
    assert(r.reason.includes('전량'), `이유에 적어야 한다: ${r.reason}`);
    assert(r.reason.includes('10%'), `요청 비율도 적어야 한다: ${r.reason}`);
  });

  test('전량조차 최소 단위 미만이면 0이다 — 닫을 수 없다', () => {
    const r = closeQuantityFor(0.0005, 100, 0.001, 0.001);
    eq(r.qty, 0);
    eq(r.fullClose, false);
    assert(r.reason.includes('최소 단위'), r.reason);
  });

  console.log('[부분 청산 — 비율 조이기]');

  test('0%·음수·NaN은 거래하지 않는다 — 추측해서 청산하지 않는다', () => {
    // 처음에는 `Number(percent) || 100`으로 두고 "0이나 음수는 전량"이라고
    // 적었는데, 실제 동작은 음수를 1%로 조이고 있었다(주석과 코드가 달랐다).
    // 어느 쪽이든 잘못된 입력으로 실제 주문을 낸다. 100%면 전량이 날아가고
    // 1%면 요청하지 않은 거래가 나간다. 그래서 둘 다 하지 않는다.
    for (const bad of [0, -50, NaN, Infinity, -Infinity]) {
      const r = closeQuantityFor(1.0, bad as number, 0.001, 0.001);
      eq(r.qty, 0, `비율 ${String(bad)}로 주문이 나갔다`);
      assert(r.reason.includes('유효하지'), `이유를 적어야 한다: ${r.reason}`);
    }
  });

  test('100% 초과는 전량으로 조인다 — 보유량보다 많이 닫을 수 없다', () => {
    const r = closeQuantityFor(1.0, 150, 0.001, 0.001);
    eq(r.qty, 1.0);
    eq(r.fullClose, true);
  });

  test('1% 미만은 1%로 올린다', () => {
    // 0.5%는 1%로 조여진다 → 100 × 1% = 1
    eq(closeQuantityFor(100, 0.5, 0.001, 0.001).qty, 1);
  });

  console.log('[부분 청산 — step이 없을 때]');

  test('stepSize가 0이면 반올림하지 않는다 — 필터를 못 읽은 경우다', () => {
    const r = closeQuantityFor(1.0, 33, 0, 0);
    eq(Math.abs(r.qty - 0.33) < 1e-9, true, `기대 0.33, 실제 ${r.qty}`);
  });

  test('큰 step도 처리한다 — 정수 단위 심볼', () => {
    // step 1, 총 7개의 50% = 3.5 → 내림 3
    const r = closeQuantityFor(7, 50, 1, 1);
    eq(r.qty, 3);
    eq(r.fullClose, false);
  });

  test('step 1에서 1개 포지션의 50%는 전량이 된다', () => {
    // 1 × 50% = 0.5 → 내림 0 → minQty 1 미만 → 전량 1
    const r = closeQuantityFor(1, 50, 1, 1);
    eq(r.qty, 1);
    eq(r.fullClose, true);
  });

  // ── 못 읽은 보유량을 "없다"로 적지 않는다 ──
  //
  //   이 함수는 `percent`에 대해서는 이미 이 교훈을 적어 뒀다:
  //
  //       처음에는 `Number(percent) || 100`으로 두고 "0이나 음수는
  //       전량"이라고 적었다. … 추측해서 청산하지 않습니다
  //
  //   그런데 `totalQty`는 아직 `Number(totalQty) || 0`이다. 같은 함수
  //   안에서 **한쪽만 고쳐져 있다.** `Number('bad') || 0`은 0이므로
  //   `total <= 0`에 걸려 **'포지션이 없습니다'**라고 적힌다.
  //
  //   닫히지는 않으므로(qty 0) 거래는 안전한 쪽으로 실패한다. 틀린 것은
  //   **사람이 읽는 사실**이다 — 보유량을 못 읽은 것을 "포지션이 없다"고
  //   적으면, 그 화면을 보고 포지션이 정리됐다고 판단한다.
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'bad', '']) {
    test(`★★ 보유량을 못 읽으면 "없다"가 아니라 "모른다"다 (${String(bad)})`, () => {
      const r = closeQuantityFor(bad as any, 50, 0.001, 0.001);
      eq(r.qty, 0, '수량을 모르는데 청산 수량을 만들었다');
      eq(r.fullClose, false);
      assert(!/포지션이 없습니다/.test(r.reason),
        `못 읽은 보유량을 "없다"로 적었다: ${r.reason}`);
      assert(/확인하지 못|유효하지 않/.test(r.reason),
        `모른다는 사실이 사유에 없다: ${r.reason}`);
    });
  }

  test('★ 진짜 0은 그대로 "없다"다 — 과잉 차단하지 않는다', () => {
    const r = closeQuantityFor(0, 50, 0.001, 0.001);
    eq(r.qty, 0);
    assert(/포지션이 없습니다/.test(r.reason), `진짜 0의 사유가 바뀌었다: ${r.reason}`);
  });

  // ── 방향 불일치와 "수량을 못 읽음"은 다른 사실이다 ──
  //
  //   `getFuturesPositions`는 `parseFloat(p.positionAmt) !== 0`으로
  //   거른다. `parseFloat('bad')`는 `NaN`이고 `NaN !== 0`은 **true**라
  //   깨진 줄이 **통과한다.** 그 줄은 이렇게 정규화된다:
  //
  //       side: amt > 0 ? 'LONG' : amt < 0 ? 'SHORT' : 'FLAT'   // → 'FLAT'
  //       amount: Math.abs(amt)                                 // → NaN
  //
  //   `'FLAT'`은 **지어낸 관측**이다. 그래서 `prepareClosePosition`은
  //   `pos.side !== positionSide`에 걸려 **"방향 불일치 — 요청 LONG,
  //   실제 FLAT"**이라고 답한다. 상태가 어긋난 것이 아니라 수량을 못
  //   읽은 것인데, 그 화면을 보면 없는 불일치를 찾게 된다.
  test('★★ 수량을 못 읽은 줄을 "방향 불일치"로 적지 않는다', async () => {
    const r = await prepareClosePosition(
      'K', 'S', 'BTCUSDT', 'LONG', 100, true, null,
      {
        fetchPositions: async () => ({
          success: true, message: '1개 포지션',
          positions: [{
            symbol: 'BTCUSDT', side: 'FLAT', amount: NaN,
            entryPrice: 95000, markPrice: 95000, unrealizedPnl: 0,
            leverage: 100, liquidationPrice: 90000, marginType: 'isolated',
          }],
        }),
        fetchFilters: async () => ({ stepSize: 0.001, minQty: 0.001 } as any),
      });
    eq(r.ok, false, '수량을 모르는데 청산을 준비했다');
    eq(r.alreadyFlat, false, '못 읽은 것을 flat으로 읽었다');
    assert(!/방향 불일치/.test(r.message),
      `수량 미확인을 방향 불일치로 적었다: ${r.message}`);
    assert(!/포지션이 없습니다/.test(r.message),
      `수량 미확인을 "없다"로 적었다: ${r.message}`);
    assert(/확인하지 못|유효하지 않/.test(r.message),
      `모른다는 사실이 메시지에 없다: ${r.message}`);
  });

  // 강제 변환이 남은 자리 — #540·#541의 입력 계약과 같은 규칙인가.
  test('★★ boolean·배열·객체를 수량으로 인정하지 않는다', () => {
    for (const bad of [true, false, [], {}, [1], '0x10']) {
      const r = closeQuantityFor(bad as any, 50, 0.001, 0.001);
      eq(r.qty, 0, `${JSON.stringify(bad)}을 수량으로 읽었다`);
      assert(/확인하지 못/.test(r.reason),
        `${JSON.stringify(bad)}의 사유가 "모른다"가 아니다: ${r.reason}`);
    }
  });
}
