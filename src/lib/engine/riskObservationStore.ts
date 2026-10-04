// src/lib/engine/riskObservationStore.ts
//
// **⑤B-2 — 위험 관측을 쌓는다. 판단하지도, 주문하지도 않는다.**
//
// 이 파일에 없는 것
// ─────────────────
// 거래소를 바꾸는 import가 하나도 없다. 문턱도 없다. 돌려주는 값은
// "적혔는가"뿐이고, 그 값으로 분기하는 코드를 만들지 않는다.
//
// 왜 `recordAudit`처럼 불 지르고 잊지 않는가
// ──────────────────────────────────────────
// 그쪽은 **주문 경로**에 있어서 기록이 주문을 느리게 하거나 실패시키면
// 안 된다 — 삼키는 것이 맞다. 여기는 다르다. 이 표본으로 나중에 백분위를
// 낸다. **조용히 사라진 줄은 분포를 왜곡한다.** 그래서 실패를 세어
// 돌려주고, 감시 회차 요약이 "몇 건 못 적었는가"를 말할 수 있게 한다.
//
// 그래도 **호출부를 실패시키지는 않는다.** 관측을 못 적었다고 감시
// 회차가 죽으면, 기록하려다 감시를 끄는 것이다.
//
// ★ 실측과 주입값을 섞지 않는다
// ─────────────────────────────
// `sampleOrigin`에 기본값이 없다. 부르는 쪽이 반드시 고른다 — 모르고
// 실측으로 적히는 길을 없앤다. 둘을 섞으면 ⑤B-3의 통계가 거짓이 된다.

import type { PostEntryRiskMeasurement } from './postEntryRisk';
import type { ExecutionIdentity } from './managedPosition';
import {
  verifiedTestnetObservationEligibility,
  type RiskObservationEligibility,
} from './riskObservationEligibility';

/**
 * 이 관측이 **어디서 나왔는가.**
 *
 * `VERIFIED_TESTNET_OBSERVATION`은 실제 자격증명으로 실제 열린 포지션을
 * 조회해 나온 것만 쓸 수 있다. 시험 fixture·검사기 주입값은 전부
 * `SYNTHETIC_TEST_ONLY`다.
 */
export type RiskSampleOrigin =
  | 'VERIFIED_TESTNET_OBSERVATION'
  | 'SYNTHETIC_TEST_ONLY';

export interface RiskObservationInput {
  /** **기본값 없음.** 부르는 쪽이 반드시 고른다 */
  sampleOrigin: RiskSampleOrigin;
  env: 'LIVE' | 'TESTNET' | 'MOCK';
  connectionId: string | null;
  symbol: string;
  side: 'LONG' | 'SHORT';
  executionIdentity: ExecutionIdentity | null;
  measurement: PostEntryRiskMeasurement;
  /** 포지션 쪽 값 — 측정 입력에 없던 것만 */
  position: {
    entryPrice: number | null;
    quantity: number | null;
    leverage: number | null;
    marginMode: 'isolated' | 'cross' | null;
  };
  bracketFreshness: string | null;
  /**
   * 거래소가 답한 **부호 있는** 수량. 실측 자격을 가리는 데 쓴다.
   *
   * `position.quantity`(절댓값)와 다른 값이다 — 부호가 사라지면 헤지
   * 계좌의 반대 다리를 이 포지션으로 적게 된다.
   */
  signedPositionAmt: number | null;
  /** 이 연결이 테스트넷인가. **못 읽었으면 null** */
  testnet: boolean | null;
  exchange: string | null;
}

export type RiskObservationCode =
  /** 적었다 */
  | 'RECORDED'
  /**
   * 적지 못했다 — **DB 쓰기가 실패했다.**
   *
   * ★ 아래 `NOT_ELIGIBLE`과 **섞지 않는다.** 열린 포지션이 없는 것은
   *   고장이 아니라 정상이고, 둘을 한 숫자로 세면 운영자가 고칠 것이
   *   없는데 DB를 들여다보게 된다.
   */
  | 'WRITE_FAILED'
  /** 출처를 고르지 않았다 — 실측으로 둔갑할 수 있어 막는다 */
  | 'ORIGIN_UNSPECIFIED'
  /** 환경이 그 출처와 맞지 않는다 (LIVE·MOCK을 실측이라고 적으려 함) */
  | 'ORIGIN_IMPOSSIBLE'
  /**
   * 실측 표본 자격이 없다. **쓰기 실패가 아니다.**
   *
   * 열린 포지션이 없거나 방향이 다른 경우다. 값을 고치거나 출처를
   * `SYNTHETIC_TEST_ONLY`로 바꿔 적지 않는다 — 실제 런타임 상황을
   * 시험값이라고 부르면 그것도 출처 오염이다.
   */
  | 'NOT_ELIGIBLE';

export interface RiskObservationResult {
  code: RiskObservationCode;
  reason: string;
  /** 자격 판정 코드. 판정하지 않았으면 null */
  eligibility: RiskObservationEligibility | null;
}

const ORIGINS: RiskSampleOrigin[] = [
  'VERIFIED_TESTNET_OBSERVATION', 'SYNTHETIC_TEST_ONLY',
];

/**
 * 관측 한 줄을 **표에 담을 모양으로** 만든다. DB를 모른다.
 *
 * 떼어 둔 이유: 시험과 검사기가 "무엇이 어느 칸에 들어가는가"를
 * DB 없이 확인할 수 있어야 한다.
 */
