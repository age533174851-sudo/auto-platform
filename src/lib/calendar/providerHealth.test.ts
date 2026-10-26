// 경제 캘린더 공급자 상태 — "일정 0건"과 "모두 실패"를 구분한다.
// 오프라인 순수 계약: 실제 공급자·운영 DB 호출 없음.
import { test, eq } from '../../test/harness';
import { calendarProviderVerdict } from './providerHealth';

export function runCalendarProviderHealthTests() {
  console.log('[경제 캘린더 — 공급자 실패 판정]');
  test('설정된 공급자가 없으면 NO_PROVIDERS', () => {
    eq(calendarProviderVerdict([], false, false), 'NO_PROVIDERS');
  });
  test('TradingEconomics 429/타임아웃은 정상 빈 달력이 아니다', () => {
    eq(calendarProviderVerdict([{ provider: 'tradingeconomics', items: null }], false, false), 'UNAVAILABLE');
  });
  test('FRED 키는 있지만 HTTP 오류면 공급자 장애다', () => {
    eq(calendarProviderVerdict([], true, false), 'UNAVAILABLE');
  });
  test('TE와 FMP 모두 실패하고 FRED도 실패하면 전체 장애', () => {
    eq(calendarProviderVerdict([
      { provider: 'tradingeconomics', items: null },
      { provider: 'fmp', items: null },
    ], true, false), 'UNAVAILABLE');
  });
  test('FRED의 유효한 빈 release_dates는 정상 0건', () => {
    eq(calendarProviderVerdict([], true, true), 'AVAILABLE');
  });
  test('TE 유효 빈 배열 + FMP 실패는 부분 성공', () => {
    eq(calendarProviderVerdict([
      { provider: 'tradingeconomics', items: [] },
      { provider: 'fmp', items: null },
    ], false, false), 'AVAILABLE');
  });
  test('FRED 실패여도 FMP 유효 배열이면 부분 성공', () => {
    eq(calendarProviderVerdict([{ provider: 'fmp', items: [] }], true, false), 'AVAILABLE');
  });
}
