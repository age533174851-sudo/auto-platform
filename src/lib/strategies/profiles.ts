// src/lib/strategies/profiles.ts
// 전략 프로필 프리셋 — 고위험 단타(Scalp) / 저위험 스윙(Swing)
// 각 프로필은 leverage·리스크·주문타입·손절익절·일손실한도를 독립 소유한다.
// 주문 생성 시 규칙 엔진(ruleEngine)이 이 프로필을 참조해 파라미터를 강제 적용/clamp 한다.

export type StrategyType =
  | 'SCALP_HIGH_LEV' | 'SWING_LOW_LEV' | 'DAILY_HIGH_LEV'
  /**
   * **전용 100배.** 기존 세 개와 이름 규칙이 다른 이유가 있다.
   *
   * 나머지 셋은 `<시간축>_<위험등급>_LEV`다. 이것은 시간축도 위험등급도
   * 아니라 **정확배율·무고정손절 실행 모드**다. 같은 접미사를 쓰면
   * "그 가족의 네 번째"로 읽히고, 그 오해가 정확히 이 프로필이 없애려는
   * 것이다 — 상한 100배(레거시)와 실제 100배 고정(이것)은 다른 물건이다.
   */
  | 'MAX_LEV_100X';

/**
 * 고정 손절을 쓰는가.
 *
 * **이것이 축인 이유**: 100배 전용은 고정 손절을 쓰지 않는데, 그것을
 * `stopLossPct: 0`이나 `0.5` 같은 숫자로 흉내내면 그 숫자가 어딘가에서
 * 진짜 손절로 읽힌다. 숫자가 아니라 **정책**으로 적어야 주문 경로가
 * 그것을 정책으로 다룬다.
 *
 *   FIXED_SL     — 진입과 함께 고정 손절(STOP_MARKET / 조건부)을 건다
 *   NO_FIXED_SL  — 고정 손절을 아예 걸지 않는다. `stopLossPct`는 null이다
 */
export type StopPolicy = 'FIXED_SL' | 'NO_FIXED_SL';
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
  /**
   * 고정 손절 폭(%).
   *
   * **`stopPolicy === 'NO_FIXED_SL'`이면 반드시 `null`이다.** 0도 아니고
   * 0.5도 아니다 — 없는 손절에 숫자를 적어 두면 그 값이 사이징의 분모나
   * 복구 경로의 손절가로 되살아난다. 없는 것은 없다고 적는다.
   */
  stopLossPct:     number | null;
  /** 고정 손절을 쓰는가. `stopLossPct`와 짝이다 (아래 불변식) */
  stopPolicy:      StopPolicy;
  /**
   * 1회 주문에 배정할 **증거금 비율(%)** — 가용 잔고 대비.
   *
   * 손절 거리에서 수량을 역산할 수 없는 프로필(NO_FIXED_SL)이 쓴다.
   * **`null`이면 "정하지 않았다"이고, 그 상태에서는 주문하지 않는다.**
   * 0으로 눕히면 수량 0이 되고, 기본값을 빌려 오면 사용자가 고른 적 없는
   * 크기로 100배가 나간다.
   */
  marginAllocationPct: number | null;
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
  const s = p.simHoldSec ?? 0;
  if (s > 0) return s;
  if (p.maxHoldSec > 0) return p.maxHoldSec;
  return 86400;
}

/** 모의 시드. 통화는 simCurrency가 정한다. */
export function simSeedOf(p: StrategyProfile): number {
  const s = p.simSeed ?? 0;
  return s > 0 ? s : 10_000_000;
}

