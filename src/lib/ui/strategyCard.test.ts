// src/lib/ui/strategyCard.test.ts
//
// 막으려는 것:
//  1. **없는 값을 0으로 그리는 것.** RSI 0은 극단적 과매도이지 '모름'이
//     아니고, 평균단가 0은 공짜로 샀다는 뜻이다. 이 저장소는 이미 한 번
//     크게 덴 적이 있다 — 예시 카드에 승률 67%가 박혀 있었고 화면은
//     '실행중'이라고 말했지만 아무것도 안 돌고 있었다
//  2. DCA에 익절 50% / 손절 20%를 다른 전략과 같은 자리에 크게 띄우는 것
//  3. 점수를 모르는데 '기회 근접'으로 세는 것 — 그러면 기본 필터가
//     결국 전부를 보여주고 필터가 없는 것과 같아진다
//  4. 오류난 전략을 필터로 숨기는 것
//  5. 3건에서 나온 승률을 20건짜리와 나란히 놓는 것
import { test, assert, eq } from '../../test/harness';
import {
  kindOf, KIND_FIELDS, showsTpSl, cardRowsOf, unwiredFieldsOf, UNKNOWN_TEXT,
  activityOf, ACTIVITY_TONE, OPPORTUNITY_RATIO,
  DEFAULT_FILTERS, filterCountsOf, passesFilter, ALL_ACTIVITIES,
  actionsOf, isCompact,
  moneyRowsOf, perfSummaryOf, MIN_TRADES_FOR_PERF,
  envLineOf,
  type Activity,
} from './strategyCard';

