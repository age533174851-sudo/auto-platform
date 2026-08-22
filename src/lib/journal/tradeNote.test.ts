// src/lib/journal/tradeNote.test.ts
//
// **매매일지가 난수로 고른 문장을 "AI 리뷰"라고 붙이고 있었다.**
//
// 사용자가 입력한 값 중 아무것도 보지 않았다. 손절을 놓쳐 크게 잃은
// 거래에 "손절 규칙을 잘 지켰습니다"가 뜰 수 있었다.
import { test, eq, assert } from '../../test/harness';
import { journalNoteOf } from './tradeNote';

export function runTradeNoteTests() {
  console.log('[매매일지 — 없는 분석을 지어내지 않는다]');

  test('입력한 값에서 실제로 따라 나오는 것만 적는다', () => {
    const n = journalNoteOf({ side: '매수', entryPrice: 100, exitPrice: 110, size: 1, pnl: 10 });
    eq(n.code, 'DERIVED');
    assert(n.text.includes('+10.00%'), n.text);
    assert(n.text.includes('방향이 맞아'), n.text);
  });

  test('같은 값이면 같은 문장이다 — 난수가 아니다', () => {
    const e = { side: '매수', entryPrice: 100, exitPrice: 90, size: 2, pnl: -20 };
    eq(journalNoteOf(e).text, journalNoteOf(e).text);
  });

  test('매도는 방향이 반대다', () => {
    // 가격이 내려가면 매도는 유리하다. 매수와 같은 문장이 나오면 안 된다.
    const sell = journalNoteOf({ side: '매도', entryPrice: 100, exitPrice: 90, size: 1 });
    assert(sell.text.includes('방향이 맞아'), sell.text);
    const buy = journalNoteOf({ side: '매수', entryPrice: 100, exitPrice: 90, size: 1 });
    assert(buy.text.includes('방향이 반대로'), buy.text);
  });

  test('값이 빠지면 계산하지 않는다 — 0으로 채우지 않는다', () => {
    const n = journalNoteOf({ side: '매수', entryPrice: 100, exitPrice: 0, size: 1 });
    eq(n.code, 'INCOMPLETE');
    eq(n.missing.join(','), '청산가');
    assert(n.text.includes('0이라는 뜻이 아닙니다'), n.text);
  });

  test('아무것도 없으면 셋 다 빠졌다고 적는다', () => {
    const n = journalNoteOf({});
    eq(n.code, 'INCOMPLETE');
    eq(n.missing.join(','), '진입가,청산가,수량');
  });

  test('잘했다·아쉽다를 말하지 않는다', () => {
    // 같은 손실이라도 계획대로면 잘한 것이다. 계획은 사용자만 안다.
    const n = journalNoteOf({ side: '매수', entryPrice: 100, exitPrice: 80, size: 1, pnl: -20 });
    for (const w of ['잘', '아쉽', '좋', '실수', '규칙을']) {
      assert(!n.text.includes(w), `판단하는 말이 들어갔습니다: ${w} — ${n.text}`);
    }
  });

  test('손익을 모르면 그 부분을 적지 않는다', () => {
    const n = journalNoteOf({ side: '매수', entryPrice: 100, exitPrice: 110, size: 1 });
    eq(n.code, 'DERIVED');
    assert(!n.text.includes('손익'), n.text);
  });
}
