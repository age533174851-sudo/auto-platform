// src/lib/engine/operatingMode.ts
//
// 단계별 운영 모드. 앞의 네 가지(상태 대조·생명주기·UNKNOWN 복구·출처 표시)를
// 묶는 바깥 관문이다.
//
// 왜 필요한가
// ───────────
// 지금은 mode가 PAPER / TESTNET / LIVE 셋뿐이고, 그 사이가 절벽이다.
// 테스트넷에서 잘 돌았다고 바로 실계좌로 가면, 실계좌에서만 나타나는 것들
// (실제 체결 지연, 실제 증거금, 실제 펀딩, 실제 청산)을 한 번도 못 보고
// 돈을 건다. 반대로 모의만 계속하면 영원히 아무것도 검증되지 않는다.
//
// 사다리를 만들되 **한 칸씩만** 오르게 한다. 두 칸을 건너뛰면 그 칸에서
// 얻었어야 할 증거가 통째로 빈다.
//
// Shadow Live에 대하여
// ────────────────────
// 실계좌 데이터로 판단은 전부 하되 **주문만 보내지 않는다.**
// 이게 의미 있으려면 "안 보냄"으로 끝나면 안 된다. 보냈어야 할 주문을
// 기록으로 남겨야, 나중에 "그때 진짜 보냈으면 어떻게 됐나"를 실제 시세와
// 대조할 수 있다. 기록하지 않는 Shadow Live는 그냥 꺼둔 것과 같다.

export type OperatingMode =
  | 'UI_DEMO'       // 화면만. 엔진도 돌지 않는다
  | 'PAPER'         // 모의매매 — 앱 내부 장부
  | 'TESTNET'       // 거래소 테스트넷에 실제 주문
  | 'SHADOW_LIVE'   // 실계좌로 판단만. 주문은 보내지 않고 기록만 남긴다
  | 'LIVE_SMALL'    // 소액 실전 — 사람이 매번 확인
  | 'LIVE_LIMITED'; // 제한 자동매매

/** 사다리 순서. 인덱스가 곧 단계다 */
export const LADDER: OperatingMode[] = [
  'UI_DEMO', 'PAPER', 'TESTNET', 'SHADOW_LIVE', 'LIVE_SMALL', 'LIVE_LIMITED',
];

export interface ModeCapability {
  /** 거래소로 주문을 실제로 보내는가 */
  sendsOrders: boolean;
  /** 진짜 돈이 걸리는가 */
  realMoney: boolean;
  /** 실계좌 키가 필요한가 (테스트넷 키가 아니라) */
  needsLiveKey: boolean;
  /**
   * 주문을 안 보내더라도 "보냈어야 할 주문"을 기록하는가.
   * Shadow Live의 존재 이유다.
   */
  recordsIntent: boolean;
  /** 사람 확인 없이 자동으로 진행해도 되는가 */
  autoTrade: boolean;
  /** 1회 주문 명목가 상한(USD). null이면 제한 없음 */
  maxNotionalUsd: number | null;
  /**
   * 자산 대비 명목가 상한(%). 실제 상한은 **둘 중 큰 쪽**이다.
   *
   * 왜 고정 금액만으로는 안 되나
   * ──────────────────────────
   * $100 고정 상한은 계좌가 $360일 때는 빡빡하고 $100,000일 때는
   * 의미가 없다. 시드가 커지면 사용자가 상한을 손으로 올려야 하는데,
   * 그러면 상한은 "안전장치"가 아니라 "귀찮은 것"이 되고 결국 꺼진다.
   *
   * 비율로 두면 자산과 함께 자란다. 그리고 이 비율이 곧 "한 번에
   * 자산의 몇 배까지 걸 수 있나"다 — 2000%는 자산의 20배 명목가,
   * 100배 배율이면 증거금 20%까지다.
   *
   * null이면 비율 상한 없음. 자산을 모르면 이 항목은 무시되고 고정
   * 금액만 남는다 — **모르는 것을 유리하게 읽지 않는다.**
   */
  maxNotionalPctOfEquity: number | null;
  /** 사용자에게 보여줄 이름 */
  label: string;
}

