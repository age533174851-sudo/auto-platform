// src/lib/engine/escapeObservationStore.ts
//
// **⑤B-3A-1 — 종료 실행 한 번을 한 줄로 적는다. 판단하지 않는다.**
//
// 이 파일에 없는 것
// ─────────────────
// 거래소를 바꾸는 import가 없다. 문턱이 없다. 돌려주는 값으로 분기하는
// 코드를 만들지 않는다 — 세기만 한다.
//
// 091과 왜 다른 표인가
// ────────────────────
// 091은 **감시 회차마다** 찍는 위험 스냅숏이고, 여기는 **종료 실행
// 한 번당** 한 줄이다. 같은 표에 섞으면 서로의 칸이 대부분 NULL인 줄이
// 섞여 두 분포가 다 망가진다.
//
// 출처를 섞지 않는다
// ──────────────────
// ⑤B-2의 자격 정본(`verifiedTestnetObservationEligibility`)을 **그대로**
// 쓴다 — 여기서 다시 판단하면 두 벌이 되고, 다른 계약의 종료가
// Exact100X 표본에 섞인다.

import {
  verifiedTestnetObservationEligibility,
  type RiskObservationEligibility,
} from './riskObservationEligibility';
import { closeSlippage } from './closeSlippage';
import type { ExitEscapeTiming } from './exitAuthorityRun';
import type { ExecutionIdentity } from './managedPosition';
import type { RiskSampleOrigin } from './riskObservationStore';

export interface EscapeObservationInput {
  /** **기본값 없음.** 부르는 쪽이 반드시 고른다 */
  sampleOrigin: RiskSampleOrigin;
  env: 'LIVE' | 'TESTNET' | 'MOCK';
  connectionId: string | null;
  symbol: string;
  side: 'LONG' | 'SHORT';
  executionIdentity: ExecutionIdentity | null;

  /** `x-traigo-source` 그대로. **추측하지 않는다** */
  wakeSource: string | null;
  /** 예정보다 얼마나 늦었는가. **모르면 null** */
  wakeDelayMs: number | null;
  /** worker가 실제로 쓰는 간격. 모르면 null */
  configuredIntervalMs: number | null;

  /** 관측 단계의 구간 시간 (⑤B-2 경로) */
  observation: {
    markReadElapsedMs: number | null;
    bracketReadElapsedMs: number | null;
    positionRiskElapsedMs: number | null;
    riskMeasurementElapsedMs: number | null;
  };
  /** 실행 단계의 구간 시간 (⑤A 경로) */
  timing: ExitEscapeTiming;

  runCode: string;
  attemptedWrite: boolean | null;
  accepted: boolean | null;
  flatVerified: boolean | null;
  /** 보낸 수량이다. **체결 수량이 아니다** */
  requestedQuantity: number | null;

  reportedAvgPrice: number | null;
  exchangeOrderId: string | null;
  executedQty: number | null;
  /**
   * 전송 시점 마크가. 낡았으면 **부르는 쪽이 null을 준다** —
   * 이 파일은 신선도 문턱을 갖지 않는다(④ 정본이 판정한다).
   */
  markAtSubmit: number | null;

  /** 실측 자격 판정용 — 부호 있는 수량 */
  signedPositionAmt: number | null;
  testnet: boolean | null;
  exchange: string | null;
}

export type EscapeObservationCode =
  | 'RECORDED'
  | 'WRITE_FAILED'
  | 'ORIGIN_UNSPECIFIED'
  | 'ORIGIN_IMPOSSIBLE'
  /** 실측 표본 자격이 없다. **쓰기 실패가 아니다** */
  | 'NOT_ELIGIBLE';

export interface EscapeObservationResult {
  code: EscapeObservationCode;
  reason: string;
  eligibility: RiskObservationEligibility | null;
}

const ORIGINS: RiskSampleOrigin[] = [
  'VERIFIED_TESTNET_OBSERVATION', 'SYNTHETIC_TEST_ONLY',
];

