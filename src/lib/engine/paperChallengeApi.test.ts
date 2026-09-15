// src/lib/engine/paperChallengeApi.test.ts
//
// **취소가 남의 사유를 덮어쓰지 않는지, 파라미터가 DB 제약과 같은 집합인지.**
//
// 여기서 고정하는 것
// ──────────────────
//  ① 생성 파라미터는 `083`의 CHECK와 **같은 규칙**이다 (제약 이름을 주석에 적었다)
//  ② 기간은 길이로만 받는다 — 시작·종료 시각을 밖에서 받지 않는다
//  ③ 취소를 다시 눌러도 실패가 아니다 (멱등)
//  ④ **목표 달성·만료가 먼저 정해졌으면 "취소했습니다"라고 적지 않는다**
//  ⑤ 모르는 결과를 성공으로 적지 않는다
//  ⑥ 잔고를 못 읽으면 0이 아니라 null이다
import { test, eq, assert } from '../../test/harness';
import {
  parseChallengeCreate, challengeCreateRejected, challengeEndsAt,
  challengeCancelView, challengeView, CHALLENGE_CANCEL_CODES,
  MAX_INITIAL_EQUITY, MIN_DURATION_DAYS, MAX_DURATION_DAYS,
} from './paperChallengeApi';
import { CLOSE_INTENTS } from './paperChallenge';

const OK = { initialEquity: 10000, targetEquity: 12000, failureEquity: 8000, durationDays: 90 };

