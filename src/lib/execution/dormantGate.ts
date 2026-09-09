// src/lib/execution/dormantGate.ts
//
// **실행 프로필을 켤 수 있는가 — 그 판단이 사는 단 한 곳.**
//
// 왜 파일 하나를 따로 만드는가
// ────────────────────────────
// 1A(#244)는 실행 프로필을 가진 예약을 네 층에서 막았다.
//
//   L1  DB CHECK          `execution_profile_id IS NULL OR enabled = false`
//   L2  POST 저장         프로필을 건드리는 요청은 `enabled:false` 명시 필수
//   L3  PATCH 켜기        켜는 UPDATE 조건 안에 프로필 필터
//   L4  실행 직전         `evaluationRunner`가 선점보다 앞에서 BLOCK
//
// 이제 프로필을 하나씩 열어야 하는데, **네 층에 각자 "이건 열어도 된다"를
// 적으면 반드시 갈린다.** 이 저장소에서 반복된 고장이 정확히 그것이다
// (`경로가 둘인데 한쪽만 고침`). 특히 나쁜 조합은 L4만 열고 L3가 계속
// 막는 경우다 — 사용자는 켤 수 없는데 시험은 "실행기가 통과시킨다"로
// 초록이 된다.
//
// 그래서 **여기 있는 목록 하나가 정본**이고, 네 층이 전부 이것을 읽는다.
// 프로필을 여는 변경은 이 파일의 배열 한 줄이다.
//
// 지금 목록이 비어 있는 이유
// ──────────────────────────
// `MAX_LEV_100X`는 구현됐지만 **아직 열지 않는다.** 근거는 두 개다.
//
//   ① 고정 손절을 대신할 자동 종료 권한이 배선돼 있지 않다.
//      `exitLifecycle.lifecycleDecide`에서 손절 없이 동작하는 자동 종료는
//      `TIME_EXIT`(최대 보유 시간) 하나뿐이고, 트레일링·본전이동은
//      `planTrail`이 `initialStop > 0`을 요구해서 아예 돌지 않는다.
//      게다가 `lifecyclePolicyOf`는 **전략 id**로만 조회한다 — 실행
//      프로필과 연결이 없어서 `MAX_LEV_100X`에는 정책이 없다.
//      100배의 청산 거리는 대략 0.6~1%다. 4시간 시간 청산은 그 자리를
//      대신하지 못한다.
//
//   ② `marginAllocationPct`가 아직 정해지지 않았다(null). 사이징이
//      그 상태를 BLOCK으로 다루므로, 열어도 주문은 나가지 않는다.
//      열어 봐야 얻는 것이 없고 잃을 것만 있다.
//
// 둘 중 하나라도 남아 있으면 이 배열은 비어 있어야 한다. 여는 사람이
// 위 두 줄을 지우지 않고 배열만 채우는 일이 없도록 여기 적어 둔다.

import { PROFILES } from '../strategies/profiles';

/**
 * 실행기가 **실제로 계약대로 실행하는** 프로필 id 목록.
 *
 * 여기 없는 프로필은 저장은 되지만 켤 수 없다. 비어 있는 것이 지금의
 * 정상 상태다 — 위 머리말의 ①②를 먼저 해결해야 채울 수 있다.
 */
export const EXECUTABLE_PROFILE_IDS: readonly string[] = [];

export interface ExecutionGateVerdict {
  /** 이 프로필을 가진 예약을 켜거나 실행해도 되는가 */
  allowed: boolean;
  /** 막는 이유. 통과면 빈 문자열 */
  reason: string;
}

/**
 * 이 예약을 켜거나 실행해도 되는가.
 *
 * `profileId`가 비어 있으면(=프로필을 쓰지 않는 기존 예약) 통과다.
 * 기존 예약의 동작을 이 파일이 바꾸지 않는다.
 *
 * @param executable 열린 목록. 시험이 주입한다. 안 주면 정본을 쓴다.
 */
export function executionGateVerdict(
  profileId: unknown,
  executable: readonly string[] = EXECUTABLE_PROFILE_IDS,
): ExecutionGateVerdict {
  const id = profileId == null ? '' : String(profileId).trim();
  if (!id) return { allowed: true, reason: '' };

  if (executable.includes(id)) return { allowed: true, reason: '' };

  // **모르는 id도 여기서 막힌다.** 화이트리스트라서 그렇다. 모르는 값을
  // "프로필이 없는 것"으로 읽어 통과시키면, 오타 하나가 기존 방식으로
  // 도는 예약이 된다 — 화면에 적힌 것과 다른 실행이다.
  const known = Object.prototype.hasOwnProperty.call(PROFILES, id);
  return {
    allowed: false,
    reason: known
      ? `실행 프로필 ${id}은(는) 아직 활성화되지 않았습니다`
        + ' — 실행기가 그 계약을 아직 그대로 실행하지 않습니다.'
        + ' 기존 방식으로 대신 실행하지도 않습니다.'
      : `모르는 실행 프로필입니다: ${id}`
        + ' — 모르는 값을 프로필 없음으로 읽지 않습니다.',
  };
}

export type EnableFilterSpec =
  /** 열린 프로필이 없다 — 프로필이 없는 줄만 켤 수 있다 */
  | { kind: 'isNull' }
  /** 프로필이 없거나, 열린 목록에 든 줄만 켤 수 있다 */
  | { kind: 'or'; expr: string };

/**
 * 켜기 UPDATE에 붙일 조건.
 *
 * **되읽어서 판단하면 늦는다.** PATCH의 update와 select가 한 문장이라,
 * 되읽었을 때는 이미 켜진 뒤다. 그래서 조건을 UPDATE 안에 넣는다 —
 * 맞는 줄이 없으면 아무것도 바뀌지 않는다.
 *
 * 이 함수를 따로 두는 이유는 순수 함수라 시험할 수 있기 때문이다.
 * 목록이 비었을 때와 찼을 때가 실제로 다른 조건을 만드는지 확인하지
 * 않으면, 나중에 목록을 채워도 이 자리가 계속 `isNull`로 남는 것을
 * 아무도 모른다.
 */
export function enableFilterSpec(
  executable: readonly string[] = EXECUTABLE_PROFILE_IDS,
): EnableFilterSpec {
  const ids = executable.filter(s => typeof s === 'string' && s.trim() !== '');
  if (ids.length === 0) return { kind: 'isNull' };
  // PostgREST의 `or`. 값에 쉼표·괄호가 들어가면 문법이 깨지므로 id 모양을
  // 여기서 제한한다 — 프로필 id는 대문자·숫자·밑줄뿐이다.
  const safe = ids.filter(s => /^[A-Z0-9_]+$/.test(s));
  if (safe.length === 0) return { kind: 'isNull' };
  return {
    kind: 'or',
    expr: `execution_profile_id.is.null,execution_profile_id.in.(${safe.join(',')})`,
  };
}
