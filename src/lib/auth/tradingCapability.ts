// src/lib/auth/tradingCapability.ts
//
// **무엇을 거래할 수 있는가** — 회원 등급과 다른 축이다.
//
// 왜 기존 role로는 안 되나
// ────────────────────────
// 지금 있는 것은 `user | vip | lifetime | founder | admin | developer |
// super_admin`이고, 이건 **회원 등급**이다. 관리자 화면에 들어갈 수
// 있는가를 정한다.
//
// 그런데 물어야 하는 것은 다른 질문이다: **이 사람이 실제 돈으로
// 자동매매를 켤 수 있는가.** 둘은 섞이면 안 된다:
//
//   · 관리자는 사용자를 관리하는 사람이지 돈을 걸 사람이 아니다
//   · 친구에게 화면을 보여 주려고 계정을 열었는데 등급이 올라가면서
//     실전 자동매매까지 켜지면, 그건 아무도 의도하지 않은 일이다
//
// 그래서 **등급은 권한을 주지 않는다.** super_admin이어도 기본값은
// 남들과 같다. 실전은 따로 켜야 한다.
//
// 기본값은 가장 좁은 쪽
// ─────────────────────
// 새 사용자는 아무것도 못 한다(VIEW_ONLY). 넓은 쪽을 기본으로 두면
// "아직 설정 안 한 사람"이 곧 "전부 할 수 있는 사람"이 된다.
//
// 화면에서 숨기는 것으로는 부족하다
// ─────────────────────────────────
// 버튼을 안 그리는 것은 편의이고, 막는 것은 서버가 한다. 화면은
// 우회할 수 있고 API는 직접 부를 수 있다.

export type TradingCapability =
  /** 보기만. 주문 경로가 전부 막힌다 */
  | 'VIEW_ONLY'
  /** 모의투자만. 거래소로 나가는 것이 없다 */
  | 'PAPER_ONLY'
  /** 테스트넷까지. 실제 돈은 안 나간다 */
  | 'TESTNET'
  /** 실전이지만 **손으로 누르는 것만.** 자동매매는 못 켠다 */
  | 'LIVE_MANUAL'
  /** 실전 자동매매까지 */
  | 'LIVE_AUTO';

/** 넓은 쪽이 큰 수. 좁은 권한이 넓은 것을 포함하지 않는다 */
export const CAP_RANK: Record<TradingCapability, number> = {
  VIEW_ONLY: 0, PAPER_ONLY: 1, TESTNET: 2, LIVE_MANUAL: 3, LIVE_AUTO: 4,
};

export const CAP_INFO: Record<TradingCapability, { label: string; desc: string }> = {
  VIEW_ONLY:   { label: '보기 전용', desc: '주문을 낼 수 없습니다' },
  PAPER_ONLY:  { label: '모의만',    desc: '모의투자만 됩니다 — 거래소로 나가지 않습니다' },
  TESTNET:     { label: '테스트넷',  desc: '테스트넷까지 됩니다 — 실제 돈은 나가지 않습니다' },
  LIVE_MANUAL: { label: '실전 수동',  desc: '실전 주문을 손으로 낼 수 있습니다. 자동매매는 못 켭니다' },
  LIVE_AUTO:   { label: '실전 자동',  desc: '실전 자동매매까지 됩니다' },
};

/**
 * **기본값은 가장 좁은 쪽이다.**
 *
 * 여기를 넓히면 "아직 설정 안 한 사람"이 곧 "전부 할 수 있는 사람"이
 * 된다. 친구에게 계정을 열어 주는 순간 그 사람이 실전 자동매매를
 * 켤 수 있게 되는 것이고, 그건 아무도 의도하지 않은 일이다.
 */
export const DEFAULT_CAPABILITY: TradingCapability = 'VIEW_ONLY';

export function capabilityOf(raw: any): TradingCapability {
  const s = String(raw ?? '').trim().toUpperCase() as TradingCapability;
  // **모르는 값은 기본값이다.** 여기서 넓은 쪽으로 떨어지면 오타 하나가
  // 권한이 된다.
  return s in CAP_RANK ? s : DEFAULT_CAPABILITY;
}

