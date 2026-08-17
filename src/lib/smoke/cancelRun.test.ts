// src/lib/smoke/cancelRun.test.ts
//
// **"중지"가 두 가지인데 버튼이 하나였다 — 그 오해를 다시 못 만들게 한다.**
//
// 사람은 "지금 당장 그만"을 눌렀고, 서버는 "다음 회차부터 그만"을 했다.
// 둘 다 필요한 기능이고 둘 다 옳게 동작했다. 틀린 것은 **이름이 하나**인
// 것이었다. 그래서 여기서 가장 많이 확인하는 것은 두 가지다:
//
//   1. 무엇을 시켰는지가 요청에 남는가 (섞이면 거절하는가)
//   2. **CANCELLED가 증거 없이 찍히지 않는가**
//
// 2번이 이 파일의 존재 이유다. 사람이 버튼을 눌렀다는 사실은 거래소가
// 비었다는 증거가 아니다 — 확인하지 못한 것은 0이 아니다.

import { test, eq, assert } from '../../test/harness';
import {
  stopIntentVerdict, cancelPhase, attemptCancelPlan, cancelCompletion,
  needsCancelResume, CANCEL_IN_FLIGHT,
} from './cancelRun';
import { advanceVerdict, runProgress, type AttemptSummary, type DirectionMode } from './smokeRun';

/** 실제 크기의 Gate 조건부 주문 번호 — int64라 JS number로는 못 담는다 */
const SL_ID = '2089209928026685417';
const TP_ID = '2089209928399978533';

const clean = (over: any = {}) => ({
  positionZero: true as boolean | null,
  slOrderId: SL_ID, tpOrderId: TP_ID,
  cancelEntries: [
    { id: SL_ID, state: 'CANCEL_CONFIRMED' },
    { id: TP_ID, state: 'CANCEL_CONFIRMED' },
  ],
  cancelCode: 'CLEAR',
  residualCode: 'ORDERS_CLEAR', residualMine: 0, residualUnknown: 0,
  ...over,
});

const RUN = (over: any = {}) => ({
  attempts: 5, directionMode: 'ALTERNATE' as DirectionMode, failurePolicy: 'SAFE' as const,
  firstSide: 'LONG' as const, state: 'RUNNING', ...over,
});
const holding = (n: number): AttemptSummary => ({
  attemptNo: n, state: 'HOLDING', verdict: null, positionZero: null, residualZero: null,
});
const passed = (n: number): AttemptSummary => ({
  attemptNo: n, state: 'PASS', verdict: 'PASS', positionZero: true, residualZero: true,
});

