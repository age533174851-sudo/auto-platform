// src/lib/engine/exitAuthorityRun.ts
//
// **종료 권한을 실제로 실행하는 순서 — 돌려서 증명할 수 있게 뗀다.**
//
// 왜 라우트에서 뗐는가
// ────────────────────
// `exitAuthority.ts`가 단계를 타입으로 적어 두었다고 **런타임 순서가
// 보장되지는 않는다.** 선언은 선언이고, 실제로 무엇을 몇 번 어느 순서로
// 부르는지는 돌려 봐야 안다. 라우트 안의 for 루프에 인라인으로 두면 그
// 가장 중요한 것이 시험되지 않는 자리에 남는다.
//
// 이 파일은 네트워크도 DB도 모른다 — 전부 주입받는다. 그래서 시험이
// 경합(임차 탈취·수동 청산·crash 후 재시작)을 **sleep 없이** 결정적으로
// 재현할 수 있다.
//
// ★ 불변식 — 이번 단계의 전부
// ───────────────────────────
//   candidate
//   → identity complete
//   → execution-aware policy resolve
//   → TIME_EXIT due
//   → lease owned
//   → current exposure READ (+ mode·side 검증, payload 준비)
//   → **fence 재검증**            ← 여기서 아래까지 네트워크 왕복 0
//   → reduceOnly close WRITE
//   → readAfter
//   → reconcile
//
// 재검증과 전송 사이에 조회를 하나라도 끼우면, 느린 실행자가 그 창에서
// 깨어나 남의 포지션에 주문을 낸다. 그래서 모드·노출·규격 조회는 전부
// **재검증 앞**에서 끝낸다(`venuePositionOps.prepareSymbolClose`).
//
// ★ 이미 flat인 것은 **실패가 아니다.** 주문을 보내지 않았다는 사실과
//   성공/실패를 한 boolean으로 합치지 않는다.

// ══════════════════════════════════════════════════════════════
// ★ ⑤A 안전 계약 — **정본은 여기 하나다**
// ══════════════════════════════════════════════════════════════
//
// 이 계약이 흩어지면 한쪽만 고쳐지고, 그때 "보장한다고 적었지만
// 보장하지 않는" 상태가 생긴다. 그래서 한 곳에 적는다.
//
// 보장하는 것
// ───────────
//   · 쓰기 **직전에** 울타리를 재검증한다
//   · 재검증 → 전송 사이에 거래소 READ가 **0**이다
//   · 낡은 실행자의 전송 가능성을 **숨기지 않는다** (Case F-A가 고정)
//   · 같은 종료 의도에 **결정적으로 같은** clientOrderId를 싣는다
//   · `reduceOnly: true` — 조건부가 아니라 상수다
//   · 주문 방향은 **관측한 포지션의 반대**다
//   · payload는 **지금 관측한 노출**로 만든다
//   · 최종 노출의 정본은 `readAfter`다
//   · flat이 아니면 `CLOSED_VERIFIED`로 적지 않는다
//   · 중복·모호 응답은 실패로 단정하지 않고 재조회로 확정한다
//
// 보장하지 **않는** 것
// ────────────────────
//   · strict single-writer — 이 경로는 그것이 아니다
//   · 낡은 실행자의 HTTP 전송 **자체**의 차단
//   · 거래소가 모든 시점에 같은 clientOrderId를 무조건 거부한다는 것
//   · 실제 Binance TESTNET의 duplicate 동작 (검증한 적 없음)
//
// 최종 문구 — 이 세 줄은 **줄이거나 강하게 고치지 않는다**
// ────────────────────────────────────────────────────────
//   exchange-level strict single-writer는 보장하지 않는다.
//   안전성은 fence window 최소화 + reduceOnly + current exposure
//   reconciliation에 의존한다.
//   clientOrderId duplicate rejection은 추가 방어층이며 외부 검증
//   전제다.

import {
  decideExitAuthority, exact100xExitVenueCapability,
  type ExitAuthorityDecision, type ExitCapabilities,
  type ExitReason, type LeaseIdentity, type PositionIdentity,
} from './exitAuthority';
import { applyLifecycleClose } from './lifecycleAction';
import { isDuplicateIntentError } from './exitIntent';
import type { ExecutionIdentity } from './managedPosition';

