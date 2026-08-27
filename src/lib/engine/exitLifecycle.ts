// src/lib/engine/exitLifecycle.ts
//
// **한 포지션에 대해 이번 주기에 무엇을 할 것인가.**
//
// 순서가 곧 안전이다
// ──────────────────
//   1. 정말 열려 있는가          거래소가 답한다. 못 읽으면 UNKNOWN이고 손대지 않는다
//   2. 이 전략의 것이 맞는가      증명 못 하면 손대지 않는다
//   3. 이 전략의 정책이 있는가    없으면 아무것도 안 한다 (기본값을 빌리지 않는다)
//   4. 시간이 다 됐는가          그러면 옮기는 것이 아니라 닫는다
//   5. 손절을 옮길 것인가        planTrail이 판단한다 (좁히기만 한다)
//
// **못 읽은 것을 flat으로 읽지 않는다**
// ────────────────────────────────────
// 포지션 조회가 실패했을 때 "포지션 0"으로 읽으면 두 가지가 동시에
// 일어난다: 보호주문을 고아로 보고 지우고, 그 뒤 실제로는 열려 있는
// 포지션이 보호 없이 남는다. 이 저장소에서 가장 비싼 실패의 모양이다.
//
// 네트워크도 DB도 안 본다 — 값만 받아서 판단한다.

import { planTrail } from './trailPlan';
import type { LifecyclePolicy } from '../strategies/lifecyclePolicy';
import type { ManagedPosition } from './managedPosition';

export type LifecycleAction = 'NONE' | 'MOVE_STOP' | 'CLOSE';

export type LifecycleCode =
  /** 거래소에 실제로 열려 있는 것을 확인했고, 할 일이 없다 */
  | 'OK'
  /** 손절을 옮긴다 */
  | 'MOVE_STOP'
  /** 시간이 다 됐다 */
  | 'TIME_EXIT'
  /** 트레일링 선을 이미 지났다 */
  | 'TRAIL_CLOSE'
  /** 거래소에 포지션이 없다. 남은 보호주문은 고아다 */
  | 'FLAT'
  /** 포지션을 못 읽었다. **flat이 아니다** */
  | 'POSITION_UNKNOWN'
  /** 이 전략의 것이라고 증명하지 못했다 */
  | 'OWNERSHIP_AMBIGUOUS'
  /** 이 전략에 생명주기 정책이 선언돼 있지 않다 */
  | 'NO_POLICY'
  /** 최고 도달 R을 못 구했다 (봉 조회 실패) */
  | 'NO_HIGH_WATER';

export interface LifecycleVerdict {
  code: LifecycleCode;
  action: LifecycleAction;
  newStop?: number;
  /** 이 회차에 고아 보호주문을 치워도 되는가. **FLAT을 확인했을 때만** */
  mayCleanProtection: boolean;
  reason: string;
}

const no = (code: LifecycleCode, reason: string): LifecycleVerdict =>
  ({ code, action: 'NONE', mayCleanProtection: false, reason });

/**
 * 이번 주기의 판단.
 *
 * @param position   장부에서 만든 후보 (`managedCandidates`)
 * @param policy     이 전략의 생명주기 정책. **없으면 null**
 * @param live       거래소가 답한 사실. `ok=false`면 못 읽은 것이다
 * @param highWaterR 진입 이후 최고 도달 R. 못 구했으면 null
 * @param lastPrice  현재가. 못 구했으면 null
 * @param liveStop   거래소에 지금 걸려 있는 손절. 못 읽었으면 null → 진입 손절을 쓴다
 * @param nowMs      지금
 */
