// src/lib/engine/exitAuthority.ts
//
// **누가, 어느 포지션을, 왜, 지금 닫아도 되는가 — 하나의 계약.**
//
// 왜 이 파일이 먼저인가
// ─────────────────────
// 이 단계에서 처음으로 **이미 열린 포지션을 자동으로 닫는다.** 종료
// 조건을 하나 더 붙이는 일이 아니다. 조건부터 붙이면 각 조건이 제 나름의
// 방식으로 거래소에 주문을 내게 되고, 그러면 같은 질문("내가 아직
// 주인인가")이 조건 수만큼 흩어진다. 이 저장소가 반복해서 당한 고장이
// 정확히 그 모양이다.
//
// 그래서 순서를 타입으로 고정한다:
//
//   observe → classify → decide → authorize → revalidate → write → reconcile
//
// 이 파일은 **앞 네 단계만** 한다. 거래소를 바꾸지 않는다 — 바꿀 수단이
// 타입에 없다. 재검증(revalidate)과 쓰기(write)는 호출부가 하고, 그
// 순서는 `lifecycleAction.applyLifecycleClose`가 이미 갖고 있다.
//
// ★ 이번 단계의 성공은 "수익성이 좋아졌다"도 "100배가 안전해졌다"도
//   아니다. **계약이 선언한 보유 상한에 도달한 Exact100X 포지션을,
//   올바른 실행 identity와 현재 노출을 다시 확인하고, 유효한 임차를 가진
//   단 하나의 실행자만, reduce-only로, 중복 없이 닫는다.** 그것뿐이다.
//
// 아직 하지 않는 것
// ─────────────────
//   · adverse-loss exit
//   · 청산 여유(liquidation-buffer) 비상 종료
//   · trailing · breakEven
// 구조는 이 사유들을 나중에 더할 수 있게 열어 두되, **빈 기능을 true로
// 적지 않는다.**

import { resolveExitPolicy, type ResolvedExitPolicy } from './exitPolicy';
import type { ExecutionIdentity } from './managedPosition';

/**
 * 왜 닫는가. **지금 실행 가능한 것은 `TIME_EXIT` 하나뿐이다.**
 *
 * 나중에 `ADVERSE_MOVE`·`LIQUIDATION_BUFFER`·`TRAIL_STOP`이 붙는다.
 * 지금 그 이름을 적어 두지 않는 이유: 이름이 있으면 어딘가에서 분기가
 * 생기고, 그 분기는 구현이 없는 채로 `true`가 될 수 있다.
 */
export type ExitReason = 'TIME_EXIT';

export type ExitAuthorityCode =
  /** 닫아도 된다 */
  | 'AUTHORIZED'
  /** 이 계약의 포지션에 이 종료 사유가 아직 열려 있지 않다 */
  | 'CAPABILITY_NOT_ENABLED'
  /** 실행 계약 식별자가 반쪽이거나 없다 */
  | 'IDENTITY_INCOMPLETE'
  /** 종료 정책을 정하지 못했다 (계약을 못 풀었거나 한도가 없다) */
  | 'POLICY_UNRESOLVED'
  /** 진입 시각을 쓸 수 없다 (없음·NaN·미래) */
  | 'OPENED_AT_UNUSABLE'
  /** 아직 때가 아니다 */
  | 'POLICY_NOT_DUE'
  /** 거래소 포지션을 읽지 못했다. **flat이 아니다** */
  | 'POSITION_READ_FAILED'
  /** 거래소에 포지션이 없다 — 보낼 주문이 없다 */
  | 'ALREADY_FLAT'
  /** 장부의 방향·종목과 거래소의 것이 다르다 */
  | 'IDENTITY_MISMATCH'
  /** 임차(실행 권한)가 내 것이 아니다 */
  | 'NOT_OWNER'
  /** 닫을 수량을 정하지 못했다 */
  | 'QUANTITY_UNUSABLE';

/**
 * 종료 대상 포지션의 신원.
 *
 * **`symbol`만으로는 부족하다.** 헤지 계좌에서는 같은 종목에 LONG·SHORT가
 * 동시에 있을 수 있고, 종목만 보고 닫으면 다른 다리를 닫는다. 계좌·거래소·
 * 방향·실행 계약까지 함께여야 "내가 연 Exact100X 포지션"이라고 말할 수 있다.
 */
export interface PositionIdentity {
  exchange: 'binance' | 'gate';
  connectionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  executionIdentity: ExecutionIdentity | null;
  /** 이 포지션을 연 주문 줄. 기록·중복 방지에 쓴다 */
  openingOrderId: string | null;
  /** 계좌의 포지션 모드. **못 읽었으면 null이고 그건 통과가 아니다** */
  positionMode: 'ONE_WAY' | 'HEDGE' | null;
}

