// src/lib/strategies/profiles.ts
// 전략 프로필 프리셋 — 고위험 단타(Scalp) / 저위험 스윙(Swing)
// 각 프로필은 leverage·리스크·주문타입·손절익절·일손실한도를 독립 소유한다.
// 주문 생성 시 규칙 엔진(ruleEngine)이 이 프로필을 참조해 파라미터를 강제 적용/clamp 한다.

export type StrategyType = 'SCALP_HIGH_LEV' | 'SWING_LOW_LEV' | 'DAILY_HIGH_LEV';
export type MarginMode   = 'isolated' | 'cross';
export type OrderType    = 'post_only_limit' | 'limit' | 'market';

export interface StrategyProfile {
  id:              StrategyType;
  label:           string;
  description:     string;
  // 레버리지
  leverage:        number;   // 기본 레버리지
  maxLeverage:     number;   // 하드 상한 (AI/신호가 이 이상 요구해도 clamp)
  marginModes:     MarginMode[];   // 허용 마진 모드 (첫 번째가 기본)
  // 자금/리스크
  maxPortfolioPct: number;   // 이 전략이 쓸 수 있는 전체 자산 비중 상한 (%)
  riskPercentPerTrade: number; // 1회 트레이드에서 감수할 자산 위험 (%) — 수량 산출 기준
  // 손절/익절 (%)
  takeProfitPct:   number;
  stopLossPct:     number;   // 필수 — 0 금지
  // 주문
  orderType:       OrderType;
  timeoutSec:      number;   // 지정가 미체결 시 취소까지 (0 = 무제한)
  // 안전장치
  dailyLossLimitPct: number; // 이 전략 계좌의 하루 손실 한도 (%) → 초과 시 프로필 킬스위치
  maxHoldSec:      number;   // 최대 보유시간 (초) — 초과 시 청산 고려 (0 = 무제한)
  maxOpenPositions: number;

  // ── 모의 시뮬 전용 칸 ────────────────────────────────────
  // 아래 값은 **거래소에 나가지 않는다.** 성적표 화면(StrategyProfilesPanel)이
  // 모의 계좌를 돌릴 때만 쓴다. 실주문 경로는 이 칸을 읽지 않는다.

  /** 모의 계좌 통화. 없으면 KRW. */
  simCurrency?:    'KRW' | 'USD';
  /** 모의 시드. 없으면 기본값(1천만원). */
  simSeed?:        number;
  /** **이 금액에 닿으면 한 회차가 끝난다.** 없으면 목표 없음(횟수로만 돈다). */
  simTargetEquity?: number;
  /** 모의 체결가. 통화에 맞는 값이어야 수량이 말이 된다. */
  simPrice?:       number;
  /**
   * 한 건이 잡아먹는 **모의 시간**(초).
   *
   * 이게 왜 필요한가: 하루 손실 한도는 '하루'가 있어야 리셋된다. 그런데
   * 시뮬 1000건은 실제로는 1초 만에 끝나서 벽시계로는 전부 같은 날이다.
   * 그러면 12건쯤에서 한도가 차고 영영 안 풀린다 — 실제로는 며칠에 걸쳐
   * 나눠 일어날 일인데도. 그래서 모의 시계를 따로 돌린다.
   *
   * 없으면 maxHoldSec을 쓰고, 그것도 0(무제한)이면 하루로 친다.
   */
  simHoldSec?:     number;
  /** 테이커 수수료(한쪽, 명목가 대비 %). 없으면 바이낸스 선물 기본 0.045. */
  takerFeePct?:    number;
}

/** 모의 한 건이 잡아먹는 시간. 무제한 보유 프로필은 '한 건 = 하루'로 가정한다. */
export function simHoldSecOf(p: StrategyProfile): number {
  if (p.simHoldSec > 0) return p.simHoldSec;
  if (p.maxHoldSec > 0) return p.maxHoldSec;
  return 86400;
}

/** 모의 시드. 통화는 simCurrency가 정한다. */
export function simSeedOf(p: StrategyProfile): number {
  return p.simSeed > 0 ? p.simSeed : 10_000_000;
}

/** 모의 체결가. */
export function simPriceOf(p: StrategyProfile): number {
  if (p.simPrice > 0) return p.simPrice;
  return p.simCurrency === 'USD' ? 100_000 : 140_000_000;
}

// ── 프리셋 A: 고위험 단타 ──────────────────────────────────
// 소액·고배율·지정가(Post-only)·타임아웃 취소·타이트 TP/SL·빡센 일손실 한도
export const SCALP_HIGH_LEV: StrategyProfile = {
  id: 'SCALP_HIGH_LEV',
  label: '스캘핑 (고배율 단타)',
  description: '전체 자산의 일부만, 20~50배, isolated + Post-only 지정가. 타임아웃 취소. 타이트한 익절/손절, 하루 손실 한도 빡세게.',
  leverage: 25,
  maxLeverage: 50,
  marginModes: ['isolated'],          // isolated only
  maxPortfolioPct: 10,                // 전체 자산의 5~10%만
  riskPercentPerTrade: 0.5,           // 1회 위험 0.5%
  takeProfitPct: 0.6,                 // 타이트
  stopLossPct: 0.3,                   // 타이트 (필수)
  orderType: 'post_only_limit',       // Post-only 지정가
  timeoutSec: 20,                     // 20초 미체결 시 취소
  dailyLossLimitPct: 2,               // 하루 -2%면 이 전략 정지
  maxHoldSec: 900,                    // 15분 이상 보유 금지
  maxOpenPositions: 2,
  simCurrency: 'KRW',
};

