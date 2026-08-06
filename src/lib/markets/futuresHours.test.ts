// src/lib/markets/futuresHours.test.ts
//
// 막으려는 것:
//  1. 주식 규칙(토·일 휴장)을 선물에 써서 **일요일 밤 세션을 통째로 놓치는** 것
//  2. 매일 한 시간 쉬는 구간(정산 시간)을 몰라 그때 주문을 내는 것
//     — 거부되는데 화면에는 이유가 안 뜬다
//  3. 서머타임을 손으로 계산해 한 시간 어긋나는 것
//  4. 만기를 모르는데 통과시켜, 만기 직전 월물에 새로 들어가는 것
import { test, assert, eq } from '../../test/harness';
import { futuresPhase, futuresVenueOf, daysToExpiry, expiryGate } from './futuresHours';

/** 시카고 현지 시각을 UTC ms로. 서머타임 구간을 명시적으로 고른다 */
const CT_WINTER_OFFSET = 6;   // CST = UTC-6
const CT_SUMMER_OFFSET = 5;   // CDT = UTC-5

/** 겨울(1월) 시카고 현지 시각 */
function ctWinter(day: number, hh: number, mm = 0): number {
  return Date.UTC(2026, 0, day, hh + CT_WINTER_OFFSET, mm);
}
/** 여름(7월) 시카고 현지 시각 */
function ctSummer(day: number, hh: number, mm = 0): number {
  return Date.UTC(2026, 6, day, hh + CT_SUMMER_OFFSET, mm);
}

