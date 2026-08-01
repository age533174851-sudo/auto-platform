import { test, eq, assert } from '../../test/harness';
import { marketPhase, marketOfSymbol, zonedParts, MARKET_HOURS } from './marketHours';

export function runMarketHoursTests() {
  console.log('[장 시간 — 24시간이 아닌 시장]');

  // 시각은 전부 UTC로 적는다. 현지 시각으로 적으면 이 테스트 자체가
  // 서머타임에 따라 흔들린다.
  const utc = (s: string) => Date.parse(s);

  // ── 한국거래소 (서머타임 없음, UTC+9) ──────────────────
  test('평일 오전 10시(KST)면 열려 있다', () => {
    // 2026-08-03은 월요일. 01:00 UTC = 10:00 KST
    const r = marketPhase('KRX', utc('2026-08-03T01:00:00Z'));
    eq(r.phase, 'OPEN');
    eq(r.canOrder, true);
  });

  test('개장 전에는 막는다', () => {
    // 23:30 UTC(일) = 08:30 KST(월)
    const r = marketPhase('KRX', utc('2026-08-02T23:30:00Z'));
    eq(r.phase, 'PRE');
    eq(r.canOrder, false);
  });

  test('마감 시각 자체를 열림으로 보지 않는다', () => {
    // 06:30 UTC = 15:30 KST — 정확히 마감
    eq(marketPhase('KRX', utc('2026-08-03T06:30:00Z')).phase, 'AFTER');
    // 1분 전은 열려 있다
    eq(marketPhase('KRX', utc('2026-08-03T06:29:00Z')).phase, 'OPEN');
  });

  test('새벽 3시에는 절대 안 열린다 — 크론이 여기서 주문을 냈다', () => {
    // 18:00 UTC = 03:00 KST 다음날
    const r = marketPhase('KRX', utc('2026-08-02T18:00:00Z'));
    eq(r.canOrder, false);
  });

  test('주말은 막는다', () => {
    // 2026-08-01은 토요일. 01:00 UTC = 10:00 KST 토요일
    eq(marketPhase('KRX', utc('2026-08-01T01:00:00Z')).phase, 'WEEKEND');
    // 2026-08-02는 일요일
    eq(marketPhase('KRX', utc('2026-08-02T01:00:00Z')).phase, 'WEEKEND');
  });

  test('자정 직후를 24시로 읽지 않는다', () => {
    // 15:10 UTC = 00:10 KST 다음날. 24:10으로 읽으면 계산이 어긋난다.
    const r = marketPhase('KRX', utc('2026-08-02T15:10:00Z'));
    assert(r.localTime!.endsWith('00:10'), r.localTime!);
  });

  // ── 미국 (서머타임을 손으로 계산하지 않는다) ────────────
  test('여름(EDT)에는 13:30 UTC가 개장이다', () => {
    // 2026-08-03 월. 13:30 UTC = 09:30 EDT — 개장 순간
    eq(marketPhase('US', utc('2026-08-03T13:30:00Z')).phase, 'OPEN');
    // 1분 전은 아직 안 열렸다
    eq(marketPhase('US', utc('2026-08-03T13:29:00Z')).phase, 'PRE');
  });

  test('겨울(EST)에는 14:30 UTC가 개장이다', () => {
    // 2026-01-05 월. 겨울에는 UTC-5라 13:30 UTC는 아직 08:30이다.
    // 오프셋을 UTC-5로 고정해 뒀다면 위 여름 테스트가 깨지고,
    // UTC-4로 고정해 뒀다면 이 테스트가 깨진다.
    eq(marketPhase('US', utc('2026-01-05T13:30:00Z')).phase, 'PRE');
    eq(marketPhase('US', utc('2026-01-05T14:30:00Z')).phase, 'OPEN');
  });

  test('미국 마감은 여름 20:00 UTC · 겨울 21:00 UTC', () => {
    // 16:00 뉴욕이 여름(EDT, UTC-4)에는 20:00 UTC, 겨울(EST, UTC-5)에는
    // 21:00 UTC다. 이 한 시간을 고정값으로 박으면 반년 동안 틀린다.
    eq(marketPhase('US', utc('2026-08-03T19:59:00Z')).phase, 'OPEN');
    eq(marketPhase('US', utc('2026-08-03T20:00:00Z')).phase, 'AFTER');
    eq(marketPhase('US', utc('2026-01-05T20:59:00Z')).phase, 'OPEN');
    eq(marketPhase('US', utc('2026-01-05T21:00:00Z')).phase, 'AFTER');
  });

  test('한국 기준 평일 낮은 미국 장외다', () => {
    // 04:00 UTC = 13:00 KST = 00:00 EDT
    eq(marketPhase('US', utc('2026-08-03T04:00:00Z')).canOrder, false);
  });

  test('미국 주말은 현지 기준으로 센다', () => {
    // 2026-08-08 토요일 13:30 UTC
    eq(marketPhase('US', utc('2026-08-08T13:30:00Z')).phase, 'WEEKEND');
    // 금요일 밤 늦게(UTC로는 토요일)여도 현지는 아직 금요일 → 마감 후
    // 2026-08-08T01:00Z = 2026-08-07 21:00 EDT (금)
    eq(marketPhase('US', utc('2026-08-08T01:00:00Z')).phase, 'AFTER');
  });

  // ── 공휴일 ──────────────────────────────────────────────
  test('휴장일 목록을 받으면 그날은 막는다', () => {
    const r = marketPhase('KRX', utc('2026-08-03T01:00:00Z'), { holidays: ['2026-08-03'] });
    eq(r.phase, 'HOLIDAY');
    eq(r.canOrder, false);
  });

  test('목록이 없으면 모른다고 적는다 — 조용히 넘어가지 않는다', () => {
    // 넣어 두면 해가 바뀔 때마다 조용히 틀리기 시작한다. 그래서 안 넣고
    // 대신 못 거른다는 사실을 결과에 남긴다.
    const r = marketPhase('KRX', utc('2026-08-03T01:00:00Z'));
    eq(r.holidaysKnown, false);
    assert(r.reason.includes('휴장일 목록이 없어'), r.reason);
  });

  test('빈 배열은 "목록을 받았고 휴장일이 없다"는 뜻이다', () => {
    const r = marketPhase('KRX', utc('2026-08-03T01:00:00Z'), { holidays: [] });
    eq(r.holidaysKnown, true);
    eq(r.phase, 'OPEN');
    // 목록을 받았으면 경고 문구가 붙지 않는다
    assert(!r.reason.includes('휴장일 목록이 없어'), r.reason);
  });

  test('휴장일보다 주말이 먼저다 — 둘 다여도 결과는 막힘', () => {
    eq(marketPhase('KRX', utc('2026-08-01T01:00:00Z'), { holidays: ['2026-08-01'] }).canOrder, false);
  });

  // ── 모르면 막는다 ───────────────────────────────────────
  test('모르는 시장은 막는다', () => {
    const r = marketPhase('NASDAQ_KR' as any, utc('2026-08-03T01:00:00Z'));
    eq(r.phase, 'UNKNOWN');
    eq(r.canOrder, false);
  });

  test('시각을 모르면 막는다', () => {
    eq(marketPhase('KRX', NaN).canOrder, false);
    eq(marketPhase('KRX', NaN).phase, 'UNKNOWN');
  });

  test('시간대를 못 읽으면 열림이 아니라 확인 불가다', () => {
    // 여기서 열림으로 기울면 주문이 언제 나가는지 아무도 모르는 채로 나간다.
    eq(zonedParts(Date.now(), 'Not/A_Zone'), null);
  });

  // ── 종목 → 시장 ─────────────────────────────────────────
  test('여섯 자리 숫자는 국내다', () => {
    eq(marketOfSymbol('005930'), 'KRX');   // 삼성전자
    eq(marketOfSymbol('069500'), 'KRX');   // KODEX 200
  });

  test('알파벳은 미국이다', () => {
    eq(marketOfSymbol('AAPL'), 'US');
    eq(marketOfSymbol('SPY'), 'US');
    eq(marketOfSymbol('BRK.B'), 'US');
  });

  test('모르는 모양은 null이다 — 미국으로 넘겨짚지 않는다', () => {
    // 넘겨짚으면 일본·홍콩 종목이 조용히 미국 시간표로 판정된다.
    eq(marketOfSymbol('7203.T'), null);
    eq(marketOfSymbol('00700.HK'), null);
    eq(marketOfSymbol(''), null);
    eq(marketOfSymbol(null), null);
  });

  // ── 시간표 자체 ─────────────────────────────────────────
  test('정규장 시간이 앞뒤가 맞는다', () => {
    for (const k of Object.keys(MARKET_HOURS) as Array<'KRX' | 'US'>) {
      const h = MARKET_HOURS[k];
      assert(h.openMin < h.closeMin, `${k}: 개장이 마감보다 늦습니다`);
      assert(h.openMin >= 0 && h.closeMin <= 24 * 60, `${k}: 범위를 벗어났습니다`);
    }
  });
}