const CAP: Record<OperatingMode, ModeCapability> = {
  UI_DEMO: {
    sendsOrders: false, realMoney: false, needsLiveKey: false,
    recordsIntent: false, autoTrade: false,
    maxNotionalUsd: 0, maxNotionalPctOfEquity: null,
    label: 'UI 데모 — 화면만',
  },
  PAPER: {
    sendsOrders: false, realMoney: false, needsLiveKey: false,
    recordsIntent: true, autoTrade: false,
    maxNotionalUsd: null, maxNotionalPctOfEquity: null,
    label: '모의매매 — 앱 내부 장부',
  },
  TESTNET: {
    sendsOrders: true, realMoney: false, needsLiveKey: false,
    recordsIntent: true, autoTrade: true,
    maxNotionalUsd: null, maxNotionalPctOfEquity: null,
    label: 'Testnet — 거래소 테스트넷 실주문',
  },
  SHADOW_LIVE: {
    // 핵심: 판단은 전부 하되 보내지 않는다.
    sendsOrders: false, realMoney: false, needsLiveKey: true,
    recordsIntent: true, autoTrade: true,
    maxNotionalUsd: null, maxNotionalPctOfEquity: null,
    label: 'Shadow Live — 실계좌 판단, 주문은 기록만',
  },
  LIVE_SMALL: {
    // 사람이 매번 확인한다. 자동으로 넘어가지 않는다.
    sendsOrders: true, realMoney: true, needsLiveKey: true,
    recordsIntent: true, autoTrade: false,
    // 자산의 2배까지. $360이면 $720 — '소액'의 뜻이 계좌 크기에 따라
    // 달라져야 한다. 고정 $100은 작은 계좌에는 과하고 큰 계좌에는 무의미했다.
    maxNotionalUsd: 100, maxNotionalPctOfEquity: 200,
    label: '소액 실전 — 건마다 사람 확인',
  },
  LIVE_LIMITED: {
    sendsOrders: true, realMoney: true, needsLiveKey: true,
    recordsIntent: true, autoTrade: true,
    // 자산의 20배까지 = 100배 배율에서 증거금 20%까지. "100배로 10%씩
    // 열 번"은 자산의 10배 명목가라 여기 들어온다. 20%를 넘으면
    // '열 번 나눠 쓴다'가 아니게 되므로 거기서 자른다.
    maxNotionalUsd: 1000, maxNotionalPctOfEquity: 2000,
    label: '제한 자동매매 — 건별 확인 없이 나갑니다',
  },
};

/**
 * 문자열을 모드로. **모르는 값은 가장 안전한 쪽으로 떨어진다.**
 *
 * 기본값을 LIVE 쪽에 두면, 환경변수 오타 하나가 실거래를 켠다.
 */
export function parseMode(raw: string | null | undefined): OperatingMode {
  const s = String(raw || '').toUpperCase().replace(/[\s-]/g, '_');
  return (LADDER as string[]).includes(s) ? (s as OperatingMode) : 'UI_DEMO';
}

export function capability(mode: OperatingMode): ModeCapability {
  return CAP[mode];
}

export function stepOf(mode: OperatingMode): number {
  return LADDER.indexOf(mode);
}

// ── 승급 ────────────────────────────────────────────────

/** 승급 판단에 필요한 증거 */
export interface ModeEvidence {
  /** 이 모드에서 완료된 거래 표본 수 */
  completedTrades: number;
  /** 이 모드로 운영한 날 수 */
  daysInMode: number;
  /** 아직 결과가 확정되지 않은 주문 수 */
  unresolvedOrders: number;
  /** 미해결 심각 상태 불일치 수 */
  criticalMismatches: number;
  /** 실계좌 키가 등록돼 있는가 */
  hasLiveKey: boolean;
  /** 실거래 잠금이 풀려 있는가 (ALLOW_LIVE_TRADING) */
  liveUnlocked: boolean;
}

/** 각 단계로 올라가기 위한 최소 조건 */
const PROMOTION_MIN: Partial<Record<OperatingMode, { trades: number; days: number }>> = {
  TESTNET:      { trades: 0,  days: 0 },
  SHADOW_LIVE:  { trades: 10, days: 10 },   // 테스트넷 표본
  LIVE_SMALL:   { trades: 10, days: 10 },   // 섀도우 표본
  LIVE_LIMITED: { trades: 20, days: 20 },   // 소액 실전 표본
};

export interface PromotionCheck {
  allowed: boolean;
  reasons: string[];
}

/**
 * from에서 to로 바꿔도 되는가.
 *
 * 내려가는 것은 언제나 허용한다. 안전 밸브에 조건을 달면
 * 정작 급할 때 못 내려간다.
 */
