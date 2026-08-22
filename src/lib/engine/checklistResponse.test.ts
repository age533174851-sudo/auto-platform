// src/lib/engine/checklistResponse.test.ts
//
// **서버는 왜 막았는지 다 보내는데 화면이 토스트 한 줄로 줄였다.**
//
// 여덟 항목의 통과·차단·확인불가가 전부 응답에 있었는데,
// `d.message`만 뽑아 "주문 실패 · …"로 보여줬다. 사용자는 시계가
// 어긋났는지, 배율이 다른지, 미결 주문이 남았는지 알 수 없었다.
import { test, eq, assert } from '../../test/harness';
import { checklistFromResponse, isChecklistBlocked } from './checklistResponse';

const blocked = {
  ok: false,
  error: 'checklist_blocked',
  message: '8개 중 6개 통과 · 2개가 막고 있습니다',
  checklist: {
    allowed: false, market: 'FUTURES', intent: 'ENTRY',
    passed: 6, total: 8, unknownCount: 1,
    results: [
      { id: 'clock', status: 'pass', label: '시계' },
      { id: 'leverage', status: 'block', label: '배율' },
      { id: 'reconcile', status: 'unknown', label: '상태 대조' },
    ],
    blockers: [{ id: 'leverage', status: 'block', label: '배율' }],
  },
};

export function runChecklistResponseTests() {
  console.log('[주문 거부 — 왜 막혔는지를 버리지 않는다]');

  test('응답에서 점검 결과를 그대로 꺼낸다', () => {
    const v = checklistFromResponse(blocked)!;
    eq(v.allowed, false);
    eq(v.passed, 6); eq(v.total, 8);
    eq(v.results.length, 3);
    eq(v.blockers.length, 1);
  });

  test('확인하지 못한 항목 수를 지우지 않는다', () => {
    // 0으로 떨어뜨리면 "전부 확인했는데 막혔다"로 읽힌다.
    eq(checklistFromResponse(blocked)!.unknownCount, 1);
  });

  test('요약은 응답 최상위의 message를 쓴다', () => {
    // 서버는 요약을 checklist 안이 아니라 message에 담아 보낸다.
    assert(checklistFromResponse(blocked)!.summary.includes('2개가 막고'), 'summary');
  });

  test('점검이 없으면 null이다 — 빈 verdict를 만들지 않는다', () => {
    // 빈 것을 만들어 주면 화면이 "0개 통과"를 그리고, 그건 점검을
    // 안 한 것과 통과한 것을 섞는다.
    eq(checklistFromResponse({ ok: false, error: 'insufficient_margin' }), null);
    eq(checklistFromResponse(null), null);
    eq(checklistFromResponse({ checklist: { results: 'nope' } }), null);
  });

  test('숫자를 못 읽어도 그럴듯한 값을 지어내지 않는다', () => {
    const v = checklistFromResponse({
      message: 'x', checklist: { results: [{ id: 'a' }, { id: 'b' }] },
    })!;
    eq(v.passed, 0);
    eq(v.total, 2, 'total은 결과 수에서 온다');
    eq(v.unknownCount, 0);
  });

  test('막힌 응답인지 알아본다', () => {
    eq(isChecklistBlocked(blocked), true);
    eq(isChecklistBlocked({ ok: false, error: 'rate_limited' }), false);
    eq(isChecklistBlocked({ ok: true, jobId: 'j1' }), false);
  });
}
