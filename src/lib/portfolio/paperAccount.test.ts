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
  paperReturnVerdict,
} from './paperAccount';

// **시작한 계좌다.** `started_at`(071)이 없으면 흔적이 없는 이 줄은
// '읽기 경로가 자동으로 만든 빈 계좌'와 구별되지 않는다 — 그때는
// NOT_STARTED가 맞고, 그 판정은 `paperWiring.test.ts`가 따로 못 박는다.
const ACCT = {
  balance: 10_000, initial_balance: 10_000,
  total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0,
  started_at: '2026-08-01T00:00:00Z',
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

  // ── 충전액을 수익으로 세지 않는다 (#592) ────────────────────────
  //
  // 화면에 실제로 나간 숫자: 시작 10,000 · 총자산 61,258.32 ·
  // 거래 손익 0 → **+512.58% 수익**. 사용자가 51,258.32를 충전했을 뿐
  // 거래를 한 번도 안 했는데 그렇게 보였다.
  //
  // 기본 모의 장부에는 입출금 원장이 없다(`paper_challenge_cashflows`는
  // 챌린지 전용). 그래서 ΣF를 표에서 읽을 수는 없다. 다만 **남는 돈으로
  // 복원할 수 있다**:
  //
  //   외부 순입출금 = 총자산 − 시작자본 − (실현손익 + 미실현손익)
  //
  // 이 장부는 펀딩을 모델링하지 않으므로 잔차는 외부 입출금뿐이다.
  // 잔차가 있으면 **수익률은 '계산 불가'가 정답이다** — 0%나 추정치로
  // 위장하면 안 된다. 금액(순손익)은 거래에서 파생되므로 그대로 정확하다.
  console.log('[모의 수익률 — 충전을 수익으로 세지 않는다 (#592)]');

  test('★ 충전만 하고 거래가 없으면 수익률은 계산 불가다 (+512.58%가 아니다)', () => {
    const v = paperReturnVerdict({
      initialBalance: 10_000, totalEquity: 61_258.32,
      realizedPnl: 0, unrealizedPnl: 0,
    });
    eq(v.code, 'EXTERNAL_FLOW', v.reason);
    eq(v.returnPct, null, '★ 충전액을 수익률로 적었다');
    eq(v.netPnl, 0, '거래로 번 돈은 0이다');
    close(v.externalFlow as number, 51_258.32, 0.01, '충전액을 잔차로 복원한다');
    assert(v.reason.includes('입출금'), v.reason);
  });

  test('충전이 없으면 수익률을 정상으로 계산한다', () => {
    const v = paperReturnVerdict({
      initialBalance: 10_000, totalEquity: 11_000,
      realizedPnl: 800, unrealizedPnl: 200,
    });
    eq(v.code, 'OK', v.reason);
    close(v.returnPct as number, 10, 1e-9, '1,000 / 10,000');
    eq(v.netPnl, 1_000);
    close(v.externalFlow as number, 0, 0.01);
  });

  test('손실도 그대로 적는다 — 음수 수익률을 0으로 깎지 않는다', () => {
    const v = paperReturnVerdict({
      initialBalance: 10_000, totalEquity: 9_000,
      realizedPnl: -600, unrealizedPnl: -400,
    });
    eq(v.code, 'OK', v.reason);
    close(v.returnPct as number, -10, 1e-9);
    eq(v.netPnl, -1_000);
  });

  test('출금(음의 잔차)도 계산 불가다 — 부호를 가리지 않는다', () => {
    const v = paperReturnVerdict({
      initialBalance: 10_000, totalEquity: 4_000,
      realizedPnl: 0, unrealizedPnl: 0,
    });
    eq(v.code, 'EXTERNAL_FLOW', v.reason);
    eq(v.returnPct, null);
    close(v.externalFlow as number, -6_000, 0.01);
  });

  test('반올림 오차는 입출금으로 세지 않는다', () => {
    const v = paperReturnVerdict({
      initialBalance: 10_000, totalEquity: 11_000.004,
      realizedPnl: 1_000, unrealizedPnl: 0,
    });
    eq(v.code, 'OK', v.reason);
    assert(v.returnPct != null, '0.004는 충전이 아니다');
  });

  // ── 못 읽은 것을 0으로 읽지 않는다 ──
  test('미실현을 못 구했으면 수익률도 순손익도 적지 않는다', () => {
    const v = paperReturnVerdict({
      initialBalance: 10_000, totalEquity: null,
      realizedPnl: 0, unrealizedPnl: null,
    });
    eq(v.code, 'UNKNOWN', v.reason);
    eq(v.returnPct, null);
    eq(v.netPnl, null, '★ 모르는 미실현을 0으로 더했다');
    eq(v.externalFlow, null);
  });

  test('실현손익을 못 읽었으면 잔차를 충전으로 단정하지 않는다', () => {
    const v = paperReturnVerdict({
      initialBalance: 10_000, totalEquity: 61_258.32,
      realizedPnl: null, unrealizedPnl: 0,
    });
    eq(v.code, 'UNKNOWN', v.reason);
    eq(v.returnPct, null);
    eq(v.netPnl, null);
  });

  test('종잣돈이 없거나 0이면 수익률을 만들지 않는다', () => {
    for (const initial of [null, 0, -1]) {
      const v = paperReturnVerdict({
        initialBalance: initial, totalEquity: 1_000, realizedPnl: 0, unrealizedPnl: 0,
      });
      eq(v.returnPct, null, `initial=${String(initial)} — ${v.reason}`);
      eq(v.code, 'NO_SEED', v.reason);
    }
  });

  test('빈 입력에서 터지지 않고 UNKNOWN을 준다', () => {
    eq(paperReturnVerdict(null as never).code, 'UNKNOWN');
    eq(paperReturnVerdict(undefined as never).returnPct, null);
  });

  // ── 두 경로가 같은 판정을 쓴다 ──
  //
  // 결함이 두 곳에 있었다: `route.ts:118`(현금으로 나눔)과
  // `paperAccount.ts:265`(총자산으로 나눔). 둘 다 충전을 수익으로 셌다.
  // 판정을 한 곳에 두고 양쪽이 그것을 쓰는지 여기서 못 박는다.
  test('paperEquityOf의 수익률이 같은 판정을 통과한다 — 충전이 있으면 null', () => {
    const e = paperEquityOf({
      account: { ...ACCT, balance: 61_258.32, initial_balance: 10_000, total_pnl: 0 },
      positions: [],
    });
    eq(e.code, 'READY');
    close(e.totalEquity as number, 61_258.32, 0.01);
    eq(e.returnPct, null, '★ paperEquityOf가 충전액을 수익률로 적었다');
    assert(/입출금|계산 불가/.test(e.note), `왜 없는지 적는다 — ${e.note}`);
    eq(e.netPnl, 0, '거래로 번 돈은 따로 정확히 적는다');
  });

  test('충전이 없는 계좌는 paperEquityOf도 수익률을 적는다', () => {
    const e = paperEquityOf({
      account: { ...ACCT, balance: 11_000, initial_balance: 10_000, total_pnl: 1_000 },
      positions: [],
    });
    close(e.returnPct as number, 10, 1e-9, e.note);
    eq(e.netPnl, 1_000);
  });
}