// ── 프리셋 B: 저위험 스윙 ──────────────────────────────────
// 큰 금액·저배율·넓은 TP/SL·긴 보유·추세 추종
export const SWING_LOW_LEV: StrategyProfile = {
  id: 'SWING_LOW_LEV',
  label: '스윙 (저배율 추세)',
  description: '큰 금액, 3~5배, isolated/cross 선택. 넓은 익절/손절, 며칠~몇 주 보유. 추세 추종 웹훅에 적합.',
  leverage: 4,
  maxLeverage: 5,
  marginModes: ['isolated', 'cross'], // 선택 가능 (기본 isolated)
  maxPortfolioPct: 40,                // 전체 자산의 30~40%
  riskPercentPerTrade: 2,             // 1회 위험 2% (넓은 손절 반영)
  takeProfitPct: 12,                  // 넓게
  stopLossPct: 6,                     // 넓게 (필수)
  orderType: 'limit',
  timeoutSec: 0,                      // 무제한 (스윙은 급하지 않음)
  dailyLossLimitPct: 8,              // 하루 -8%면 정지
  maxHoldSec: 0,                      // 무제한 보유
  maxOpenPositions: 4,
  simCurrency: 'KRW',
  // 무제한 보유라 실제 소요 시간을 알 수 없다. 시뮬에서는 **가정**을 하나
  // 세워야 모의 시계가 돈다 — 설명대로 '며칠~몇 주' 중 짧은 쪽인 3일.
  // 화면에는 이게 가정이라고 적는다.
  simHoldSec: 259_200,                // 3일 (가정)
};

// ── 프리셋 C: 10슬롯 격리 고배율 ──────────────────────────
// 시작 자산을 10등분해 슬롯당 1회씩만 승부. 각 포지션 ISOLATED 강제.
//
// 중요: maxLeverage 100은 "목표"가 아니라 "절대 상한"이다.
// 실제 배율은 손절 거리에서 역산된다 (riskManager). 계산 결과:
//   손절 0.5% → 최대 75배 / 손절 1.0% → 최대 50배 / 손절 2.0% → 최대 30배
//   100배를 쓰려면 손절이 0.26% 안쪽이어야 하는데, 이는 BTC 노이즈 수준이라
//   진입 직후 손절될 가능성이 높다. 즉 100배는 사실상 선택되지 않는다.
export const DAILY_HIGH_LEV: StrategyProfile = {
  id: 'DAILY_HIGH_LEV',
  label: '10슬롯 격리 (고배율)',
  description: '시작 자산 ÷ 10 = 슬롯 1개. 슬롯당 하루 1회, 최대 10회. ISOLATED 강제, Cross 금지. 배율은 손절 거리에서 역산(상한 100배).',
  leverage: 10,                       // 기본값 — 실제로는 손절 거리에서 역산
  maxLeverage: 100,                   // 절대 상한 (도달 조건이 매우 까다로움)
  marginModes: ['isolated'],          // Cross 금지 — 다른 슬롯 자금이 끌려가면 안 됨
  // **슬롯 1개 = 자산의 10%.** 여기가 100이면 증거금 상한이 계좌 전액이 되고,
  // 그러면 한 번에 계좌 전부를 걸 수 있다 — '10등분'이 아니게 된다.
  // 10으로 묶어야 규칙 엔진이 산출한 증거금이 슬롯 한 칸을 넘지 못한다.
  maxPortfolioPct: 10,
  riskPercentPerTrade: 10,            // 슬롯 1개 = 자산의 10%
  takeProfitPct: 1.5,
  stopLossPct: 0.5,                   // 기본 손절 (신호가 주면 그것 사용)
  orderType: 'market',
  timeoutSec: 30,
  dailyLossLimitPct: 30,              // 하루 -30%면 전략 정지 (슬롯 3개 소진 수준)
  maxHoldSec: 14400,                  // 4시간
  maxOpenPositions: 1,                // 동시 1개만 (슬롯 순차 사용)

  // ── 모의: $1,000으로 시작해서 $100,000에 닿으면 한 회차 끝 ──
  // 실제 계획과 같은 숫자를 쓴다. 시드 1000불, 목표 10만불.
  simCurrency: 'USD',
  simSeed: 1_000,
  simTargetEquity: 100_000,
  simPrice: 100_000,
};

export const PROFILES: Record<StrategyType, StrategyProfile> = {
  SCALP_HIGH_LEV: SCALP_HIGH_LEV,
  SWING_LOW_LEV: SWING_LOW_LEV,
  DAILY_HIGH_LEV: DAILY_HIGH_LEV,
};

export function getProfile(type: StrategyType): StrategyProfile {
  return PROFILES[type] ?? SWING_LOW_LEV;
}

export function listProfiles(): StrategyProfile[] {
  return [SCALP_HIGH_LEV, SWING_LOW_LEV, DAILY_HIGH_LEV];
}
