// src/lib/engine/highWater.test.ts
//
// **Gate 포지션의 트레일링이 영원히 안 돌고 있었다.**
//
// `highWaterSince()`가 호스트를 `testnet ? demo-fapi.binance : fapi.binance`로
// 고정했다. Gate 계약(`BTC_USDT`)을 그대로 넣으면 바이낸스가 400을 주고,
// 그 실패는 `null` → "캔들 조회 실패 — 이번 주기 건너뜀"으로 끝난다.
// 매 주기 조용히 반복되므로 아무도 모른다.
//
// 여기서는 fetch를 걷어낸 순수 계산과 응답 모양 변환을 고정한다.
import { test, assert, eq, close } from '../../test/harness';
import { highWaterOf, barFromBinance, barFromGate, gateContractOf } from './highWater';

/** 진입 100 · 손절 90 → 1R = 10 */
const LONG = { entry: 100, stop: 90, isLong: true };
/** 진입 100 · 손절 110 → 1R = 10 (숏) */
const SHORT = { entry: 100, stop: 110, isLong: false };

export function runHighWaterTests() {
  console.log('\n📈 최고 도달 R (남의 거래소 봉으로 계산하지 않는다)');

  // ══ 계산 ══
  test('롱은 고가로 잰다 — 120이면 2R', () => {
    const hw = highWaterOf({ ...LONG, bars: [
      { high: 105, low: 99, close: 104 },
      { high: 120, low: 103, close: 118 },
    ] });
    close(hw!.highWaterR, 2, 1e-9, '2R');
    eq(hw!.lastPrice, 118, '마지막 종가');
  });

  test('숏은 저가로 잰다 — 80이면 2R', () => {
    const hw = highWaterOf({ ...SHORT, bars: [
      { high: 101, low: 95, close: 96 },
      { high: 97, low: 80, close: 82 },
    ] });
    close(hw!.highWaterR, 2, 1e-9, '2R');
    eq(hw!.lastPrice, 82, '마지막 종가');
  });

  test('불리하게만 갔으면 0R이다 — 음수로 내려가지 않는다', () => {
    const hw = highWaterOf({ ...LONG, bars: [{ high: 99, low: 92, close: 93 }] });
    eq(hw!.highWaterR, 0, '최고가 0R');
    eq(hw!.lastPrice, 93, '종가는 그대로 싣는다');
  });

  // ══ 못 읽은 것을 0으로 적지 않는다 ══
  test('봉이 없으면 null이다 — 0R이 아니다', () => {
    eq(highWaterOf({ ...LONG, bars: [] }), null, '빈 목록');
    eq(highWaterOf({ ...LONG, bars: null }), null, 'null');
    // 0R은 "아직 안 갔다"라 트레일링을 안 하는 **정상** 상태로 읽힌다.
    // 못 읽은 것과 섞이면 트레일링이 조용히 멈춘다.
  });

  test('줄은 왔는데 쓸 수 있는 값이 하나도 없으면 null이다', () => {
    const hw = highWaterOf({ ...LONG, bars: [
      { high: NaN, low: NaN, close: NaN } as any,
      { high: undefined, low: undefined, close: undefined } as any,
    ] });
    eq(hw, null, '**이게 Gate 응답을 배열로 읽었을 때의 모양이다**');
  });

  test('손절과 진입이 같으면 R을 정의할 수 없다 — null', () => {
    eq(highWaterOf({ entry: 100, stop: 100, isLong: true, bars: [{ high: 120, low: 99, close: 118 }] }),
      null, '0으로 나누지 않는다');
  });

  // ══ 응답 모양 ══
  test('바이낸스 kline은 배열 인덱스다', () => {
    const b = barFromBinance([1700000000000, '100', '120', '95', '118', '3.2']);
    eq(b!.high, 120, '고가'); eq(b!.low, 95, '저가'); eq(b!.close, 118, '종가');
  });

  test('Gate candlestick은 객체다 — 배열로 읽으면 전부 undefined가 된다', () => {
    const b = barFromGate({ t: 1700000000, o: '100', h: '120', l: '95', c: '118', v: 3 });
    eq(b!.high, 120, '고가'); eq(b!.low, 95, '저가'); eq(b!.close, 118, '종가');
    eq(barFromGate([1, 2, 3]), null, '배열은 Gate 모양이 아니다');
    eq(barFromBinance({ h: 1 }), null, '객체는 바이낸스 모양이 아니다');
  });

  test('두 거래소 응답이 같은 R을 낸다 — 변환에서 갈리지 않는다', () => {
    const bn = [[0, '100', '120', '95', '118']].map(barFromBinance).filter(Boolean) as any;
    const gt = [{ t: 0, o: '100', h: '120', l: '95', c: '118' }].map(barFromGate).filter(Boolean) as any;
    close(highWaterOf({ ...LONG, bars: bn })!.highWaterR,
      highWaterOf({ ...LONG, bars: gt })!.highWaterR, 1e-9, '같은 값');
  });

  // ══ 심볼 표기 ══
  test('Gate 계약 표기로 바꾼다 — BTCUSDT는 Gate에 없는 이름이다', () => {
    eq(gateContractOf('BTCUSDT'), 'BTC_USDT', 'USDT');
    eq(gateContractOf('ETHUSDC'), 'ETH_USDC', 'USDC');
    eq(gateContractOf('BTC_USDT'), 'BTC_USDT', '이미 밑줄이면 그대로');
    eq(gateContractOf('btcusdt'), 'BTC_USDT', '소문자');
    eq(gateContractOf(''), '', '빈 값');
  });

  test('접미사를 못 알아보면 지어내지 않는다', () => {
    eq(gateContractOf('WEIRD'), 'WEIRD', '그대로 둔다 — 조회가 실패하면 실패로 드러난다');
    eq(gateContractOf('USDT'), 'USDT', '접미사만 있는 것을 쪼개지 않는다');
  });
}
