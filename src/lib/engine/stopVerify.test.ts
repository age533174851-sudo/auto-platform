import { test, eq, assert } from '../../test/harness';
import { verifyStopAttached, shouldUnwind, findAnyStop, type OpenOrderLike } from './stopVerify';

export function runStopVerifyTests() {
  console.log('[손절 되읽기 — 200을 받았다고 걸린 것은 아니다]');

  const WANT = { symbol: 'BTCUSDT', side: 'SELL' as const, stopPrice: 100 };
  const stop = (o: Partial<OpenOrderLike> = {}): OpenOrderLike => ({
    symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 100, orderId: 7, ...o,
  });

  // ── 있음 ────────────────────────────────────────────────
  test('그 손절이 주문장에 있으면 attached', () => {
    const r = verifyStopAttached([stop()], WANT);
    eq(r.status, 'attached');
    eq(r.orderId, '7');
    eq(r.foundStopPrice, 100);
  });

  test('틱 반올림만큼 어긋나도 같은 손절로 본다', () => {
    // 거래소가 틱 단위로 반올림한다. 정확히 같기를 요구하면 멀쩡한 손절을
    // '없음'으로 보고 포지션을 청산한다.
    eq(verifyStopAttached([stop({ stopPrice: 100.3 })], WANT).status, 'attached');
    eq(verifyStopAttached([stop({ stopPrice: 99.7 })], WANT).status, 'attached');
  });

  test('허용 오차를 넘으면 다른 주문이다', () => {
    // 5% 떨어진 발동가는 반올림이 아니다 — 다른 값이 걸렸다는 뜻이고,
    // 그러면 포지션 크기를 정당화하던 손실 거리가 그 값이 아니다.
    eq(verifyStopAttached([stop({ stopPrice: 105 })], WANT).status, 'missing');
  });

  test('문자열 가격도 읽는다 — 바이낸스는 문자열로 준다', () => {
    eq(verifyStopAttached([stop({ stopPrice: '100.0' })], WANT).status, 'attached');
  });

  test('게이트식 triggerPrice도 읽는다', () => {
    eq(verifyStopAttached(
      [stop({ stopPrice: null, triggerPrice: 100 })], WANT).status, 'attached');
  });

  test('stopPrice가 없으면 price로 본다', () => {
    eq(verifyStopAttached(
      [stop({ stopPrice: null, triggerPrice: null, price: 100 })], WANT).status, 'attached');
  });

  test('여러 주문 중에서 찾는다', () => {
    const r = verifyStopAttached([
      stop({ type: 'LIMIT', stopPrice: 100, orderId: 1 }),
      stop({ symbol: 'ETHUSDT', orderId: 2 }),
      stop({ orderId: 3 }),
    ], WANT);
    eq(r.status, 'attached');
    eq(r.orderId, '3');
  });

  // ── 없음 ────────────────────────────────────────────────
  test('빈 목록은 확인된 없음이다', () => {
    // 빈 배열은 "읽었는데 없다"이다. null과 반드시 달라야 한다.
    eq(verifyStopAttached([], WANT).status, 'missing');
  });

  test('익절만 걸려 있으면 손절 없음이다', () => {
    // 둘을 섞으면 익절만 남은 포지션이 '손절 있음'으로 통과한다. 그러면
    // 반대로 갔을 때 막아줄 것이 아무것도 없다.
    eq(verifyStopAttached([stop({ type: 'TAKE_PROFIT_MARKET' })], WANT).status, 'missing');
    eq(verifyStopAttached([stop({ type: 'TAKE_PROFIT' })], WANT).status, 'missing');
  });

  test('방향이 반대면 이 포지션의 손절이 아니다', () => {
    // 롱을 닫는 손절은 SELL이다. BUY 스톱은 숏의 손절이거나 신규 진입이다.
    eq(verifyStopAttached([stop({ side: 'BUY' })], WANT).status, 'missing');
  });

  test('다른 심볼이면 아니다', () => {
    eq(verifyStopAttached([stop({ symbol: 'ETHUSDT' })], WANT).status, 'missing');
  });

  test('손절이 아닌 종류는 세지 않는다', () => {
    eq(verifyStopAttached([stop({ type: 'LIMIT' })], WANT).status, 'missing');
    eq(verifyStopAttached([stop({ type: 'MARKET' })], WANT).status, 'missing');
    eq(verifyStopAttached([stop({ type: null })], WANT).status, 'missing');
  });

  test('발동가를 못 읽는 주문은 세지 않는다', () => {
    // 종류는 STOP인데 가격이 안 읽히면 어디에 걸렸는지 모른다. 모르는 것을
    // 유리하게 읽지 않는다.
    eq(verifyStopAttached(
      [stop({ stopPrice: null, triggerPrice: null, price: null })], WANT).status, 'missing');
    eq(verifyStopAttached([stop({ stopPrice: 'abc' })], WANT).status, 'missing');
    eq(verifyStopAttached([stop({ stopPrice: 0 })], WANT).status, 'missing');
  });

  // ── 확인 불가 ────────────────────────────────────────────
  test('못 읽었으면 없음이 아니라 확인 불가다', () => {
    // 이게 이 파일에서 제일 중요한 줄이다. 조회 실패를 '손절 없음'으로
    // 처리하면 조회가 한 번 튈 때마다 멀쩡한 포지션이 시장가로 닫힌다.
    eq(verifyStopAttached(null, WANT).status, 'unknown');
    eq(verifyStopAttached(undefined, WANT).status, 'unknown');
    eq(verifyStopAttached('오류' as any, WANT).status, 'unknown');
    eq(verifyStopAttached({} as any, WANT).status, 'unknown');
  });

  test('확인할 손절가 자체가 없으면 확인 불가다', () => {
    // 손절가가 0/NaN이면 무엇을 찾아야 할지 모른다. 이때 '없음'이라 하면
    // 애초에 손절을 안 건 경우까지 청산으로 몰고 간다.
    eq(verifyStopAttached([stop()], { ...WANT, stopPrice: 0 }).status, 'unknown');
    eq(verifyStopAttached([stop()], { ...WANT, stopPrice: NaN }).status, 'unknown');
    eq(verifyStopAttached([stop()], { ...WANT, stopPrice: null as any }).status, 'unknown');
  });

  test('확인 불가에는 주문 id를 붙이지 않는다', () => {
    const r = verifyStopAttached(null, WANT);
    eq(r.orderId, null);
    eq(r.foundStopPrice, null);
    assert(r.reason.length > 0, '이유가 비어 있으면 로그에서 알 수 없다');
  });

  // ── 되돌릴지 판단 ────────────────────────────────────────
  test('되돌리는 것은 확인된 없음일 때뿐이다', () => {
    eq(shouldUnwind(verifyStopAttached([], WANT)), true);
    eq(shouldUnwind(verifyStopAttached([stop()], WANT)), false);
    eq(shouldUnwind(verifyStopAttached(null, WANT)), false);
  });

  // ── 잡스러운 입력 ────────────────────────────────────────
  test('목록에 빈 칸이 섞여도 터지지 않는다', () => {
    eq(verifyStopAttached([null as any, undefined as any, stop()], WANT).status, 'attached');
    eq(verifyStopAttached([null as any], WANT).status, 'missing');
  });

  test('대소문자를 가리지 않는다', () => {
    eq(verifyStopAttached(
      [stop({ symbol: 'btcusdt', side: 'sell', type: 'stop_market' })], WANT).status, 'attached');
  });

  test('허용 오차는 바꿀 수 있고 음수는 0으로 본다', () => {
    eq(verifyStopAttached([stop({ stopPrice: 102 })], WANT, 3).status, 'attached');
    eq(verifyStopAttached([stop({ stopPrice: 102 })], WANT, 1).status, 'missing');
    // 음수를 그대로 쓰면 허용 범위가 뒤집혀 아무것도 안 맞는다
    eq(verifyStopAttached([stop({ stopPrice: 100 })], WANT, -5).status, 'attached');
  });

  // ── 화면이 묻는 질문: 이 포지션, 손절 있나 ──────────────
  //
  // 실제로 테스트넷에 5배 포지션이 열렸는데 거래소에는 Open Orders(0)이었다.
  // 포지션 카드에 그 사실이 어디에도 안 적혀서, 손절이 붙었는지를 사람이
  // 거래소에 직접 들어가서 확인해야 했다.
  const LONG = { symbol: 'BTCUSDT', positionSide: 'LONG' as const };
  const SHORT = { symbol: 'BTCUSDT', positionSide: 'SHORT' as const };

  test('발동가를 몰라도 손절이 있는지는 알 수 있다', () => {
    const r = findAnyStop([stop()], LONG);
    eq(r.status, 'attached');
    eq(r.foundStopPrice, 100);
  });

  test('목록은 읽었는데 없으면 missing — 이게 위험한 상태다', () => {
    eq(findAnyStop([], LONG).status, 'missing');
  });

  test('못 읽었으면 unknown — 없음으로 단정하지 않는다', () => {
    eq(findAnyStop(null, LONG).status, 'unknown');
    eq(findAnyStop(undefined, LONG).status, 'unknown');
  });

  // 롱을 닫는 손절은 SELL이다. 방향을 안 보면 반대 방향 진입 예약이
  // 손절로 잡혀서 '손절 있음'이 된다.
  test('포지션을 닫는 방향만 손절로 본다', () => {
    eq(findAnyStop([stop({ side: 'SELL' })], LONG).status, 'attached');
    eq(findAnyStop([stop({ side: 'BUY' })], LONG).status, 'missing');
    eq(findAnyStop([stop({ side: 'BUY' })], SHORT).status, 'attached');
  });

  test('익절은 손절이 아니다', () => {
    eq(findAnyStop([stop({ type: 'TAKE_PROFIT_MARKET' })], LONG).status, 'missing');
  });

  test('다른 종목의 손절은 세지 않는다', () => {
    eq(findAnyStop([stop({ symbol: 'ETHUSDT' })], LONG).status, 'missing');
  });

  test('발동가를 못 읽어도 걸려 있으면 attached다', () => {
    const r = findAnyStop([stop({ stopPrice: null, price: null })], LONG);
    eq(r.status, 'attached');
    eq(r.foundStopPrice, null);
  });

  console.log('[손절 조회 — 방향을 모르면 찾지 않는다]');

  test('방향 미확인이면 없음이 아니라 확인 불가다', () => {
    // 실제로 났던 사고: Gate가 수량을 절대값으로 보내 숏이 롱으로 읽혔고,
    // 숏의 손절(BUY)을 롱의 손절(SELL)로 찾다가 못 찾았다. 화면에는
    // "손절 없음"이 떴다 — **조회 실패를 부재로 말한 것이다.**
    const orders = [{ symbol: 'BTCUSDT', side: 'BUY', type: 'STOP_MARKET', stopPrice: 65352.5 }];
    const r = findAnyStop(orders, { symbol: 'BTCUSDT', positionSide: 'LONG', sideKnown: false });
    eq(r.status, 'unknown');
    assert(r.reason.includes('방향'));
  });

  test('방향이 맞으면 숏의 손절을 찾는다', () => {
    const orders = [{
      symbol: 'BTCUSDT', side: 'BUY', type: 'STOP_MARKET',
      stopPrice: 65352.5, closePosition: true, orderId: '9',
    }];
    const r = findAnyStop(orders, { symbol: 'BTCUSDT', positionSide: 'SHORT' });
    eq(r.status, 'attached');
    eq(r.foundStopPrice, 65352.5);
    eq(r.orderId, '9');
  });

  test('sideKnown을 안 주면 예전처럼 동작한다', () => {
    const orders = [{ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 60000 }];
    eq(findAnyStop(orders, { symbol: 'BTCUSDT', positionSide: 'LONG' }).status, 'attached');
  });

  console.log('[손절 조회 — 있음과 쓸모 있음은 다르다]');

  test('롱의 손절이 현재가 위면 통과시키되 적어 둔다', () => {
    const orders = [{ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 70000 }];
    const r = findAnyStop(orders, { symbol: 'BTCUSDT', positionSide: 'LONG', refPrice: 64000 });
    eq(r.status, 'attached', '주문은 실재한다 — 없음으로 보면 안 된다');
    assert(r.warning != null, '걸자마자 발동한다는 사실을 들고 나간다');
  });

  test('제자리에 걸린 손절은 경고하지 않는다', () => {
    const orders = [{ symbol: 'BTCUSDT', side: 'BUY', type: 'STOP_MARKET', stopPrice: 65352.5 }];
    const r = findAnyStop(orders, { symbol: 'BTCUSDT', positionSide: 'SHORT', refPrice: 64071 });
    eq(r.status, 'attached');
    eq(r.warning, null);
  });

  test('현재가를 모르면 방향 검증을 건너뛴다', () => {
    const orders = [{ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 70000 }];
    eq(findAnyStop(orders, { symbol: 'BTCUSDT', positionSide: 'LONG' }).warning, null);
  });
}
