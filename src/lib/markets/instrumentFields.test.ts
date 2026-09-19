// src/lib/markets/instrumentFields.test.ts
//
// **칸을 먼저 만들면 누군가 숫자를 채운다.**
//
// 이 저장소에 이미 그렇게 들어온 값이 있다 — 손으로 적은 시가총액,
// 손으로 쓴 뉴스 기사, `AutoBotLabPage`의 삼성전자 ROE 11.2. 셋 다
// 오류를 내지 않고 화면에서 실제 값과 구별되지 않는다.
import { test, eq, assert } from '../../test/harness';
import {
  instrumentKindOf, instrumentFieldPlan, dividendField, companyInfoField, marketCapField,
} from './instrumentFields';

export function runInstrumentFieldTests() {
  console.log('[종목 상세 칸 권위]');

  test('★ 코인에는 배당 칸 자체를 그리지 않는다', () => {
    // 칸을 만들고 '0'이나 '-'를 적으면 "배당이 없는 주식"처럼 읽힌다.
    eq(dividendField('USDM').availability, 'HIDDEN');
    eq(dividendField('SPOT').availability, 'HIDDEN');
    eq(companyInfoField('SPOT').availability, 'HIDDEN');
  });

  test('★ 주식은 개념이 있으나 공급자가 없다 — 없다고 적는다', () => {
    eq(dividendField('STOCK').availability, 'UNAVAILABLE');
    assert(!!dividendField('STOCK').reason);
    eq(companyInfoField('STOCK').availability, 'UNAVAILABLE');
  });

  test('★ 시가총액은 어디서도 못 온다 — 칸은 남기고 없다고 적는다', () => {
    for (const m of ['SPOT', 'USDM', 'STOCK', 'KRSTOCK']) {
      eq(marketCapField(m).availability, 'UNAVAILABLE', m);
      assert(!!marketCapField(m).reason, m);
    }
  });

  test('★ 모르는 시장은 시세 출처를 정하지 못한다', () => {
    eq(instrumentKindOf('WAT'), 'UNKNOWN');
    eq(instrumentFieldPlan('WAT').chart.availability, 'UNAVAILABLE');
  });

  test('자산 종류를 시장에서 읽는다', () => {
    eq(instrumentKindOf('USDM'), 'CRYPTO');
    eq(instrumentKindOf('spot'), 'CRYPTO');
    eq(instrumentKindOf('STOCK'), 'EQUITY');
    eq(instrumentKindOf('ETF'), 'EQUITY');
    eq(instrumentKindOf(null), 'UNKNOWN');
  });

  test('뉴스는 정본이 있으므로 그릴 수 있다', () => {
    eq(instrumentFieldPlan('SPOT').news.availability, 'AVAILABLE');
  });
}
