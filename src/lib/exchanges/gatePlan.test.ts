// src/lib/exchanges/gatePlan.test.ts
//
// Gate 경로에서 **조용히 틀리는** 것들을 못 박는다.
//
// 수량 반올림 방향, 격리 판정, 손절 트리거 방향. 셋 다 화면에서는 정상으로
// 보인다 — 주문이 나가고, '손절 걸림'이 뜨고, 숫자가 그럴듯하다.

import { test, eq, assert } from '../../test/harness';
import {
  toGateContract, toGateSize, isGateIsolated, gateStopSpec, gatePositionToRisk, gateFillOf,
  gateSizeFromBase, gateFiltersOf, gateBaseFromContracts,
} from './gatePlan';
import { quantizeOrder } from './quantize';
import { futuresExchangeOf } from './futuresAdapter';
import { toGateText } from './gateFutures';

export function runGatePlanTests() {
  console.log('[Gate — 계약 이름]');

  test('BTCUSDT → BTC_USDT', () => {
    eq(toGateContract('BTCUSDT'), 'BTC_USDT');
    eq(toGateContract('ETHUSDT'), 'ETH_USDT');
  });

  test('슬래시·언더바·소문자를 정리한다', () => {
    eq(toGateContract('btc/usdt'), 'BTC_USDT');
    eq(toGateContract('BTC_USDT'), 'BTC_USDT');
  });

  test('USDT가 아니면 그대로 둔다 — 추측해서 바꾸지 않는다', () => {
    eq(toGateContract('BTCUSD'), 'BTCUSD');
  });

  test('빈 값은 빈 문자열', () => {
    eq(toGateContract(''), '');
    eq(toGateContract(null as any), '');
  });

  test("'USDT'만 오면 계약으로 만들지 않는다", () => {
    eq(toGateContract('USDT'), 'USDT');
  });

  console.log('[Gate — 계약 수 (반올림 방향)]');

  test('정수는 그대로, 롱은 양수 숏은 음수', () => {
    eq(toGateSize(3, 'LONG').size, 3);
    eq(toGateSize(3, 'SHORT').size, -3);
  });

  test('내림한다 — 올리면 의도보다 큰 포지션이 열린다', () => {
    // 예전 코드는 Math.round였다. 1.6 → 2는 25% 큰 주문이다.
    eq(toGateSize(1.6, 'LONG').size, 1);
    eq(toGateSize(1.9, 'SHORT').size, -1);
    eq(toGateSize(9.99, 'LONG').size, 9);
  });

  test('1계약 미만은 주문하지 않는다 — Math.round는 0을 만들어 보냈다', () => {
    for (const q of [0.4, 0.9, 0.001]) {
      const r = toGateSize(q, 'LONG');
      eq(r.ok, false, `${q}가 통과했다`);
      eq(r.size, 0);
      assert(r.reason.includes('1계약'), `이유를 적어야 한다: ${r.reason}`);
    }
  });

  test('0·음수·NaN은 주문하지 않는다', () => {
    for (const q of [0, -3, NaN, Infinity]) {
      eq(toGateSize(q as number, 'LONG').ok, false, `${String(q)}가 통과했다`);
    }
  });

  test('내림이 일어나면 그 사실을 이유에 남긴다', () => {
    assert(toGateSize(1.6, 'LONG').reason.includes('내림'), '내림을 알려야 한다');
    eq(toGateSize(2, 'LONG').reason, '', '정수는 군더더기를 붙이지 않는다');
  });

  console.log('[Gate — 격리 판정]');

  test('0이 아닌 레버리지는 격리다', () => {
    eq(isGateIsolated('10'), true);
    eq(isGateIsolated(10), true);
    eq(isGateIsolated('1'), true);
  });

  test('레버리지 0은 교차다 — Gate에서 0은 cross margin이다', () => {
    eq(isGateIsolated('0'), false);
    eq(isGateIsolated(0), false);
  });

  test('읽지 못하면 격리가 아니다 — 모르는 것을 격리로 보면 교차 계좌에서 주문이 나간다', () => {
    eq(isGateIsolated(null), false);
    eq(isGateIsolated(undefined), false);
    eq(isGateIsolated(''), false);
    eq(isGateIsolated('알 수 없음'), false);
  });

  console.log('[Gate — 체결량 읽기]');

  test('전량 체결', () => {
    const f = gateFillOf({ size: 3, left: 0, status: 'finished', fill_price: '60000' });
    eq(f.filledQty, 3);
    eq(f.avgPrice, 60000);
    eq(f.unfilled, false);
  });

  test('IOC가 하나도 못 붙고 끝나면 미체결이다 — 200 응답에 finished가 실려 온다', () => {
    const f = gateFillOf({ size: 3, left: 3, status: 'finished', fill_price: '0' });
    eq(f.unfilled, true, '체결 0인데 접수로 보고하면 없는 포지션에 손절을 건다');
    eq(f.filledQty, 0);
    eq(f.avgPrice, null, '0은 체결가가 아니다');
    assert(f.reason.includes('0계약'), `이유를 적어야 한다: ${f.reason}`);
  });

  test('부분 체결은 미체결이 아니다', () => {
    const f = gateFillOf({ size: 5, left: 2, status: 'finished', fill_price: '60000' });
    eq(f.filledQty, 3);
    eq(f.unfilled, false);
  });

  test('숏(음수 수량)도 절대값으로 센다', () => {
    eq(gateFillOf({ size: -4, left: -1, status: 'finished' }).filledQty, 3);
  });

  test('열려 있는 주문은 미체결로 단정하지 않는다 — 아직 끝나지 않았다', () => {
    const f = gateFillOf({ size: 3, left: 3, status: 'open' });
    eq(f.unfilled, false);
    eq(f.filledQty, 0);
  });

  test('left를 못 읽으면 모르는 것이다 — 미체결로도, 체결로도 단정하지 않는다', () => {
    for (const r of [null, undefined, {}, { size: 3, status: 'finished' }]) {
      const f = gateFillOf(r);
      eq(f.filledQty, null, `${JSON.stringify(r)}에서 수량을 만들어냈다`);
      eq(f.unfilled, false);
    }
  });

  console.log('[Gate — 주문 이름(text)]');

  test("규격에 맞는 이름은 't-'만 붙인다 — 지금 쓰는 키가 바뀌지 않게", () => {
    eq(toGateText('LD20260730BTCUSDT'), 't-LD20260730BTCUSDT');
    eq(toGateText('MF1735689600000'), 't-MF1735689600000');
  });

  test('빈 값·영숫자가 하나도 없는 값은 이름을 만들지 않는다', () => {
    eq(toGateText(undefined), undefined);
    eq(toGateText(''), undefined);
    eq(toGateText('///'), undefined);
  });

  test('특수문자를 지운 뒤에도 서로 다른 주문은 다른 이름이어야 한다', () => {
    // 예전 구현은 둘 다 't-MF12'였다 → 중복 확인이 남의 주문을 내 것으로 읽는다
    const a = toGateText('MF/1:2');
    const b = toGateText('MF12');
    assert(a !== b, `충돌: ${a} === ${b}`);
  });

  test('30자를 넘겨도 접미사(SL)가 살아 남아야 한다 — 진입과 손절이 같은 이름이 되면 안 된다', () => {
    const longId = 'MF' + '9'.repeat(30);
    const entry = toGateText(longId);
    const stop = toGateText(`${longId}SL`);
    assert(entry !== stop, `진입과 손절이 같은 이름이다: ${entry}`);
  });

  test('Gate 규격을 지킨다 — 30자 이내, 영숫자·밑줄·하이픈만', () => {
    for (const id of ['MF/1:2', 'MF' + '9'.repeat(40), 'LD20260730BTCUSDT', 'a-b_c']) {
      const t = toGateText(id)!;
      assert(t.startsWith('t-'), `접두사가 없다: ${t}`);
      assert(t.length <= 30, `${t} 가 ${t.length}자다`);
      assert(/^t-[A-Za-z0-9_-]+$/.test(t), `허용되지 않는 문자: ${t}`);
    }
  });

  test('같은 입력은 항상 같은 이름 — 멱등 키가 재시도마다 바뀌면 중복 주문이 난다', () => {
    eq(toGateText('MF/1:2'), toGateText('MF/1:2'));
  });

  console.log('[Gate — 포지션 → 점검 입력]');

  test('못 읽으면 null이다 — 빈 값을 만들어 주면 "포지션 없음·교차"가 사실이 된다', () => {
    eq(gatePositionToRisk(null), null);
    eq(gatePositionToRisk(undefined), null);
  });

  test('격리 포지션을 그대로 옮긴다', () => {
    const r = gatePositionToRisk({
      contract: 'BTC_USDT', size: 3, leverage: '10',
      liq_price: '54000', entry_price: '60000',
    })!;
    eq(r.marginType, 'isolated');
    eq(r.leverage, 10);
    eq(r.liquidationPrice, 54000);
    eq(r.positionAmt, 3);
    eq(r.entryPrice, 60000);
  });

  test('레버리지 0은 교차이고, 배율은 0이 아니라 unknown이다', () => {
    const r = gatePositionToRisk({ contract: 'BTC_USDT', size: 0, leverage: '0' })!;
    eq(r.marginType, 'cross');
    eq(r.leverage, null, '0을 배율로 적으면 의도 배율과의 비교가 거짓말을 한다');
  });

  test('숏은 음수 수량으로 온다 — 부호를 지운다', () => {
    eq(gatePositionToRisk({ contract: 'BTC_USDT', size: -5, leverage: '20' })!.positionAmt, -5);
  });

  test('청산가 0·없음은 null이다 — 0을 적으면 청산거리가 100%로 계산된다', () => {
    for (const liq of [undefined, null, '0', '', 'x']) {
      eq(gatePositionToRisk({ contract: 'BTC_USDT', size: 1, leverage: '5', liq_price: liq })!.liquidationPrice,
        null, `${String(liq)}가 값으로 남았다`);
    }
  });

  test('수량이 없는 신규 계약도 마진 모드를 돌려준다 — 첫 주문이 막히지 않게', () => {
    const r = gatePositionToRisk({ contract: 'ETH_USDT', size: 0, leverage: '15' })!;
    eq(r.marginType, 'isolated');
    eq(r.positionAmt, 0);
  });

  console.log('[Gate — 손절 트리거 방향]');

  test('LONG은 가격이 내려갈 때 닫는다', () => {
    const s = gateStopSpec('LONG', 58000, 60000);
    eq(s.ok, true, s.reason);
    eq(s.rule, 2, '이하일 때 발동해야 한다');
    eq(s.autoSize, 'close_long');
  });

  test('SHORT은 가격이 올라갈 때 닫는다', () => {
    const s = gateStopSpec('SHORT', 62000, 60000);
    eq(s.ok, true, s.reason);
    eq(s.rule, 1, '이상일 때 발동해야 한다');
    eq(s.autoSize, 'close_short');
  });

  test('방향이 뒤집히면 즉시 발동한다 — 그걸 막는다', () => {
    const badLong = gateStopSpec('LONG', 61000, 60000);
    eq(badLong.ok, false);
    assert(badLong.reason.includes('즉시 발동'), `이유를 적어야 한다: ${badLong.reason}`);

    const badShort = gateStopSpec('SHORT', 59000, 60000);
    eq(badShort.ok, false);
  });

  test('손절가가 없으면 거부한다', () => {
    for (const sp of [null, undefined, 0, -1, NaN]) {
      eq(gateStopSpec('LONG', sp as number, 60000).ok, false, `${String(sp)}가 통과했다`);
    }
  });

  test('기준가를 모르면 방향 검사를 건너뛴다 — 손절가 자체는 여전히 필요하다', () => {
    eq(gateStopSpec('LONG', 58000, null).ok, true);
    eq(gateStopSpec('LONG', null, null).ok, false);
  });

  test('거부해도 rule·autoSize는 채워 돌려준다 — 호출자가 분기를 두 번 하지 않게', () => {
    const s = gateStopSpec('LONG', null);
    eq(s.rule, 2);
    eq(s.autoSize, 'close_long');
    eq(s.ok, false);
  });

  // ── 기초자산 수량 ↔ 계약 수 ─────────────────────────
  //
  // **이게 없어서 Gate 주문은 BTC에서 한 번도 나가지 못했다.**
  //
  // Gate의 size는 정수 계약 수이고, 1계약이 몇 개인지는 계약마다 다르다.
  // BTC_USDT는 0.0001이다. 예전 코드는 배수를 읽지 않고 기초자산 수량을
  // 그대로 계약 수로 보고 내림했다 — 0.05 BTC는 floor(0.05)=0계약이 되어
  // "1계약 미만"으로 거부됐다. 실제로는 500계약이었다.
  console.log('[Gate — 수량 단위(계약 배수)]');

  const BTC = { quantoMultiplier: 0.0001, orderSizeMin: 1, orderSizeMax: 1000000, orderPriceRound: 0.1 };
  const SOL = { quantoMultiplier: 1, orderSizeMin: 1, orderSizeMax: 1000000, orderPriceRound: 0.01 };

  test('0.05 BTC는 0계약이 아니라 500계약이다', () => {
    const r = gateSizeFromBase(0.05, 'LONG', BTC);
    eq(r.ok, true, r.reason);
    eq(r.size, 500);
  });

  test('숏은 음수 계약이다', () => {
    eq(gateSizeFromBase(0.05, 'SHORT', BTC).size, -500);
  });

  test('배수가 1인 계약은 수량이 그대로 계약 수다', () => {
    eq(gateSizeFromBase(3, 'LONG', SOL).size, 3);
  });

  // **여기가 핵심이다.** 배수를 1로 가정하면 0.05 BTC 주문이 500 BTC로
  // 나간다 — 계좌 전체의 몇 백 배다. 그건 거부당하는 것과 비교할 수 없다.
  test('배수를 모르면 주문하지 않는다 — 1로 가정하지 않는다', () => {
    for (const spec of [null, undefined, {} as any, { quantoMultiplier: 0 },
                        { quantoMultiplier: NaN }, { quantoMultiplier: -1 }]) {
      const r = gateSizeFromBase(0.05, 'LONG', spec as any);
      eq(r.ok, false, `규격 ${JSON.stringify(spec)}로 주문이 나갔다`);
      eq(r.size, 0);
    }
    assert(gateSizeFromBase(0.05, 'LONG', null).reason.includes('규격'),
      '왜 못 나가는지 안 적었다');
  });

  test('내림한다 — 올리면 의도보다 큰 포지션이 열린다', () => {
    // 0.05009 / 0.0001 = 500.9 → 500계약
    eq(gateSizeFromBase(0.05009, 'LONG', BTC).size, 500);
  });

  // 부동소수 오차. 0.05 / 0.0001이 499.99999…로 나오면 한 계약을 잃는다.
  test('부동소수 오차로 한 계약을 잃지 않는다', () => {
    for (const q of [0.05, 0.07, 0.29, 0.0003, 1.1]) {
      const r = gateSizeFromBase(q, 'LONG', BTC);
      eq(r.size, Math.round(q / 0.0001), `수량 ${q}에서 계약 수가 어긋났다`);
    }
  });

  test('1계약보다 작으면 거부하고, 1계약이 얼마인지 알려준다', () => {
    const r = gateSizeFromBase(0.00005, 'LONG', BTC);
    eq(r.ok, false);
    assert(r.reason.includes('0.0001'), '1계약이 얼마인지 안 알려줬다: ' + r.reason);
  });

  test('최소·최대 계약 수를 지킨다', () => {
    eq(gateSizeFromBase(0.0005, 'LONG', { ...BTC, orderSizeMin: 10 }).ok, false);
    eq(gateSizeFromBase(0.05, 'LONG', { ...BTC, orderSizeMax: 100 }).ok, false);
  });

  test('수량이 유효하지 않으면 거부한다', () => {
    for (const q of [0, -1, NaN, null, undefined, 'x']) {
      eq(gateSizeFromBase(q as number, 'LONG', BTC).ok, false, `${String(q)}가 통과했다`);
    }
  });

  test('바뀌었으면 바뀌었다고 말한다', () => {
    assert(gateSizeFromBase(0.05009, 'LONG', BTC).reason.includes('내림'), '조용히 줄였다');
    assert(!gateSizeFromBase(0.05, 'LONG', BTC).reason.includes('내림'), '안 바뀐 걸 바뀌었다고 한다');
  });

  test('계약 수 → 기초자산. 배수를 모르면 null이다', () => {
    eq(gateBaseFromContracts(500, BTC), 0.05);
    eq(gateBaseFromContracts(-500, BTC), -0.05);
    eq(gateBaseFromContracts(500, null), null, '계약 수를 수량으로 적으면 안 된다');
    eq(gateBaseFromContracts(500, { quantoMultiplier: 0 }), null);
  });

  // 규격을 공용 quantizeOrder가 읽는 모양으로 바꿔, 두 거래소가 같은
  // 판정 코드를 지나게 한다. 배수를 stepSize로 놓으면 "기초자산을 배수로
  // 내림"이 곧 "정수 계약으로 내림"이다.
  console.log('[Gate — 규격을 공용 수량 보정에 연결한다]');

  test('배수가 수량 단위가 되고, 최소 계약 수는 기초자산으로 환산된다', () => {
    const f = gateFiltersOf(BTC);
    eq(f!.stepSize, 0.0001);
    eq(f!.minQty, 0.0001);
    eq(f!.tickSize, 0.1);
    eq(gateFiltersOf({ ...BTC, orderSizeMin: 10 })!.minQty, 0.001);
  });

  test('배수를 모르면 규격도 null이다 — 지어내지 않는다', () => {
    eq(gateFiltersOf(null), null);
    eq(gateFiltersOf({ quantoMultiplier: 0 } as any), null);
  });

  test('공용 보정을 지나면 항상 계약의 정수배가 나온다', () => {
    const f = gateFiltersOf(BTC);
    const q = quantizeOrder(0.05009, 62661.95, f);
    eq(q.ok, true, q.reason);
    eq(q.quantity, 0.05);
    // 가격도 Gate 호가 단위(0.1)에 맞는다 — .95는 존재할 수 없는 가격이다
    eq(q.price, 62661.9);
    // 그 수량은 계약으로 정확히 떨어진다
    eq(gateSizeFromBase(q.quantity!, 'LONG', BTC).size, 500);
  });

  console.log('[선물 어댑터 — 거래소 이름]');

  test('gate와 gateio를 한 이름으로 모은다', () => {
    for (const v of ['gate', 'gateio', 'GATE', 'Gate.io', ' gate ']) {
      eq(futuresExchangeOf(v), 'gate', `${v}가 gate로 안 읽혔다`);
    }
    eq(futuresExchangeOf('BINANCE'), 'binance');
  });

  // **모르는 거래소를 바이낸스로 치지 않는다.** 그러면 Gate가 아닌 키로
  // 바이낸스에 서명 요청을 보내고, 그 실패는 '주문 실패'로만 보인다.
  test('모르는 거래소는 null이다', () => {
    for (const v of ['upbit', 'bybit', 'okx', '', null, undefined, 'binance-futures']) {
      eq(futuresExchangeOf(v), null, `${String(v)}가 통과했다`);
    }
  });

  // ── 손절 트리거 가격도 호가 단위에 맞아야 한다 ──────
  //
  // **이것 때문에 Gate 주문이 실제로 실패했다.**
  //   Gate 400: invalid argument: trigger.price price is not an integer
  //   multiple of a price unit
  // 진입 가격은 quantizeOrder가 맞춰 주는데 손절가는 아무도 안 맞추고
  // 있었다. 그래서 진입은 체결되고 손절만 실패했고, 규칙대로 방금 연
  // 포지션을 되돌렸다 — 안전하긴 하지만 주문을 아예 낼 수 없다.
  console.log('[Gate — 손절 트리거 가격 단위]');

  const TICK = { quantoMultiplier: 0.0001, orderPriceRound: 0.1 };

  test('호가 단위의 배수로 맞춘다', () => {
    const s = gateStopSpec('LONG', 62653.906, 63912.1, TICK);
    eq(s.ok, true, s.reason);
    eq(s.triggerPrice, 62653.9);
    // 소수 꼬리가 남으면 거래소가 또 거부한다
    eq(String(s.triggerPrice).length <= 9, true, `꼬리가 남았다: ${s.triggerPrice}`);
  });

  // **반올림하지 않는다.** 진입 쪽으로 당기면 손절이 한 틱 일찍 터진다 —
  // 그건 사용자가 정하지 않은 손절이다. 멀어지는 쪽이 낫다.
  test('LONG은 내리고 SHORT은 올린다 — 진입에서 멀어지는 쪽', () => {
    eq(gateStopSpec('LONG', 62653.98, 63912.1, TICK).triggerPrice, 62653.9);
    eq(gateStopSpec('SHORT', 65170.02, 63912.1, TICK).triggerPrice, 65170.1);
  });

  test('이미 격자에 맞는 값은 한 틱도 안 움직인다', () => {
    eq(gateStopSpec('LONG', 62653.9, 63912.1, TICK).triggerPrice, 62653.9);
    eq(gateStopSpec('SHORT', 65170.1, 63912.1, TICK).triggerPrice, 65170.1);
  });

  test('바뀌었으면 바뀌었다고 적는다', () => {
    assert(gateStopSpec('LONG', 62653.906, 63912.1, TICK).note.includes('62653.9'),
      '조용히 바꿨다');
    eq(gateStopSpec('LONG', 62653.9, 63912.1, TICK).note, '', '안 바뀐 걸 바뀌었다고 한다');
  });

  test('규격을 모르면 원래 값을 그대로 쓴다 — 지어낸 격자로 옮기지 않는다', () => {
    eq(gateStopSpec('LONG', 62653.906, 63912.1, null).triggerPrice, 62653.906);
    eq(gateStopSpec('LONG', 62653.906, 63912.1).triggerPrice, 62653.906);
  });

  test('맞추고 나서도 방향 검사는 그대로 한다', () => {
    // LONG 손절이 진입가 위 → 즉시 발동
    eq(gateStopSpec('LONG', 64000.06, 63912.1, TICK).ok, false);
  });

  test('거부해도 맞춘 값을 함께 돌려준다 — 호출자가 두 번 계산하지 않게', () => {
    const s = gateStopSpec('LONG', 64000.06, 63912.1, TICK);
    eq(s.ok, false);
    eq(s.triggerPrice, 64000);
  });

  test('손절가가 없으면 트리거 가격도 없다', () => {
    eq(gateStopSpec('LONG', null, 63912.1, TICK).triggerPrice, null);
  });
}
