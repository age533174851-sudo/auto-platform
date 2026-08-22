// src/lib/autotrade/runOutcome.test.ts
//
// **자동매매를 켜면 실평가 경로가 둘이었다.**
//
//   [켜기] → POST /api/autotrade/schedule
//              ├ 예약 저장
//              └ 서버가 evaluateIfDue() 실행        ← 첫 번째
//          → AutotradeControl.save() → runFirstCheck()
//              └ 전략 API POST (checkOnly 아님)     ← 두 번째
//
// 아래쪽 중복 방어가 받아 주고 있었지만, 실평가 경로 둘을 그 방어에
// 기대어 두는 것은 **방어 하나가 약해지는 날 주문이 두 번 나간다**는
// 뜻이다. 서버는 이미 첫 평가 결과를 응답에 담아 준다.
import { test, eq, assert } from '../../test/harness';
import { classifyRun, firstEvaluationVerdict } from './runOutcome';

export function runRunOutcomeTests() {
  console.log('[첫 평가 — 켤 때 두 번 돌리지 않는다]');

  test('서버가 돌린 진입 결과를 그대로 쓴다', () => {
    const v = firstEvaluationVerdict({ ran: true, outcome: 'ENTERED', summary: '조건 충족' });
    eq(v.outcome, 'ORDER_SENT'); eq(v.ordered, true); eq(v.tone, 'good');
  });

  test('나갔다와 체결됐다를 섞지 않는다', () => {
    // ENTERED는 주문을 보냈다는 뜻이다. 체결은 아직 모른다.
    const v = firstEvaluationVerdict({ ran: true, outcome: 'ENTERED' });
    eq(v.outcome, 'ORDER_SENT');
    assert(v.outcome !== 'ORDER_FILLED', '체결로 적으면 안 된다');
  });

  test('조건 불충족은 실패가 아니다', () => {
    // 실패로 읽히면 사용자가 멀쩡한 설정을 헤집는다.
    const v = firstEvaluationVerdict({ ran: true, outcome: 'NO_SIGNAL', summary: '이격 부족' });
    eq(v.outcome, 'WAITING'); eq(v.ordered, false);
    assert(v.detail.includes('정상입니다'), v.detail);
  });

  test('점검이 막은 것과 실패를 가른다', () => {
    eq(firstEvaluationVerdict({ ran: true, outcome: 'BLOCKED' }).outcome, 'BLOCKED_CHECKLIST');
    eq(firstEvaluationVerdict({ ran: true, outcome: 'FAILED' }).outcome, 'ERROR');
  });

  test('못 돌린 것과 조건이 안 맞은 것을 섞지 않는다', () => {
    // 앞은 "아직 모른다"이고 뒤는 "정상인데 지금은 아니다"다.
    const v = firstEvaluationVerdict({ ran: false, outcome: null, note: 'ADMIN_SECRET이 없습니다' });
    eq(v.outcome, 'SAVED_ONLY'); eq(v.ordered, false);
    assert(v.detail.includes('ADMIN_SECRET'), v.detail);
    assert(v.label.includes('아직 평가하지 않았습니다'), v.label);
  });

  test('응답에 첫 평가가 없으면 없다고 적는다', () => {
    const v = firstEvaluationVerdict(null);
    eq(v.outcome, 'SAVED_ONLY');
    eq(v.ordered, false, '주문이 나갔다고 하면 안 된다');
  });

  test('모르는 결과를 성공으로 적지 않는다', () => {
    const v = firstEvaluationVerdict({ ran: true, outcome: 'WAT' });
    eq(v.ordered, false);
    assert(v.detail.includes('정상이라는 뜻이 아닙니다'), v.detail);
  });

  test('기록을 못 남긴 사실을 덧붙인다', () => {
    // 평가는 돌았는데 기록이 없으면 "왜 아무 기록이 없지"의 답이 없다.
    const v = firstEvaluationVerdict({ ran: true, outcome: 'ENTERED', saveError: 'insert 실패' });
    assert(v.detail.includes('실행 기록을 남기지 못했습니다'), v.detail);
  });

  console.log('[주문 결과 판정 — 응답을 못 받은 것을 성공으로 적지 않는다]');

  test('응답이 없으면 오류다', () => {
    const v = classifyRun(null);
    eq(v.outcome, 'ERROR'); eq(v.ordered, false);
  });

  test('다른 실행이 먼저 한 것은 오류가 아니다', () => {
    // 켜는 순간과 실행기가 겹칠 수 있다. 그때 두 번째가 받는 응답이다.
    const v = classifyRun({ status: 409, body: { ok: false, code: 'ALREADY_TRADED' } });
    eq(v.outcome, 'ALREADY_TODAY'); eq(v.tone, 'info'); eq(v.ordered, false);
  });
}