export type ExitRunCode =
  // ── 닫았다 ──
  /** 보냈고 재조회로 잔여 0을 확인했다 */
  | 'CLOSED_VERIFIED'
  /** 전송 결과는 몰랐지만 재조회로 잔여 0을 확인했다 */
  | 'RECONCILED_CLOSED'
  // ── 안 닫혔다 ──
  /** 접수됐는데 아직 남아 있다 (부분 종료일 수 있다) */
  | 'CLOSE_INCOMPLETE'
  /** 거래소가 **명시적으로** 거부했다 */
  | 'CLOSE_REJECTED'
  /** 보냈는지·닫혔는지 모른다 — 사람이 거래소와 대조해야 한다 */
  | 'CLOSE_UNKNOWN_RECONCILE_REQUIRED'
  // ── 보내지 않았다 ──
  /** 거래소에 포지션이 없다. **주문 0건** */
  | 'ALREADY_FLAT'
  /** 임차가 내 것이 아니다 (판정 시점) */
  | 'NOT_OWNER'
  /** 쓰기 직전 재검증에서 임차가 넘어가 있었다. **주문 0건** */
  | 'LEASE_LOST'
  | 'IDENTITY_MISMATCH'
  | 'POSITION_READ_FAILED'
  | 'POLICY_NOT_DUE'
  | 'POLICY_UNRESOLVED'
  | 'OPENED_AT_UNUSABLE'
  | 'IDENTITY_INCOMPLETE'
  | 'CAPABILITY_NOT_ENABLED'
  | 'QUANTITY_UNUSABLE'
  /** 이 거래소는 전용 종료 권한이 아직 지원하지 않는다. **주문 0건·조회 0건** */
  | 'EXIT_VENUE_UNSUPPORTED';

export interface ExitRunResult {
  code: ExitRunCode;
  /**
   * 이 회차가 **의도한 일을 끝냈는가.**
   *
   * `ALREADY_FLAT`도 참이다 — 닫으려던 노출이 없으므로 할 일이 끝났다.
   * 막힌 것(`NOT_OWNER`·`POLICY_NOT_DUE`)은 실패가 아니라 **지금 아님**
   * 이므로 따로 본다(`blocked`).
   */
  ok: boolean;
  /** 고쳐야 할 상태인가. 집계에서 이것만 실패로 센다 */
  failed: boolean;
  /** 일부러 아무것도 안 한 회차인가 */
  blocked: boolean;

  /** **거래소에 주문을 보냈는가.** `ALREADY_FLAT`이면 false다 */
  attemptedWrite: boolean;
  /** 거래소가 받았는가. **모르면 null** */
  accepted: boolean | null;
  /** 재조회로 잔여 0을 확인했는가. 못 읽었으면 null */
  flatVerified: boolean | null;
  /** 주문 없이 flat을 확인해 정리된 경우 */
  reconciledFlat: boolean;
  /** 사람이 거래소와 대조해야 하는가 */
  needsReconcile: boolean;

  decision: ExitAuthorityDecision | null;
  /**
   * **요청한 수량.** 안 보냈으면 null.
   *
   * ★ 이것은 "닫힌 양"이 **아니다.** 준비 시점의 노출로 만든 값이고,
   *   그 사이 사용자가 일부를 수동 청산하면 축소 전용 주문은 남은 만큼만
   *   체결된다. 실제로 닫혔는지는 `flatVerified` 하나만이 사실이다 —
   *   보낸 수량을 체결량으로 적으면 장부가 거짓말을 한다.
   */
  requestedQuantity: number | null;
  reason: string;
}

/** 이 후보 하나를 실행하는 데 필요한 바깥 세계 */
export interface ExitRunDeps {
  /**
   * 지금 임차가 내 것인가 (판정 시점).
   *
   * 여기서 참이어도 **쓰기 직전에 다시 묻는다** — 그 사이에 넘어갈 수 있다.
   */
  leaseOwned(): Promise<{ owned: boolean; identity: LeaseIdentity | null; reason?: string }>;
  /**
   * 거래소의 **지금 노출**을 읽고 보낼 payload를 만든다.
   *
   * 모드·수량·규격 조회를 **전부 여기서** 끝낸다 — 울타리 재검증 뒤에는
   * 네트워크 왕복이 없어야 한다.
   */
  prepareClose(): Promise<{
    code: 'READY' | 'ALREADY_FLAT' | 'READ_FAILED' | 'MODE_BLOCKED' | 'SIDE_MISMATCH';
    prepared: {
      quantity: number | null; orderSide: 'BUY' | 'SELL' | null; reduceOnly: true;
      observedQty: number | null; positionMode: 'ONE_WAY' | 'HEDGE' | null;
    } | null;
    message: string;
  }>;
  /**
   * **쓰기 직전** 울타리 재검증. 못 읽으면 false(fail-closed).
   *
   * 이 호출과 `sendClose` 사이에 await를 끼우지 않는다.
   */
  revalidateFence(): Promise<boolean>;
  /** 준비된 청산을 보낸다. 읽지 않는다 */
  sendClose(): Promise<{ attempted: boolean; ok: boolean; error: string | null; ambiguous?: boolean }>;
  /** 보낸 뒤 잔여를 다시 읽는다. `ok:false`는 "못 읽었다"다 */
  readAfter(): Promise<{ ok: boolean; found: boolean }>;
}

