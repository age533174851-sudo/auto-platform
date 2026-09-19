// src/lib/trading/submitGate.test.ts
//
// 실기에서 나온 결함을 고정한다: 로그인·잔고·수량이 다 있는데 버튼만
// 회색이었고 **왜인지 화면 어디에도 없었다.**
import { test, eq, assert } from '../../test/harness';
import { submitGate, submitLabel } from './submitGate';

export function runSubmitGateTests() {
  const ok = { canOrder: true, quantity: 4.3, planOk: true };

  test('세 조건이 다 맞으면 열린다', () => {
    const g = submitGate(ok);
    eq(g.ready, true);
    eq(g.block, 'NONE');
    eq(g.reason, null);
  });

  // ── ★ 막혔으면 이유가 있다 ──
  test('★ 잠긴 상태에는 **언제나** 사유가 있다 — 이유 없는 잠금은 없다', () => {
    const cases = [
      { canOrder: false, quantity: 4.3, planOk: true },
      { canOrder: true, quantity: null, planOk: true },
      { canOrder: true, quantity: 0, planOk: true },
      { canOrder: true, quantity: 4.3, planOk: false },
      { canOrder: true, quantity: NaN, planOk: true },
    ];
    for (const c of cases) {
      const g = submitGate(c as any);
      eq(g.ready, false, `${JSON.stringify(c)}가 열렸습니다`);
      assert(!!g.reason && g.reason.length > 0, `${JSON.stringify(c)}에 사유가 없습니다`);
    }
  });

  test('★ 실기 사례: 잔고·수량이 있는데 손절이 없어 막힌다 — 그 사유가 나온다', () => {
    const g = submitGate({
      canOrder: true, quantity: 4.30516, planOk: false,
      planReason: '손절가가 없습니다. 모의에서도 손절 없는 진입은 받지 않습니다',
    });
    eq(g.ready, false);
    eq(g.block, 'PLAN_REJECTED');
    assert(/손절가가 없습니다/.test(g.reason || ''), '계획 거절 사유가 전달되지 않았습니다');
  });

  // ── ★ 순서 ──
  test('★ 먼저 걸리는 것이 먼저 해결할 것이다 — 권한 → 수량 → 계획', () => {
    // 셋 다 막혀 있으면 권한을 말한다. 손절을 넣어도 안 열리기 때문이다.
    const g = submitGate({
      canOrder: false, blockedReason: '로그인이 필요합니다',
      quantity: null, planOk: false, planReason: '손절가가 없습니다',
    });
    eq(g.block, 'NOT_ALLOWED');
    assert(/로그인/.test(g.reason || ''), '권한 사유가 아닙니다');
  });

  test('권한은 있고 수량만 없으면 수량을 말한다', () => {
    const g = submitGate({ canOrder: true, quantity: 0, planOk: false, planReason: '손절가가 없습니다' });
    eq(g.block, 'NO_QUANTITY');
  });

  test('사유를 안 넘겨도 기본 문구가 나온다 — 빈 잠금을 만들지 않는다', () => {
    for (const c of [{ canOrder: false, quantity: 1, planOk: true },
                     { canOrder: true, quantity: null, planOk: true },
                     { canOrder: true, quantity: 1, planOk: false }]) {
      const g = submitGate(c as any);
      assert((g.reason || '').length > 4, `${g.block}에 기본 사유가 없습니다`);
    }
  });

  // ── ★ 버튼 글자 ──
  test('★ 버튼 자체가 무엇이 필요한지 말한다', () => {
    eq(submitLabel(submitGate(ok), 'LONG', 'BTCUSDT'), 'LONG BTCUSDT');
    eq(submitLabel(submitGate({ canOrder: true, quantity: 0, planOk: true }), 'LONG', 'BTCUSDT'),
      '비중을 정하세요');
    eq(submitLabel(submitGate({ canOrder: true, quantity: 1, planOk: false }), 'LONG', 'BTCUSDT'),
      '주문 조건을 확인하세요');
    eq(submitLabel(submitGate({ canOrder: false, quantity: 1, planOk: true }), 'LONG', 'BTCUSDT'),
      '주문할 수 없습니다');
  });

  test('열렸을 때만 방향·종목이 버튼에 적힌다', () => {
    const blocked = submitLabel(submitGate({ canOrder: true, quantity: 0, planOk: true }), 'SHORT', 'ETHUSDT');
    assert(!/ETHUSDT/.test(blocked), '막힌 버튼이 주문할 것처럼 적혀 있습니다');
  });
}