export function canChangeMode(
  from: OperatingMode, to: OperatingMode, ev: ModeEvidence,
): PromotionCheck {
  if (from === to) return { allowed: true, reasons: [] };

  const up = stepOf(to) - stepOf(from);
  if (up < 0) return { allowed: true, reasons: ['하향은 항상 허용됩니다'] };

  const reasons: string[] = [];

  // 한 칸씩만. 건너뛴 칸에서 얻었어야 할 증거가 통째로 빈다.
  if (up > 1) {
    reasons.push(
      `${LADDER[stepOf(from) + 1]}를 건너뛸 수 없습니다 — 한 단계씩 올라가야 합니다`);
  }

  const min = PROMOTION_MIN[to];
  if (min) {
    if (ev.completedTrades < min.trades) {
      reasons.push(`표본 부족: ${ev.completedTrades}/${min.trades}건`);
    }
    if (ev.daysInMode < min.days) {
      reasons.push(`기간 부족: ${ev.daysInMode}/${min.days}일`);
    }
  }

  // 미확정·불일치를 남긴 채로 올라가면, 그 문제가 더 위험한 단계에서 터진다.
  if (ev.unresolvedOrders > 0) {
    reasons.push(`결과 미확정 주문 ${ev.unresolvedOrders}건을 먼저 확정하세요`);
  }
  if (ev.criticalMismatches > 0) {
    reasons.push(`거래소와 심각한 상태 불일치 ${ev.criticalMismatches}건이 남아 있습니다`);
  }

  const cap = CAP[to];
  if (cap.needsLiveKey && !ev.hasLiveKey) {
    reasons.push('실계좌 API 키가 등록돼 있지 않습니다');
  }
  if (cap.realMoney && !ev.liveUnlocked) {
    reasons.push('실거래가 잠겨 있습니다 (ALLOW_LIVE_TRADING)');
  }

  return { allowed: reasons.length === 0, reasons };
}

// ── 주문 관문 ────────────────────────────────────────────

export type OrderDisposition =
  | 'SEND'      // 거래소로 보낸다
  | 'RECORD'    // 보내지 않고 기록만 (Shadow Live · 모의)
  | 'BLOCK';    // 아무것도 하지 않는다

export interface OrderGate {
  disposition: OrderDisposition;
  /** 실계좌인가 (테스트넷이면 false) */
  live: boolean;
  /** 사람 확인이 필요한가 */
  needsConfirmation: boolean;
  reason: string;
}

/**
 * 이 모드에서 이 주문을 어떻게 처리할 것인가.
 *
 * 다른 모든 검사를 통과했어도 여기서 막히면 나가지 않는다.
 * 모드는 가장 바깥 관문이다.
 */
export interface GateOptions {
  /**
   * 계좌 자산(USD). 비율 상한을 계산할 때만 쓴다.
   * **모르면 주지 말 것** — 0을 주면 비율 상한이 0이 되어 전부 막힌다.
   */
  equityUsd?: number | null;
  /** 환경변수 등으로 명시적으로 올린 절대 상한(USD) */
  overrideMaxNotionalUsd?: number | null;
}

/**
 * 이 모드에서 이 주문의 명목가 상한은 얼마인가. null이면 상한 없음.
 *
 * 고정 금액과 자산 비율 중 **큰 쪽**을 쓴다. 작은 계좌는 고정 금액이
 * 지켜 주고, 계좌가 커지면 비율이 따라 올라간다. 사용자가 상한을 손으로
 * 올리게 만들면 그 상한은 결국 꺼진다.
 */
export function notionalCapOf(mode: OperatingMode, opts?: GateOptions): number | null {
  const cap = CAP[mode];
  if (cap.maxNotionalUsd === null) return null;

  const candidates: number[] = [cap.maxNotionalUsd];

  const eq = Number(opts?.equityUsd);
  if (cap.maxNotionalPctOfEquity != null && Number.isFinite(eq) && eq > 0) {
    candidates.push(eq * (cap.maxNotionalPctOfEquity / 100));
  }

  const ov = Number(opts?.overrideMaxNotionalUsd);
  if (Number.isFinite(ov) && ov > 0) candidates.push(ov);

  // UI_DEMO의 0은 '상한 0'이 맞다. 0을 max로 밀어 올리면 안 되므로
  // 후보가 하나뿐일 때는 그대로 둔다.
  return Math.max(...candidates);
}

