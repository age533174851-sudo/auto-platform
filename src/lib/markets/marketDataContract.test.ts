// src/lib/markets/marketDataContract.test.ts
//
// **줄 수 없는 것을 줄 수 있는 것처럼 그리지 않는다.**
//
// 화면에 `1초 · 틱 · 월 · 년` 버튼을 늘어놓는 것은 쉽고, 눌러도 오류가
// 나지 않는다 — 빈 차트가 뜰 뿐이다. 그리고 빈 차트는 "이 종목은 거래가
// 없었다"로 읽힌다. 그래서 버튼을 만들기 전에 능력을 묻는다.
//
// 변동률도 같다. 주식의 `전일대비`(어제 종가)와 코인의 24시간 롤링은
// 다른 기준인데, 같은 말로 적으면 사용자는 코인 숫자를 어제 종가 대비로
// 읽는다. 장 마감이 없는 시장에서 그 해석은 틀렸고, 틀린 줄 알 방법도 없다.
import { test, eq, assert } from '../../test/harness';
import {
  INTERVAL_CAPABILITIES, intervalCapability, supportedIntervals, isIntervalUsable,
} from './intervalCapability';
import { changeBasisOf, changeLabelOf, changeView } from './changeBasis';

export function runMarketDataContractTests() {
  console.log('[봉 주기 능력]');

  test('★ 요청된 주기 11개가 모두 분류돼 있다 — 빠뜨린 칸이 없다', () => {
    for (const id of ['1s', 'tick', '1m', '5m', '15m', '1h', '4h', '1d', '1w', 'month', 'year']) {
      const c = INTERVAL_CAPABILITIES.find(x => x.id === id);
      assert(!!c, `${id}가 능력표에 없습니다`);
    }
  });

  test('★ 지금 줄 수 있는 것은 다섯뿐이다', () => {
    eq(supportedIntervals().map(c => c.id).join(','), '1m,15m,1h,4h,1d');
  });

  test('★ 능력표와 봉 라우트 화이트리스트가 같다 — 한쪽만 늘면 400을 받는 버튼이 생긴다', () => {
    // `/api/market/candles`의 INTERVALS와 같아야 한다. 다르면 화면이
    // 누를 수 있게 그려 놓고 서버가 거절한다.
    const ROUTE = ['1m', '15m', '1h', '4h', '1d'];
    eq(supportedIntervals().map(c => c.id).join(','), ROUTE.join(','));
  });

  test('★ 체결 스트림이 없으므로 1초·틱은 지원이 아니다', () => {
    for (const id of ['1s', 'tick']) {
      eq(intervalCapability(id).support, 'UNSUPPORTED', `${id}가 지원으로 잡혀 있습니다`);
      eq(isIntervalUsable(id), false, `${id}가 누를 수 있는 버튼이 됩니다`);
      assert(!!intervalCapability(id).reason, `${id}에 사유가 없습니다`);
    }
  });

  test('★ venue에 있어도 우리 경로가 안 이으면 지원이 아니다', () => {
    for (const id of ['5m', '1w', 'month', 'year']) {
      eq(intervalCapability(id).support, 'REQUIRES_SOURCE_OR_AGGREGATION', id);
      eq(isIntervalUsable(id), false, `${id}가 누를 수 있는 버튼이 됩니다`);
    }
  });

  test('★ 모르는 주기는 통과시키지 않는다', () => {
    for (const bad of ['2s', '', null, undefined, '3분', 0, {}]) {
      eq(isIntervalUsable(bad as any), false, `${String(bad)}가 사용 가능으로 나옵니다`);
      eq(intervalCapability(bad as any).support, 'UNSUPPORTED');
    }
  });

  test('지원하는 주기에는 사유가 없다 — 사유는 못 줄 때만 적는다', () => {
    for (const c of supportedIntervals()) eq(c.reason, null, c.id);
  });

  console.log('[변동률 기준]');

  test('★ 코인은 24시간이고 주식은 전일대비다 — 같은 말로 적지 않는다', () => {
    eq(changeBasisOf('USDM'), 'ROLLING_24H');
    eq(changeBasisOf('SPOT'), 'ROLLING_24H');
    eq(changeBasisOf('STOCK'), 'PREVIOUS_CLOSE');
    eq(changeBasisOf('KRSTOCK'), 'PREVIOUS_CLOSE');
    assert(changeLabelOf('USDM').label !== changeLabelOf('STOCK').label,
      '코인과 주식이 같은 기준 이름을 씁니다');
    eq(changeLabelOf('USDM').label, '24시간');
    eq(changeLabelOf('STOCK').label, '전일대비');
  });

  test('★ 모르는 시장은 숫자를 적지 않는다', () => {
    for (const m of ['', null, undefined, 'FUTURES_X', 123]) {
      const v = changeView({ market: m as any, price: 100, referencePrice: 90 });
      eq(v.basis, 'UNKNOWN', String(m));
      eq(v.pct, null, `${String(m)}에서 변동률을 지어냈습니다`);
      eq(v.amount, null);
      assert(!!v.unknownReason);
    }
  });

  test('★ 기준가를 모르면 변동액을 만들지 않는다 — 0이 아니다', () => {
    const v = changeView({ market: 'STOCK', price: 100 });
    eq(v.amount, null, '기준가 없이 변동액이 나왔습니다');
    eq(v.pct, null);
    assert(!!v.unknownReason);
  });

  test('★ 거래소가 준 변동률이 있으면 다시 계산하지 않는다', () => {
    // 우리가 다시 계산하면 반올림이 갈리고, 같은 화면에 두 숫자가 생긴다.
    const v = changeView({ market: 'USDM', price: 100, referencePrice: 90, changePct: 2.31 });
    eq(v.pct, 2.31);
    eq(v.basis, 'ROLLING_24H');
  });

  test('기준가가 있으면 변동액을 낸다', () => {
    const v = changeView({ market: 'STOCK', price: 110, referencePrice: 100 });
    eq(v.amount, 10);
    eq(v.pct, 10);
    eq(v.label, '전일대비');
    eq(v.unknownReason, null);
  });

  test('★ 기준가 0을 나눗셈에 쓰지 않는다', () => {
    const v = changeView({ market: 'STOCK', price: 110, referencePrice: 0 });
    eq(v.pct, null, '0으로 나눠 무한대를 만들었습니다');
  });
}
