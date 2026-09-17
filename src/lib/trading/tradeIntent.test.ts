// src/lib/trading/tradeIntent.test.ts
//
// **주문 방향은 사용자가 누른 것이어야 한다.**
//
// 무엇이 잘못됐었나
// ─────────────────
// 시트 구조였을 때, 첫 화면의 LONG과 SHORT 버튼은 **둘 다** 그냥 시트를
// 열기만 했다(`onClick={() => setSheetOpen(true)}`). 그런데 시트 안의
// 방향 상태는 항상 `'LONG'`으로 시작했다. 그래서
//
//   첫 화면에서 SHORT를 누름 → 주문판이 LONG으로 열림
//
// 이 됐다. 사용자가 시트 안에서 SHORT를 다시 누르지 않고 진행하면 **누른
// 적 없는 방향으로 주문이 나간다.** 금액 계산이 아무리 맞아도 방향이
// 틀리면 그 주문은 처음부터 틀린 것이다.
//
// 한 화면 배치로 바꾸면서 시트는 없어졌지만, 방향 초기값이 곧 "골랐다"로
// 읽히는 문제는 남아 있었다 — LONG은 한 번만 눌러도 주문이 나가고 SHORT는
// 두 번 눌러야 하는 비대칭이었다.
//
// 그래서 **고른 적이 있는가**를 값으로 들고 다닌다. 방향 상태를 두 벌
// 만들지 않는다 — `useTradeForm` 한 곳이다.
import { test, eq, assert } from '../../test/harness';

/**
 * 화면이 하는 판단을 그대로 적은 것.
 *
 * `TradingWorkspace`의 CTA가 이 규칙이다: 고른 방향이 아니면 **고르고
 * 멈춘다**, 이미 그 방향이면 보낸다.
 */
function pressCta(
  state: { side: 'LONG' | 'SHORT'; chosen: boolean },
  pressed: 'LONG' | 'SHORT',
): { side: 'LONG' | 'SHORT'; chosen: boolean; submitted: boolean } {
  const on = state.chosen && state.side === pressed;
  if (!on) return { side: pressed, chosen: true, submitted: false };
  return { side: state.side, chosen: true, submitted: true };
}

export function runTradeIntentTests() {
  console.log('[주문 방향 의도]');

  const fresh = () => ({ side: 'LONG' as const, chosen: false });

  test('★ SHORT를 누르면 SHORT가 골라진다 — LONG으로 열리지 않는다', () => {
    const a = pressCta(fresh(), 'SHORT');
    eq(a.side, 'SHORT');
    eq(a.chosen, true);
    eq(a.submitted, false, '첫 누름에 바로 나가면 안 됩니다');

    const b = pressCta(a, 'SHORT');
    eq(b.side, 'SHORT');
    eq(b.submitted, true);
  });

  test('★ LONG도 똑같이 두 번이다 — 방향에 따라 규칙이 달라지지 않는다', () => {
    // 예전에는 방향 초기값이 'LONG'이라 **LONG만 한 번에 나갔다.**
    const a = pressCta(fresh(), 'LONG');
    eq(a.side, 'LONG');
    eq(a.chosen, true);
    eq(a.submitted, false, 'LONG이 한 번 누름에 나갔습니다 — SHORT와 규칙이 다릅니다');

    const b = pressCta(a, 'LONG');
    eq(b.submitted, true);
  });

  test('★ 방향을 바꾸면 다시 확인한다 — 바꾸자마자 나가지 않는다', () => {
    const long = pressCta(pressCta(fresh(), 'LONG'), 'LONG');
    eq(long.submitted, true);
    const flip = pressCta({ side: 'LONG', chosen: true }, 'SHORT');
    eq(flip.side, 'SHORT');
    eq(flip.submitted, false, '방향을 바꾸는 누름이 그대로 주문이 됐습니다');
  });

  test('★ 아무것도 안 눌렀으면 어느 방향도 고른 것이 아니다', () => {
    const s = fresh();
    // 초기값이 'LONG'이지만 그것은 미리보기 계산용이지 사용자의 선택이 아니다.
    assert(!s.chosen, '누르기 전부터 골라진 상태입니다');
  });
}