/** 표에 담을 모양. DB를 모른다 — 시험과 검사기가 칸을 대조할 수 있어야 한다 */
export function escapeObservationRow(i: EscapeObservationInput): Record<string, any> {
  const slip = closeSlippage({
    side: i.side, markPrice: i.markAtSubmit, fillPrice: i.reportedAvgPrice,
  });
  return {
    env: i.env,
    connection_id: i.connectionId,
    symbol: i.symbol,
    side: i.side,
    execution_profile_id: i.executionIdentity?.profileId ?? null,
    execution_preset_id: i.executionIdentity?.presetId ?? null,
    execution_contract_version: i.executionIdentity?.contractVersion ?? null,

    wake_source: i.wakeSource,
    wake_delay_ms: i.wakeDelayMs,
    configured_interval_ms: i.configuredIntervalMs,

    mark_read_elapsed_ms: i.observation.markReadElapsedMs,
    bracket_read_elapsed_ms: i.observation.bracketReadElapsedMs,
    position_risk_elapsed_ms: i.observation.positionRiskElapsedMs,
    risk_measurement_elapsed_ms: i.observation.riskMeasurementElapsedMs,
    lease_check_elapsed_ms: i.timing.leaseCheckElapsedMs,
    prepare_close_elapsed_ms: i.timing.prepareCloseElapsedMs,
    fence_revalidation_elapsed_ms: i.timing.fenceRevalidationElapsedMs,
    critical_window_elapsed_ms: i.timing.criticalWindowElapsedMs,
    submit_elapsed_ms: i.timing.submitElapsedMs,
    submit_accepted_to_first_read_after_ms: i.timing.submitAcceptedToFirstReadAfterMs,

    run_code: i.runCode,
    attempted_write: i.attemptedWrite,
    accepted: i.accepted,
    flat_verified: i.flatVerified,
    // **첫 조회에서 봤는가**일 뿐이다. 실제 flat 시각이 아니다.
    flat_observed_at_first_read: i.timing.flatObservedAtFirstRead,
    requested_quantity: i.requestedQuantity,

    reported_avg_price: i.reportedAvgPrice,
    exchange_order_id: i.exchangeOrderId,
    executed_qty: i.executedQty,

    mark_at_submit: i.markAtSubmit,
    adverse_close_slippage_pct: slip.adverseCloseSlippagePct,

    sample_origin: i.sampleOrigin,
  };
}

/**
 * 관측을 **덧붙인다.** 갱신도 삭제도 하지 않는다.
 *
 * 돌려주는 값으로 분기하지 마라 — 호출부가 셀 수 있게 적을 뿐이다.
 */
export async function recordEscapeObservation(
  sb: any, i: EscapeObservationInput,
): Promise<EscapeObservationResult> {
  if (!ORIGINS.includes(i?.sampleOrigin as any)) {
    return { code: 'ORIGIN_UNSPECIFIED', eligibility: null,
      reason: `표본 출처를 고르지 않았습니다 (${String(i?.sampleOrigin)})` };
  }
  if (i.sampleOrigin === 'VERIFIED_TESTNET_OBSERVATION') {
    if (i.env !== 'TESTNET') {
      return { code: 'ORIGIN_IMPOSSIBLE', eligibility: null,
        reason: `${i.env} 환경의 값을 VERIFIED_TESTNET으로 적을 수 없습니다` };
    }
    // ⑤B-2의 자격 정본을 **그대로** 쓴다. 여기서 다시 판단하지 않는다.
    const el = verifiedTestnetObservationEligibility({
      testnet: i.testnet, exchange: i.exchange, side: i.side,
      executionIdentity: i.executionIdentity, positionAmt: i.signedPositionAmt,
    });
    if (!el.eligible) {
      return { code: 'NOT_ELIGIBLE', eligibility: el.code, reason: el.reason };
    }
  }
  try {
    const { error } = await sb.from('exact100x_exit_escape_observations')
      .insert(escapeObservationRow(i));
    if (error) {
      return { code: 'WRITE_FAILED', eligibility: null,
        reason: String(error?.message || error).slice(0, 160) };
    }
    return { code: 'RECORDED', eligibility: null, reason: '' };
  } catch (e: any) {
    // **호출부를 실패시키지 않는다.** 기록하려다 종료 경로를 죽이지 않는다.
    return { code: 'WRITE_FAILED', eligibility: null,
      reason: String(e?.message || e).slice(0, 160) };
  }
}
