// src/lib/engine/entry100x.ts
//
// **전용 100배의 진입 계획 — 거래소를 실제로 물어본 값으로만 만든다.**
//
// 이 파일이 있는 이유
// ───────────────────
// `sizing100x.planSize100x`는 순수 계산이다. 그 앞에 "무엇을 물어봐서
// 어떤 순서로 확인하는가"가 있어야 실제 주문이 나가는데, 그것을 라우트
// 안에 인라인으로 쓰면 두 가지가 동시에 나빠진다.
//
//   · 라우트는 시험에서 돌릴 수 없다(네트워크·DB·인증이 붙어 있다).
//     그래서 **가장 중요한 순서가 시험되지 않는 자리에 남는다**
//   · 다른 라우트가 같은 진입을 하려면 그 순서를 복제하게 된다.
//     이 저장소에서 반복된 고장이 정확히 그것이다
//
// 그래서 **의존을 주입받는다.** 실제 라우트는 거래소 모듈을 물려 주고,
// 시험은 가짜 어댑터를 물려 준다. 판단하는 코드는 한 벌이다.
//
// 순서가 계약의 일부다
// ────────────────────
//   PHASE A — 읽고 계산만 한다
//   ① 마진 모드를 되읽는다      cross거나 모르면 여기서 멈춘다
//   ② 배정 비율을 검증한다      거래소에 물어볼 것이 없다
//   ③ 가용 잔고를 읽는다        못 읽으면 멈춘다 (0으로 눕히지 않는다)
//   ④ 기준 마크가를 **관측**한다 값·출처·거래소 시각·수신 시각·캐시
//   ⑤ 크기를 만든다             planSize100x
//   ⑥ 거래소 규격으로 다듬는다   수량 단위·최소 주문
//   ⑦ 필요 증거금을 다시 잰다    다듬느라 배정을 넘었으면 멈춘다
//   ⑧ 브래킷·변동성 거리를 읽는다
//   ⑨ 수수료·호가·펀딩을 읽는다
//   ⑩ **시장 데이터 신선도**     언제의 값인지 모르면 여기서 멈춘다
//   ⑪ 청산거리 (RAW)
//   ⑫ 실행·보유 비용
//   ⑬ 비용을 반영한 청산거리 (EFFECTIVE)
//   PHASE B — 여기서 처음으로 거래소에 쓴다 (배율 설정·되읽기)
//
// ⑩이 ⑪·⑫보다 앞인 이유: 낡은 값으로 계산한 "여유 0.59%"는 틀린
// 전제 위에 선 숫자다. 그 숫자가 통과하면 아무도 그것이 몇 초 전
// 시장이었는지 묻지 않는다. **읽기를 전부 끝낸 뒤** 보는 이유는, 서로
// 다른 시점을 하나의 현재 시장 상태로 합쳤는지는 전부 모여야 알 수
// 있기 때문이다.
//
// ⑦이 필요한 이유: 거래소 수량 단위는 올림이 될 수 있다. 0.001 단위에서
// 0.0007이 0.001이 되면 명목가가 배정보다 커지고, 그 차이는 100배에서
// 그대로 증거금 초과가 된다. 다듬은 **뒤에** 다시 재야 한다.

import {
  planSize100x, validateMarginAllocation, verifyLeverageExact,
  type Sizing100xVerdict,
} from './sizing100x';
import {
  assessLiquidationDistance, type LiquidationDistanceAssessment,
} from './liquidationDistance';
import {
  assessExecutionCost, effectiveMarginAfterCost,
  type ExecutionCostAssessment, type CommissionRates, type DepthBook,
  type FundingContext, type OrderFillKind,
} from './executionCost';
import {
  assessMarketFreshness, type MarketFreshnessAssessment,
  type MarketObservation, type ObservationCache, type ObservationKind,
} from './marketFreshness';
import type { BracketTier } from '../safety/liquidationPrice';

export type Entry100xCode =
  | 'OK'
  /**
   * 시장 데이터가 **언제의 값인지 모르거나 지금 시장이 아니다.**
   *
   * 값이 없어서가 아니라 **시각이 없거나 낡아서** 막은 것이다. 둘은
   * 다른 고장이라 코드를 나눈다.
   *
   * **진입 전 보호다.** 이미 열린 포지션을 닫는 권한이 아니다.
   */
  | 'MARKET_DATA_STALE'
  /**
   * 청산거리를 신뢰할 수 없거나 계약이 요구하는 여유가 없다.
   *
   * **진입 전 보호다.** 이미 열린 포지션을 닫는 권한이 아니다.
   */
  | 'LIQUIDATION_UNSAFE'
  /**
   * 실행·보유 비용을 확정하지 못했다 (수수료·호가·펀딩).
   *
   * **진입 전 보호다.** 비용을 모르면 실질 여유를 말할 수 없다.
   */
  | 'COST_UNKNOWN'
  /**
   * 비용을 빼면 청산 여유가 계약을 만족하지 못한다.
   *
   * RAW는 통과했는데 여기서 막히는 경우가 이 코드다.
   */
  | 'LIQUIDATION_UNSAFE_AFTER_COST'
  /** 이 계약은 증거금 배정 사이징이 아니다 — 호출부가 잘못 불렀다 */
  | 'NOT_MARGIN_ALLOCATION'
  /** 마진 모드를 읽지 못했다 */
  | 'MARGIN_MODE_UNKNOWN'
  /** 거래소 마진 모드가 격리가 아니다 */
  | 'MARGIN_MODE_NOT_ISOLATED'
  /** 배율 설정·되읽기가 요청값과 다르다 */
  | 'LEVERAGE_NOT_EXACT'
  /** 수량 계산 단계에서 막혔다 (사유는 sizing이 갖고 있다) */
  | 'SIZING_BLOCKED'
  /** 거래소 규격으로 다듬지 못했다 */
  | 'QUANTIZE_FAILED'
  /** 다듬은 수량의 필요 증거금이 배정을 넘었다 */
  | 'MARGIN_EXCEEDED';

