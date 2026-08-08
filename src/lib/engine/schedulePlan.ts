// src/lib/engine/schedulePlan.ts
//
// **예약이 가리키는 거래소 연결이 아직 있는가.**
//
// 무슨 일이 있었나
// ────────────────
// BTCUSDT 예약은 예전에 저장한 `connection_id`를 들고 있는데, Gate 테스트넷
// 연결을 다시 등록하면서 그 id가 새로 생겼다. 예약의 id는 그대로였고,
// 그 연결은 더 이상 없다.
//
// 화면의 [끄기] 스위치는 **예약에 적힌 id를 그대로** 보낸다. 서버는 그
// id가 내 연결 목록에 없으니 404 `connection_not_found`로 거절한다.
// 그래서 켤 수도 끌 수도 없는 줄이 화면에 남는다 — 사용자는 무엇이
// 잘못됐는지 알 방법이 없다. 화면에는 "연결 있음"이라고 적혀 있었다.
//
// 왜 자동으로 안 바꾸는가
// ───────────────────────
// 서버가 "없는 id네, 그럼 이 사람 연결 중 아무거나 쓰자"로 고치면
// **주문이 어느 계좌로 나가는지 사용자가 모르는 채 바뀐다.** 계좌가
// 둘 이상이면 그건 남의 돈으로 실험하는 것과 같다.
//
// 그래서 이 파일은 두 가지만 한다:
//   1. 예약이 낡은 연결을 가리키는지 **판정한다**
//   2. 사용자가 **명시적으로 고른** 연결로 바꿔도 되는지 **판정한다**
//
// 고르는 것은 언제나 사람이 한다.

import { isLiveConnection, type ConnLike } from '../markets/tradeMode';

export type ScheduleConnState =
  | 'OK'          // 예약이 가리키는 연결이 지금도 있다
  | 'STALE'       // 연결 id는 있는데 내 연결 목록에 없다 — 다시 골라야 한다
  | 'MISSING'     // 예약에 연결 id 자체가 없다
  | 'UNKNOWN';    // 연결 목록을 못 읽었다 — 낡았는지 아닌지 말할 수 없다

export interface ScheduleConnVerdict {
  state: ScheduleConnState;
  /** 사람이 그대로 읽는 한 줄 */
  message: string;
  /** 사용자가 연결을 다시 골라야 하는가 */
  needsRebind: boolean;
}

export interface ConnRow extends ConnLike {
  id: string;
  exchange_id?: string | null;
  label?: string | null;
}

/**
 * 이 예약이 가리키는 연결이 지금도 있는가.
 *
 * **연결 목록을 못 읽었으면 UNKNOWN이다.** 빈 배열로 치면 모든 예약이
 * 한꺼번에 '낡음'으로 뜨고, 사용자는 멀쩡한 예약을 다시 연결한다.
 * 0과 모름은 다른 값이다.
 */
export function scheduleConnState(
  scheduleConnectionId: any,
  connections: ConnRow[] | null | undefined,
): ScheduleConnVerdict {
  const id = String(scheduleConnectionId ?? '').trim();
  if (!id) {
    return {
      state: 'MISSING', needsRebind: true,
      message: '연결 없음 — 주문을 낼 수 없습니다. 거래소 연결을 고르세요',
    };
  }
  if (!Array.isArray(connections)) {
    return {
      state: 'UNKNOWN', needsRebind: false,
      message: '연결 목록을 읽지 못해 이 예약의 연결이 살아 있는지 확인하지 못했습니다',
    };
  }
  const hit = connections.find(c => String(c?.id) === id);
  if (!hit) {
    return {
      state: 'STALE', needsRebind: true,
      message: '연결 다시 선택 필요 — 이 예약이 가리키는 거래소 연결이 더 이상 없습니다. '
             + '켜고 끄는 것도 막힙니다',
    };
  }
  return { state: 'OK', needsRebind: false, message: '연결 있음' };
}

