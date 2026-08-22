// src/lib/engine/entryEvidence.test.ts
//
// **이 판정에 전 전략이 걸려 있는데 테스트가 하나도 없었다.**
//
// `enteredVerdict`는 "장부에 ENTERED로 적어도 되는가"를 정하는 단 하나의
// 함수다. my-original-v1 · 스모크 · (이제) daily-ladder가 전부 이 값을
// 보고 예약 행의 운명을 정한다 — OPEN으로 확정할지, 하루를 돌려줄지,
// 붙잡아 둘지.
//
// 여기가 틀리면 두 방향으로 나쁘다:
//
//   너무 관대하면 → 접수만 된 주문이 장부에 ENTERED로 남는다.
//                   그 위에서 계산한 손익은 처음부터 틀리고,
//                   사용자는 없는 포지션을 들고 있다고 믿는다.
//
//   너무 엄격하면 → 실제로 열린 포지션이 '진입 실패'로 적힌다.
//                   그러면 **아무도 그 포지션을 안 닫는다.**
//
// 그래서 순서가 곧 의미다: 안 들어간 것이 확정됐는가 → 증거를 모은다 →
// 포지션은 있는데 보호가 없는가 → 나머지는 모른다.
import { test, eq, assert } from '../../test/harness';
import { enteredVerdict, outcomeOf } from './entryEvidence';

/** 되읽기로 확인된 보호주문 */
const found = (price: number, closes: 'LONG' | 'SHORT') => ({
  readOk: true, found: true, orderId: 'o1', triggerPrice: price, closes, reason: 'ok',
});
/** 조회는 됐는데 그 주문이 없다 */
const absent = () => ({
  readOk: true, found: false, orderId: null, triggerPrice: null, closes: null, reason: '없음',
});
/** 조회 자체가 실패했다. **없는 것과 다르다** */
const unreadable = () => ({
  readOk: false, found: false, orderId: null, triggerPrice: null, closes: null, reason: '조회 실패',
});

/** 모든 증거가 갖춰진 입력 */
function complete(over: any = {}) {
  return {
    expectedSide: 'LONG' as const,
    settled: true, filledQty: 0.01, avgPrice: 60000,
    rejected: false,
    position: { ok: true, found: true, qty: 0.01, side: 'LONG' as const, error: null },
    leverageConfirmed: true, positionModeConfirmed: true,
    stop: found(59000, 'LONG'),
    takeProfit: found(62000, 'LONG'),
    takeProfitRequired: true,
    ...over,
  };
}