/**
 * **거래소 상태를 바꾸는 의존.**
 *
 * 왜 목록으로 두는가: 지금은 배율 설정 하나뿐이지만, 나중에 마진 모드
 * setter 같은 쓰기가 하나 더 붙으면 "차단될 요청이 거래소를 건드렸다"는
 * 같은 결함이 조용히 되살아난다. 그때 시험이 옛 이름 하나만 세고 있으면
 * 아무도 모른다.
 *
 * 그래서 **모든 의존을 읽기/쓰기로 분류해 둔다.** 검사기가 인터페이스의
 * 칸 이름과 이 두 목록을 대조해서, 분류되지 않은 의존이 생기면 실패시킨다.
 */
export const MUTATING_DEPS = ['applyLeverage'] as const;

/** 거래소를 읽기만 하는 의존 */
export const READONLY_DEPS = [
  'observeMarginMode', 'availableUsd', 'referenceMark', 'quantize',
  'maintenanceTiers', 'adverseDistancePct',
  'commissionRates', 'orderBookDepth', 'fundingContext',
] as const;

/**
 * **읽기 단계가 쓸 수 있는 의존.** 쓰기 함수가 아예 들어 있지 않다.
 *
 * 이것이 이 파일에서 가장 중요한 줄이다. 순서를 주석이나 줄 위치로
 * 지키면 언젠가 뒤집힌다 — 실제로 뒤집혀 있었다. `prepareEntry100x`가
 * 이 타입만 받으면, 그 안에서 배율을 거는 코드는 **타입이 없어서**
 * 쓸 수 없다. 순서가 규칙이 아니라 구조가 된다.
 */
/**
 * **기준 마크가 관측.** 값과 "언제의 값인가"를 함께 들고 다닌다.
 *
 * `binanceFutures.readMarketSnapshot`이 돌려주는 모양이다. 여기서 따로
 * 선언하는 이유는 엔진이 거래소 모듈에 의존하지 않기 위해서다 —
 * 시험은 가짜 어댑터를 물려 준다.
 *
 * ★ **같은 스냅숏이 펀딩 입력에도 쓰여야 한다.** 마크가와 premium을
 *   따로 읽으면 청산거리는 T0, 펀딩은 T1로 계산된다 — ④가 막으려는
 *   바로 그 모양이다. 공유는 호출부(라우트)의 일이고, 검사기가 그것을
 *   확인한다.
 */
export interface ReferenceMarkObservation {
  /** 마크가. 못 읽었으면 null */
  price: number | null;
  /** 거래소가 적어 준 시각. 없으면 null — **지어내지 않는다** */
  exchangeTimeMs: number | null;
  /** 우리 서버가 응답을 **실제로 받은** 시각 */
  receivedAtMs?: number | null;
  /** 이 값이 **원래 관측된** 시각. 캐시가 없으면 수신 시각과 같다 */
  observedAtMs: number | null;
  source: string | null;
  cache: ObservationCache | null;
}

/** 유지증거금 구간 관측. 표와 **언제 읽었는지**를 함께 받는다 */
export interface BracketObservation {
  tiers: BracketTier[] | null;
  observedAtMs: number | null;
  freshness: ObservationCache | null;
}