export function runFuturesHoursTests() {
  console.log('[선물 거래시간 — 일요일에 열린다]');

  // 2026-01-04는 일요일, 01-05 월요일, 01-09 금요일, 01-10 토요일
  test('일요일 17:00 CT에 주간 거래가 시작된다', () => {
    // 주식 규칙(토·일 휴장)을 쓰면 이 세션을 통째로 놓친다.
    eq(futuresPhase('CME', ctWinter(4, 16, 59)).phase, 'WEEKEND', '개장 1분 전');
    const open = futuresPhase('CME', ctWinter(4, 17, 0));
    eq(open.phase, 'OPEN', open.reason);
    eq(open.canOrder, true);
  });

  test('일요일 낮은 아직 닫혀 있다', () => {
    eq(futuresPhase('CME', ctWinter(4, 10)).phase, 'WEEKEND');
  });

  test('토요일은 종일 닫혀 있다', () => {
    for (const h of [0, 8, 17, 23]) {
      eq(futuresPhase('CME', ctWinter(10, h)).phase, 'WEEKEND', `토요일 ${h}시`);
    }
  });

  test('금요일 16:00 CT에 닫히고 그 뒤로는 주간 휴장이다', () => {
    eq(futuresPhase('CME', ctWinter(9, 15, 59)).phase, 'OPEN');
    eq(futuresPhase('CME', ctWinter(9, 16, 0)).phase, 'WEEKEND', '마감 시각 자체는 닫힘');
    eq(futuresPhase('CME', ctWinter(9, 20)).phase, 'WEEKEND');
  });

  console.log('[선물 거래시간 — 매일 한 시간 쉰다]');

  test('평일 16:00–17:00 CT는 정산 휴식이다', () => {
    // 이 한 시간을 모르면 그때 낸 주문이 거부되는데 화면에는 이유가 안 뜬다.
    const brk = futuresPhase('CME', ctWinter(6, 16, 30));
    eq(brk.canOrder, false);
    assert(brk.reason.includes('정산 휴식'), brk.reason);
    eq(futuresPhase('CME', ctWinter(6, 15, 59)).canOrder, true, '휴식 직전');
    eq(futuresPhase('CME', ctWinter(6, 17, 0)).canOrder, true, '휴식 직후');
  });

  test('한밤중에도 열려 있다 — 코인처럼', () => {
    // 주식 시간표(09:30–16:00)를 쓰면 이 시간이 전부 닫힘이 된다.
    for (const h of [0, 3, 9, 12, 22]) {
      eq(futuresPhase('CME', ctWinter(7, h)).canOrder, true, `수요일 ${h}시`);
    }
  });

  console.log('[선물 거래시간 — 서머타임]');

  test('여름에도 현지 17:00 개장이 유지된다', () => {
    // 2026-07-05는 일요일. UTC 고정 오프셋으로 계산하면 한 시간 어긋난다.
    eq(futuresPhase('CME', ctSummer(5, 16, 59)).phase, 'WEEKEND');
    eq(futuresPhase('CME', ctSummer(5, 17, 0)).phase, 'OPEN');
  });

  test('여름 정산 휴식도 현지 16:00–17:00이다', () => {
    // 2026-07-08은 수요일
    eq(futuresPhase('CME', ctSummer(8, 16, 30)).canOrder, false);
    eq(futuresPhase('CME', ctSummer(8, 15, 30)).canOrder, true);
  });

  console.log('[선물 거래시간 — 모르면 닫힘]');

  test('시각을 모르면 열림으로 기울지 않는다', () => {
    const r = futuresPhase('CME', NaN);
    eq(r.phase, 'UNKNOWN');
    eq(r.canOrder, false);
  });

  test('모르는 거래소는 통과시키지 않는다', () => {
    const r = futuresPhase('NYSE' as any, ctWinter(6, 10));
    eq(r.phase, 'UNKNOWN');
    eq(r.canOrder, false);
  });

  test('휴장일 목록이 없으면 그 사실을 적는다', () => {
    const r = futuresPhase('CME', ctWinter(6, 10));
    eq(r.holidaysKnown, false);
    assert(r.reason.includes('휴장일 목록이 없어'), r.reason);
  });

  test('휴장일 목록을 주면 거른다', () => {
    const r = futuresPhase('CME', ctWinter(6, 10), { holidays: ['2026-01-06'] });
    eq(r.phase, 'HOLIDAY');
    eq(r.canOrder, false);
  });

  console.log('[선물 거래시간 — 심볼 → 거래소]');

  test('알려진 루트만 CME로 본다', () => {
    for (const s of ['GC', 'CL', 'ES', 'NQ', 'NG', 'SI']) {
      eq(futuresVenueOf(s), 'CME', s);
    }
  });

  test('월물 코드가 붙어도 찾는다', () => {
    eq(futuresVenueOf('GCZ6'), 'CME');
    eq(futuresVenueOf('CLX6'), 'CME');
    eq(futuresVenueOf('RTYZ6'), 'CME', '세 글자 루트');
  });

  test('모르는 심볼은 null이다 — CME로 떨어뜨리지 않는다', () => {
    // CME로 떨어뜨리면 다른 거래소 상품이 조용히 이 시간표로 판정되고,
    // 그 판정은 대부분의 시간에 '열림'이라 통과한다.
    for (const s of ['BTCUSDT', 'AAPL', '005930', '', null, undefined, 'XX']) {
      eq(futuresVenueOf(s), null, String(s));
    }
  });

  console.log('[선물 거래시간 — 만기와 롤오버]');

  test('만기까지 남은 날을 센다', () => {
    const now = Date.UTC(2026, 0, 1);
    eq(daysToExpiry('2026-01-11', now), 10);
    eq(daysToExpiry('2026-01-01', now), 0);
  });

  test('만기를 모르면 null이다 — 0이 아니다', () => {
    eq(daysToExpiry(null, Date.UTC(2026, 0, 1)), null, '0으로 두면 오늘 만기가 된다');
    eq(daysToExpiry('아무거나', Date.UTC(2026, 0, 1)), null);
  });

  test('만기가 가까우면 새로 들어가지 않는다', () => {
    const now = Date.UTC(2026, 0, 1);
    eq(expiryGate('2026-01-20', now).ok, true, '19일 남음');
    eq(expiryGate('2026-01-04', now).ok, false, '3일 남음');
    assert(expiryGate('2026-01-04', now).reason.includes('다음 월물'));
  });

  test('이미 지난 월물은 막는다', () => {
    const r = expiryGate('2025-12-20', Date.UTC(2026, 0, 1));
    eq(r.ok, false);
    assert(r.reason.includes('지난 월물'), r.reason);
  });

  test('만기를 모르면 통과시키지 않는다', () => {
    // 여기까지 왔는데 만기를 모른다면 명세를 못 읽은 것이다.
    const r = expiryGate(null, Date.UTC(2026, 0, 1));
    eq(r.ok, false);
    eq(r.days, null);
    assert(r.reason.includes('실물 인수'), r.reason);
  });

  test('기준 일수를 상품별로 바꿀 수 있다', () => {
    const now = Date.UTC(2026, 0, 1);
    // 원유는 실물 인수가 걸려 있어 더 길게 잡아야 한다.
    eq(expiryGate('2026-01-08', now, 5).ok, true);
    eq(expiryGate('2026-01-08', now, 14).ok, false);
  });
}