export function riskObservationRow(i: RiskObservationInput): Record<string, any> {
  const m = i.measurement;
  const p = m.provenance;
  return {
    env: i.env,
    connection_id: i.connectionId,
    symbol: i.symbol,
    side: i.side,
    execution_profile_id: i.executionIdentity?.profileId ?? null,
    execution_preset_id: i.executionIdentity?.presetId ?? null,
    execution_contract_version: i.executionIdentity?.contractVersion ?? null,

    entry_price: i.position.entryPrice,
    quantity: i.position.quantity,
    leverage: i.position.leverage,
    margin_mode: i.position.marginMode,

    mark_price: m.markPrice,
    mark_exchange_time_ms: p.markExchangeTimeMs,
    mark_received_at_ms: p.markReceivedAtMs,
    mark_observed_at_ms: p.markObservedAtMs,
    mark_freshness_code: m.freshness?.code ?? null,

    position_risk_source: p.positionRiskSource,
    position_risk_request_started_at_ms: p.positionRiskRequestStartedAtMs,
    position_risk_received_at_ms: p.positionRiskReceivedAtMs,
    // **청산가 시각이 아니다.** 이름 그대로 적는다.
    position_update_time_ms: p.positionUpdateTimeMs,
    exchange_liquidation_price: m.exchangeLiquidationPrice,

    // duration — epoch 칸과 섞지 않는다
    position_risk_elapsed_ms: p.positionRiskElapsedMs,
    account_elapsed_ms: p.accountElapsedMs,
    helper_elapsed_ms: p.helperElapsedMs,
    position_risk_wall_clock_delta_ms: p.positionRiskWallClockDeltaMs,

    estimated_liquidation_price: m.estimatedLiquidationPrice,
    internal_trustworthy: m.internalTrustworthy,
    internal_code: m.internal?.code ?? null,
    tier_index: m.internal?.entryTierIndex ?? null,
    tier_mmr: m.internal?.tier?.mmr ?? null,
    tier_maint_amount: m.internal?.tier?.maintAmount ?? null,

    exchange_headroom_pct: m.exchangeHeadroomPct,
    estimated_headroom_pct: m.estimatedHeadroomPct,
    absolute_delta: m.absoluteDelta,
    delta_pct: m.deltaPct,
    liquidation_sources: m.liquidationSources,

    // 090의 **사본**이다. 원본을 갱신하지 않는다.
    entry_adverse_distance_pct: m.entryAdverseDistancePct,
    entry_liquidation_distance_pct_raw: m.entryLiquidationDistancePctRaw,

    bracket_observed_at_ms: p.bracketObservedAtMs,
    bracket_freshness: i.bracketFreshness,

    status: m.status,
    reason: m.reason || null,
    sample_origin: i.sampleOrigin,
  };
}

/**
 * 관측을 **덧붙인다.** 갱신도 삭제도 하지 않는다.
 *
 * 돌려주는 값으로 분기하지 마라 — 호출부가 셀 수 있게 적을 뿐이다.
 */
export async function recordRiskObservation(
  sb: any, i: RiskObservationInput,
): Promise<RiskObservationResult> {
  // ★ 출처를 고르지 않았으면 **적지 않는다.** 기본값을 주면 시험
  //   주입값이 조용히 실측으로 쌓이고, 그 표로 낸 통계는 거짓이 된다.
  if (!ORIGINS.includes(i?.sampleOrigin as any)) {
    return { code: 'ORIGIN_UNSPECIFIED', eligibility: null,
      reason: `표본 출처를 고르지 않았습니다 (${String(i?.sampleOrigin)})`
        + ' — 실측과 시험값을 섞으면 ⑤B-3의 통계가 거짓이 됩니다' };
  }
  if (i.sampleOrigin === 'VERIFIED_TESTNET_OBSERVATION') {
    // ★ **TESTNET에서만 성립한다.** 이름 그대로다 — LIVE를
    //   VERIFIED_TESTNET으로 적는 경로는 0이어야 한다. LIVE 관측이
    //   필요해지면 별도 출처를 별도로 설계한다.
    if (i.env !== 'TESTNET') {
      return { code: 'ORIGIN_IMPOSSIBLE', eligibility: null,
        reason: `${i.env} 환경의 값을 VERIFIED_TESTNET으로 적을 수 없습니다`
          + ' — 환경을 섞으면 표본이 오염됩니다' };
    }
    // ★ **실제로 열린 포지션인가.** 자격 판정은 정본 한 곳이다.
    const el = verifiedTestnetObservationEligibility({
      testnet: i.testnet, exchange: i.exchange, side: i.side,
      executionIdentity: i.executionIdentity, positionAmt: i.signedPositionAmt,
    });
    if (!el.eligible) {
      // **쓰기 실패가 아니다.** 값을 고치거나 출처를 바꿔 적지 않는다.
      return { code: 'NOT_ELIGIBLE', eligibility: el.code, reason: el.reason };
    }
  }
  try {
    const { error } = await sb.from('exact100x_risk_observations')
      .insert(riskObservationRow(i));
    if (error) {
      return { code: 'WRITE_FAILED', eligibility: null,
        reason: String(error?.message || error).slice(0, 160) };
    }
    return { code: 'RECORDED', eligibility: null, reason: '' };
  } catch (e: any) {
    // **호출부를 실패시키지 않는다.** 관측을 못 적었다고 감시를 끄지 않는다.
    return { code: 'WRITE_FAILED', eligibility: null,
      reason: String(e?.message || e).slice(0, 160) };
  }
}
