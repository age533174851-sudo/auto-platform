// src/lib/strategies/lifecyclePolicy.ts
//
// **트레일링 · 본전이동 · 시간청산의 값은 전략마다 다르다.
// 한 전략의 값을 다른 전략에 복사하면 조용히 틀린다.**
//
// 조사에서 나온 것
// ────────────────
// 청산 감시가 쓰던 `TrailConfig`(2R / 1R / 1R)는 **전역 기본값 + 환경
// 변수**이고, `maxHoldBars: 5`는 `daily-ladder` 라우트의 값이다
// (`body.maxHoldDays ?? 5`, **일봉 기준**). `registry.ts`에는 청산 정책
// 칸이 아예 없다.
//
// 그 값을 scalp·my-original-v1에 그대로 쓰면 두 곳에서 명백히 틀린다:
//
//   scalp           목표가 이미 2R이다(`rewardRisk: 2`). 트레일링 시작을
//                   2R에 두면 익절이 먼저 닿아 **트레일링이 영원히 발동하지
//                   않는다.** 그리고 분봉 돌파에 5일 보유는 뜻이 없다.
//
//   my-original-v1  100배 · 손절 0.4%다. 청산 거리가 0.6%뿐이라
//                   (`exitPolicy.ts`) 본전이동 지점을 잘못 잡으면
//                   손절이 청산선에 붙는다.
//
// 이 값들은 원본 규칙이 아니다
// ────────────────────────────
// `exitPolicy.ts`가 이미 같은 문제를 다뤘다: 사용자의 원본 전략은 청산이
// **재량**이었고, 숫자를 적어 두면 나중에 그게 원본인 줄 알게 된다.
//
// 그래서 여기 값도 **검증용**이고 버전이 따로 붙는다. 진입 전략 버전과
// 섞이지 않으므로, 나중에 이 정책만 바꿔 가며 비교할 수 있다.
//
//   진입  scalp v1 · my-original-v1 v1   — 바뀌지 않는다
//   생명  lifecycle-testnet-v1            — 검증용. 교체된다
//
// 선언이 없으면 아무것도 하지 않는다
// ──────────────────────────────────
// 정책이 없는 전략에서 트레일링을 "기본값으로" 돌리지 않는다. 그건
// 없던 규칙을 만드는 것이고, 이 저장소에서 가장 비싼 실수의 모양이다.
// 없으면 `NO_POLICY`로 남고, 그 사실이 커버리지 표에 그대로 보인다.

/** 이 값들이 어느 판에서 나왔는가. 진입 전략 버전과 별개다 */
export const LIFECYCLE_POLICY_ID = 'lifecycle-testnet-v1';
export const LIFECYCLE_POLICY_VERSION = '1';

export interface LifecyclePolicy {
  /** 트레일링을 시작하는 R. null이면 트레일링을 하지 않는다 */
  trailStartR: number | null;
  /** 최고점에서 이만큼 R 물러나면 청산 */
  trailDistanceR: number | null;
  /** 이 R에 닿으면 손절을 본전으로. null이면 본전이동을 하지 않는다 */
  breakEvenR: number | null;
  /** 최대 보유 시간(ms). null이면 시간청산을 하지 않는다 */
  maxHoldMs: number | null;
  /** 이 값이 어디서 왔는가 — 화면·응답에 그대로 싣는다 */
  source: 'STRATEGY_DECLARED' | 'LIFECYCLE_TESTNET_V1';
  note: string;
}

const HOUR = 60 * 60 * 1000;

/**
 * 전략별 생명주기 정책.
 *
 * **여기 없는 전략은 기본값을 받지 않는다.** `lifecyclePolicyOf`가
 * `null`을 돌려주고, 그 전략은 트레일링·본전이동·시간청산을 안 한다.
 */
const BY_STRATEGY: Record<string, LifecyclePolicy> = {
  // daily-ladder는 원래부터 값이 있었다. 여기서 바꾸지 않는다 —
  // 이 PR은 **더하는** 것이지 도는 것을 건드리는 것이 아니다.
  'daily-ladder': {
    trailStartR: 2, trailDistanceR: 1, breakEvenR: 1,
    maxHoldMs: 5 * 24 * HOUR,
    source: 'STRATEGY_DECLARED',
    note: '기존 daily-ladder 값 (exitPlan · maxHoldDays 5일) 그대로입니다',
  },

  // ── 아래 둘은 검증용으로 **새로 정한** 값이다 ──
  scalp: {
    // 목표가 2R이므로 그보다 앞에서 시작해야 뜻이 있다.
    trailStartR: 1, trailDistanceR: 0.5,
    // 목표의 절반에서 본전으로 — 분봉 돌파는 되돌림이 빠르다.
    breakEvenR: 0.5,
    // 분봉 돌파가 하루를 넘겨 살아 있으면 그건 이미 다른 거래다.
    maxHoldMs: 6 * HOUR,
    source: 'LIFECYCLE_TESTNET_V1',
    note: '원본 진입 규칙과 무관하게 정한 검증용 값입니다 — '
      + '목표 2R보다 앞에서 트레일링이 시작되도록 골랐습니다',
  },
  'my-original-v1': {
    trailStartR: 1, trailDistanceR: 0.5,
    // **0.5R = 진입가 대비 0.2%.** 손절 0.4% · 청산 거리 0.6%이므로
    // 본전 손절은 청산선에서 0.6% 떨어진 자리에 놓인다 — 더 붙지 않는다.
    breakEvenR: 0.5,
    // 하루 1회 전략이다. 다음 판단 창(다음 날 아침) 전에 정리한다.
    maxHoldMs: 24 * HOUR,
    source: 'LIFECYCLE_TESTNET_V1',
    note: '원본 진입 규칙과 무관하게 정한 검증용 값입니다 — '
      + '100배 청산 거리(0.6%) 안쪽에 본전 손절이 놓이도록 골랐습니다',
  },
};

/** 이 전략의 생명주기 정책. **없으면 null이고, 그러면 아무것도 하지 않는다** */
export function lifecyclePolicyOf(strategyId: string | null | undefined): LifecyclePolicy | null {
  const id = String(strategyId || '').trim();
  if (!id) return null;
  return BY_STRATEGY[id] ?? null;
}

/** 정책이 선언된 전략 목록 — 커버리지 표가 이 값을 읽는다 */
export function strategiesWithLifecyclePolicy(): string[] {
  return Object.keys(BY_STRATEGY);
}