export interface Entry100xReadDeps {
  /** 이 심볼의 거래소 마진 모드. **못 읽으면 null** */
  observeMarginMode(): Promise<'isolated' | 'cross' | null>;
  /** 주문에 쓸 수 있는 잔고(USD). **못 읽으면 null** */
  availableUsd(): Promise<number | null>;
  /**
   * **기준 마크가 관측.** 숫자 하나가 아니다.
   *
   * 예전에는 `Promise<number | null>`이었고, 그 값은 `positionRisk`
   * 응답에서 떼어 온 것이었다. 두 가지가 동시에 잘못돼 있었다.
   *
   *   · **계좌/포지션 상태와 시장 가격을 섞었다.** 그 응답의
   *     `updateTime`은 포지션이 갱신된 시각이지 마크가가 만들어진
   *     시각이 아니다 — 서로의 timestamp가 될 수 없다
   *   · 숫자만 오니 **언제의 값인지 물을 자리가 없었다.** 시각이 없으면
   *     "지금 시장"이라고 말할 근거도 없다
   *
   * 그래서 값·출처·거래소 시각·수신 시각·캐시 상태를 **함께** 받는다.
   * 수신 시각은 읽는 쪽이 채운다 — 여기서 `Date.now()`를 붙일 수 있게
   * 두면 낡은 캐시가 "방금 읽은 값"이 된다.
   */
  referenceMark(): Promise<ReferenceMarkObservation | null>;
  /** 거래소 수량 단위·최소 주문에 맞춘 수량. 못 맞추면 null */
  quantize(qty: number): Promise<{ qty: number | null; message: string }>;
  /**
   * 이 명목가 구간의 **거래소 유지증거금 브래킷**. 못 읽으면 null.
   *
   * 청산가는 구간별 유지증거금률·공제액이 정한다. 추정 표로 때우면
   * 100배에서 구간을 한 칸 잘못 짚는 것만으로 청산가가 통째로 달라진다.
   * **못 읽으면 진입을 막는다** — 이 의존이 null을 돌려주는 것은 통과가
   * 아니다.
   */
  maintenanceTiers(notional: number): Promise<BracketObservation | null>;
  /**
   * **예상 adverse/변동성 위험 거리 (%).** 못 구하면 null.
   *
   * ★ 손절 주문이 아니다. `NO_FIXED_SL`에서는 거래소에 손절이 나가지
   *   않는다. 신호가 ATR로 잰 "이 종목이 이 정도는 불리하게 움직인다"는
   *   참고 거리이고, 청산거리가 그보다 먼지 비교하는 데만 쓴다.
   */
  adverseDistancePct(): Promise<number | null>;
  /**
   * **계정의 실제 수수료율.** 못 읽으면 null → 막는다.
   *
   * 기본값 표(`lib/fees.ts`)는 등급·할인·프로모션을 모른다. 100배에서
   * 왕복 수수료는 청산 여유의 상당 부분이라 추정으로 때울 수 없다.
   */
  commissionRates(): Promise<CommissionRates | null>;
  /**
   * **거래소 호가.** 못 읽으면 null → 막는다.
   *
   * 슬리피지는 API가 확정해 주는 값이 아니다. 체결되는 쪽 호가를 수량만큼
   * 먹어 예상 체결가를 구한다 — 임의의 `0.05%` 상수를 만들지 않는다.
   */
  orderBookDepth(): Promise<DepthBook | null>;
  /**
   * **펀딩 정보.** 못 읽으면 null → 막는다. 주기를 8시간으로 박지 않는다.
   */
  fundingContext(): Promise<FundingContext | null>;
}

/** 확정 단계가 쓰는 의존 — 여기에만 쓰기가 있다. */
export interface Entry100xWriteDeps {
  /**
   * 배율을 걸고 **독립적으로 되읽는다.**
   *
   * `futuresApplyLeverage`가 그것이다 — 설정 응답이 아니라 되읽은 값을
   * `observed`로 준다.
   */
  applyLeverage(leverage: number): Promise<{ ok: boolean; observed: number | null; message: string }>;
}

/** 두 단계를 합친 모양 — 검사기가 칸 분류를 대조할 때 쓴다. */
export interface Entry100xDeps extends Entry100xReadDeps, Entry100xWriteDeps {}

export interface Entry100xVerdict {
  ok: boolean;
  code: Entry100xCode;
  quantity: number | null;
  leverage: number | null;
  /** 배정한 증거금(USD) */
  allocatedMargin: number | null;
  /** 다듬은 수량으로 다시 잰 필요 증거금(USD) */
  requiredMargin: number | null;
  referencePrice: number | null;
  marginMode: 'isolated' | 'cross' | null;
  /**
   * 청산거리 판정. **계산했으면 막혔든 통과했든 여기 담긴다** —
   * 화면과 기록이 "얼마로 계산했는데 모자랐다"를 말할 수 있어야 한다.
   */
  liquidation: LiquidationDistanceAssessment | null;
  /**
   * **시장 데이터 신선도 판정.** 계산했으면 막혔든 통과했든 담긴다.
   *
   * 출처별 관측 시각이 여기 그대로 남는다 — 화면과 기록이 "무엇이
   * 몇 ms 전 값이었나"를 말할 수 있어야 한다.
   */
  freshness: MarketFreshnessAssessment | null;
  /** 실행·보유 비용 판정. 계산했으면 막혔든 통과했든 담긴다 */
  cost: ExecutionCostAssessment | null;
  /**
   * **비용을 반영한** 청산거리 판정 (`headroomKind: 'EFFECTIVE'`).
   *
   * `liquidation`(RAW)을 덮어쓰지 않는다 — 둘을 나란히 두어야 비용이
   * 여유를 얼마나 먹었는지 볼 수 있다.
   */
  effectiveLiquidation: LiquidationDistanceAssessment | null;
  message: string;
  /** 무엇을 물어보고 무엇을 얻었는지. 화면과 기록이 같은 말을 하게 한다 */
  notes: string[];
}

const fail = (
  code: Entry100xCode, message: string, notes: string[],
  partial: Partial<Entry100xVerdict> = {},
): Entry100xVerdict => ({
  ok: false, code, quantity: null, leverage: null, allocatedMargin: null,
  requiredMargin: null, referencePrice: null, marginMode: null,
  liquidation: null, freshness: null, cost: null, effectiveLiquidation: null,
  message, notes, ...partial,
});

