// src/lib/journal/tradeNote.test.ts
//
// 이 시험이 막는 것: **지어낸 조언이 일지에 다시 들어오는 것.**
//
// 예전에는 고정 문장 아홉 개 중 하나를 난수로 골라 "AI 리뷰"로 붙였다.
// 같은 거래를 두 번 저장하면 다른 문장이 나왔고, 거래 내용과는 아무
// 관계가 없었다.
import { test, eq, assert } from '../../test/harness';
import { tradeNote } from './tradeNote';

export function runTradeNoteTests() {
  console.log('[매매일지 한 줄 — 입력에서 따라 나온 것만]');

  test('같은 입력은 언제나 같은 문장을 낸다 — 난수가 섞이면 안 된다', () => {
    const i = { side: '매수', entryPrice: 100, exitPrice: 110, size: 5, pnl: 50, pnlPct: 10 };
    const a = tradeNote(i).text;
    const b = tradeNote(i).text;
    const c = tradeNote(i).text;
    eq(a, b, '같은 거래에 다른 문장이 나왔다');
    eq(b, c, '같은 거래에 다른 문장이 나왔다');
    assert(a.length > 0, '아무것도 적지 않았다');
  });

  test('명목가와 손익은 입력에서 계산된 값이다', () => {
    const r = tradeNote({ side: '매수', entryPrice: 100, exitPrice: 110, size: 5, pnl: 50, pnlPct: 10 });
    assert(r.text.includes('명목 500'), r.text);
    assert(r.text.includes('+50'), r.text);
    assert(r.text.includes('+10%'), r.text);
  });

  test('손실 거래를 이익처럼 적지 않는다', () => {
    const r = tradeNote({ side: '매수', entryPrice: 100, exitPrice: 90, size: 5, pnl: -50, pnlPct: -10 });
    assert(r.text.includes('-50'), r.text);
    assert(!r.text.includes('+'), `이익 기호가 섞였다: ${r.text}`);
    assert(r.text.includes('내렸습니다'), r.text);
  });

  test('매도는 가격이 내려야 이익이다 — 방향을 뒤집어 적지 않는다', () => {
    const r = tradeNote({ side: '매도', entryPrice: 100, exitPrice: 90, size: 5, pnl: 50, pnlPct: 10 });
    assert(r.text.includes('매도'), r.text);
    assert(r.text.includes('내렸습니다'), r.text);
    assert(r.text.includes('+50'), r.text);
  });

  test('**값이 비면 손익 0을 "본전"으로 적지 않는다**', () => {
    // computePnl 은 입력이 모자라면 0을 돌려준다. 그 0은 본전이 아니라
    // 계산하지 못한 것이다.
    const r = tradeNote({ side: '매수', entryPrice: 100, exitPrice: 0, size: 5, pnl: 0, pnlPct: 0 });
    assert(!r.facts.some(f => f.startsWith('손익')), `계산하지 못한 손익을 적었다: ${JSON.stringify(r.facts)}`);
    assert(r.unknown.some(u => u.startsWith('손익')), '알 수 없다고 적지 않았다');
  });

  test('손절 준수 여부는 **언제나** 알 수 없다고 적는다 — 칸이 없다', () => {
    const r = tradeNote({ side: '매수', entryPrice: 100, exitPrice: 110, size: 5, pnl: 50, pnlPct: 10 });
    assert(r.unknown.some(u => u.includes('손절')), '손절을 안다고 넘어갔다');
    // 예전 문구가 그대로 돌아오지 않는지 본다.
    assert(!r.text.includes('손절 규칙을 잘'), r.text);
    assert(!r.text.includes('FOMO'), r.text);
  });

  test('조언하지 않는다 — 관측에서 따라 나오지 않는 문장은 없다', () => {
    const r = tradeNote({ side: '매수', entryPrice: 100, exitPrice: 110, size: 5, pnl: 50, pnlPct: 10 });
    for (const banned of ['하세요', '고려해', '좋습니다', '아쉽습니다', '훌륭']) {
      assert(!r.text.includes(banned), `조언 문구가 들어갔다(${banned}): ${r.text}`);
    }
  });

  test('아무것도 못 받으면 빈 문장이고, 모르는 것은 남는다', () => {
    const r = tradeNote(null);
    eq(r.text, '', '값도 없이 무언가를 적었다');
    assert(r.unknown.length >= 3, JSON.stringify(r.unknown));
  });
}