export function runPaperChallengeApiTests() {
  // ── ① 생성 파라미터 ──
  test('정상 파라미터는 통과한다', () => {
    const p = parseChallengeCreate(OK);
    assert(!challengeCreateRejected(p), '정상값이 거부됐습니다');
    eq((p as any).params.initialEquity, 10000);
    eq((p as any).params.failureEquity, 8000);
  });

  test('시작금은 0보다 커야 한다 (paper_challenges_equity_chk)', () => {
    for (const v of [0, -1, NaN, null, undefined, '', 'abc']) {
      const p = parseChallengeCreate({ ...OK, initialEquity: v });
      assert(challengeCreateRejected(p), `${JSON.stringify(v)}가 통과했습니다`);
      eq((p as any).code, 'INITIAL_EQUITY');
    }
  });

  test('시작금에 상한이 있다 — 무한대가 들어오지 않는다', () => {
    const p = parseChallengeCreate({ ...OK, initialEquity: MAX_INITIAL_EQUITY + 1 });
    assert(challengeCreateRejected(p), '상한을 넘겼는데 통과했습니다');
    const q = parseChallengeCreate({ ...OK, initialEquity: Infinity });
    assert(challengeCreateRejected(q), 'Infinity가 통과했습니다');
  });

  test('목표는 시작금보다 커야 한다 (paper_challenges_equity_chk)', () => {
    for (const v of [10000, 9999, 0, -5, null]) {
      const p = parseChallengeCreate({ ...OK, targetEquity: v });
      assert(challengeCreateRejected(p), `목표 ${v}가 통과했습니다`);
      eq((p as any).code, 'TARGET_EQUITY');
    }
  });

  test('실패선은 선택이고, 주면 시작금보다 작아야 한다', () => {
    const none = parseChallengeCreate({ ...OK, failureEquity: undefined });
    assert(!challengeCreateRejected(none), '실패선 없음이 거부됐습니다');
    eq((none as any).params.failureEquity, null);

    // **0과 없음은 다르다.** 0은 "전액을 잃을 때까지"이고, 없음은 실패선을 두지 않는 것이다
    const zero = parseChallengeCreate({ ...OK, failureEquity: 0 });
    assert(!challengeCreateRejected(zero), '실패선 0이 거부됐습니다');
    eq((zero as any).params.failureEquity, 0);

    for (const v of [10000, 10001, -1]) {
      const p = parseChallengeCreate({ ...OK, failureEquity: v });
      assert(challengeCreateRejected(p), `실패선 ${v}가 통과했습니다`);
      eq((p as any).code, 'FAILURE_EQUITY');
    }
  });

  test('기간은 정수 일수이고 범위가 있다', () => {
    for (const v of [0, -1, 1.5, MAX_DURATION_DAYS + 1, NaN, null, 'x']) {
      const p = parseChallengeCreate({ ...OK, durationDays: v });
      assert(challengeCreateRejected(p), `기간 ${JSON.stringify(v)}가 통과했습니다`);
      eq((p as any).code, 'DURATION');
    }
    for (const v of [MIN_DURATION_DAYS, MAX_DURATION_DAYS]) {
      const p = parseChallengeCreate({ ...OK, durationDays: v });
      assert(!challengeCreateRejected(p), `경계 ${v}가 거부됐습니다`);
    }
  });

  // ── ② 시각은 밖에서 오지 않는다 ──
  test('본문의 시작·종료·사건 시각은 읽지 않는다', () => {
    const p = parseChallengeCreate({
      ...OK,
      startsAt: '2000-01-01T00:00:00.000Z',
      endsAt: '2000-01-02T00:00:00.000Z',
      eventEffectiveAt: '2000-01-01T00:00:00.000Z',
      event_effective_at: '2000-01-01T00:00:00.000Z',
    });
    assert(!challengeCreateRejected(p), '정상값이 거부됐습니다');
    // 파라미터에 시각 칸이 아예 없다 — 들어올 자리가 없다
    eq(Object.keys((p as any).params).sort().join(','),
       'durationDays,failureEquity,initialEquity,targetEquity');
  });

  test('끝 시각은 시작 시각에서 계산한다 (paper_challenges_period_chk)', () => {
    const start = '2026-01-01T00:00:00.000Z';
    eq(challengeEndsAt(start, 1), '2026-01-02T00:00:00.000Z');
    eq(challengeEndsAt(start, 90), '2026-04-01T00:00:00.000Z');
    // ends_at > starts_at가 항상 성립한다
    assert(Date.parse(challengeEndsAt(start, 1)) > Date.parse(start), '끝이 시작보다 앞입니다');
  });

  test('시작 시각을 못 읽으면 기간을 지어내지 않는다', () => {
    let threw = false;
    try { challengeEndsAt('not a time', 30); } catch { threw = true; }
    assert(threw, '읽지 못한 시각으로 기간을 만들었습니다');
  });

  // ── ③④⑤ 취소 ──
  test('취소 성공은 200이다', () => {
    const v = challengeCancelView('CLOSING');
    eq(v.http, 200); eq(v.ok, true);
  });

  test('다시 눌러도 실패가 아니다 — 멱등이다', () => {
    const v = challengeCancelView('ALREADY_CLOSING', 'CANCELLED');
    eq(v.http, 200); eq(v.ok, true);
  });

  test('이미 다른 사유로 얼어 있으면 "취소했습니다"라고 적지 않는다', () => {
    for (const intent of ['TARGET_REACHED', 'EXPIRED', 'FAILED']) {
      const v = challengeCancelView('INTENT_FROZEN', intent);
      eq(v.ok, false);
      eq(v.http, 409);
      assert(!/취소했습니다/.test(v.message), `${intent}인데 취소했다고 적었습니다`);
    }
  });

  test('얼어 있는 사유는 083의 사유 집합 안에서만 설명한다', () => {
    for (const intent of CLOSE_INTENTS) {
      const v = challengeCancelView('INTENT_FROZEN', intent);
      // CANCELLED로 언 것은 INTENT_FROZEN으로 오지 않지만, 와도 성공으로 적지 않는다
      eq(v.ok, false);
    }
  });

  test('이미 끝났거나 없는 것은 각각 409·404다', () => {
    eq(challengeCancelView('ALREADY_CLOSED').http, 409);
    eq(challengeCancelView('NOT_FOUND').http, 404);
    eq(challengeCancelView('NOT_FOUND').ok, false);
  });

  test('모르는 결과를 성공으로 적지 않는다', () => {
    for (const c of [null, undefined, '', 'WHATEVER', 'closing']) {
      const v = challengeCancelView(c as any);
      eq(v.ok, false);
      eq(v.http, 500);
    }
  });

  test('취소 코드 집합이 087과 같다', () => {
    eq(CHALLENGE_CANCEL_CODES.length, 5);
    for (const c of CHALLENGE_CANCEL_CODES) {
      // 집합 안의 코드는 전부 판정이 있다 — default로 떨어지면 500이 된다
      const v = challengeCancelView(c);
      assert(v.http !== 500, `${c}에 판정이 없습니다`);
    }
  });

  // ── ⑥ 화면이 읽는 모양 ──
  test('잔고를 못 읽으면 0이 아니라 null이다', () => {
    const row = { id: 'x', status: 'RUNNING', initial_equity: 10000, target_equity: 12000 };
    const v = challengeView(row, null);
    eq(v.balance, null);
    eq(v.returnPct, null);
  });

  test('수익률은 시작금이 있을 때만 계산한다', () => {
    const row = { id: 'x', status: 'RUNNING', initial_equity: 10000, target_equity: 12000 };
    eq(challengeView(row, 11000).returnPct, 10);
    eq(challengeView({ ...row, initial_equity: 0 }, 11000).returnPct, null);
  });

  test('주문 가능 여부는 RUNNING일 때만 참이다', () => {
    const row = { id: 'x', initial_equity: 10000, target_equity: 12000 };
    eq(challengeView({ ...row, status: 'RUNNING' }, 1).ordersAllowed, true);
    for (const s of ['READY', 'CLOSING', 'CLOSED', 'WAT', '']) {
      eq(challengeView({ ...row, status: s }, 1).ordersAllowed, false);
    }
  });

  test('계좌 id를 내보내지 않는다', () => {
    const row = {
      id: 'x', status: 'RUNNING', initial_equity: 10000, target_equity: 12000,
      paper_account_id: 'acct-secret', user_id: 'u',
    };
    const v = challengeView(row, 1) as any;
    eq(v.paperAccountId, undefined);
    eq(v.paper_account_id, undefined);
    eq(v.userId, undefined);
    assert(!JSON.stringify(v).includes('acct-secret'), '계좌 id가 응답에 들어갔습니다');
  });
}