/** 이 계약의 포지션에 **지금 실제로 열려 있는** 종료 수단 */
export interface ExitCapabilities {
  /** 진입 시점 고정 손절을 거는가 */
  fixedStopAtEntry: boolean;
  breakEven: boolean;
  trailing: boolean;
  timeExit: boolean;
  /** adverse/청산여유 비상 종료. **아직 없다** */
  emergency: boolean;
}

/** 거래소가 지금 답한 노출 */
export interface ObservedPosition {
  /** 조회 자체가 성공했는가. `false`면 **없다는 뜻이 아니다** */
  ok: boolean;
  found: boolean;
  /** 부호 없는 수량. 못 읽으면 null */
  qty: number | null;
  side: 'LONG' | 'SHORT' | null;
}

export interface ExitAuthorityDecision {
  authorized: boolean;
  code: ExitAuthorityCode;
  reasonCode: ExitReason | null;
  reason: string;

  positionIdentity: PositionIdentity;
  executionIdentity: ExecutionIdentity | null;
  strategyId: string | null;
  executionProfileId: string | null;
  side: 'LONG' | 'SHORT';

  /** 무엇을 할 것인가. 지금은 전량 축소뿐이다 */
  requestedAction: 'CLOSE' | 'NONE';
  /** 닫을 수량. **지금 관측한 노출이다 — 진입 수량이 아니다** */
  requestedQuantity: number | null;
  /** 반드시 참이다. 신규 반대 포지션을 만들지 않는다 */
  reduceOnly: boolean;
  /** 판정 시점에 거래소가 답한 수량 */
  observedPositionQuantity: number | null;

  /** 어느 임차 아래의 판정인가 */
  leaseIdentity: LeaseIdentity | null;
  decisionAt: number;
  policySource: string | null;
  policyVersion: string | null;
  /** 정책 판정 자체 — 막혔어도 남긴다 */
  policy: ResolvedExitPolicy | null;
  /** 보유 경과(ms). 못 재면 null */
  heldMs: number | null;
}

/**
 * 임차의 신원. **보유자 문자열만으로는 부족하다.**
 *
 * A가 임차를 얻고 멈춘 사이 만료되어 B가 얻고, 그 뒤 A가 깨어나는
 * 경우가 있다. 그때 A가 "내 이름이 적혀 있나"만 보면 B의 이름을 보고
 * 물러나지만, 이름이 같은 러너가 둘이면 구분하지 못한다. 그래서
 * **단조 증가하는 울타리 번호**를 함께 본다 — 이 저장소의
 * `exit_monitor_lease.fence`가 그것이다.
 */
export interface LeaseIdentity {
  holder: string | null;
  /** 단조 증가 울타리 번호. 없으면 null */
  fence: number | null;
}

export interface ExitAuthorityInput {
  positionIdentity: PositionIdentity;
  strategyId: string | null | undefined;
  /** 이 계약에 지금 열려 있는 종료 수단 */
  capabilities: ExitCapabilities;
  /** 이번에 쓰려는 종료 사유 */
  reason: ExitReason;
  /** 진입(체결) 시각 ms */
  openedAtMs: number | null | undefined;
  /** 거래소가 답한 지금 노출 */
  observed: ObservedPosition | null | undefined;
  /** 지금 임차 상태. `owned=false`면 쓰지 않는다 */
  lease: { owned: boolean; identity: LeaseIdentity | null; reason?: string } | null | undefined;
  /**
   * 판정 시각. **인자로 받는다** — 한 회차의 같은 포지션에 대한 판정이
   * 여러 `Date.now()`로 갈라지면 경계에서 답이 흔들린다.
   */
  nowMs: number;
}

const base = (i: ExitAuthorityInput, policy: ResolvedExitPolicy | null, heldMs: number | null)
: Omit<ExitAuthorityDecision, 'authorized' | 'code' | 'reason' | 'reasonCode'
  | 'requestedAction' | 'requestedQuantity'> => ({
  positionIdentity: i.positionIdentity,
  executionIdentity: i.positionIdentity?.executionIdentity ?? null,
  strategyId: i.strategyId == null ? null : String(i.strategyId),
  executionProfileId: i.positionIdentity?.executionIdentity?.profileId ?? null,
  side: i.positionIdentity?.side,
  // **언제나 참이다.** 축소 전용이 아닌 종료 주문을 이 권한으로 내지 않는다.
  reduceOnly: true,
  observedPositionQuantity: i.observed?.qty ?? null,
  leaseIdentity: i.lease?.identity ?? null,
  decisionAt: i.nowMs,
  policySource: policy?.source ?? null,
  policyVersion: policy?.policyVersion ?? null,
  policy,
  heldMs,
});

