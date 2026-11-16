// 손절을 걸 수 있는지에 대한 답이 거짓말을 하지 않는가.
//
// 여기서 가장 비싼 실패는 ❌가 아니라 **확인하지 못한 것을 ✅로 그리는
// 것**이다. 사용자는 점검이 끝났다고 믿고 자동매매를 켜고, 진입할
// 때마다 수수료만 나간다.
import { test, assert, eq } from '../../test/harness';
import {
  supportVerdict, summarize, venueLabel, probeLabel, REQUIRED_STOP_TYPE,
} from './protectiveOrderSupport';

export function runProtectiveOrderSupportTests() {
  const BINANCE_TYPES = ['LIMIT', 'MARKET', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'];

  test('STOP_MARKET이 목록에 있으면 SUPPORTED', () => {
    const v = supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: BINANCE_TYPES });
    eq(v.code, 'SUPPORTED');
    assert(v.label.includes('실계좌'), '환경이 라벨에 나와야 한다');
    eq(v.nextAction, null);
  });

  test('STOP_MARKET이 목록에 없으면 UNSUPPORTED — 수수료가 나간다는 것까지 적는다', () => {
    const v = supportVerdict({ exchange: 'binance', testnet: true, ok: true, orderTypes: ['LIMIT', 'MARKET'] });
    eq(v.code, 'UNSUPPORTED');
    assert(v.detail.includes('수수료'), '왜 손해인지 적어야 한다');
    assert(v.nextAction !== null, '할 일을 줘야 한다');
  });

  // ── 아래 다섯은 전부 "모르는 것을 통과로 적지 않는다" ──

  test('조회 실패는 UNSUPPORTED가 아니라 UNKNOWN', () => {
    const v = supportVerdict({ exchange: 'binance', testnet: true, ok: false, orderTypes: [], detail: 'HTTP 503' });
    eq(v.code, 'UNKNOWN');
    assert(v.detail.includes('HTTP 503'), '원문을 삼키지 않는다');
    assert(v.detail.includes('지원하지 않는다는 뜻이 아닙니다'), '오해를 막는 문장이 있어야 한다');
  });

  test('ok인데 목록이 배열이 아니면 UNKNOWN', () => {
    const v = supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: null });
    eq(v.code, 'UNKNOWN');
  });

  test('ok인데 목록이 비어 있으면 UNKNOWN — 빈 목록은 답이 아니다', () => {
    const v = supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: [] });
    eq(v.code, 'UNKNOWN');
  });

  test('물어볼 수 없는 거래소는 UNKNOWN — 안 된다고 적지 않는다', () => {
    const v = supportVerdict({ exchange: 'gate', testnet: false, ok: false, unprobeable: true });
    eq(v.code, 'UNKNOWN');
    assert(!v.label.includes('없습니다\u0000'), '');
    assert(v.detail.includes('지원하지 않는다는 뜻이 아닙니다'), '모르는 것과 안 되는 것을 구분해야 한다');
  });

  test('아무것도 못 받으면 UNKNOWN', () => {
    eq(supportVerdict(null).code, 'UNKNOWN');
    eq(supportVerdict(undefined).code, 'UNKNOWN');
    eq(supportVerdict({} as any).code, 'UNKNOWN');
  });

  test('대소문자가 달라도 STOP_MARKET을 알아본다', () => {
    eq(supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: ['stop_market'] }).code, 'SUPPORTED');
  });

  test('testnet이 null이면 환경을 단정하지 않는다', () => {
    const l = venueLabel('binance', null);
    assert(!l.includes('테스트넷') && !l.includes('실계좌'), `모르는 환경을 적었다: ${l}`);
  });

  test('심볼이 있으면 라벨에 적는다 — 거래소 전체로 일반화하지 않는다', () => {
    const v = supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: ['LIMIT'], symbol: 'solusdt' });
    assert(v.label.includes('SOLUSDT'), `심볼이 빠졌다: ${v.label}`);
  });

  test('심볼을 모르면 거래소만 적는다', () => {
    eq(probeLabel({ exchange: 'binance', testnet: true }), '바이낸스 테스트넷');
  });

  test('한 심볼이 못 걸면 다른 심볼이 걸려도 머리줄은 못 거는 쪽', () => {
    const r = summarize([
      supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: BINANCE_TYPES, symbol: 'BTCUSDT' }),
      supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: ['LIMIT'], symbol: 'SOLUSDT' }),
    ]);
    eq(r.code, 'UNSUPPORTED');
    assert(r.worst !== null && r.worst.label.includes('SOLUSDT'), '어느 심볼인지 알려줘야 한다');
  });

  test('REQUIRED_STOP_TYPE는 손절 주문 유형이다', () => {
    eq(REQUIRED_STOP_TYPE, 'STOP_MARKET');
  });

  // ── 합치기 — 심각한 쪽이 머리줄이다 ──

  test('하나라도 못 걸면 그것이 머리줄', () => {
    const r = summarize([
      supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: BINANCE_TYPES }),
      supportVerdict({ exchange: 'binance', testnet: true, ok: true, orderTypes: ['LIMIT'] }),
    ]);
    eq(r.code, 'UNSUPPORTED');
  });

  test('모르는 것은 통과보다 위다 — 전부 초록으로 덮지 않는다', () => {
    const r = summarize([
      supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: BINANCE_TYPES }),
      supportVerdict({ exchange: 'gate', testnet: false, ok: false, unprobeable: true }),
    ]);
    eq(r.code, 'UNKNOWN');
  });

  test('전부 되면 SUPPORTED', () => {
    const r = summarize([
      supportVerdict({ exchange: 'binance', testnet: false, ok: true, orderTypes: BINANCE_TYPES }),
      supportVerdict({ exchange: 'binance', testnet: true, ok: true, orderTypes: BINANCE_TYPES }),
    ]);
    eq(r.code, 'SUPPORTED');
    assert(r.headline.includes('2곳'), '개수를 적어야 한다');
  });

  test('볼 것이 없으면 NONE — 0곳을 "모두 통과"로 적지 않는다', () => {
    const r = summarize([]);
    eq(r.code, 'NONE');
    assert(!r.headline.includes('모두'), `0건을 통과로 적었다: ${r.headline}`);
  });
}