/** 이 사람의 권한이 요구 수준 이상인가 */
export function capAtLeast(cap: any, need: TradingCapability): boolean {
  return CAP_RANK[capabilityOf(cap)] >= CAP_RANK[need];
}

export type TradeIntent =
  | 'VIEW'
  /** 모의투자 주문 */
  | 'PAPER_ORDER'
  /** 테스트넷 주문 (손으로) */
  | 'TESTNET_ORDER'
  /** 실전 주문 (손으로) */
  | 'LIVE_ORDER'
  /** 자동매매 켜기 — 테스트넷이든 실전이든 */
  | 'ENABLE_AUTOTRADE'
  /** 실전 자동매매 켜기 */
  | 'ENABLE_LIVE_AUTOTRADE';

/** 각 동작에 필요한 최소 권한 */
export const INTENT_MIN: Record<TradeIntent, TradingCapability> = {
  VIEW: 'VIEW_ONLY',
  PAPER_ORDER: 'PAPER_ONLY',
  TESTNET_ORDER: 'TESTNET',
  LIVE_ORDER: 'LIVE_MANUAL',
  // 테스트넷 자동매매도 TESTNET이면 된다 — 실제 돈이 안 나간다.
  ENABLE_AUTOTRADE: 'TESTNET',
  ENABLE_LIVE_AUTOTRADE: 'LIVE_AUTO',
};

export interface CapVerdict {
  allowed: boolean;
  reason: string;
  /** 지금 권한 */
  capability: TradingCapability;
  /** 필요한 권한 */
  required: TradingCapability;
}

/**
 * 이 동작을 해도 되는가.
 *
 * 순수 함수다 — 저장소를 안 읽는다. 호출부가 읽어 온 값을 넘긴다.
 *
 * **등급(role)을 받지 않는다.** 받으면 언젠가 "관리자는 통과"가 들어가고,
 * 그러면 이 파일이 있는 이유가 사라진다.
 */
export function canDo(cap: any, intent: TradeIntent): CapVerdict {
  const c = capabilityOf(cap);
  const need = INTENT_MIN[intent] ?? 'LIVE_AUTO';
  const ok = CAP_RANK[c] >= CAP_RANK[need];
  return {
    allowed: ok,
    capability: c,
    required: need,
    reason: ok ? ''
      : `${CAP_INFO[c].label} 권한으로는 할 수 없습니다 — ${CAP_INFO[need].label} 이상이 필요합니다`,
  };
}

/**
 * 주문 하나가 어떤 동작인가.
 *
 * 모드와 자동 여부에서 뽑는다. **실전 자동매매를 실전 수동과 같게 보면
 * 안 된다** — 사람이 누르는 것과 사람이 안 볼 때 도는 것은 위험이 다르다.
 */
export function intentOf(args: {
  paper?: boolean;
  testnet?: boolean;
  /** 자동매매가 낸 주문인가 */
  automated?: boolean;
}): TradeIntent {
  if (args.paper) return 'PAPER_ORDER';
  if (args.automated) {
    // **testnet이 아니라고 확신할 때만 실전 자동으로 본다.**
    // 이 저장소의 공통 규칙: is_testnet === false 일 때만 실전이다.
    return args.testnet === false ? 'ENABLE_LIVE_AUTOTRADE' : 'ENABLE_AUTOTRADE';
  }
  return args.testnet === false ? 'LIVE_ORDER' : 'TESTNET_ORDER';
}

/**
 * 등급에서 권한을 **추론하지 않는다.**
 *
 * 이 함수는 그 사실을 코드로 못박기 위해 있다. 언젠가 누가
 * "admin이면 LIVE_AUTO로 하자"를 넣고 싶어질 때, 그게 왜 안 되는지가
 * 여기 적혀 있어야 한다.
 *
 * 관리자는 **사용자를 관리하는 사람**이지 돈을 걸 사람이 아니다.
 * 그리고 친구에게 화면을 보여 주려고 등급을 올렸는데 실전 자동매매까지
 * 켜지면, 그건 아무도 의도하지 않은 일이다.
 */
export function capabilityFromRole(_role: string | null | undefined): TradingCapability {
  return DEFAULT_CAPABILITY;
}