export function runCancelRunTests() {
  console.log('[스모크 중지 — 무엇을 시켰는가]');

  test('intent가 없으면 아무것도 하지 않는다', () => {
    const v = stopIntentVerdict({ runId: 'r1' });
    eq(v.ok, false); eq(v.code, 'MISSING_INTENT'); eq(v.intent, null);
  });

  test('옛 형식 stop:true는 언제나 다음 회차 중지다 — 뜻이 바뀌지 않는다', () => {
    const v = stopIntentVerdict({ stop: true, runId: 'r1' });
    eq(v.ok, true); eq(v.intent, 'STOP_AFTER_CURRENT');
  });

  test('**옛 형식과 새 intent를 섞어 보내면 거절한다** — 서버가 하나를 고르게 두지 않는다', () => {
    const v = stopIntentVerdict({ stop: true, intent: 'CANCEL_NOW', runId: 'r1' });
    eq(v.ok, false); eq(v.code, 'MIXED_INTENT');
    assert(/다른 요청/.test(v.message), `사유가 이유를 설명해야 한다: ${v.message}`);
  });

  test('모르는 intent는 통과시키지 않는다', () => {
    eq(stopIntentVerdict({ intent: 'STOP', runId: 'r1' }).code, 'UNKNOWN_INTENT');
    eq(stopIntentVerdict({ intent: 'CANCEL', runId: 'r1' }).code, 'UNKNOWN_INTENT');
  });

  test('runId가 없으면 거절한다 — 어느 묶음을 닫을지 모른다', () => {
    eq(stopIntentVerdict({ intent: 'CANCEL_NOW' }).code, 'MISSING_RUN');
  });

  test('CANCEL_NOW는 대소문자를 가리지 않는다', () => {
    eq(stopIntentVerdict({ intent: 'cancel_now', runId: 'r1' }).intent, 'CANCEL_NOW');
  });

  console.log('[스모크 중지 — 지금 회차에 무엇을 하는가]');

  test('HOLDING 회차는 즉시 청산하고 보호주문까지 정리한다', () => {
    eq(attemptCancelPlan({ attempt: { state: 'HOLDING' } }).code, 'CLOSE_AND_CLEAN');
  });

  test('ENTERING도 청산 경로로 간다 — 상태 이름만 보고 "없다"고 하지 않는다', () => {
    // 진입 주문이 이미 나가 있을 수 있다. 상태만 보고 없다고 적으면
    // 그게 유령 포지션이 된다.
    eq(attemptCancelPlan({ attempt: { state: 'ENTERING' } }).code, 'CLOSE_AND_CLEAN');
  });

  test('열린 회차가 없으면 거래소에 아무 요청도 보내지 않는다', () => {
    eq(attemptCancelPlan({ attempt: null }).code, 'NOTHING_OPEN');
    eq(attemptCancelPlan({ attempt: { state: 'PASS' } }).code, 'NOTHING_OPEN');
  });

  test('**같은 버튼을 두 번 눌러도 청산 주문이 두 번 나가지 않는다**', () => {
    // 이미 CLOSING이면 다른 실행기가 닫는 중이다. 여기서 또 보내면
    // 하나는 반대 방향 신규 진입이 된다.
    const p = attemptCancelPlan({ attempt: { state: 'CLOSING' } });
    eq(p.code, 'ALREADY_CLOSING');
    assert(/보내지 않습니다/.test(p.reason), p.reason);
  });

  console.log('[스모크 중지 — 끝났는가]');

  test('넷이 전부 확인되면 CANCELLED', () => {
    const c = cancelCompletion(clean());
    eq(c.code, 'CANCELLED'); eq(c.ok, true);
    eq(c.checks.filter(x => x.ok === true).length, 4);
  });

  test('**포지션이 남아 있으면 CANCELLED가 아니다**', () => {
    const c = cancelCompletion(clean({ positionZero: false }));
    eq(c.code, 'CANCEL_FAILED'); eq(c.ok, false);
    assert(/포지션 0/.test(c.reason), c.reason);
  });

  test('**포지션을 확인하지 못했으면 CANCELLED가 아니다** — 모르는 것은 0이 아니다', () => {
    const c = cancelCompletion(clean({ positionZero: null }));
    eq(c.code, 'CANCEL_FAILED');
    assert(/확인하지 못한 것은 0이 아닙니다/.test(c.reason), c.reason);
  });

  test('**보호주문이 UNKNOWN이면 CANCELLED가 아니다**', () => {
    const c = cancelCompletion(clean({
      cancelEntries: [{ id: SL_ID, state: 'CANCEL_UNKNOWN' }, { id: TP_ID, state: 'CANCEL_CONFIRMED' }],
      cancelCode: 'UNKNOWN',
    }));
    eq(c.code, 'CANCEL_FAILED');
    assert(c.checks.some(x => x.ok == null && x.label.includes(SL_ID)), JSON.stringify(c.checks));
  });

  test('보호주문이 아직 남아 있으면 CANCELLED가 아니다', () => {
    const c = cancelCompletion(clean({
      cancelEntries: [{ id: SL_ID, state: 'STILL_PRESENT' }, { id: TP_ID, state: 'CANCEL_CONFIRMED' }],
      cancelCode: 'STILL_PRESENT',
    }));
    eq(c.code, 'CANCEL_FAILED');
    assert(/거래소에서 직접 확인/.test(c.reason), c.reason);
  });

  test('**판별하지 못한 잔여 주문이 있으면 CANCELLED가 아니다**', () => {
    // 내 것으로 판별된 것만 0이면 통과시키던 것이 #128 이전의 거짓 PASS다.
    const c = cancelCompletion(clean({ residualMine: 0, residualUnknown: 2, residualCode: 'MINE_PRESENT' }));
    eq(c.code, 'CANCEL_FAILED');
  });

  test('잔여를 읽지 못했으면(ORDERS_UNKNOWN) CANCELLED가 아니다', () => {
    const c = cancelCompletion(clean({ residualCode: 'ORDERS_UNKNOWN', residualMine: 0, residualUnknown: 0 }));
    eq(c.code, 'CANCEL_FAILED');
  });

  test('보호주문을 건 적이 없으면 지울 것도 없다 — 그건 통과다', () => {
    const c = cancelCompletion(clean({
      slOrderId: null, tpOrderId: null, cancelEntries: [], cancelCode: 'NOTHING_TO_CANCEL',
    }));
    eq(c.code, 'CANCELLED');
  });

  console.log('[스모크 중지 — int64 주문번호]');

  test('**19자리 주문 번호를 문자열 그대로 대조한다** (#139)', () => {
    assert(!Number.isSafeInteger(Number(SL_ID)), 'SL_ID는 안전 정수 범위를 넘어야 한다');
    const c = cancelCompletion(clean());
    eq(c.code, 'CANCELLED');
    assert(c.checks.some(x => x.label.includes(SL_ID)), '정확한 번호가 증거에 남아야 한다');
  });

  test('**반올림된 번호는 취소 확인으로 읽히지 않는다** — 그 번호로는 지운 적이 없다', () => {
    // JSON.parse가 int64를 Number로 만들면 끝자리가 반올림된다.
    const rounded = String(Number(SL_ID));   // 2089209928026685400
    assert(rounded !== SL_ID, '반올림된 값과 원래 값이 달라야 한다');
    const c = cancelCompletion(clean({ slOrderId: rounded }));
    eq(c.code, 'CANCEL_FAILED');
    assert(c.checks.some(x => x.label.includes(rounded) && x.ok == null),
      '반올림된 번호는 "취소 확인"이 아니라 "확인 못 함"이어야 한다');
  });

  test('마지막 한 자리만 다른 두 번호가 서로 다른 것으로 대조된다', () => {
    const other = SL_ID.slice(0, -1) + '8';
    eq(Number(other) === Number(SL_ID), true);   // number로는 같아진다
    const c = cancelCompletion(clean({
      cancelEntries: [{ id: other, state: 'CANCEL_CONFIRMED' }, { id: TP_ID, state: 'CANCEL_CONFIRMED' }],
    }));
    eq(c.code, 'CANCEL_FAILED');
  });

  console.log('[스모크 중지 — 진행 표시]');

  test('누른 직후는 "중지 요청됨"이지 "완료"가 아니다', () => {
    eq(cancelPhase('CANCEL_REQUESTED').label, '중지 요청됨');
    eq(cancelPhase('CANCEL_REQUESTED').done, false);
    eq(cancelPhase('CANCEL_REQUESTED').ok, false);
  });

  test('단계가 순서대로 보인다 — 청산 중 → 정리 중 → 완료', () => {
    eq(cancelPhase('CLOSING').label, '포지션 청산 중');
    eq(cancelPhase('CLEANING_PROTECTION').label, '보호주문 정리 중');
    eq(cancelPhase('CANCELLED').label, '중지 완료');
    eq(cancelPhase('CANCELLED').ok, true);
  });

  test('**중지 실패는 완료로 보이지 않는다**', () => {
    const p = cancelPhase('CANCEL_FAILED');
    eq(p.done, true); eq(p.ok, false);
    assert(/직접 확인/.test(p.label), p.label);
  });

  test('반복만 중지는 "열린 회차는 마감 시각에 청산"이라고 말한다', () => {
    assert(/마감 시각/.test(cancelPhase('STOPPED').label), cancelPhase('STOPPED').label);
  });

  console.log('[스모크 중지 — 중지 중에는 새 회차를 열지 않는다]');

  test('**5회 중 1회차 HOLDING에서 반복만 중지 → 2~5회차는 시작하지 않는다**', () => {
    const v = advanceVerdict({ run: RUN({ state: 'STOPPED' }), attempts: [holding(1)] });
    eq(v.code, 'STOPPED'); eq(v.nextAttemptNo, null);
  });

  test('반복만 중지 뒤 1회차가 PASS로 끝나도 2회차를 열지 않는다', () => {
    const v = advanceVerdict({ run: RUN({ state: 'STOPPED' }), attempts: [passed(1)] });
    eq(v.code, 'STOPPED'); eq(v.nextAttemptNo, null);
  });

  test('**중지 절차가 도는 동안 새 회차가 열리지 않는다**', () => {
    for (const st of CANCEL_IN_FLIGHT) {
      const v = advanceVerdict({ run: RUN({ state: st }), attempts: [passed(1)] });
      eq(v.code, 'CANCELLING');
      eq(v.nextAttemptNo, null);
    }
  });

  test('중지가 끝난 묶음도 새 회차를 열지 않는다', () => {
    eq(advanceVerdict({ run: RUN({ state: 'CANCELLED' }), attempts: [passed(1)] }).code, 'CANCELLED');
    eq(advanceVerdict({ run: RUN({ state: 'CANCEL_FAILED' }), attempts: [passed(1)] }).code, 'CANCELLED');
  });

  test('RUNNING이면 예전처럼 다음 회차를 연다 — 기존 동작을 깨지 않는다', () => {
    const v = advanceVerdict({ run: RUN(), attempts: [passed(1)] });
    eq(v.code, 'START_NEXT'); eq(v.nextAttemptNo, 2); eq(v.nextSide, 'SHORT');
  });

  console.log('[스모크 중지 — 브라우저를 닫아도 끝난다]');

  test('**끊긴 중지는 워커가 이어받을 대상으로 표시된다**', () => {
    eq(needsCancelResume('CANCEL_REQUESTED'), true);
    eq(needsCancelResume('CLOSING'), true);
    eq(needsCancelResume('CLEANING_PROTECTION'), true);
  });

  test('끝난 묶음은 다시 청산하러 가지 않는다', () => {
    eq(needsCancelResume('CANCELLED'), false);
    eq(needsCancelResume('CANCEL_FAILED'), false);
    eq(needsCancelResume('RUNNING'), false);
    eq(needsCancelResume('STOPPED'), false);
  });

  console.log('[스모크 중지 — 회차 표시]');

  test('**사람이 종료한 회차는 실패로 세지 않는다** — 없던 고장을 찾게 만들지 않는다', () => {
    const p = runProgress({
      total: 5, firstSide: 'LONG', directionMode: 'ALTERNATE',
      attempts: [
        passed(1),
        { attemptNo: 2, state: 'CANCELLED', verdict: 'CANCELLED', positionZero: true, residualZero: true },
      ],
    });
    eq(p.passed, 1);
    eq(p.failed, 0);
    eq(p.completed, 2);
    eq(p.marks[1].label, '중지됨');
  });

  test('중지된 회차가 통과로도 세지 않는다 — 유지 시간을 안 채웠다', () => {
    const p = runProgress({
      total: 2, firstSide: 'LONG', directionMode: 'LONG',
      attempts: [{ attemptNo: 1, state: 'CANCELLED', verdict: 'CANCELLED', positionZero: true, residualZero: true }],
    });
    eq(p.passed, 0);
  });
}