export interface ExitRunCandidate {
  positionIdentity: Omit<PositionIdentity, 'positionMode'>;
  strategyId: string | null;
  executionIdentity: ExecutionIdentity;
  capabilities: ExitCapabilities;
  reason: ExitReason;
  openedAtMs: number;
}

const denied = (
  code: ExitRunCode, decision: ExitAuthorityDecision | null, reason: string,
  over: Partial<ExitRunResult> = {},
): ExitRunResult => ({
  code, ok: false, failed: false, blocked: true,
  attemptedWrite: false, accepted: null, flatVerified: null,
  reconciledFlat: false, needsReconcile: false,
  decision, requestedQuantity: null, reason, ...over,
});

/**
 * 후보 하나를 실행한다.
 *
 * 각 단계는 앞 단계가 참일 때만 일어난다. 막히면 **그 아래 단계는 아예
 * 호출되지 않는다** — 시험이 호출 횟수로 그것을 센다.
 */
export async function runExitAuthority(
  candidate: ExitRunCandidate, deps: ExitRunDeps, nowMs: number,
): Promise<ExitRunResult> {
  // ── ⓪ 거래소가 지원 범위 안인가 — **무엇이든 부르기 전에** ──
  //
  // `decideExitAuthority`에도 같은 관문이 있지만 그것만으로는 부족하다.
  // 이 함수는 판정보다 **먼저** `leaseOwned`와 `prepareClose`를 부른다
  // (임차 없으면 읽지 않으려고 그 순서다). 그래서 판정에만 두면 지원하지
  // 않는 거래소를 **조회한 뒤에** 막게 된다 — "주문 0건"은 지켜도
  // "거래소 READ 0"이 깨진다.
  //
  // ★ 그렇다고 판단을 두 벌 적지는 않는다. 두 자리가 **같은 정본**
  //   (`exact100xExitVenueCapability`)을 부른다. Gate를 열 때 바꿀 곳은
  //   그 함수 하나다.
  const venue = exact100xExitVenueCapability(candidate.positionIdentity?.exchange);
  if (candidate.reason === 'TIME_EXIT' && venue.timeExit !== true) {
    // deps는 **하나도 부르지 않았다.** 조회·준비·전송 전부 0회다.
    return denied('EXIT_VENUE_UNSUPPORTED', null, venue.reason);
  }

  // ── ① 임차 (거래소를 읽기 **전에**) ──
  //
  // 남의 임차면 조회할 이유도 없다. 그리고 여기서 참이어도 끝이 아니다.
  let lease: { owned: boolean; identity: LeaseIdentity | null; reason?: string };
  try { lease = await deps.leaseOwned(); }
  catch (e: any) { lease = { owned: false, identity: null, reason: String(e?.message || e) }; }

  // ── ② 거래소의 지금 노출 + payload 준비 ──
  //
  // ★ 임차가 없으면 **읽지도 않는다.** 아래 판정이 어차피 막는다.
  let prep: Awaited<ReturnType<ExitRunDeps['prepareClose']>> | null = null;
  if (lease.owned === true) {
    try { prep = await deps.prepareClose(); }
    catch (e: any) {
      prep = { code: 'READ_FAILED', prepared: null, message: String(e?.message || e) };
    }
  }

  // ── ③ 권한 판정 ──
  //
  // 판정은 `exitAuthority` 한 곳이다. 여기서 규칙을 다시 적지 않는다.
  const observed = prep == null
    ? { ok: false, found: false, qty: null, side: null as 'LONG' | 'SHORT' | null }
    : prep.code === 'ALREADY_FLAT'
      ? { ok: true, found: false, qty: 0, side: null as 'LONG' | 'SHORT' | null }
      : prep.code === 'READY'
        ? { ok: true, found: true, qty: prep.prepared?.observedQty ?? null,
            side: candidate.positionIdentity.side }
        : prep.code === 'SIDE_MISMATCH'
          // 방향이 다르다는 것은 **읽긴 읽었다**는 뜻이다. 반대 방향으로
          // 넘겨 판정이 `IDENTITY_MISMATCH`로 잡게 한다.
          ? { ok: true, found: true, qty: prep.prepared?.observedQty ?? 1,
              side: (candidate.positionIdentity.side === 'LONG' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT' }
          : { ok: false, found: false, qty: null, side: null as 'LONG' | 'SHORT' | null };

  const decision = decideExitAuthority({
    positionIdentity: {
      ...candidate.positionIdentity,
      // 모드는 **거래소에서 읽은 것**이다. 못 읽었으면 null이고 판정이 막는다.
      positionMode: prep?.code === 'MODE_BLOCKED' ? null : (prep?.prepared?.positionMode ?? null),
    },
    strategyId: candidate.strategyId,
    capabilities: candidate.capabilities,
    reason: candidate.reason,
    openedAtMs: candidate.openedAtMs,
    observed,
    lease,
    nowMs,
  });

  if (!decision.authorized) {
    const code = decision.code === 'AUTHORIZED' ? 'IDENTITY_MISMATCH' : decision.code;
    if (code === 'ALREADY_FLAT') {
      // ★ **보낸 주문 0건이다.** 성공과 전송을 같은 값으로 적지 않는다.
      return denied('ALREADY_FLAT', decision, decision.reason, {
        ok: true, blocked: false, reconciledFlat: true, flatVerified: true,
      });
    }
    const failed = code === 'POSITION_READ_FAILED' || code === 'IDENTITY_MISMATCH';
    return denied(code as ExitRunCode, decision,
      prep?.code === 'MODE_BLOCKED' ? prep.message : decision.reason,
      { failed, blocked: !failed });
  }

  // ── ④ 쓰기 직전 재검증 → 전송 → 재조회 ──
  //
  // `applyLifecycleClose`가 그 순서를 갖고 있다(권한 → 전송 → 재조회).
  // **여기서 다시 쓰지 않는다** — 같은 순서가 두 곳에 있으면 한쪽만
  // 고쳐지고 그때 두 답이 갈린다.
  //
  // ★ 재검증과 전송 사이에 await가 없다: `prepareClose`가 이미 끝났고
  //   `sendClose`는 읽지 않는다.
  const act = await applyLifecycleClose({
    stillMine: deps.revalidateFence,
    close: async () => {
      const r = await deps.sendClose();
      // ★ **중복 식별자 거부는 실패가 아니다.**
      //
      //   같은 종료 의도를 다른 실행자가 이미 보냈다는 뜻이다(울타리가
      //   넘어간 직후의 경합). "거부됐다"로 적으면 **안 나간 것**으로
      //   읽혀 같은 자리에 또 보내게 된다. 실제로 닫혔는지는 거래소에만
      //   있으므로 재조회가 확정하게 넘긴다.
      if (!r.ok && isDuplicateIntentError(r.error)) {
        return { ...r, ambiguous: true };
      }
      return r;
    },
    readAfter: deps.readAfter,
  });

  const qty = decision.requestedQuantity;
  if (act.code === 'LEASE_LOST') {
    // **주문 0건.** 재검증이 막았다.
    return denied('LEASE_LOST', decision, act.reason, { blocked: true });
  }
  if (act.code === 'CLOSED_VERIFIED') {
    // 전송 결과를 몰랐어도 잔여 0을 확인했으면 대조로 닫힌 것이다.
    const reconciled = act.accepted === null;
    return {
      code: reconciled ? 'RECONCILED_CLOSED' : 'CLOSED_VERIFIED',
      ok: true, failed: false, blocked: false,
      attemptedWrite: true, accepted: act.accepted, flatVerified: true,
      reconciledFlat: reconciled, needsReconcile: false,
      decision, requestedQuantity: qty, reason: act.reason,
    };
  }
  if (act.code === 'CLOSE_REJECTED') {
    return {
      code: 'CLOSE_REJECTED', ok: false, failed: true, blocked: false,
      attemptedWrite: act.attempted, accepted: false, flatVerified: null,
      reconciledFlat: false, needsReconcile: false,
      decision, requestedQuantity: null, reason: act.reason,
    };
  }
  if (act.code === 'CLOSE_INCOMPLETE') {
    return {
      code: 'CLOSE_INCOMPLETE', ok: false, failed: true, blocked: false,
      attemptedWrite: true, accepted: true, flatVerified: false,
      reconciledFlat: false, needsReconcile: true,
      decision, requestedQuantity: qty, reason: act.reason,
    };
  }
  // CLOSE_AMBIGUOUS · CLOSE_UNVERIFIED — **보냈는지도 닫혔는지도 모른다.**
  // "실패"로 적으면 안 나간 것으로 읽혀 같은 자리에 또 보낸다.
  return {
    code: 'CLOSE_UNKNOWN_RECONCILE_REQUIRED', ok: false, failed: true, blocked: false,
    attemptedWrite: true, accepted: act.accepted, flatVerified: act.flatVerified,
    reconciledFlat: false, needsReconcile: true,
    decision, requestedQuantity: null, reason: act.reason,
  };
}