/**
 * **PHASE A — 읽고 계산만 한다. 거래소에 쓰지 않는다.**
 *
 * 왜 두 단계인가
 * ──────────────
 * 예전에는 한 함수였고 순서가 이랬다:
 *
 *     마진 모드 READ → 배율 WRITE → 잔고 READ → 기준가 READ
 *     → 사이징 → 규격 READ → 다듬기 → 증거금 재검증
 *
 * 배율 설정이 두 번째다. 그런데 그 뒤의 어느 단계에서든 막힐 수 있다 —
 * 잔고를 못 읽거나, 기준가를 못 읽거나, 규격에 못 맞추거나, 다듬은
 * 수량의 증거금이 배정을 넘거나. **그 요청들은 전부 주문 없이 끝나는데,
 * 계좌의 배율은 이미 100배로 바뀐 뒤다.** 그 자리에 다른 포지션이
 * 있었다면 청산가가 함께 움직인다.
 *
 * 주문이 안 나갔다는 것으로는 부족하다. 그래서 **쓰기 없이 판정할 수
 * 있는 것을 전부 여기서 끝낸다.**
 *
 * 이 함수는 `Entry100xReadDeps`만 받는다. 쓰기 함수가 타입에 없으므로
 * 여기에 배율 설정을 넣는 것은 주석 위반이 아니라 **컴파일 오류**다.
 */