/** 모의 체결가. */
export function simPriceOf(p: StrategyProfile): number {
  const s = p.simPrice ?? 0;
  if (s > 0) return s;
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
  // 기존 셋은 전부 고정 손절 전략이다. 의미가 바뀌지 않는다.
  stopPolicy: 'FIXED_SL',
  // 손절 거리에서 수량을 역산하므로 증거금 비율을 따로 배정하지 않는다.
  marginAllocationPct: null,
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
  // 기존 셋은 전부 고정 손절 전략이다. 의미가 바뀌지 않는다.
  stopPolicy: 'FIXED_SL',
  // 손절 거리에서 수량을 역산하므로 증거금 비율을 따로 배정하지 않는다.
  marginAllocationPct: null,
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
  // 기존 셋은 전부 고정 손절 전략이다. 의미가 바뀌지 않는다.
  stopPolicy: 'FIXED_SL',
  // 손절 거리에서 수량을 역산하므로 증거금 비율을 따로 배정하지 않는다.
  marginAllocationPct: null,
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

// ── 프리셋 D: 전용 100배 (고정 손절 없음) ───────────────────
//
// **레거시 "상한 100배"와 다른 물건이다.**
//
// 지금까지 화면의 `levCap=100`은 *상한*이었다. 실제 배율은 손절 거리에서
// 역산되고 그 상한에서 잘렸다 — 손절 0.5%면 75배, 1%면 50배. 100배가
// 실제로 나가려면 손절이 0.26% 안쪽이어야 해서 **사실상 선택되지 않았다.**
// 그런데 화면에는 "100배"라고 적혀 있었다. 적힌 것과 나가는 것이 달랐다.
//
// 이 프로필은 그 구조를 쓰지 않는다:
//
//   · 요청 배율이 **정확히 100**이다. 상한이 아니다
//   · 거래소에 설정한 뒤 **되읽어서 100인지 확인**하고, 99·75·모름이면
//     주문하지 않는다 (`futuresApplyLeverage` → `leverageVerdict`)
//   · 고정 손절을 **걸지 않는다**(`NO_FIXED_SL`). 그래서 손절 거리에서
//     수량을 역산할 수 없고, 증거금 비율로 크기를 정한다
//   · `marginAllocationPct`는 아직 **정해지지 않았다(null)**. 그 상태에서는
//     사이징이 막는다 — 기본값을 빌려 오지 않는다
//
// **이 프로필이 있다고 100배가 안전해지지는 않는다.** 100배의 청산 거리는
// 대략 0.6~1%다. 이것이 보장하는 것은 하나뿐이다 — 화면에 100배라고
// 적혀 있으면 거래소에도 100배가 걸려 있고, 아니면 주문이 나가지 않는다.
export const MAX_LEV_100X: StrategyProfile = {
  id: 'MAX_LEV_100X',
  label: '전용 100배 (고정 손절 없음)',
  description:
    '요청 배율이 정확히 100배다. 거래소에 되읽어 100이 확인될 때만 주문한다(99·75·모름이면 중단). '
    + '고정 손절을 걸지 않으므로 수량은 손절 거리가 아니라 명시적 증거금 배정에서 나온다. '
    + 'ISOLATED 강제. 증거금 배정이 정해지기 전에는 주문하지 않는다.',
  // **상한이 아니라 요청값이다.** 둘을 같게 두어 "100까지 허용"과
  // "정확히 100"이 갈릴 자리를 없앤다.
  leverage: 100,
  maxLeverage: 100,
  marginModes: ['isolated'],          // Cross 금지 — 100배 손실이 지갑 전체로 번진다
  maxPortfolioPct: 10,
  // 손절 거리 기반 사이징을 타지 않으므로 이 값은 크기를 정하지 않는다.
  // 다른 한도(전체 동시 위험 등)와 같은 단위를 유지하려고 남긴다.
  riskPercentPerTrade: 10,
  takeProfitPct: 1.5,
  // **고정 손절 없음.** 숫자를 적지 않는다 — 위 stopLossPct 주석 참조.
  stopLossPct: null,
  stopPolicy: 'NO_FIXED_SL',
  // **아직 정해지지 않았다.** 숫자를 여기서 지어내지 않는다. null이면
  // 사이징이 BLOCK하고, 그래서 이 프로필은 구현되어 있어도 주문을 내지
  // 못한다 — 의도된 상태다.
  marginAllocationPct: null,
  orderType: 'market',
  timeoutSec: 30,
  dailyLossLimitPct: 30,
  maxHoldSec: 14400,                  // 4시간
  maxOpenPositions: 1,

  // 모의 전용 (거래소에 나가지 않는다)
  simCurrency: 'USD',
  simSeed: 1_000,
  simTargetEquity: 100_000,
  simPrice: 100_000,
};

export const PROFILES: Record<StrategyType, StrategyProfile> = {
  SCALP_HIGH_LEV: SCALP_HIGH_LEV,
  SWING_LOW_LEV: SWING_LOW_LEV,
  DAILY_HIGH_LEV: DAILY_HIGH_LEV,
  MAX_LEV_100X: MAX_LEV_100X,
};

export function getProfile(type: StrategyType): StrategyProfile {
  return PROFILES[type] ?? SWING_LOW_LEV;
}

/**
 * `stopPolicy`와 `stopLossPct`의 짝이 맞는가 — **어긋난 프로필의 목록.**
 *
 * 왜 함수로 두는가: 이 판단이 필요한 곳이 셋이다(시험 · CI 검사기 ·
 * 사이징). 세 곳에 따로 적으면 언젠가 한 곳만 고쳐지고, 그때
 * `NO_FIXED_SL`인데 손절 숫자가 남아 있는 프로필이 통과한다.
 *
 * 비어 있으면 정상이다.
 */
export function stopPolicyInvariantErrors(): string[] {
  const out: string[] = [];
  for (const p of Object.values(PROFILES)) {
    if (p.stopPolicy === 'NO_FIXED_SL') {
      if (p.stopLossPct !== null) {
        out.push(`${p.id}: NO_FIXED_SL인데 stopLossPct가 ${p.stopLossPct}입니다 — null이어야 합니다`);
      }
    } else if (!(Number(p.stopLossPct) > 0)) {
      out.push(`${p.id}: FIXED_SL인데 stopLossPct가 ${String(p.stopLossPct)}입니다 — 0보다 커야 합니다`);
    }
  }
  return out;
}

export function listProfiles(): StrategyProfile[] {
  return [SCALP_HIGH_LEV, SWING_LOW_LEV, DAILY_HIGH_LEV, MAX_LEV_100X];
}

/**
 * **모의 성적표를 낼 수 있는 프로필만.**
 *
 * 모의 모델(`simModel`)은 고정 익절·손절 한 쌍에서 손익비를 구하고 그
 * 손익비에서 무우위 승률을 낸다. 고정 손절이 없는 프로필에는 그 분모가
 * 없다 — `noEdgeWinRate`는 그때 0.5를 돌려주는데, 그건 "반반"이라는
 * **관측이 아니라 자리 채우기**다.
 *
 * 그 숫자로 성적표를 그리면 화면에는 근거 없는 기대값이 뜬다. 이 저장소가
 * 반복해서 없애 온 것이 정확히 그것이라, 모의 목록에서 뺀다. 실행 계약은
 * 그대로 있다 — **모의를 못 하는 것과 실행을 못 하는 것은 다른 얘기다.**
 */
export function simulatableProfiles(): StrategyProfile[] {
  return listProfiles().filter(p => p.stopPolicy === 'FIXED_SL');
}