// ── 재연결 ───────────────────────────────────────────

export type RebindCode =
  | 'OK'
  | 'NO_CHOICE'          // 사용자가 연결을 안 골랐다
  | 'NOT_YOURS'          // 고른 연결이 내 목록에 없다
  | 'CONNECTIONS_UNKNOWN'// 연결 목록을 못 읽었다
  | 'ENV_MISMATCH';      // 모드와 연결의 환경이 다르다

export interface RebindVerdict {
  ok: boolean;
  code: RebindCode;
  /** 실제로 저장할 연결 id. ok가 false면 null */
  connectionId: string | null;
  message: string;
}

/**
 * 이 예약을 **사용자가 고른 연결**로 바꿔도 되는가.
 *
 * 규칙 셋
 * ───────
 *  1. **고르지 않았으면 안 한다.** 대신 골라 주지 않는다 — 계좌가 둘
 *     이상이면 어느 쪽으로 주문이 나가는지 모르는 채 바뀐다.
 *  2. **내 연결이어야 한다.** 남의 연결 id를 넣어 그 계좌로 주문이
 *     나가게 하면 안 된다. 목록은 호출자가 `user_id`로 걸러 넘긴다.
 *  3. **환경이 같아야 한다.** 테스트넷 예약을 실전 연결로 바꾸면
 *     "테스트넷인 줄 알고 켰는데 진짜 돈이 나간다"가 된다.
 *     저장소 규칙 그대로 `is_testnet === false`만 실전이다.
 */
export function rebindVerdict(input: {
  /** 사용자가 화면에서 지금 고른 연결 */
  currentConnectionId: any;
  /** 내 연결 목록. **못 읽었으면 null** — 빈 배열로 치지 않는다 */
  connections: ConnRow[] | null | undefined;
  /** 예약의 운영 모드 (TESTNET · LIVE_SMALL …) */
  mode: any;
}): RebindVerdict {
  const id = String(input.currentConnectionId ?? '').trim();
  if (!id) {
    return {
      ok: false, code: 'NO_CHOICE', connectionId: null,
      message: '바꿀 거래소 연결을 먼저 고르세요 — 대신 골라 주지 않습니다. '
             + '어느 계좌로 주문이 나가는지는 사용자가 정해야 합니다',
    };
  }
  if (!Array.isArray(input.connections)) {
    return {
      ok: false, code: 'CONNECTIONS_UNKNOWN', connectionId: null,
      message: '연결 목록을 읽지 못해 이 연결이 내 것인지 확인하지 못했습니다',
    };
  }
  const hit = input.connections.find(c => String(c?.id) === id);
  if (!hit) {
    return {
      ok: false, code: 'NOT_YOURS', connectionId: null,
      message: '그 연결은 내 목록에 없습니다 — 다른 계정의 연결로는 바꿀 수 없습니다',
    };
  }

  const modeRaw = String(input.mode ?? '').trim().toUpperCase();
  const modeIsLive = modeRaw.startsWith('LIVE') || modeRaw === 'SHADOW_LIVE';
  const connIsLive = isLiveConnection(hit);

  if (modeIsLive && !connIsLive) {
    return {
      ok: false, code: 'ENV_MISMATCH', connectionId: null,
      message: `${modeRaw} 모드인데 테스트넷 연결입니다 — 주문이 테스트넷으로 나갑니다`,
    };
  }
  if (!modeIsLive && connIsLive) {
    // 이쪽이 훨씬 위험하다. 테스트넷인 줄 알고 켰는데 실계좌로 나간다.
    return {
      ok: false, code: 'ENV_MISMATCH', connectionId: null,
      message: `${modeRaw} 모드인데 **실전 연결**입니다 — 진짜 돈으로 주문이 나갑니다`,
    };
  }

  return { ok: true, code: 'OK', connectionId: id, message: '이 연결로 바꿉니다' };
}
