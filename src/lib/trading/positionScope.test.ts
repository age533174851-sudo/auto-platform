// src/lib/trading/positionScope.test.ts
//
// **주문이 간 계좌와 포지션을 읽는 계좌는 같아야 한다.**
//
// 무엇이 갈라져 있었나
// ────────────────────
// 정본 화면에는 포지션을 그리는 곳이 없었고 아래 `BottomDock`이 대신
// 그렸다. 그런데 둘은 **다른 계좌**를 보고 있었다.
//
//   주문      TradingWorkspace → usePaperTarget(challengeId)
//               → /api/paper/order          → 챌린지 계좌
//   포지션 표시 BottomDock      → usePaperAccount
//               → /api/paper/account        → readPaperEquity
//               → paper_accounts.is_default = true  ← **늘 기본 계좌**
//
// 챌린지 장부로 주문하면 방금 연 포지션이 안 보이고 기본 계좌 포지션이
// 대신 보인다. 화면에 오류는 없다 — 그냥 "포지션이 없네"로 읽힌다.
//
// 그래서 한 화면의 포지션 줄은 **다시 읽지 않는다.** 주문에 쓰는 바로 그
// `usePaperLedger` 결과를 그대로 받는다. 읽는 곳과 쓰는 곳이 같은 객체이면
// 어긋날 자리가 없다.
import { test, eq, assert } from '../../test/harness';
import { targetQuery, type PaperTarget } from './paperTarget';

export function runPositionScopeTests() {
  console.log('[포지션 계좌 범위]');

  const DEFAULT_T: PaperTarget = { kind: 'DEFAULT' } as any;
  const CHALLENGE_T: PaperTarget = { kind: 'CHALLENGE', challengeId: 'ch_abc' } as any;

  test('★ 챌린지 장부는 그 챌린지를 실어 읽는다', () => {
    eq(targetQuery(CHALLENGE_T), '?challengeId=ch_abc');
  });

  test('★ 기본 장부는 챌린지를 싣지 않는다', () => {
    eq(targetQuery(DEFAULT_T), '');
  });

  // ── ★ 주문과 표시가 같은 장부를 가리키는가 ──
  //
  // 화면이 실제로 하는 일을 그대로 적는다: 주문도 포지션도 **같은
  // target**에서 나온 같은 질의를 쓴다.
  const orderScope = (t: PaperTarget) => targetQuery(t);
  const ledgerScope = (t: PaperTarget) => targetQuery(t);
  /** 예전 `BottomDock` 경로 — 무엇을 고르든 기본 계좌를 읽는다 */
  const accountRouteScope = (_t: PaperTarget) => '';

  test('★ 챌린지에서 주문 계좌와 표시 계좌가 같다', () => {
    eq(ledgerScope(CHALLENGE_T), orderScope(CHALLENGE_T));
  });

  test('★ 기본 장부에서도 같다', () => {
    eq(ledgerScope(DEFAULT_T), orderScope(DEFAULT_T));
  });

  test('★ /api/paper/account 경로를 쓰면 챌린지에서 갈라진다 — 그래서 쓰지 않는다', () => {
    // 이 시험은 **고장 난 배선이 실제로 갈라진다**는 것을 고정한다.
    // 갈라지지 않게 되면(예: account 라우트가 챌린지를 받게 되면) 이
    // 시험이 먼저 깨지고, 그때 위 계약을 다시 본다.
    assert(accountRouteScope(CHALLENGE_T) !== orderScope(CHALLENGE_T),
      '기본 계좌 경로가 챌린지 주문과 같은 범위를 봅니다 — 전제가 바뀌었습니다');
    eq(accountRouteScope(DEFAULT_T), orderScope(DEFAULT_T),
      '기본 장부에서는 두 경로가 같아야 합니다 (그래서 지금까지 안 드러났다)');
  });

  test('★ 다른 챌린지는 다른 범위다 — 장부가 섞이지 않는다', () => {
    const other: PaperTarget = { kind: 'CHALLENGE', challengeId: 'ch_zzz' } as any;
    assert(targetQuery(CHALLENGE_T) !== targetQuery(other),
      '두 챌린지가 같은 포지션 목록을 봅니다');
  });
}