export function runStrategyCardTests() {
  console.log('[전략 카드 — 전략마다 보는 것이 다르다]');

  test('타입을 종류로 옮긴다', () => {
    eq(kindOf('ema_cross'), 'TREND');
    eq(kindOf('macd_trend'), 'TREND');
    eq(kindOf('rsi_reversal'), 'REVERSAL');
    eq(kindOf('breakout'), 'BREAKOUT');
    eq(kindOf('dca'), 'ACCUMULATE');
    eq(kindOf('funding_rate'), 'FUNDING');
    eq(kindOf('ai_strategy'), 'AI');
  });

  test('모르는 타입을 아무 종류로나 밀어 넣지 않는다', () => {
    eq(kindOf(null), 'UNKNOWN');
    eq(kindOf(''), 'UNKNOWN');
    eq(kindOf('아무거나'), 'UNKNOWN');
  });

  test('종류마다 보는 것이 실제로 다르다', () => {
    // 이게 같으면 카드 일곱 개가 복사본이라는 원래 문제 그대로다.
    const keysOf = (k: any) => KIND_FIELDS[k].map(x => x.key).join(',');
    const seen = new Set<string>();
    for (const k of ['TREND', 'REVERSAL', 'BREAKOUT', 'ACCUMULATE', 'FUNDING', 'AI'] as const) {
      const s = keysOf(k);
      assert(!seen.has(s), `${k}가 다른 종류와 같은 칸을 본다`);
      seen.add(s);
    }
  });

  test('DCA는 익절·손절을 앞면에 두지 않는다', () => {
    // 익절 50% / 손절 20%짜리 적립은 사실상 그 규칙이 없는 것인데,
    // 다른 전략과 같은 자리에 크게 띄우면 있는 규칙으로 읽힌다.
    eq(showsTpSl('ACCUMULATE'), false);
    eq(showsTpSl('TREND'), true);
    const keys = KIND_FIELDS.ACCUMULATE.map(x => x.key);
    assert(!keys.includes('tp'), keys.join(','));
    assert(!keys.includes('sl'), keys.join(','));
    // 대신 적립에서 실제로 중요한 것들이 있어야 한다.
    for (const k of ['nextBuyAt', 'amountPerBuy', 'avgCost', 'investedTotal']) {
      assert(keys.includes(k), `${k}가 없다`);
    }
  });

  console.log('[전략 카드 — 없는 값을 지어내지 않는다]');

  test('값이 없으면 0이 아니라 —다', () => {
    const rows = cardRowsOf('REVERSAL', {});
    for (const r of rows) {
      eq(r.value, UNKNOWN_TEXT, r.label);
      eq(r.known, false, r.label);
    }
  });

  test('진짜 0은 0으로 그린다 — 모름과 다르다', () => {
    // RSI 0은 극단적 과매도지 '모름'이 아니다.
    const rows = cardRowsOf('REVERSAL', { rsi: 0 });
    const rsi = rows.find(r => r.key === 'rsi')!;
    eq(rsi.value, '0');
    eq(rsi.known, true);
  });

  test('숫자가 아닌 값은 모르는 것으로 센다', () => {
    for (const bad of [NaN, Infinity, 'abc', null, undefined, '']) {
      const rows = cardRowsOf('REVERSAL', { rsi: bad });
      eq(rows.find(r => r.key === 'rsi')!.known, false, String(bad));
    }
  });

  test('아직 계산 안 되는 칸을 카드가 스스로 말한다', () => {
    // 이 목록이 그대로 "안 붙인 배선 목록"이 된다.
    const all = unwiredFieldsOf('BREAKOUT', {});
    eq(all.length, KIND_FIELDS.BREAKOUT.length);
    const some = unwiredFieldsOf('BREAKOUT', { resistance: 188.4, lastPrice: 186.9 });
    eq(some.length, KIND_FIELDS.BREAKOUT.length - 2);
    assert(!some.includes('저항'), some.join(','));
  });

  test('평균단가 0을 아직 안 샀다로 읽지 않는다', () => {
    const rows = cardRowsOf('ACCUMULATE', { avgCost: 0 });
    const c = rows.find(r => r.key === 'avgCost')!;
    eq(c.known, true, '0은 공짜로 샀다는 뜻이고, 그건 모름이 아니다');
  });

  console.log('[전략 카드 — 무엇이 지금 도는가]');

  test('점수를 모르면 기회가 아니다', () => {
    // 모르는 것을 기회로 세면 기본 필터가 결국 전부를 보여준다.
    eq(activityOf({ enabled: true, status: 'stopped' }), 'WAITING');
    eq(activityOf({ enabled: true, status: 'stopped', score: 79 }), 'WAITING');
    eq(activityOf({ enabled: true, status: 'stopped', requiredScore: 80 }), 'WAITING');
  });

  test('기준의 90%에 닿으면 기회 근접이다', () => {
    eq(OPPORTUNITY_RATIO, 0.9);
    eq(activityOf({ status: 'stopped', score: 72, requiredScore: 80 }), 'OPPORTUNITY');
    eq(activityOf({ status: 'stopped', score: 71, requiredScore: 80, enabled: true }), 'WAITING');
  });

  test('돌고 있으면 점수와 무관하게 실행중이다', () => {
    eq(activityOf({ status: 'running', score: 1, requiredScore: 80 }), 'RUNNING');
  });

  test('오류가 가장 먼저다', () => {
    eq(activityOf({ status: 'error', score: 99, requiredScore: 80 }), 'ERROR');
    eq(ACTIVITY_TONE.ERROR, 'bad');
  });

  test('켜 뒀는데 조건이 안 맞는 것과 꺼 둔 것을 가른다', () => {
    eq(activityOf({ enabled: true, status: 'stopped' }), 'WAITING');
    eq(activityOf({ enabled: false, status: 'stopped' }), 'STOPPED');
  });

  test('일시중지는 정지다 — 실행중으로 세지 않는다', () => {
    eq(activityOf({ status: 'paused', enabled: true }), 'STOPPED');
  });

  console.log('[전략 카드 — 필터]');

  test('기본 필터가 오류를 숨기지 않는다', () => {
    // 숨기면 고장이 조용해진다.
    assert(DEFAULT_FILTERS.includes('ERROR'), DEFAULT_FILTERS.join(','));
    assert(DEFAULT_FILTERS.includes('RUNNING'), DEFAULT_FILTERS.join(','));
    assert(DEFAULT_FILTERS.includes('OPPORTUNITY'), DEFAULT_FILTERS.join(','));
    assert(!DEFAULT_FILTERS.includes('STOPPED'), '정지된 전략 스무 개를 매번 볼 이유가 없다');
  });

  test('빈 필터는 전체다 — 화면이 텅 비지 않는다', () => {
    for (const a of ALL_ACTIVITIES) {
      eq(passesFilter(a, []), true, a);
      eq(passesFilter(a, null), true, a);
    }
  });

  test('칸마다 몇 개인지 센다', () => {
    const list: Activity[] = ['RUNNING', 'RUNNING', 'OPPORTUNITY', 'STOPPED'];
    const c = filterCountsOf(list);
    eq(c.RUNNING, 2);
    eq(c.OPPORTUNITY, 1);
    eq(c.STOPPED, 1);
    eq(c.WAITING, 0);
    eq(c.ERROR, 0);
  });

  console.log('[전략 카드 — 버튼과 높이]');

  test('버튼 세 개가 언제나 자리를 차지하지 않는다', () => {
    const stopped = actionsOf('STOPPED');
    eq(stopped.primary.id, 'start');
    eq(stopped.inMenu.length, 1, '멈춰 있을 때 중지 버튼은 뜻이 없다');

    const running = actionsOf('RUNNING');
    eq(running.primary.id, 'pause');
    eq(running.inMenu.map(x => x.id).join(','), 'stop,settings');
  });

  test('정지된 전략은 한 줄로 접힌다', () => {
    eq(isCompact('STOPPED'), true);
    eq(isCompact('RUNNING'), false);
    eq(isCompact('OPPORTUNITY'), false);
    eq(isCompact('ERROR'), false, '오류를 접으면 안 보인다');
  });

  console.log('[전략 카드 — 이 전략에 돈을 얼마 맡겼나]');

  test('배정을 모르는 것과 0을 가른다', () => {
    // 배정 0은 '돈을 안 맡겼다'이고, 그건 '아직 계산 안 됨'과 다르다.
    const none = moneyRowsOf({});
    eq(none[0].value, UNKNOWN_TEXT);
    eq(none[0].known, false);

    const zero = moneyRowsOf({ allocated: 0 });
    eq(zero[0].known, true);
    eq(zero[0].value, '0');
  });

  test('다섯 칸이 다 나온다', () => {
    const rows = moneyRowsOf({ allocated: 5000, equity: 5183, pnl: 183, riskPct: 0.37, openPositions: 1 });
    eq(rows.length, 5);
    eq(rows[4].value, '1건');
    assert(rows.every(r => r.known), rows.map(r => r.label).join(','));
  });

  console.log('[전략 카드 — 표본을 같이 말한다]');

  test('표본이 모자라면 그렇다고 적는다', () => {
    // 3건에서 나온 승률 67%는 정보가 아니라 우연이다.
    const p = perfSummaryOf({ winRatePct: 67, trades: 3 });
    eq(p.enoughSamples, false);
    assert(p.note.includes('3건'), p.note);
    assert(p.note.includes(String(MIN_TRADES_FOR_PERF)), p.note);
  });

  test('건수를 모르면 충분하다고 하지 않는다', () => {
    const p = perfSummaryOf({ winRatePct: 67 });
    eq(p.enoughSamples, false);
    assert(p.note.includes('확인하지 못했'), p.note);
  });

  test('표본이 충분하면 군말이 없다', () => {
    const p = perfSummaryOf({ return30dPct: 3.8, winRatePct: 46, profitFactor: 1.31, maxDrawdownPct: -4.8, trades: 120 });
    eq(p.enoughSamples, true);
    eq(p.note, '');
    assert(p.rows.every(r => r.known), p.rows.map(r => r.label).join(','));
  });

  console.log('[전략 카드 — 카드에도 환경이 보인다]');

  test('실전만 실제 자금이라고 말한다', () => {
    eq(envLineOf('LIVE_SMALL', 'Gate').realMoney, true);
    eq(envLineOf('TESTNET', 'Gate').realMoney, false);
    eq(envLineOf('PAPER').realMoney, false);
  });

  test('모르는 값은 실전이 아니다 — 다만 모의라고도 안 한다', () => {
    const v = envLineOf(null);
    eq(v.realMoney, false);
    assert(v.text.includes('TESTNET'), v.text);
  });

  test('모의는 체결이 가짜라는 것을 적는다', () => {
    assert(envLineOf('PAPER').text.includes('MOCK 체결'), envLineOf('PAPER').text);
  });
}