export async function prepareEntry100x(
  contract: {
    leverage: number;
    sizingPolicy: string;
    marginModes: string[];
    /**
     * 이번 진입의 방향. **저장된 계약이 아니라 신호가 정한다.**
     *
     * 청산은 LONG이면 아래로, SHORT이면 위로 간다. 방향을 모르면 어느
     * 쪽이 불리한 방향인지 알 수 없어 청산거리를 정의할 수 없다 —
     * 그래서 선택값이 아니라 **필수**다. 빠뜨리면 컴파일이 멈춘다.
     */
    side: 'LONG' | 'SHORT' | null;
    /**
     * 이 주문이 호가를 **먹는** 쪽인가 놓는 쪽인가.
     *
     * 계약의 주문 유형에서 온다 — 시장가면 taker다. **여기서 고르지
     * 않는다.** maker를 임의로 고르면 비용이 실제보다 작게 나온다.
     */
    fillKind: OrderFillKind | null;
    /**
     * 계약이 선언한 최대 보유 시간(초). 펀딩 평가 구간이다.
     *
     * ★ "이 시간에 자동 청산된다"는 뜻이 **아니다.** 그 배선은 아직 없다.
     */
    maxHoldSec: number | null;
  },
  marginAllocationPct: number | null,
  deps: Entry100xReadDeps,
  /** 지금 시각. 시험이 고정할 수 있게 주입받는다 */
  nowMs: () => number = () => Date.now(),
): Promise<Entry100xVerdict> {
  const notes: string[] = [];

  if (contract?.sizingPolicy !== 'MARGIN_ALLOCATION') {
    return fail('NOT_MARGIN_ALLOCATION',
      `이 계약의 사이징 정책은 ${String(contract?.sizingPolicy)}입니다 — 증거금 배정 경로가 아닙니다`,
      notes);
  }

  const req = Number(contract.leverage);

  // ── ① 마진 모드 ──
  //
  // 계약이 허용하는 모드만 통과시킨다. 전용 100배는 격리 전용이라
  // 교차 계좌에서는 여기서 멈춘다.
  let mode: 'isolated' | 'cross' | null = null;
  try { mode = await deps.observeMarginMode(); } catch { mode = null; }
  if (mode == null) {
    return fail('MARGIN_MODE_UNKNOWN',
      '거래소 마진 모드를 읽지 못했습니다 — 모르는 담보 범위로는 주문하지 않습니다', notes);
  }
  notes.push(`마진 모드 ${mode} (되읽음)`);
  const allowed = Array.isArray(contract.marginModes) ? contract.marginModes : [];
  if (!allowed.includes(mode)) {
    return fail('MARGIN_MODE_NOT_ISOLATED',
      `거래소 마진 모드가 ${mode}인데 이 프로필은 ${allowed.join('/') || '(없음)'}만 허용합니다`
      + ' — 담보 범위가 다르면 같은 이름의 다른 전략이 됩니다',
      notes, { marginMode: mode });
  }

  // ── ② 배정 비율 ──
  //
  // 사용자가 넣은 숫자 하나라 거래소에 물어볼 것이 없다.
  const allocBad = validateMarginAllocation(marginAllocationPct);
  if (allocBad) {
    return fail('SIZING_BLOCKED', allocBad.message, notes, { marginMode: mode });
  }

  // ── ③ 잔고 ──
  let avail: number | null = null;
  try { avail = await deps.availableUsd(); } catch { avail = null; }

  // ── ④ 기준 마크가 **관측** ──
  //
  // 숫자 하나를 받지 않는다. 값·출처·거래소 시각·수신 시각·캐시 상태를
  // 함께 받아 "언제의 값인가"를 물을 수 있게 한다.
  let mark: ReferenceMarkObservation | null = null;
  try { mark = await deps.referenceMark(); } catch { mark = null; }
  const markObservation: MarketObservation = {
    kind: 'MARK',
    source: mark?.source ?? null,
    value: mark?.price ?? null,
    exchangeTimeMs: mark?.exchangeTimeMs ?? null,
    receivedAtMs: mark?.receivedAtMs ?? null,
    observedAtMs: mark?.observedAtMs ?? null,
    cache: mark?.cache ?? null,
  };
  // ★ **먼저 알 수 있는 것은 먼저 막는다.**
  //   아래 ⑩에서 전부 모아 한 번 더 보지만, 기준가는 바로 다음 줄의
  //   사이징이 쓴다. 쓸 수 없는 값으로 계산부터 해 놓고 뒤에서 막으면,
  //   그 사이에 끼어든 어떤 단계가 그 숫자를 다른 곳으로 흘릴 수 있다.
  //   판정은 같은 정본 함수 한 곳이고, 여기서는 그 시점에 **가진 것**만
  //   넘긴다 — 규칙이 두 벌이 되지 않는다.
  const markFreshness = assessMarketFreshness({
    observations: [markObservation], required: ['MARK'], nowMs: nowMs(),
  });
  notes.push(markFreshness.ok
    ? `기준 마크가 신선도 확인 — ${markFreshness.findings[0]?.detail ?? ''}`
    : `기준 마크가 신선도 미달 — ${markFreshness.reason}`);
  if (!markFreshness.ok) {
    // **값이 없어서가 아니라 언제의 값인지 모르거나 낡아서 막는다.**
    return fail('MARKET_DATA_STALE', markFreshness.reason, notes, {
      marginMode: mode, leverage: req, freshness: markFreshness,
    });
  }
  const price: number = mark!.price as number;

  // ── ⑤ 후보 크기 ──
  //
  // **계약이 요구하는 배율**로 계산한다. 되읽은 값이 아니다 — 되읽으려면
  // 먼저 걸어야 하고, 그러면 이 아래에서 막힐 요청이 계좌를 바꾼 뒤가
  // 된다. 실제 배율 확인은 확정 단계(`commitEntry100x`)의 일이다.
  const size: Sizing100xVerdict = planSize100x({
    requiredLeverage: req,
    availableUsd: avail,
    marginAllocationPct,
    referencePrice: price,
  });
  if (!size.ok) {
    return fail('SIZING_BLOCKED', size.message, notes,
      { marginMode: mode, leverage: req, referencePrice: price });
  }
  notes.push(size.message);

  // ── ⑥ 거래소 규격 ──
  let q: { qty: number | null; message: string };
  try { q = await deps.quantize(size.quantity as number); }
  catch (e: any) { q = { qty: null, message: String(e?.message || e) }; }
  if (q.qty == null || !(q.qty > 0)) {
    return fail('QUANTIZE_FAILED',
      `거래소 수량 규격에 맞추지 못했습니다 — ${q.message || '사유 미상'}`,
      notes, { marginMode: mode, leverage: req, referencePrice: price });
  }
  if (q.qty !== size.quantity) notes.push(`수량을 거래소 단위로 맞췄습니다: ${size.quantity} → ${q.qty}`);

  // ── ⑦ 필요 증거금 재검증 ──
  //
  // 다듬느라 올라간 수량이 배정을 넘으면 막는다. 넘는 만큼을 사용자가
  // 허락한 적이 없다.
  const requiredMargin = (q.qty * (price as number)) / req;
  const allocated = size.allocatedMargin as number;
  if (requiredMargin > allocated) {
    return fail('MARGIN_EXCEEDED',
      `거래소 수량 단위로 맞추니 필요 증거금이 $${requiredMargin.toFixed(4)}가 되어`
      + ` 배정한 $${allocated.toFixed(4)}를 넘습니다 — 넘는 만큼은 허락받은 적이 없습니다`,
      notes, { marginMode: mode, leverage: req, referencePrice: price,
               allocatedMargin: allocated, requiredMargin });
  }

  // ── ⑧ 유지증거금 구간 · 변동성 위험거리 읽기 ──
  //
  // 구간별 유지증거금은 명목가로 정해지므로 **다듬은 수량이 확정된
  // 뒤**여야 맞는 구간을 짚는다.
  const notional = q.qty * (price as number);
  let bracket: BracketObservation | null = null;
  try { bracket = await deps.maintenanceTiers(notional); } catch { bracket = null; }
  const tiers: BracketTier[] | null = bracket?.tiers ?? null;
  let adverse: number | null = null;
  try { adverse = await deps.adverseDistancePct(); } catch { adverse = null; }

  // ── ⑨ 비용 입력 읽기 ──
  //
  // **읽기를 먼저 전부 끝낸다.** 신선도 판정(⑩)은 여섯 출처의 관측
  // 시각을 서로 비교해야 하므로, 하나라도 아직 안 읽혔으면 "서로 다른
  // 시점을 합쳤는가"를 물을 수 없다.
  //
  // 세 입력 모두 **거래소에서 읽는다.** 못 읽으면 막는다 — 기본 수수료
  // 표나 `0.05% 슬리피지` 같은 상수로 때우지 않는다.
  let commission: CommissionRates | null = null;
  try { commission = await deps.commissionRates(); } catch { commission = null; }
  let book: DepthBook | null = null;
  try { book = await deps.orderBookDepth(); } catch { book = null; }
  let funding: FundingContext | null = null;
  try { funding = await deps.fundingContext(); } catch { funding = null; }

  // ── ⑩ 시장 데이터 신선도 ──
  //
  // **청산거리·비용 판정보다 먼저다.** 낡은 값으로 계산한 "여유
  // 0.59%"는 틀린 전제 위에 선 숫자이고, 그 숫자가 통과하면 아무도
  // 그것이 몇 초 전 시장이었는지 묻지 않는다.
  //
  // ★ 이 판정이 `prepareEntry100x` 안에 있다는 것이 요점이다. 라우트의
  //   `if` 한 줄로 두면 그 줄을 아래로 옮기는 변경이 조용히 통과한다.
  //   여기서는 `Entry100xReadDeps`에 쓰기 함수가 없으므로, 이 판정보다
  //   먼저 거래소에 쓰는 코드는 **타입이 없어서 쓸 수 없다.**
  //
  // 캐시 상태에 대하여: 브래킷과 premium은 읽는 쪽이 캐시를 선언하므로
  // 그쪽이 돌려준 값을 그대로 쓴다. 수수료·호가·펀딩 상한은 캐시를 두지
  // 않는 조회라 **응답이 있으면 그 자체가 방금 읽은 것**이다(그래서
  // `FRESH`, 없으면 `NONE`). 나이는 그 뒤 `observedAtMs`로 잰다 —
  // 여기서 시각을 만들어 붙이는 자리는 없다.
  //
  // **못 읽은 출처는 목록에 넣지 않는다.** "못 읽었다"는 이미 주인이
  // 있는 고장이다 — 브래킷은 ⑪(`LIQUIDATION_UNSAFE`), 수수료·호가·펀딩은
  // ⑫(`COST_UNKNOWN`)가 막는다. 여기서 같은 상황을 `MARKET_DATA_STALE`로
  // 덮어쓰면 ②·③이 세운 계약이 조용히 사라지고, 운영자는 "낡았다"와
  // "못 읽었다"를 구분할 수 없게 된다.
  //
  // 기준 마크가만 다르다. 그 값에는 다른 주인이 없으므로 ④가 막는다.
  const observations: MarketObservation[] = [markObservation];
  if (bracket) {
    observations.push({ kind: 'BRACKET', source: 'EXCHANGE_LEVERAGE_BRACKET',
      exchangeTimeMs: null,
      observedAtMs: bracket.observedAtMs ?? null, cache: bracket.freshness ?? null });
  }
  if (commission) {
    observations.push({ kind: 'COMMISSION', source: commission.source ?? null,
      exchangeTimeMs: null,
      observedAtMs: commission.observedAtMs ?? null, cache: 'FRESH' });
  }
  if (book) {
    observations.push({ kind: 'BOOK', source: book.source ?? null,
      exchangeTimeMs: book.exchangeTimeMs ?? null,
      observedAtMs: book.observedAtMs ?? null, cache: 'FRESH' });
  }
  if (funding) {
    // **premium과 펀딩 상한을 하나의 timestamp로 합치지 않는다.**
    // 다른 엔드포인트에서 다른 순간에 온 값이고, 한 칸에 적으면 한쪽의
    // 신선함이 다른 쪽을 덮는다.
    observations.push({ kind: 'PREMIUM', source: 'EXCHANGE_PREMIUM_INDEX',
      exchangeTimeMs: funding.premiumExchangeTimeMs ?? null,
      observedAtMs: funding.premiumObservedAtMs ?? null,
      // **읽는 쪽이 선언한 캐시 상태를 그대로 쓴다.** premium은 45초
      // 캐시를 두므로 "응답이 있으니 방금 읽은 것"이 성립하지 않는다.
      cache: funding.premiumCache ?? null });
    observations.push({ kind: 'FUNDING_BOUNDS', source: funding.source ?? null,
      exchangeTimeMs: null,
      observedAtMs: funding.fundingBoundsObservedAtMs ?? null, cache: 'FRESH' });
  }
  const freshness = assessMarketFreshness({
    observations,
    // 기준 마크가만 **반드시** 있어야 한다. 나머지의 "없음"은 ⑪·⑫가
    // 자기 사유로 막는다.
    required: ['MARK'],
    nowMs: nowMs(),
  });
  notes.push(freshness.ok
    ? `시장 데이터 신선도 확인 (${freshness.findings.length}개 출처`
      + `${freshness.maxCrossSourceSkewMs == null ? ''
          : ` · 출처 간 최대 시각차 ${freshness.maxCrossSourceSkewMs}ms`})`
    : `시장 데이터 신선도 미달 — ${freshness.reason}`);
  if (!freshness.ok) {
    return fail('MARKET_DATA_STALE', freshness.reason, notes, {
      marginMode: mode, leverage: req, referencePrice: price,
      allocatedMargin: allocated, requiredMargin, quantity: q.qty,
      freshness,
    });
  }

  // ── ⑪ 청산거리 (RAW) ──
  //
  // ★ 이 단계가 PHASE A 안에 있다는 것이 요점이다. 라우트의 `if` 한 줄로
  //   두면 그 줄을 아래로 옮기는 변경이 조용히 통과할 수 있다. 여기서는
  //   `Entry100xReadDeps`에 쓰기 함수가 없으므로, 이 판정보다 먼저 거래소에
  //   쓰는 코드는 **타입이 없어서 쓸 수 없다.** 순서가 규칙이 아니라 구조다.
  const liquidation = assessLiquidationDistance({
    side: contract.side,
    referencePrice: price,
    quantity: q.qty,
    leverage: req,
    marginMode: mode,
    // 구간은 **판정이 푼다.** 진입 명목가로 미리 고르면 청산가에서
    // 경계를 넘은 경우를 잡지 못한다 — 표를 통째로 넘긴다.
    brackets: tiers,
    adverseDistancePct: adverse,
  });
  notes.push(
    liquidation.liquidationDistancePct == null
      ? `청산거리 계산 실패 (${liquidation.code})`
      : `청산거리 ${liquidation.liquidationDistancePct.toFixed(4)}%`
        + ` (청산가 ${liquidation.estimatedLiquidationPrice}`
        + `${liquidation.adverseDistancePct == null ? ''
            : ` · 변동성 위험거리 ${liquidation.adverseDistancePct.toFixed(4)}%`})`,
  );
  if (!liquidation.ok) {
    // **모르는 것은 통과가 아니다.** 100배에서 "확인하지 못함"을 통과로
    // 읽으면 그 한 번이 증거금 전액이다.
    return fail('LIQUIDATION_UNSAFE', liquidation.reason, notes, {
      marginMode: mode, leverage: req, referencePrice: price,
      allocatedMargin: allocated, requiredMargin, quantity: q.qty,
      liquidation, freshness,
    });
  }

  // ── ⑫ 실행·보유 비용 ──
  //
  // RAW 여유(⑪)는 비용을 빼기 **전** 값이다. 100배에서 왕복 taker 수수료만
  // 여유의 상당 부분이고 슬리피지가 거기 더해진다. 빼지 않으면 "청산거리가
  // 충분하다"가 사실이 아니게 된다.
  //
  // 세 입력은 ⑨에서 이미 읽었다 — 신선도 판정이 전부를 함께 봐야
  // 하기 때문이다.
  const cost = assessExecutionCost({
    side: contract.side,
    referencePrice: price,
    quantity: q.qty,
    leverage: req,
    // **시장가면 taker다.** 계약의 주문 유형에서 오고, 여기서 고르지 않는다.
    fillKind: contract.fillKind,
    commission, book, funding,
    nowMs: nowMs(),
    // 계약이 **선언한** 최대 보유 시간이 펀딩 평가 구간이다.
    //
    // ★ 이것은 "4시간에 자동으로 청산된다"는 뜻이 **아니다.** 그 배선은
    //   아직 없다(post-entry exit authority 없음). 여기서는 "계약이 최대
    //   4시간 보유한다고 선언했으므로 비용을 그 구간으로 본다"일 뿐이다.
    holdHorizonMs: contract.maxHoldSec != null && contract.maxHoldSec > 0
      ? contract.maxHoldSec * 1000 : null,
  });
  notes.push(
    cost.totalCostNotionalPct == null
      ? `비용 계산 실패 (${cost.code})`
      : `비용 ${cost.totalCostNotionalPct.toFixed(4)}%`
        + ` (수수료 입 ${cost.entryFeeUsd!.toFixed(6)} · 출예약 ${cost.exitFeeReserveUsd!.toFixed(6)}`
        + ` · 슬리피지 입 ${cost.entrySlippageUsd!.toFixed(6)} · 출예약 ${cost.exitSlippageReserveUsd!.toFixed(6)}`
        + ` · 펀딩예약 ${cost.fundingReserveUsd!.toFixed(6)} × ${cost.fundingEvents}회)`,
  );
  if (!cost.ok) {
    return fail('COST_UNKNOWN', cost.reason, notes, {
      marginMode: mode, leverage: req, referencePrice: price,
      allocatedMargin: allocated, requiredMargin, quantity: q.qty,
      liquidation, freshness, cost,
    });
  }

  // ── ⑬ 비용을 반영한 청산거리 ──
  //
  // **퍼센트끼리 빼지 않는다.** 슬리피지는 진입가를 옮기고, 수수료·펀딩은
  // 격리 증거금을 줄인다. 줄어든 증거금은 곧 오른 배율이므로, 같은 식에
  // 예상 체결가와 실효배율을 넣어 **다시 푼다**(executionCost 머리말 참조).
  const eff = effectiveMarginAfterCost(cost, req);
  if (eff.code !== 'OK') {
    return fail('LIQUIDATION_UNSAFE_AFTER_COST', eff.reason, notes, {
      marginMode: mode, leverage: req, referencePrice: price,
      allocatedMargin: allocated, requiredMargin, quantity: q.qty,
      liquidation, freshness, cost,
    });
  }
  const effectiveLiquidation = assessLiquidationDistance({
    side: contract.side,
    // **거리는 마크가에서 잰다** — 청산은 마크가로 발동한다.
    referencePrice: price,
    // **식에는 예상 체결가를 넣는다** — 포지션이 열리는 가격이 그것이다.
    entryPrice: eff.effectiveEntryPrice,
    quantity: q.qty,
    leverage: eff.effectiveLeverage,
    marginMode: mode,
    brackets: tiers,
    adverseDistancePct: adverse,
    headroomKind: 'EFFECTIVE',
  });
  notes.push(
    effectiveLiquidation.liquidationDistancePct == null
      ? `실질 청산거리 계산 실패 (${effectiveLiquidation.code})`
      : `실질 청산거리 ${effectiveLiquidation.liquidationDistancePct.toFixed(4)}%`
        + ` (실효배율 ${eff.effectiveLeverage!.toFixed(4)}배`
        + ` · 체결가 ${eff.effectiveEntryPrice})`,
  );
  if (!effectiveLiquidation.ok) {
    return fail('LIQUIDATION_UNSAFE_AFTER_COST', effectiveLiquidation.reason, notes, {
      marginMode: mode, leverage: req, referencePrice: price,
      allocatedMargin: allocated, requiredMargin, quantity: q.qty,
      liquidation, freshness, cost, effectiveLiquidation,
    });
  }

  return {
    ok: true, code: 'OK',
    quantity: q.qty,
    leverage: req,
    allocatedMargin: allocated,
    requiredMargin,
    referencePrice: price,
    marginMode: mode,
    liquidation, freshness, cost, effectiveLiquidation,
    message: `${req}배 · 수량 ${q.qty} · 증거금 $${requiredMargin.toFixed(4)} / 배정 $${allocated.toFixed(4)}`
      + ` · 청산거리 ${liquidation.liquidationDistancePct!.toFixed(4)}%`
      + ` → 비용 ${cost.totalCostNotionalPct!.toFixed(4)}% 반영 후`
      + ` ${effectiveLiquidation.liquidationDistancePct!.toFixed(4)}%`,
    notes,
  };
}