const deny = (
  i: ExitAuthorityInput, code: ExitAuthorityCode, reason: string,
  policy: ResolvedExitPolicy | null = null, heldMs: number | null = null,
): ExitAuthorityDecision => ({
  ...base(i, policy, heldMs),
  authorized: false, code, reasonCode: null,
  requestedAction: 'NONE', requestedQuantity: null,
  reason,
});

const num = (v: unknown): number | null => {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * **닫아도 되는가.**
 *
 * 순서가 계약이다. 각 단계는 앞 단계가 참일 때만 의미가 있다.
 *
 *   ① 이 사유가 이 계약에 열려 있는가   (capability)
 *   ② 실행 identity가 온전한가
 *   ③ 종료 정책을 정할 수 있는가        (계약이 정본)
 *   ④ 진입 시각을 쓸 수 있는가
 *   ⑤ 때가 됐는가
 *   ⑥ 임차가 내 것인가
 *   ⑦ 거래소가 지금 뭐라고 답하는가
 *   ⑧ 그것이 내가 아는 그 포지션인가
 *   ⑨ 닫을 수량이 얼마인가
 *
 * ⑥이 ⑦보다 앞인 이유: 임차가 남의 것이면 거래소를 **읽을 이유도** 없다.
 * ⑦이 ⑨보다 앞인 이유: 닫을 수량은 **지금 관측한 노출**이지 진입 수량이
 * 아니다. 사이에 수동 부분청산이 있었을 수 있다.
 */
export function decideExitAuthority(i: ExitAuthorityInput): ExitAuthorityDecision {
  // ── ① 이 사유가 열려 있는가 ──
  //
  // "관리됨/관리 안 됨" boolean 하나로 네 기능을 같이 열지 않는다.
  // 지금 열려 있는 것은 시간 청산 하나뿐이고, 나머지는 명시적으로 닫혀 있다.
  const cap = i?.capabilities;
  if (i.reason === 'TIME_EXIT' && cap?.timeExit !== true) {
    return deny(i, 'CAPABILITY_NOT_ENABLED',
      '이 계약의 포지션에는 시간 청산이 열려 있지 않습니다');
  }

  // ── ② 실행 identity ──
  const pid = i?.positionIdentity;
  const eid = pid?.executionIdentity ?? null;
  if (!pid || !pid.exchange || !pid.connectionId || !pid.symbol || !pid.side) {
    return deny(i, 'IDENTITY_INCOMPLETE',
      '포지션 신원(거래소·계좌·종목·방향)이 온전하지 않습니다 — 종목만 보고 닫지 않습니다');
  }
  if (eid == null) {
    // 계약 없이 연 포지션은 이 권한의 대상이 아니다. 기존 생명주기가 본다.
    return deny(i, 'IDENTITY_INCOMPLETE',
      '이 포지션에 실행 계약 기록이 없습니다 — 전용 종료 권한의 대상이 아닙니다');
  }

  // ── ③ 종료 정책 ──
  const policy = resolveExitPolicy({ executionIdentity: eid, strategyId: i.strategyId });
  if (!policy.ok || policy.maxHoldMs == null) {
    return deny(i, 'POLICY_UNRESOLVED', policy.reason, policy);
  }

  // ── ④ 진입 시각 ──
  //
  // **없는 것을 지금으로 대체하지 않는다.** 지금으로 두면 경과가 0이 되어
  // 영원히 안 닫히고, 0으로 두면 1970년이 되어 즉시 닫힌다. 둘 다 사고다.
  const openedAt = num(i.openedAtMs);
  if (openedAt == null || !(openedAt > 0)) {
    return deny(i, 'OPENED_AT_UNUSABLE',
      `진입 시각을 쓸 수 없습니다 (${String(i.openedAtMs)})`
      + ' — 지금 시각이나 0으로 대체하지 않습니다', policy);
  }
  const now = num(i.nowMs);
  if (now == null) {
    return deny(i, 'OPENED_AT_UNUSABLE',
      '판정 시각을 읽지 못했습니다 — 보유 경과를 잴 수 없습니다', policy);
  }
  if (openedAt > now) {
    // 미래 진입 시각. 경과를 0으로 깎으면 "방금 열린 포지션"이 되어
    // 조용히 통과한다 — 그건 시계가 어긋났다는 사실을 지우는 것이다.
    return deny(i, 'OPENED_AT_UNUSABLE',
      `진입 시각이 판정 시각보다 ${openedAt - now}ms 미래입니다`
      + ' — 경과를 0으로 깎지 않고 막습니다', policy);
  }

  // ── ⑤ 때가 됐는가 ──
  //
  // **경계는 `>=`다.** 계약이 "최대 보유 4시간"이라고 하면 4시간째가
  // 초과의 시작이다. `>`로 두면 정확히 4시간인 포지션이 통과한다.
  const heldMs = now - openedAt;
  if (!(heldMs >= policy.maxHoldMs)) {
    return deny(i, 'POLICY_NOT_DUE',
      `보유 ${Math.round(heldMs / 1000)}초 — 한도 ${Math.round(policy.maxHoldMs / 1000)}초에`
      + ' 아직 도달하지 않았습니다', policy, heldMs);
  }

  // ── ⑥ 임차 ──
  //
  // 거래소를 **읽기 전에** 본다. 남의 임차면 읽을 이유도 없다.
  // ★ 이것은 판정 시점의 확인이다. **쓰기 직전에 한 번 더** 물어야
  //   한다 — 그 재검증은 호출부(`applyLifecycleClose`)의 일이고,
  //   여기서 끝났다고 생각하면 그 사이에 임차가 넘어간다.
  if (i.lease?.owned !== true) {
    return deny(i, 'NOT_OWNER',
      i.lease?.reason || '실행 권한(임차)이 내 것이 아닙니다', policy, heldMs);
  }

  // ── ⑦ 거래소가 지금 뭐라고 답하는가 ──
  const obs = i.observed;
  if (!obs || obs.ok !== true) {
    // **못 읽은 것을 flat으로 읽지 않는다.** 이 저장소에서 가장 비싼
    // 실패의 모양이다.
    return deny(i, 'POSITION_READ_FAILED',
      '거래소 포지션을 읽지 못했습니다 — 없다는 뜻이 아니므로 주문을 보내지 않습니다',
      policy, heldMs);
  }
  if (obs.found !== true) {
    // 이미 닫혀 있다. **주문을 보내지 않는다** — 보내면 반대 포지션이 된다.
    return deny(i, 'ALREADY_FLAT',
      '거래소에 포지션이 없습니다 — 보낼 청산 주문이 없습니다 (대조로 정리합니다)',
      policy, heldMs);
  }

  // ── ⑧ 내가 아는 그 포지션인가 ──
  if (obs.side != null && obs.side !== pid.side) {
    return deny(i, 'IDENTITY_MISMATCH',
      `장부는 ${pid.side}인데 거래소는 ${obs.side}입니다 — 짐작하면 다른 다리를 닫습니다`,
      policy, heldMs);
  }
  // 포지션 모드를 모르면 막는다. 양방향 계좌에서 단방향 조합을 보내면
  // 거부가 아니라 **반대 방향 신규 진입**이 될 수 있다. 실제 전송 관문
  // (`closeModeVerdict`)도 같은 판단을 하지만, 권한 자체가 모르는 상태를
  // 통과시키면 그 관문이 유일한 방어가 된다.
  if (pid.positionMode !== 'ONE_WAY') {
    return deny(i, 'IDENTITY_MISMATCH',
      pid.positionMode === 'HEDGE'
        ? '양방향(헤지) 계좌의 청산 규격을 확정하지 못했습니다 — 보내지 않습니다'
        : '계좌의 포지션 모드를 읽지 못했습니다 — 확인하지 못한 것은 통과가 아닙니다',
      policy, heldMs);
  }

  // ── ⑨ 닫을 수량 ──
  //
  // **진입 수량을 그대로 믿지 않는다.** 사이에 수동 부분청산·거래소
  // 조정이 있었을 수 있다. 지금 관측한 노출로 닫는다.
  const qty = num(obs.qty);
  if (qty == null || !(qty > 0)) {
    return deny(i, 'QUANTITY_UNUSABLE',
      `거래소가 답한 수량이 ${String(obs.qty)}입니다 — 닫을 양을 정할 수 없습니다`,
      policy, heldMs);
  }

  return {
    ...base(i, policy, heldMs),
    authorized: true, code: 'AUTHORIZED', reasonCode: i.reason,
    requestedAction: 'CLOSE', requestedQuantity: qty,
    reason: `${policy.reason} 초과 (보유 ${Math.round(heldMs / 1000)}초) — 축소 전용 청산`,
  };
}