export function lifecycleDecide(i: {
  position: ManagedPosition;
  policy: LifecyclePolicy | null | undefined;
  live: { ok: boolean; found: boolean } | null | undefined;
  highWaterR: number | null;
  lastPrice: number | null;
  liveStop: number | null;
  nowMs: number;
}): LifecycleVerdict {
  const p = i.position;

  // ── ① 정말 열려 있는가 ──
  const live = i.live;
  if (!live || live.ok !== true) {
    return no('POSITION_UNKNOWN',
      '거래소에서 포지션을 확인하지 못했습니다 — 없다는 뜻이 아니므로 아무것도 하지 않습니다');
  }
  if (!live.found) {
    // 여기서만 보호주문을 고아로 볼 수 있다. **확인한 경우다.**
    return { code: 'FLAT', action: 'NONE', mayCleanProtection: true,
      reason: '거래소에 포지션이 없습니다 — 남은 보호주문은 고아입니다' };
  }

  // ── ② 이 전략의 것이 맞는가 ──
  if (p.ownership.code !== 'OWNED') {
    return no(p.ownership.code === 'OWNERSHIP_AMBIGUOUS' ? 'OWNERSHIP_AMBIGUOUS' : 'OWNERSHIP_AMBIGUOUS',
      p.ownership.reason);
  }

  // ── ③ 정책이 있는가 ──
  //
  // **없으면 기본값을 빌리지 않는다.** 다른 전략의 숫자를 쓰는 것은
  // 없던 규칙을 만드는 것이다.
  const pol = i.policy;
  if (!pol) {
    return no('NO_POLICY',
      `${p.strategyId ?? '이 전략'}에 트레일링·본전이동·시간청산 정책이 선언돼 있지 않습니다 `
      + '— 다른 전략의 값을 빌려 쓰지 않습니다');
  }

  // ── ④ 시간이 다 됐는가 ──
  //
  // 옮기기 전에 본다. 시간이 지난 포지션의 손절을 옮기는 것은 뜻이 없다.
  if (pol.maxHoldMs != null && Number.isFinite(p.openedAt)) {
    const held = i.nowMs - p.openedAt;
    if (held >= pol.maxHoldMs) {
      const hours = Math.round(pol.maxHoldMs / 3_600_000);
      return { code: 'TIME_EXIT', action: 'CLOSE', mayCleanProtection: false,
        reason: `최대 보유 시간(${hours}시간) 초과 — 시간 청산` };
    }
  }

  // ── ⑤ 손절을 옮길 것인가 ──
  if (i.highWaterR == null || !Number.isFinite(i.highWaterR)) {
    // **0으로 두지 않는다.** 0은 '아직 안 올랐다'라 본전이동이 영원히 안 걸린다.
    return no('NO_HIGH_WATER', '최고 도달 R을 확인하지 못해 이번 주기는 건너뜁니다');
  }

  const useTrailing = pol.trailStartR != null && pol.trailDistanceR != null;
  const useBreakEven = pol.breakEvenR != null;
  if (!useTrailing && !useBreakEven) {
    return no('OK', '이 전략은 트레일링·본전이동을 하지 않습니다 (정책에 없음)');
  }

  const v = planTrail({
    side: p.side,
    entryPrice: p.entryPrice,
    initialStop: p.stopLoss,                 // 1R의 기준. 절대 안 바뀐다
    currentStop: i.liveStop ?? p.stopLoss,   // 거래소에 지금 걸린 것
    highWaterR: i.highWaterR,
    lastPrice: i.lastPrice,
    cfg: {
      trailStartR: pol.trailStartR ?? 0,
      trailDistanceR: pol.trailDistanceR ?? 0,
      breakEvenR: pol.breakEvenR ?? 0,
      useTrailing, useBreakEven,
    },
  });

  if (v.action === 'MOVE_STOP' && v.newStop != null) {
    return { code: 'MOVE_STOP', action: 'MOVE_STOP', newStop: v.newStop,
      mayCleanProtection: false, reason: v.reason };
  }
  if (v.action === 'CLOSE') {
    return { code: 'TRAIL_CLOSE', action: 'CLOSE', mayCleanProtection: false, reason: v.reason };
  }
  return no('OK', v.reason);
}
