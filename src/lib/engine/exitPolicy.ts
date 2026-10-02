// src/lib/engine/exitPolicy.ts
//
// **이 포지션의 종료 정책은 누가 정하는가.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// 지금 종료 경로는 `lifecyclePolicyOf(p.strategyId)` 하나만 부른다
// (`exit-monitor` 라우트). 전략 이름만 보는 것이다. 그런데 Exact100X는
// **같은 `scalp` 전략 위에서 다른 실행 계약으로** 돈다.
//
//   `profiles.MAX_LEV_100X.maxHoldSec = 14400`   (4시간)  ← 계약이 선언
//   `lifecyclePolicyOf('scalp').maxHoldMs = 6h`           ← 전략이 선언
//
// 두 숫자가 다르고, 전략 이름으로 고르면 **계약이 선언한 4시간이 아니라
// 6시간으로 닫힌다.** 계약은 사용자가 고른 것이고 전략 기본값은 아니다 —
// 사용자가 허락하지 않은 2시간을 더 들고 있게 된다.
//
// 그래서 "어느 정책을 쓰는가"를 한 곳에서 정한다.
//
// 규칙
// ────
//   ① 실행 계약 identity가 있으면 **계약이 정본이다.**
//      전략 정책으로 내려가지 않는다.
//   ② identity가 있는데 계약을 풀지 못하면 **막는다.**
//      전략 기본값으로 대신하지 않는다 — 그건 사용자가 고르지 않은
//      숫자로 남의 포지션을 닫는 것이다.
//   ③ identity가 아예 없으면(계약 없이 연 예약) 기존 전략 정책 그대로.
//      **다른 전략의 기존 의미를 바꾸지 않는다.**
//
// ★ 이 파일은 시간만 정한다. "닫아도 되는가"는 `exitAuthority`가 정한다.

import { resolveExecutionProfile } from '../execution/profile';
import { lifecyclePolicyOf } from '../strategies/lifecyclePolicy';
import type { ExecutionIdentity } from './managedPosition';

export type ExitPolicySource =
  /** 사용자가 고른 실행 계약이 선언한 값 */
  | 'EXECUTION_CONTRACT'
  /** 계약 없이 연 예약 — 전략 생명주기 표 */
  | 'STRATEGY_LIFECYCLE';

export type ExitPolicyCode =
  | 'OK'
  /** 계약 identity가 반쪽이다. **나머지를 추측하지 않는다** */
  | 'IDENTITY_INCOMPLETE'
  /** identity는 있는데 그 계약을 풀지 못했다 */
  | 'CONTRACT_UNRESOLVED'
  /** 계약·정책에 최대 보유 한도가 선언돼 있지 않다 */
  | 'NO_MAX_HOLD';

export interface ResolvedExitPolicy {
  ok: boolean;
  code: ExitPolicyCode;
  /** 최대 보유 시간(ms). 못 정하면 null */
  maxHoldMs: number | null;
  source: ExitPolicySource | null;
  /**
   * 어느 정책 판본인가. 기록에 남겨야 "무슨 규칙으로 닫았는지"를
   * 나중에 말할 수 있다.
   */
  policyVersion: string | null;
  reason: string;
}

const fail = (code: ExitPolicyCode, reason: string): ResolvedExitPolicy =>
  ({ ok: false, code, maxHoldMs: null, source: null, policyVersion: null, reason });

export interface ExitPolicyInput {
  /** 이 포지션을 연 실행 계약. 기록이 없으면 null */
  executionIdentity: ExecutionIdentity | null | undefined;
  /** 계약이 없을 때만 쓰는 전략 이름 */
  strategyId: string | null | undefined;
}

/**
 * 이 포지션의 종료 정책.
 *
 * **계약이 있으면 계약이 이긴다.** 그리고 계약을 못 읽으면 전략 값으로
 * 내려가지 않고 막는다 — 내려가는 순간 "사용자가 4시간을 골랐는데
 * 6시간에 닫혔다"가 된다.
 */
export function resolveExitPolicy(i: ExitPolicyInput): ResolvedExitPolicy {
  const id = i?.executionIdentity ?? null;

  // ── ③ 계약 없이 연 예약 — 기존 의미 그대로 ──
  if (id == null) {
    const sid = String(i?.strategyId ?? '').trim();
    const pol = lifecyclePolicyOf(sid);
    if (!pol) {
      return fail('NO_MAX_HOLD',
        `${sid || '이 전략'}에 생명주기 정책이 선언돼 있지 않습니다`
        + ' — 다른 전략의 값을 빌려 쓰지 않습니다');
    }
    if (pol.maxHoldMs == null || !(pol.maxHoldMs > 0)) {
      return fail('NO_MAX_HOLD',
        `${sid}의 생명주기 정책에 최대 보유 한도가 없습니다`);
    }
    return {
      ok: true, code: 'OK', maxHoldMs: pol.maxHoldMs,
      source: 'STRATEGY_LIFECYCLE',
      policyVersion: `strategy:${sid}:${pol.source}`,
      reason: `전략 ${sid}의 생명주기 정책 (최대 보유 ${Math.round(pol.maxHoldMs / 3_600_000)}시간)`,
    };
  }

  // ── ① 계약이 정본이다 ──
  const profileId = String(id.profileId ?? '').trim();
  const presetId = String(id.presetId ?? '').trim();
  const version = id.contractVersion;
  if (!profileId || !presetId || !Number.isFinite(Number(version))) {
    // ② **전략 값으로 내려가지 않는다.**
    return fail('IDENTITY_INCOMPLETE',
      '실행 계약 식별자가 반쪽입니다 — 전략 기본값으로 대신하지 않고 막습니다'
      + ' (사용자가 고르지 않은 보유 한도로 포지션을 닫지 않습니다)');
  }

  const r = resolveExecutionProfile(profileId, presetId, version);
  if (!r.ok || !r.contract) {
    return fail('CONTRACT_UNRESOLVED',
      `실행 계약 ${profileId}·${presetId} v${version}을 풀지 못했습니다`
      + `${r.ok ? '' : ` (${(r as any).code})`}`
      + ' — 전략 기본값으로 대신하지 않습니다');
  }

  const sec = Number(r.contract.maxHoldSec);
  if (!Number.isFinite(sec) || !(sec > 0)) {
    // **0은 "무제한"이라 적혀 있다.** 그 경우 시간 청산은 하지 않는다.
    // 전략 값으로 내려가면 계약이 "무제한"이라고 한 포지션이 6시간에
    // 닫힌다 — 계약을 어기는 것이다.
    return fail('NO_MAX_HOLD',
      `실행 계약 ${profileId}·${presetId} v${version}에 최대 보유 한도가 없습니다`
      + ' (0 = 무제한) — 전략 기본값으로 대신하지 않습니다');
  }

  return {
    ok: true, code: 'OK', maxHoldMs: sec * 1000,
    source: 'EXECUTION_CONTRACT',
    policyVersion: `contract:${profileId}/${presetId}/v${version}`,
    reason: `실행 계약이 선언한 최대 보유 ${Math.round(sec / 3600)}시간`,
  };
}