export function gateOrder(
  mode: OperatingMode,
  notionalUsd: number,
  opts?: GateOptions,
): OrderGate {
  const cap = CAP[mode];

  if (mode === 'UI_DEMO') {
    return { disposition: 'BLOCK', live: false, needsConfirmation: false,
      reason: 'UI 데모 모드에서는 주문을 만들지 않습니다' };
  }

  if (!cap.sendsOrders) {
    return {
      disposition: cap.recordsIntent ? 'RECORD' : 'BLOCK',
      live: false, needsConfirmation: false,
      reason: mode === 'SHADOW_LIVE'
        ? 'Shadow Live — 판단은 마쳤으나 주문은 보내지 않고 기록합니다'
        : '모의 모드 — 거래소로 보내지 않습니다',
    };
  }

  // 상한은 권고가 아니라 강제다. 넘으면 보내지 않는다.
  const limit = notionalCapOf(mode, opts);
  if (limit !== null && notionalUsd > limit) {
    const eq = Number(opts?.equityUsd);
    const byPct = cap.maxNotionalPctOfEquity != null && Number.isFinite(eq) && eq > 0
      && eq * (cap.maxNotionalPctOfEquity / 100) >= limit;
    return {
      disposition: 'BLOCK', live: cap.realMoney, needsConfirmation: false,
      reason: `${cap.label}의 1회 상한 $${limit.toFixed(2)}를 넘습니다 `
        + `(요청 $${notionalUsd.toFixed(2)})`
        + (byPct ? ` — 자산 $${eq.toFixed(2)}의 ${cap.maxNotionalPctOfEquity}%` : ''),
    };
  }

  return {
    disposition: 'SEND',
    live: cap.realMoney,
    needsConfirmation: cap.realMoney && !cap.autoTrade,
    reason: cap.realMoney ? `${cap.label} — 실제 자금이 사용됩니다` : `${cap.label}`,
  };
}

/**
 * 기존 코드가 쓰던 PAPER/TESTNET/LIVE로 되돌린다.
 *
 * executeOrder와 거래소 호출은 아직 이 세 값만 안다. 사다리를 한 번에
 * 전부 갈아엎기보다, 경계에서만 변환한다.
 * SHADOW_LIVE는 주문을 보내지 않으므로 여기로 오지 않아야 한다 —
 * 실수로 오면 가장 안전한 PAPER로 떨어뜨린다.
 */
export function fromLegacyMode(raw: string | null | undefined): OperatingMode {
  const s = String(raw || '').toUpperCase();
  if (s === 'PAPER') return 'PAPER';
  if (s === 'TESTNET') return 'TESTNET';
  // 예전 'LIVE'는 상한도 확인도 없었다. 사다리에서 가장 좀은 실자금
  // 단계로 보낸다. 이러면 기존 호출이 갑자기 $100 상한과 사람 확인을
  // 만나게 되는데, 상한 없는 자동 실거래보다는 그쪽이 맞다.
  if (s === 'LIVE') return 'LIVE_SMALL';
  return parseMode(raw);
}

/**
 * **이 주문이 실제로 어디로 나가는가**를 기준으로 모드를 정한다.
 *
 * 왜 필요한가
 * ───────────
 * 수동 선물 주문 경로는 이랬다:
 *
 *   목적지(실제 돈인가) ← 연결의 is_testnet
 *   상한·사람 확인      ← NEXT_PUBLIC_APP_MODE 환경변수
 *
 * **둘이 서로 모른다.** 테스트넷으로 며칠 돌리다가 실전 연결을 고르면,
 * 주문은 fapi(실제 돈)로 나가는데 관문은 여전히 TESTNET이라 $100 상한도
 * 사람 확인도 안 걸린다. 환경변수를 바꾸는 것을 잊는 순간 그렇게 된다 —
 * 그리고 그 실수는 실제 돈으로만 드러난다.
 *
 * 그래서 **목적지가 실계좌면 모드를 최소 LIVE_SMALL로 올린다.**
 *
 * 내리지는 않는다
 * ───────────────
 * 이미 실자금 단계(LIVE_LIMITED 등)면 그대로 둔다. 테스트넷 목적지에
 * 대해서도 낮추지 않는다 — UI_DEMO로 잠가 둔 것을 이 함수가 풀어 주면
 * 잠근 이유가 사라진다. **오직 조이는 방향으로만 움직인다.**
 */
export function modeForDestination(
  envMode: OperatingMode,
  isLiveDestination: boolean,
): OperatingMode {
  if (!isLiveDestination) return envMode;
  // 실계좌인데 실자금 단계가 아니면 가장 좁은 실자금 단계로 올린다.
  return CAP[envMode].realMoney ? envMode : 'LIVE_SMALL';
}

export function toLegacyMode(mode: OperatingMode): 'PAPER' | 'TESTNET' | 'LIVE' {
  if (mode === 'TESTNET') return 'TESTNET';
  if (mode === 'LIVE_SMALL' || mode === 'LIVE_LIMITED') return 'LIVE';
  return 'PAPER';
}