export function runEntryEvidenceTests() {
  console.log('[진입 증거 — 접수를 진입으로 적지 않는다]');

  test('증거가 전부 있으면 ENTERED다', () => {
    const v = enteredVerdict(complete());
    eq(v.code, 'ENTERED');
    eq(v.entered, true);
    eq(v.missing.length, 0, v.missing.join(' · '));
    eq(outcomeOf(v), 'ENTERED');
  });

  // ── 요구 ① exec.ok=true지만 실제 포지션 없음 → OPEN 금지 ──
  test('체결은 확정됐는데 거래소에 포지션이 없으면 OPEN이 아니다', () => {
    // 주문 응답은 우리가 보낸 것에 대한 답이고, 포지션 조회는 계좌의 사실이다.
    const v = enteredVerdict(complete({
      position: { ok: true, found: false, qty: null, side: null, error: null },
    }));
    eq(v.entered, false, '거래소에 없는 포지션을 장부에 열었다');
    assert(v.code !== 'ENTERED', v.code);
    assert(v.missing.some(m => m.includes('포지션이 보이지 않음')), v.missing.join(' · '));
  });

  test('포지션 재조회에 실패한 것도 OPEN이 아니다', () => {
    // **조회 실패는 "없다"도 "있다"도 아니다.**
    const v = enteredVerdict(complete({
      position: { ok: false, found: false, qty: null, side: null, error: 'timeout' },
    }));
    eq(v.entered, false);
    eq(v.code, 'UNKNOWN', '조회 실패를 확정으로 읽었다');
  });

  test('재조회 방향이 다르면 OPEN이 아니다', () => {
    // 반대 방향 포지션은 남의 것이거나 옛 포지션이다.
    const v = enteredVerdict(complete({
      position: { ok: true, found: true, qty: 0.01, side: 'SHORT', error: null },
    }));
    eq(v.entered, false);
    assert(v.missing.some(m => m.includes('방향 불일치')), v.missing.join(' · '));
  });

  // ── 요구 ② Gate ACKED지만 settled=false → OPEN 금지 ──
  test('접수(ACKED)만 되고 체결이 확정 안 됐으면 OPEN이 아니다', () => {
    // Gate는 체결이 확정되지 않아도 접수를 돌려준다. `exec.ok === true`가
    // 여기서 참이므로, 예전 구조라면 그대로 OPEN이 됐다.
    const v = enteredVerdict(complete({ settled: false }));
    eq(v.entered, false, '접수를 진입으로 적었다');
    assert(v.missing.some(m => m.includes('체결 확정')), v.missing.join(' · '));
  });

  test('체결 수량이 0이면 OPEN이 아니다', () => {
    const v = enteredVerdict(complete({ filledQty: 0 }));
    eq(v.entered, false);
  });

  test('평균 체결가를 모르면 OPEN이 아니다', () => {
    // 진입가를 모르면 1R도 손익도 정할 수 없다.
    const v = enteredVerdict(complete({ avgPrice: null }));
    eq(v.entered, false);
    assert(v.missing.some(m => m.includes('평균 체결가')), v.missing.join(' · '));
  });

  test('배율·포지션 모드를 확인 못 했으면 OPEN이 아니다', () => {
    eq(enteredVerdict(complete({ leverageConfirmed: null })).entered, false);
    eq(enteredVerdict(complete({ positionModeConfirmed: null })).entered, false);
    // false와 null 둘 다 '확인됨'이 아니다.
    eq(enteredVerdict(complete({ leverageConfirmed: false })).entered, false);
  });

  // ── 요구 ⑥ unprotected position → 정상 OPEN으로 위장 금지 ──
  test('포지션은 있는데 손절이 없으면 ENTERED_UNPROTECTED다', () => {
    const v = enteredVerdict(complete({ stop: absent() }));
    eq(v.code, 'ENTERED_UNPROTECTED');
    eq(v.entered, false, '보호 없는 포지션을 정상 진입으로 적었다');
    eq(outcomeOf(v), 'UNPROTECTED');
  });

  test('보호 없는 포지션을 "안 들어갔다"로 적지 않는다', () => {
    // 이게 뒤집히면 **아무도 그 포지션을 안 닫는다.**
    const v = enteredVerdict(complete({ stop: absent() }));
    assert(v.code !== 'NOT_ENTERED', '열린 포지션을 진입 실패로 적었다');
    assert(v.code !== 'UNKNOWN', '포지션이 확인됐는데 모른다고 적었다');
    assert(v.reason.includes('재진입하지'), v.reason);
  });

  test('손절 조회 실패와 손절 없음을 구분해서 적는다', () => {
    const gone = enteredVerdict(complete({ stop: absent() }));
    const blind = enteredVerdict(complete({ stop: unreadable() }));
    assert(gone.missing.some(m => m.includes('거래소에 손절이 없음')), gone.missing.join(' · '));
    assert(blind.missing.some(m => m.includes('되읽기 실패')), blind.missing.join(' · '));
  });

  test('익절이 필수인 전략은 익절도 증거다', () => {
    const v = enteredVerdict(complete({ takeProfit: absent(), takeProfitRequired: true }));
    eq(v.code, 'ENTERED_UNPROTECTED');
  });

  test('익절이 필수가 아니면 없어도 ENTERED다', () => {
    // 분할 사다리가 없는 전략까지 막으면, 멀쩡한 진입이 전부 미확정이 된다.
    const v = enteredVerdict(complete({ takeProfit: absent(), takeProfitRequired: false }));
    eq(v.code, 'ENTERED');
  });

  console.log('[진입 증거 — 안 들어간 것과 모르는 것을 가른다]');

  test('거절 + 재조회에서 포지션 없음이면 NOT_ENTERED다', () => {
    // **둘 다 있어야 한다.** 거절 응답만으로 없다고 적으면, 실제로는
    // 체결됐는데 응답만 놓친 경우에 보호 없는 포지션이 방치된다.
    const v = enteredVerdict(complete({
      rejected: true,
      position: { ok: true, found: false, qty: null, side: null, error: null },
    }));
    eq(v.code, 'NOT_ENTERED');
    eq(v.retryable, true, '안 들어간 것이 확인됐는데 재시도를 막았다');
    eq(outcomeOf(v), 'FAILED');
  });

  test('거절만으로는 NOT_ENTERED가 아니다', () => {
    // 재조회를 못 했으면 체결됐는지 모른다.
    const v = enteredVerdict(complete({
      rejected: true,
      position: { ok: false, found: false, qty: null, side: null, error: 'timeout' },
    }));
    assert(v.code !== 'NOT_ENTERED', '재조회 없이 안 들어갔다고 단정했다');
    eq(v.code, 'UNKNOWN');
  });

  test('체결 확정 + 수량 0 + 포지션 없음이면 NOT_ENTERED다', () => {
    const v = enteredVerdict(complete({
      settled: true, filledQty: 0,
      position: { ok: true, found: false, qty: null, side: null, error: null },
    }));
    eq(v.code, 'NOT_ENTERED');
  });

  // ── 요구 ③④의 앞단: UNKNOWN은 재시도를 열지 않는다 ──
  test('모르는 것은 재시도를 열지 않는다', () => {
    // 여기서 retry를 허용하면 앞 주문이 붙는 사이에 한 번 더 나가고,
    // 그게 2배 포지션이다.
    const v = enteredVerdict(complete({
      settled: false,
      position: { ok: false, found: false, qty: null, side: null, error: 'timeout' },
    }));
    eq(v.code, 'UNKNOWN');
    eq(v.retryable, false, '모르는데 재시도를 열었다 — 중복 진입이 된다');
    eq(outcomeOf(v), 'RECONCILE_REQUIRED');
  });

  test('재시도를 여는 판정은 정확히 하나뿐이다', () => {
    const cases = [
      // ENTERED
      complete(),
      // ENTERED_UNPROTECTED
      complete({ stop: absent() }),
      // UNKNOWN
      complete({ settled: false, position: { ok: false, found: false, qty: null, side: null, error: 'x' } }),
      // NOT_ENTERED
      complete({ rejected: true, position: { ok: true, found: false, qty: null, side: null, error: null } }),
    ];
    const retryable = cases.map(c => enteredVerdict(c)).filter(v => v.retryable);
    eq(retryable.length, 1, `재시도를 여는 판정이 ${retryable.length}개다`);
    eq(retryable[0].code, 'NOT_ENTERED');
  });

  test('빠진 증거를 사람이 읽을 수 있게 적는다', () => {
    // "확정하지 못했습니다"만 적으면 무엇을 볼지 알 수 없다.
    const v = enteredVerdict(complete({ settled: false, avgPrice: null }));
    assert(v.missing.length >= 2, v.missing.join(' · '));
    assert(v.reason.includes('빠진 증거'), v.reason);
  });

  test('입력이 통째로 비어도 진입으로 적지 않는다', () => {
    const v = enteredVerdict({ expectedSide: 'LONG', position: null, stop: null } as any);
    eq(v.entered, false);
    eq(v.code, 'UNKNOWN');
  });
}
