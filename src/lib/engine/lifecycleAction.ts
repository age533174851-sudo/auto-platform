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
  /**
   * **거래소가 명시적으로 거부했다.**
   *
   * 타임아웃·연결 끊김처럼 접수 여부를 모르는 경우는 여기 넣지 않는다 —
   * 그건 `CLOSE_AMBIGUOUS`다.
   */
  | 'CLOSE_REJECTED'
  /**
   * **보냈는지 접수됐는지 모른다** (타임아웃·연결 끊김).
   *
   * 거부로 단정하면 "안 나갔다"로 읽혀 같은 자리에 또 보내게 된다.
   * 실제로는 나갔을 수 있다. 재조회로 결과만 확인하고, 확정되지 않으면
   * 대조(reconcile) 대상으로 남긴다.
   */
  | 'CLOSE_AMBIGUOUS'
  /** 보내기 전에 실행 권한(임차)이 넘어갔다 */
  | 'LEASE_LOST';

export interface LifecycleActionDeps {
  /**
   * 전량 청산을 보낸다. `attempted`는 "보냈는가"다.
   *
   * `ambiguous: true`는 **접수 여부를 모른다**는 뜻이다(타임아웃·연결
   * 끊김). 거래소가 명시적으로 거부한 것과 구분해야 한다 — 거부로 적으면
   * "안 나갔다"로 읽혀 같은 자리에 또 보낸다.
   */
  close: () => Promise<{
    attempted: boolean; ok: boolean; error: string | null; ambiguous?: boolean;
  }>;
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
  /** 거래소가 받았는가. **모르면 null** (타임아웃·연결 끊김) */
  accepted: boolean | null;
  /** 포지션 0을 확인했는가. **못 읽었으면 null** */
  flatVerified: boolean | null;
  /** 사람이 거래소와 대조해야 하는가 */
  needsReconcile: boolean;
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
        flatVerified: null, needsReconcile: false,
        reason: '실행 권한(임차)이 넘어가 청산을 보내지 않았습니다' };
    }
  }

  // ── ② 전송 ──
  let r: { attempted: boolean; ok: boolean; error: string | null; ambiguous?: boolean };
  try { r = await deps.close(); }
  catch (e: any) {
    // **예외를 '안 보냈다'로도 '거부됐다'로도 적지 않는다.** 보내고
    // 응답을 못 받았을 수도 있다 — 그 구분은 아래 재조회가 한다.
    r = { attempted: true, ok: false, error: String(e?.message || e), ambiguous: true };
  }

  const ambiguous = r.ambiguous === true;

  if (!r.ok && !ambiguous) {
    // 거래소가 **명시적으로** 거부했다. 그래도 보냈을 수는 있으므로
    // `attempted`를 보존한다.
    return { code: 'CLOSE_REJECTED', ok: false,
      attempted: r.attempted !== false, accepted: false, flatVerified: null,
      needsReconcile: false,
      reason: r.error || '청산 주문이 접수되지 않았습니다' };
  }

  // ── ③ 재조회 ──
  //
  // **접수는 체결이 아니다.** 부분 종료도 체결로 잡히므로 잔여를 본다.
  // 접수 여부를 모르는 경우(ambiguous)에도 반드시 읽는다 — 결과는
  // 거래소에만 있다.
  let after: { ok: boolean; found: boolean };
  try { after = await deps.readAfter(); }
  catch { after = { ok: false, found: false }; }

  if (after.ok !== true) {
    return { code: 'CLOSE_UNVERIFIED', ok: false, attempted: true,
      accepted: ambiguous ? null : true, flatVerified: null,
      needsReconcile: true,
      reason: ambiguous
        ? '청산 전송 결과를 모르는 채 재조회도 실패했습니다 — 거래소와 대조가 필요합니다'
        : '청산은 접수됐지만 종료 후 재조회에 실패했습니다 — 포지션이 0이라는 뜻이 아닙니다' };
  }

  if (after.found === true) {
    if (ambiguous) {
      // 보냈는지도 모르고 포지션도 남아 있다. **거부로 단정하지 않는다** —
      // 주문이 살아 있을 수 있고, 그 상태에서 또 보내면 두 번 나간다.
      return { code: 'CLOSE_AMBIGUOUS', ok: false, attempted: true,
        accepted: null, flatVerified: false, needsReconcile: true,
        reason: (r.error ? `${r.error} — ` : '')
          + '전송 결과를 모르고 포지션이 남아 있습니다 — 거래소와 대조가 필요합니다' };
    }
    return { code: 'CLOSE_INCOMPLETE', ok: false, attempted: true, accepted: true,
      flatVerified: false, needsReconcile: true,
      reason: '청산이 접수됐지만 포지션이 아직 남아 있습니다 (부분 종료일 수 있습니다)' };
  }

  // 잔여 0을 **확인**했다. 전송 결과를 몰랐더라도 결과는 확인됐다.
  return { code: 'CLOSED_VERIFIED', ok: true, attempted: true,
    accepted: ambiguous ? null : true, flatVerified: true, needsReconcile: false,
    reason: ambiguous
      ? '전송 결과는 몰랐지만 재조회로 포지션 0을 확인했습니다'
      : '청산 후 포지션 0을 확인했습니다' };
}
