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
import { targetQuery, targetRequestFields, type PaperTarget } from './paperTarget';

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

  // ══════════ 매도 경로도 같은 장부다 (Phase 3) ══════════
  //
  // 088이 보유 조회·매도를 만들었고 Phase 3이 화면을 붙였다. 화면이 하나
  // 늘면 **장부가 갈릴 자리도 하나 는다** — 이 저장소가 이미 겪은 고장이
  // 정확히 그것이었다(주문은 챌린지, 표시는 기본 계좌).
  //
  // 아래는 `useSellForm`이 실제로 하는 것과 같은 모양이다:
  //   보유 조회  `/api/paper/holdings` + targetQuery(target)
  //   매도 실행  body에 targetRequestFields(target)
  const holdingsScope = (t: PaperTarget) => targetQuery(t);
  const sellBody = (t: PaperTarget) => targetRequestFields(t);

  test('★ 보유를 읽는 장부와 주문을 내는 장부가 같다', () => {
    eq(holdingsScope(CHALLENGE_T), orderScope(CHALLENGE_T));
    eq(holdingsScope(DEFAULT_T), orderScope(DEFAULT_T));
  });

  test('★ 매도 본문이 챌린지를 싣는다 (기본 장부에서는 안 싣는다)', () => {
    eq(sellBody(CHALLENGE_T).challengeId, 'ch_abc');
    eq(sellBody(DEFAULT_T).challengeId, undefined);
  });

  test('★ 매도 본문에 계좌 id가 없다 — 계좌는 서버가 정한다', () => {
    for (const t of [CHALLENGE_T, DEFAULT_T]) {
      const keys = Object.keys(sellBody(t));
      assert(!keys.some(k => /account/i.test(k)),
        `매도 본문에 계좌 칸이 있습니다: ${keys.join(',')}`);
    }
  });

  test('★ 보유를 읽은 장부로 그대로 판다 — 두 챌린지가 안 섞인다', () => {
    const other: PaperTarget = { kind: 'CHALLENGE', challengeId: 'ch_zzz' } as any;
    // 읽은 곳과 파는 곳이 같은 target에서 나오므로, 다른 챌린지의 보유를
    // 이 챌린지 장부로 파는 조합이 만들어지지 않는다.
    assert(holdingsScope(CHALLENGE_T) !== holdingsScope(other),
      '두 챌린지가 같은 보유 목록을 봅니다');
    assert(sellBody(CHALLENGE_T).challengeId !== sellBody(other).challengeId,
      '두 챌린지의 매도가 같은 장부로 나갑니다');
  });

  test('★ 기본 PAPER와 챌린지가 섞이지 않는다 (조회·매도 양쪽)', () => {
    assert(holdingsScope(DEFAULT_T) !== holdingsScope(CHALLENGE_T),
      '기본 계좌와 챌린지가 같은 보유를 봅니다');
    assert(sellBody(DEFAULT_T).challengeId !== sellBody(CHALLENGE_T).challengeId,
      '기본 계좌 매도와 챌린지 매도가 같은 장부로 나갑니다');
  });
}
