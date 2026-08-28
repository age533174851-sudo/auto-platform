// src/lib/portfolio/paperAccount.test.ts
//
// **지갑에서 한 실수를 모의 계좌에서 반복하지 않는다.**
//
// 그때 고친 것: 값을 못 매긴 자산이 하나라도 있으면 부분합계를 총자산이라
// 적지 않는다. 여기도 같다 — 미실현을 못 구한 포지션이 하나라도 있으면
// 총자산은 null이다.
import { test, assert, eq, close } from '../../test/harness';
import {
  paperEquityOf, paperTodayPnl, validateSeed, PAPER_SEED_CHOICES,
} from './paperAccount';

const ACCT = {
  balance: 10_000, initial_balance: 10_000,
  total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0,
};

export function runPaperAccountTests() {
  console.log('\n🧪 모의투자 계좌 (부분합계를 총자산이라 적지 않는다)');

  // ══ 시작 전 ══
  test('계좌가 없으면 0이 아니라 "시작하지 않음"이다', () => {
    const v = paperEquityOf({ account: null, positions: [] });
    eq(v.state, 'NOT_STARTED', '아직');
    eq(v.totalEquity, null, '**0으로 적지 않는다** — 0은 전액을 잃은 것이다');
    eq(v.cash, null, '현금도 모른다');
  });

  test('잔고를 못 읽으면 UNREADABLE이다', () => {
    const v = paperEquityOf({ account: { balance: null, initial_balance: 10_000 }, positions: [] });
    eq(v.state, 'UNREADABLE', '못 읽었다');
    eq(v.totalEquity, null, '0이 아니다');
    assert(v.note.includes('0으로 적지 않습니다'), '이유를 남긴다');
  });

  // ══ 총자산 ══
  test('포지션이 없으면 총자산은 현금이다', () => {
    const v = paperEquityOf({ account: ACCT, positions: [] });
    eq(v.state, 'ACTIVE', '돌고 있다');
    eq(v.totalEquity, 10_000, '현금 그대로');
    eq(v.usedMargin, 0, '묶인 증거금 없음');
    eq(v.unrealizedPnl, 0, '미실현 0');
  });

  test('미실현손익을 더해 총자산을 만든다', () => {
    const v = paperEquityOf({
      account: ACCT,
      positions: [
        { margin: 500, unrealizedPnl: 120 },
        { margin: 300, unrealizedPnl: -40 },
      ],
    });
    eq(v.usedMargin, 800, '증거금 합');
    eq(v.unrealizedPnl, 80, '미실현 합');
    eq(v.totalEquity, 10_080, '현금 + 미실현');
    close(v.returnPct!, 0.8, 1e-9, '시작 대비 0.8%');
  });

  // ══ 이 파일이 존재하는 이유 ══
  test('현재가를 못 구한 포지션이 하나라도 있으면 총자산은 null이다', () => {
    const v = paperEquityOf({
      account: ACCT,
      positions: [
        { margin: 500, unrealizedPnl: 120 },
        { margin: 300, unrealizedPnl: null },   // 못 구했다
      ],
    });
    eq(v.unrealizedPnl, null, '부분합계를 미실현이라 적지 않는다');
    eq(v.totalEquity, null, '**총자산도 적지 않는다**');
    eq(v.knownCash, 10_000, '확인된 현금은 따로 준다');
    assert(v.note.includes('1건'), `몇 건인지 적는다 — ${v.note}`);
    eq(v.returnPct, null, '수익률도 계산하지 않는다');
  });

  test('증거금을 못 읽은 줄은 합계에서 빠지되 총자산을 막지는 않는다', () => {
    const v = paperEquityOf({ account: ACCT, positions: [{ margin: null, unrealizedPnl: 50 }] });
    eq(v.usedMargin, 0, '못 읽은 증거금은 안 더한다');
    eq(v.totalEquity, 10_050, '미실현은 알고 있으므로 총자산은 낼 수 있다');
  });

  // ══ 오늘 손익 ══
  test('기준점이 없으면 오늘 손익을 계산하지 않는다', () => {
    const v = paperTodayPnl({ totalEquity: 10_500, dayStartEquity: null });
    eq(v.pnl, null, '**시작 잔고로 대신 재지 않는다** — 그건 누적이다');
    assert(v.note.includes('기준점'), '이유를 남긴다');
  });

  test('총자산을 모르면 오늘 손익도 없다', () => {
    eq(paperTodayPnl({ totalEquity: null, dayStartEquity: 10_000 }).pnl, null, '모른다');
  });

  test('기준점이 있으면 오늘 손익을 낸다', () => {
    const v = paperTodayPnl({ totalEquity: 10_300, dayStartEquity: 10_000 });
    eq(v.pnl, 300, '오늘 +300');
    close(v.pct!, 3, 1e-9, '+3%');
  });

  test('오늘 손해도 그대로 적는다', () => {
    const v = paperTodayPnl({ totalEquity: 9_700, dayStartEquity: 10_000 });
    eq(v.pnl, -300, '−300');
    close(v.pct!, -3, 1e-9, '−3%');
  });

  // ══ 시작 금액 ══
  test('선택지는 USDT 장부 기준이다', () => {
    eq(PAPER_SEED_CHOICES.length, 3, '세 가지');
    assert(PAPER_SEED_CHOICES.every(v => v >= 100), '전부 최소값 이상');
  });

  test('시작 금액을 검사한다', () => {
    eq(validateSeed(10_000).code, 'OK', '보통 값');
    eq(validateSeed(10_000).value, 10_000, '그대로');
    eq(validateSeed(0).code, 'INVALID', '0');
    eq(validateSeed(-5).code, 'INVALID', '음수');
    eq(validateSeed('abc').code, 'INVALID', '숫자가 아님');
    eq(validateSeed(null).code, 'INVALID', 'null');
  });

  test('너무 작으면 막고 이유를 말한다 — 최소 주문 수량에 걸린다', () => {
    const v = validateSeed(50);
    eq(v.code, 'TOO_SMALL', '작다');
    eq(v.value, null, '값을 주지 않는다');
    assert(v.reason.includes('최소 주문 수량'), `왜 막는지 적는다 — ${v.reason}`);
  });

  test('너무 크면 막는다 — 수익률이 전부 0에 붙어 비교가 안 된다', () => {
    eq(validateSeed(99_000_000).code, 'TOO_LARGE', '크다');
    eq(validateSeed(10_000_000).code, 'OK', '상한 자체는 통과');
  });
}