/**
 * 쓰기 전 마지막 관문의 판정.
 *
 * `gateOrder`가 돌려주는 모양의 일부만 받는다 — 이 파일이 운영 모드를
 * 알 필요는 없고, 알면 규칙이 두 곳이 된다.
 */
export interface PreWriteDecision {
  /** 'SEND'가 아니면 거래소에 쓰지 않는다 */
  disposition: string;
  reason?: string;
}

/**
 * **PHASE B — 여기서 처음으로 거래소에 쓴다.**
 *
 * 배율을 걸고 **독립적으로 되읽어** 정확히 요구값인지 확인한다.
 *
 * 이 단계에 도달했다는 것은 쓰기 없이 판정할 수 있는 차단이 하나도
 * 남지 않았다는 뜻이다. 그래서 여기서 남는 차단은 하나뿐이다 —
 * **걸어 봐야 아는 것**, 즉 거래소가 요청한 배율을 실제로 주었는가.
 *
 * 느슨해진 것은 없다. 되읽기가 실패했거나 75배·99배가 나오면 그대로
 * 막는다. 판정은 `verifyLeverageExact` 한 곳에 있다.
 */
export async function commitEntry100x(
  prepared: Entry100xVerdict,
  deps: Entry100xWriteDeps,
  preWrite: PreWriteDecision,
): Promise<Entry100xVerdict> {
  const notes = [...(prepared.notes || [])];

  // 막힌 계획으로는 쓰지 않는다. 호출부가 순서를 어겨도 여기서 멈춘다.
  if (!prepared.ok) return { ...prepared, notes };

  // ── 쓰기 전 마지막 관문 ──
  //
  // 이 판정을 라우트의 `if` 한 줄로 두면, 그 조건을 `true`로 바꾸는
  // 변경이 아무 시험에도 걸리지 않는다. 실제로 돌연변이가 그대로
  // 새 나갔다 — 검사기가 "`gateOrder`를 부르는가"라는 **문자열**만 보고
  // 있었기 때문이다.
  //
  // 그래서 규칙을 여기로 옮긴다. 이 함수는 시험이 직접 돌릴 수 있고,
  // "허락되지 않았는데 썼는가"를 셀 수 있다.
  if (!preWrite || preWrite.disposition !== 'SEND') {
    notes.push(`쓰기 없이 멈춤 — ${preWrite?.reason || '쓰기 전 관문이 허락하지 않았습니다'}`);
    return { ...prepared, notes };
  }

  const req = Number(prepared.leverage);

  let lev: { ok: boolean; observed: number | null; message: string };
  try { lev = await deps.applyLeverage(req); }
  catch (e: any) { lev = { ok: false, observed: null, message: String(e?.message || e) }; }

  const bad = verifyLeverageExact(req, lev.ok ? lev.observed : null);
  if (bad) {
    return fail('LEVERAGE_NOT_EXACT', `${bad.message}${lev.message ? ` — ${lev.message}` : ''}`,
      notes, { marginMode: prepared.marginMode, leverage: req,
               referencePrice: prepared.referencePrice });
  }
  notes.push(`배율 ${req}배 확인(되읽음)`);

  return { ...prepared, notes };
}
