// src/lib/ui/display.test.ts
//
// 화면에 실제로 떴던 네 가지를 못 박는다:
//   `0.00000000 USDT` · 반복되는 '확인 불가' · `내 원본 v1 (v1)` · 긴 빨간 박스
import { test, eq, assert } from '../../test/harness';
import {
  shownValue, moneyText, pnlText, qtyText, pctText, digitsFor,
  strategyLabel, noticeOf, splitNotice, topNotice, numOrNull,
  UNKNOWN_TEXT, UNKNOWN_LABEL, HEADLINE_MAX,
} from './display';

export function runDisplayTests() {
  console.log('\n🧪 표시 계층 — 숫자·상태·이름을 한 곳에서 정한다');

  // ══ ① 0은 0이다 ══
  test('잔고 0은 0 USDT다 — 0.00000000이 아니다', () => {
    eq(moneyText(0).text, '0 USDT');
  });

  test('0에 소수 자릿수를 붙이지 않는다', () => {
    eq(digitsFor(0, 'money'), 0);
    eq(digitsFor(0, 'qty'), 0);
  });

  test('보통 금액은 두 자리다', () => {
    eq(moneyText(10000).text, '10,000.00 USDT');
    eq(moneyText(1234.5678).text, '1,234.57 USDT');
  });

  test('아주 작은 값에만 자릿수를 늘린다 — 크기가 자릿수를 정한다', () => {
    assert(moneyText(0.00001234).text.startsWith('0.0000123'), moneyText(0.00001234).text);
    eq(moneyText(0.5).text, '0.50 USDT');
  });

  // ══ ② 모르는 것은 0이 아니다 ══
  test('null·빈 문자열·NaN은 값이 아니다', () => {
    for (const bad of [null, undefined, '', NaN, Infinity, 'abc']) {
      eq(numOrNull(bad), null, `${String(bad)}`);
      eq(shownValue(bad, 'money').known, false);
    }
  });

  test('모르는 값은 0으로 적히지 않는다', () => {
    const s = moneyText(null);
    eq(s.text, UNKNOWN_TEXT);
    eq(s.known, false);
    assert(!s.text.includes('0'), `0이 새어 나왔다 — ${s.text}`);
  });

  test('문장 자리에서는 확인 불가라고 쓴다', () => {
    eq(shownValue(null, 'money', { unknownText: UNKNOWN_LABEL }).text, '확인 불가');
  });

  test('true/false를 숫자로 읽지 않는다', () => {
    eq(numOrNull(true), null);
    eq(numOrNull(false), null);
  });

  // ══ ③ 손익은 부호와 색이 값에서 나온다 ══
  test('이익은 +와 good, 손실은 −와 bad다', () => {
    const up = pnlText(12.5); const down = pnlText(-12.5);
    eq(up.text, '+12.50 USDT'); eq(up.tone, 'good');
    eq(down.text, '−12.50 USDT'); eq(down.tone, 'bad');
  });

  test('손익 0은 부호도 색도 없다 — 이겼다고도 졌다고도 하지 않는다', () => {
    const z = pnlText(0);
    eq(z.text, '0 USDT');
    eq(z.tone, 'muted');
  });

  test('음수 부호는 하이픈이 아니다 — 빈칸 표시와 헷갈리지 않게', () => {
    assert(!pnlText(-1).text.includes('-'), pnlText(-1).text);
    eq(UNKNOWN_TEXT, '—');
  });

  // ══ ④ 수량 ══
  test('수량 0은 0이다', () => { eq(qtyText(0).text, '0'); });
  test('작은 수량은 유효한 자리까지 보여 준다', () => {
    assert(qtyText(0.00012345).text.length > 4, qtyText(0.00012345).text);
    eq(qtyText(1.5).text, '1.5000');
  });

  // ══ ⑤ 퍼센트·건수 ══
  test('퍼센트와 건수는 단위가 붙는다', () => {
    eq(pctText(12.345).text, '12.35%');
    eq(pctText(5, true).text, '+5.00%');
    eq(shownValue(3, 'count').text, '3건');
  });

  // ══ ⑥ 내 원본 v1 (v1) ══
  test('이름이 이미 버전을 말하면 다시 붙이지 않는다', () => {
    eq(strategyLabel({ name: '내 원본 v1', version: 1 }), '내 원본 v1');
    eq(strategyLabel({ name: '내 원본 v1', version: 'v1' }), '내 원본 v1');
  });

  test('이름에 버전이 없으면 붙인다', () => {
    eq(strategyLabel({ name: '스캘핑', version: 2 }), '스캘핑 (v2)');
  });

  test('다른 버전이면 붙인다 — 겹칠 때만 생략한다', () => {
    eq(strategyLabel({ name: '내 원본 v1', version: 2 }), '내 원본 v1 (v2)');
  });

  test('버전이 없으면 이름만 쓴다', () => {
    eq(strategyLabel({ name: '스캘핑' }), '스캘핑');
    eq(strategyLabel({ name: '스캘핑', version: '' }), '스캘핑');
  });

  test('이름이 없으면 지어내지 않는다', () => {
    eq(strategyLabel({ name: '', version: 1 }), UNKNOWN_LABEL);
    eq(strategyLabel(null), UNKNOWN_LABEL);
  });

  test('이름 안의 다른 숫자를 버전으로 착각하지 않는다', () => {
    // 'BTC 15분'의 15는 버전이 아니다
    eq(strategyLabel({ name: 'BTC 15분', version: 3 }), 'BTC 15분 (v3)');
  });

  // ══ ⑦ 경고는 짧고, 급한 것만 빨갛다 ══
  test('막힌 것만 빨갛다', () => {
    eq(noticeOf('blocking', 'x').tone, 'bad');
    eq(noticeOf('warn', 'x').tone, 'warn');
    eq(noticeOf('info', 'x').tone, 'muted');
  });

  test('긴 문장은 첫 줄과 상세로 나뉜다', () => {
    const long = 'DB 오류가 났습니다 — column paper_accounts.started_at does not exist 라고 서버가 답했습니다';
    const n = splitNotice('blocking', long);
    assert(n.headline.length <= HEADLINE_MAX, `첫 줄이 길다(${n.headline.length}) — ${n.headline}`);
    assert(!!n.detail, '상세가 있어야 한다');
    assert(!n.headline.includes('does not exist'), `DB 오류가 첫 줄에 샜다 — ${n.headline}`);
  });

  test('짧은 문장은 나누지 않는다', () => {
    const n = splitNotice('warn', '시세를 받지 못했습니다');
    eq(n.headline, '시세를 받지 못했습니다');
    eq(n.detail, undefined);
  });

  test('빈 문장을 빈 경고로 만들지 않는다', () => {
    eq(splitNotice('warn', '').headline, UNKNOWN_LABEL);
    eq(splitNotice('warn', null).headline, UNKNOWN_LABEL);
  });

  test('맨 위에는 막힌 것 하나만 — 다 보여 주면 아무것도 안 보인다', () => {
    const list = [noticeOf('info', 'i'), noticeOf('warn', 'w'), noticeOf('blocking', 'b')];
    eq(topNotice(list)?.headline, 'b');
    eq(topNotice([noticeOf('info', 'i'), noticeOf('warn', 'w')])?.headline, 'w');
    eq(topNotice([]), null);
    eq(topNotice(null), null);
  });
}
