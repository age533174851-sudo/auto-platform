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
  maxPortfolioPct: 100,               // 슬롯 시스템이 별도로 통제
  riskPercentPerTrade: 10,            // 슬롯 1개 = 자산의 10%
  takeProfitPct: 1.5,
  stopLossPct: 0.5,                   // 기본 손절 (신호가 주면 그것 사용)
  orderType: 'market',
  timeoutSec: 30,
  dailyLossLimitPct: 30,              // 하루 -30%면 전략 정지 (슬롯 3개 소진 수준)
  maxHoldSec: 14400,                  // 4시간
  maxOpenPositions: 1,                // 동시 1개만 (슬롯 순차 사용)
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
