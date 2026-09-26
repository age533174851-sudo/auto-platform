// src/lib/engine/lifecycleAction.ts
//
// **판단이 CLOSE로 나온 뒤 실제로 무엇을 하는가 — 그 순서를 시험할 수 있게 뗀다.**
//
// 왜 라우트에서 뗐는가
// ────────────────────
// 이 단계는 거래소를 **바꾼다.** 그런데 라우트 안의 for 루프에 인라인으로
// 있어서, 가장 중요한 것들이 시험되지 않는 자리에 남아 있었다:
//
//   · 청산 주문을 몇 번 보내는가
//   · 권한(임차) 확인이 전송보다 **앞**인가
//   · 보낸 뒤 포지션을 다시 읽는가
//   · 재조회 실패를 "닫혔다"로 읽지 않는가
//
// 정규식 검사기는 "그 줄이 있는가"만 본다. **순서와 횟수는 돌려 봐야**
// 안다. `engine/entry100x`를 같은 이유로 같은 방식으로 뗐다.
//
// ★ 불변식
// ─────────
//   ORDER SUBMITTED  != CLOSED
//   ORDER ACCEPTED   != CLOSED
//   CLOSED            = 재조회로 잔여 0을 **확인**한 경우만
//
// 그래서 세 가지를 섞지 않는다:
//
//   attempted    거래소에 요청을 보냈는가 (응답을 못 받아도 보낸 것이다)
//   accepted     거래소가 그 요청을 받았는가
//   flatVerified 재조회로 포지션 0을 **확인**했는가 — 못 읽으면 null
//
// 부분 종료 주문도 체결로 잡힌다. 그래서 접수(`accepted`)만으로 종료를
// 적지 않는다 — 잔여를 다시 읽어 0인 것을 본 뒤에만 `ok`다.

export type LifecycleActionCode =
  /** 청산을 보내고 포지션 0을 확인했다 */
  | 'CLOSED_VERIFIED'
  /** 보냈고 접수됐지만 아직 남아 있다 (부분 종료일 수 있다) */
  | 'CLOSE_INCOMPLETE'
  /** 보냈지만 종료 후 재조회를 못 했다. **0이라는 뜻이 아니다** */
  | 'CLOSE_UNVERIFIED'
  /** 거래소가 거부했거나 보내지 못했다 */
  | 'CLOSE_REJECTED'
  /** 보내기 전에 실행 권한(임차)이 넘어갔다 */
  | 'LEASE_LOST';

export interface LifecycleActionDeps {
  /** 전량 청산을 보낸다. `attempted`는 "보냈는가"다 */
  close: () => Promise<{ attempted: boolean; ok: boolean; error: string | null }>;
  /** 보낸 뒤 잔여를 다시 읽는다. `ok:false`는 "못 읽었다"다 */
  readAfter: () => Promise<{ ok: boolean; found: boolean }>;
  /**
   * 거래소를 바꿔도 되는가. **전송보다 먼저 불린다.**
   *
   * 안 주면 확인하지 않는다 — 임차 표가 없는 배포에서 청산이 통째로
   * 멈추는 것이 이 확인이 막으려는 것보다 나쁘다.
   */
  stillMine?: () => Promise<boolean>;
}

export interface LifecycleActionResult {
  code: LifecycleActionCode;
  /** 셋이 다 참일 때만 true */
  ok: boolean;
  /** 거래소에 요청을 보냈는가 */
  attempted: boolean;
  /** 거래소가 받았는가 */
  accepted: boolean;
  /** 포지션 0을 확인했는가. **못 읽었으면 null** */
  flatVerified: boolean | null;
  reason: string;
}

/**
 * 청산을 실행하고 결과를 분류한다.
 *
 * 순서가 계약이다: **권한 → 전송 → 재조회.** 권한이 없으면 전송하지 않고,
 * 전송했으면 반드시 다시 읽는다.
 */
export async function applyLifecycleClose(
  deps: LifecycleActionDeps,
): Promise<LifecycleActionResult> {
  // ── ① 권한 ──
  //
  // 여기까지 오는 데 거래소 조회로 수십 초가 걸릴 수 있다. 그 사이 임차가
  // 넘어갔다면 남이 같은 판단을 하고 있고, 내가 마저 내면 **같은 포지션에
  // 청산이 두 번** 나간다.
  if (deps.stillMine) {
    let mine = false;
    try { mine = await deps.stillMine(); } catch { mine = false; }
    if (!mine) {
      return { code: 'LEASE_LOST', ok: false, attempted: false, accepted: false,
        flatVerified: null,
        reason: '실행 권한(임차)이 넘어가 청산을 보내지 않았습니다' };
    }
  }

  // ── ② 전송 ──
  let r: { attempted: boolean; ok: boolean; error: string | null };
  try { r = await deps.close(); }
  catch (e: any) {
    // **예외를 '안 보냈다'로 적지 않는다.** 보내고 응답을 못 받았을 수도
    // 있다 — 그 구분은 아래 재조회가 한다.
    r = { attempted: true, ok: false, error: String(e?.message || e) };
  }

  if (!r.ok) {
    // 접수되지 않았다. 그래도 보냈을 수는 있으므로 `attempted`를 보존한다.
    return { code: 'CLOSE_REJECTED', ok: false,
      attempted: r.attempted !== false, accepted: false, flatVerified: null,
      reason: r.error || '청산 주문이 접수되지 않았습니다' };
  }

  // ── ③ 재조회 ──
  //
  // **접수는 체결이 아니다.** 부분 종료도 체결로 잡히므로 잔여를 본다.
  let after: { ok: boolean; found: boolean };
  try { after = await deps.readAfter(); }
  catch { after = { ok: false, found: false }; }

  if (after.ok !== true) {
    return { code: 'CLOSE_UNVERIFIED', ok: false, attempted: true, accepted: true,
      flatVerified: null,
      reason: '청산은 접수됐지만 종료 후 재조회에 실패했습니다 — 포지션이 0이라는 뜻이 아닙니다' };
  }
  if (after.found === true) {
    return { code: 'CLOSE_INCOMPLETE', ok: false, attempted: true, accepted: true,
      flatVerified: false,
      reason: '청산이 접수됐지만 포지션이 아직 남아 있습니다 (부분 종료일 수 있습니다)' };
  }
  return { code: 'CLOSED_VERIFIED', ok: true, attempted: true, accepted: true,
    flatVerified: true, reason: '청산 후 포지션 0을 확인했습니다' };
}
