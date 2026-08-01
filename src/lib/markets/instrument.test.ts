import { test, eq, assert, close } from '../../test/harness';
import {
  instrumentOf, adjustForLeverage, checkHoldPeriod, suitableForLongTerm,
  KNOWN_INSTRUMENTS, type InstrumentSpec,
} from './instrument';

export function runInstrumentTests() {
  console.log('[종목 배수 — 3배 ETF를 일반 주식처럼 다루지 않는다]');

  const DAY = 86_400_000;

  // ── 조회 ────────────────────────────────────────────────
  test('아는 종목을 찾는다', () => {
    eq(instrumentOf('TQQQ')!.leverageFactor, 3);
    eq(instrumentOf('122630')!.leverageFactor, 2);
  });

  test('대소문자를 가리지 않는다', () => {
    eq(instrumentOf('tqqq')!.symbol, 'TQQQ');
  });

  test('인버스는 음수다', () => {
    eq(instrumentOf('SQQQ')!.leverageFactor, -3);
    eq(instrumentOf('252670')!.leverageFactor, -2);
  });

  test('모르는 종목은 null이다 — 이름으로 추측하지 않는다', () => {
    // '레버리지'가 들어가면 2배로 치는 식으로 만들면, 표기가 다른 3배
    // 종목을 놓친다. 놓친 쪽이 더 위험하다.
    eq(instrumentOf('UPRO'), null);
    eq(instrumentOf('아무거나레버리지3X'), null);
    eq(instrumentOf(''), null);
    eq(instrumentOf(null), null);
  });

  // ── 배수 조정 ───────────────────────────────────────────
  test('1배는 손절을 그대로 쓴다', () => {
    const r = adjustForLeverage(2, instrumentOf('SPY'));
    eq(r.effectiveStopPct, 2);
    eq(r.sizeDivisor, 1);
    eq(r.known, true);
  });

  test('3배는 손절을 3배로 넓히고 수량을 3분의 1로', () => {
    // 손절 폭을 그대로 두면 3배 자주 걸린다. 손실 한 번의 크기는 같아도
    // **횟수가 3배**라 기대손실이 그만큼 커진다.
    const r = adjustForLeverage(2, instrumentOf('TQQQ'));
    eq(r.effectiveStopPct, 6);
    eq(r.sizeDivisor, 3);
  });

  test('인버스도 크기만큼 넓힌다 — 부호를 그대로 쓰면 손절이 음수가 된다', () => {
    const r = adjustForLeverage(2, instrumentOf('SQQQ'));
    eq(r.effectiveStopPct, 6);
    eq(r.sizeDivisor, 3);
    assert(r.reason.includes('인버스'), r.reason);
  });

  test('모르는 종목은 1배로 치지 않는다', () => {
    // 3배 ETF가 조용히 일반 주식처럼 다뤄지면 손절이 3배 자주 걸리고,
    // 화면에는 '승률이 낮다'로만 보인다. 원인을 못 찾는다.
    const r = adjustForLeverage(2, null);
    eq(r.known, false);
    eq(r.effectiveStopPct, null);
    eq(r.sizeDivisor, null);
    assert(r.reason.includes('모르는'), r.reason);
  });

  test('배수를 모르는 종목도 계산하지 않는다', () => {
    const spec: InstrumentSpec = {
      symbol: 'X', name: 'X', kind: 'ETF',
      leverageFactor: null, decays: false, maxHoldDays: null, note: '',
    };
    eq(adjustForLeverage(2, spec).known, false);
  });

  test('손절 폭이 없으면 계산하지 않는다', () => {
    eq(adjustForLeverage(0, instrumentOf('TQQQ')).known, false);
    eq(adjustForLeverage(NaN, instrumentOf('TQQQ')).known, false);
    eq(adjustForLeverage(-2, instrumentOf('TQQQ')).known, false);
  });

  test('무엇을 왜 바꿨는지 숫자로 적는다', () => {
    const r = adjustForLeverage(2, instrumentOf('TQQQ'));
    assert(r.reason.includes('6.00%'), r.reason);
    assert(r.reason.includes('3'), r.reason);
  });

  // ── 보유 기간 ───────────────────────────────────────────
  const now = 1_800_000_000_000;

  test('일반 ETF는 오래 들고 있어도 된다', () => {
    const r = checkHoldPeriod(instrumentOf('SPY'), now - 400 * DAY, now);
    eq(r.status, 'ok');
    eq(r.limitDays, null);
  });

  test('레버리지 ETF는 한도가 있다', () => {
    eq(instrumentOf('TQQQ')!.maxHoldDays, 10);
    eq(checkHoldPeriod(instrumentOf('TQQQ'), now - 3 * DAY, now).status, 'ok');
    eq(checkHoldPeriod(instrumentOf('TQQQ'), now - 12 * DAY, now).status, 'over');
  });

  test('한도에 닿기 전에 미리 알린다', () => {
    // 한도에 닿는 날 갑자기 알리면 그날이 하필 장이 닫힌 날일 수 있다.
    eq(checkHoldPeriod(instrumentOf('TQQQ'), now - 8.5 * DAY, now).status, 'warn');
    eq(checkHoldPeriod(instrumentOf('TQQQ'), now - 7 * DAY, now).status, 'ok');
  });

  test('넘었으면 왜 문제인지 같이 적는다', () => {
    const r = checkHoldPeriod(instrumentOf('TQQQ'), now - 12 * DAY, now);
    assert(r.reason.includes('짧게'), r.reason);
    close(r.heldDays!, 12, 0.01);
  });

  test('언제 샀는지 모르면 괜찮다고 하지 않는다', () => {
    // 감쇄하는 상품을 언제부터 들고 있는지 모르는 상태 자체가 문제다.
    eq(checkHoldPeriod(instrumentOf('TQQQ'), null, now).status, 'unknown');
    eq(checkHoldPeriod(instrumentOf('TQQQ'), NaN, now).status, 'unknown');
  });

  test('매수 시각이 미래면 기록을 믿지 않는다', () => {
    eq(checkHoldPeriod(instrumentOf('TQQQ'), now + DAY, now).status, 'unknown');
  });

  test('모르는 종목은 기준도 모른다', () => {
    eq(checkHoldPeriod(null, now - DAY, now).status, 'unknown');
  });

  test('천연가스는 한도가 제일 짧다', () => {
    // 롤오버 손실이 가장 심한 축이다.
    const ung = instrumentOf('UNG')!.maxHoldDays!;
    const spy = instrumentOf('132030')!.maxHoldDays!;
    assert(ung < spy, `천연가스(${ung}) < 금(${spy})이어야 한다`);
  });

  // ── 장투 적합성 ─────────────────────────────────────────
  test('감쇄하는 상품은 장투에 안 쓴다', () => {
    eq(suitableForLongTerm(instrumentOf('TQQQ')).ok, false);
    eq(suitableForLongTerm(instrumentOf('UNG')).ok, false);
    eq(suitableForLongTerm(instrumentOf('261220')).ok, false);
  });

  test('일반 ETF는 장투에 쓴다', () => {
    eq(suitableForLongTerm(instrumentOf('SCHD')).ok, true);
    eq(suitableForLongTerm(instrumentOf('069500')).ok, true);
  });

  test('모르는 종목은 장투에 안 쓴다', () => {
    eq(suitableForLongTerm(null).ok, false);
  });

  test('왜 안 되는지 적는다', () => {
    assert(suitableForLongTerm(instrumentOf('TQQQ')).reason.includes('샙니다'), '이유가 없다');
  });

  // ── 표 자체 ─────────────────────────────────────────────
  test('종목 코드에 중복이 없다', () => {
    // 같은 코드가 둘이면 앞의 것만 쓰이고 뒤는 죽은 설정이 된다.
    const s = new Set(KNOWN_INSTRUMENTS.map(i => i.symbol.toUpperCase()));
    eq(s.size, KNOWN_INSTRUMENTS.length);
  });

  test('감쇄하는 상품에는 전부 보유 한도가 있다', () => {
    // 한도 없이 '샌다'고만 적으면 아무것도 막지 못한다.
    for (const i of KNOWN_INSTRUMENTS) {
      if (i.decays) assert(i.maxHoldDays != null && i.maxHoldDays > 0,
        `${i.symbol}: 감쇄하는데 보유 한도가 없습니다`);
    }
  });

  test('배수가 1이 아닌 상품은 전부 감쇄로 표시돼 있다', () => {
    // 레버리지 ETF는 일일 리밸런싱이라 예외 없이 감쇄한다.
    for (const i of KNOWN_INSTRUMENTS) {
      if (i.leverageFactor != null && Math.abs(i.leverageFactor) !== 1) {
        assert(i.decays, `${i.symbol}: ${i.leverageFactor}배인데 감쇄 표시가 없습니다`);
      }
    }
  });

  test('모든 종목에 설명이 있다', () => {
    for (const i of KNOWN_INSTRUMENTS) {
      assert(i.name.length > 0 && i.note.length > 0, `${i.symbol}: 이름이나 설명이 없습니다`);
    }
  });
}
