// src/lib/engine/adaptiveEntry.ts
//
// **적응형 배율 정책의 진입 경계 — 100배가 지나갈 수 없는 자리.**
//
// 왜 판정과 따로 있는가
// ─────────────────────
// `adaptiveLeverage.ts`는 순수 판정이다. 숫자만 받고 숫자만 돌려준다.
// 그런데 이 저장소에서 반복된 고장은 **판정이 틀린 것이 아니라 판정이
// 배선되지 않은 것**이었다 — 만들어 놓고 호출하는 곳이 없다.
//
// 그래서 "이 정책으로 주문을 낸다"를 함수 하나로 둔다. 실행기를 부르는
// 길이 여기 하나뿐이면, 100배가 이 정책의 이름으로 나갈 길도 하나뿐이고
// 그 길에 관문이 있다.
//
// 무엇을 하지 않는가
// ──────────────────
// · **수량 산출을 새로 만들지 않는다.** `planSize100x`를 그대로 쓴다.
//   그 함수는 배율을 인자로 받으므로 100 전용이 아니다. 같은 판단을
//   두 곳에 두면 언젠가 갈린다 — 갈리는 쪽이 수량이면 그건 돈이다.
// · **손절·청산 정책을 바꾸지 않는다.** 이 경계는 배율과 수량까지만
//   정하고, 그 뒤는 기존 `executeOrder`가 하던 그대로다.
// · **예약을 켜지 않는다.** 이 함수를 부르는 운영 경로는 아직 없다.
//   배선은 별도 승인 뒤의 일이다.
import {
  planAdaptiveLeverage, adaptiveLeverageAllows, FORBIDDEN_LEVERAGE,
  type AdaptiveLeverageInput, type AdaptiveLeverageVerdict,
} from './adaptiveLeverage';
import { planSize100x, validateMarginAllocation, type Sizing100xVerdict } from './sizing100x';

export type AdaptiveEntryCode =
  | 'OK'
  /** 배율 판정이 막았다 — 사유는 `leverage.code` */
  | 'LEVERAGE_BLOCKED'
  /** 배정 비율이 없거나 범위 밖 */
  | 'MARGIN_ALLOCATION_BLOCKED'
  /** 수량 산출이 막았다 — 사유는 `sizing.code` */
  | 'SIZING_BLOCKED'
  /** 잔고·기준가를 못 읽었다 */
  | 'BALANCE_UNKNOWN'
  | 'PRICE_UNKNOWN'
  /** **이 정책에 100배는 없다.** 어떤 경로로 들어왔든 여기서 끝난다 */
  | 'HUNDRED_X_FORBIDDEN'
  /** 사다리에 없는 배율 — 판정이 깨졌거나 누가 끼워 넣었다 */
  | 'LEVERAGE_NOT_ON_LADDER';

export interface AdaptiveEntryInput {
  /** 위험 판정에 넣을 입력. `allocatedMarginUsd`는 여기서 채운다 */
  risk: Omit<AdaptiveLeverageInput, 'allocatedMarginUsd'>;
  availableUsd: number | null;
  marginAllocationPct: number | null;
  referencePrice: number | null;
  /**
   * 호출자가 특정 배율을 요구하는 경우(수동 재시도·회귀 시험).
   * **비워 두는 것이 정상**이다 — 채우면 판정이 낸 값보다 높을 수 없고,
   * 100이면 무조건 막힌다.
   */
  requestedLeverage?: number | null;
}

export interface AdaptiveEntryPlan {
  ok: boolean;
  code: AdaptiveEntryCode;
  /** 막혔으면 null. **0을 적지 않는다** */
  leverage: number | null;
  quantity: number | null;
  allocatedMargin: number | null;
  targetNotional: number | null;
  /** LONG/SHORT 각각의 예상 청산가. 기준가를 모르면 null */
  liquidationPrice: { long: number | null; short: number | null };
  leverageVerdict: AdaptiveLeverageVerdict | null;
  sizing: Sizing100xVerdict | null;
  message: string;
}

function fail(code: AdaptiveEntryCode, message: string,
  extra: Partial<AdaptiveEntryPlan> = {}): AdaptiveEntryPlan {
  return {
    ok: false, code, leverage: null, quantity: null,
    allocatedMargin: null, targetNotional: null,
    liquidationPrice: { long: null, short: null },
    leverageVerdict: null, sizing: null, message, ...extra,
  };
}

/**
 * 격리 포지션의 예상 청산가.
 *
 * 증거금이 전부 녹는 지점에서 유지증거금률만큼 앞이다.
 *   LONG  : entry × (1 − 1/L + mmr)
 *   SHORT : entry × (1 + 1/L − mmr)
 *
 * **거래소가 계산한 값이 아니다.** 진입 전에 "대략 어디쯤인가"를 알기
 * 위한 값이고, 주문 뒤에는 거래소가 돌려주는 값을 쓴다. 둘을 같은
 * 이름으로 섞지 않도록 이 함수는 `expected`만 만든다.
 */
export function expectedLiquidationPrice(
  entry: number, leverage: number, mmr: number,
): { long: number; short: number } {
  const d = 1 / leverage - mmr;
  return { long: entry * (1 - d), short: entry * (1 + d) };
}

/**
 * 이 회차의 배율·수량·예상 청산가.
 *
 *   ① 배정 비율 → 증거금 (배율을 쓰기 전에 끝낸다)
 *   ② 위험 판정 → 배율 (막히면 여기서 끝)
 *   ③ 요구 배율이 있으면 **더 낮은 쪽**을 쓴다. 올리지 않는다
 *   ④ 100 · 사다리 밖 → 차단
 *   ⑤ 수량은 `planSize100x`가 만든다
 */
export function planAdaptiveEntry(i: AdaptiveEntryInput): AdaptiveEntryPlan {
  // ── ① 배정 비율 ──
  const allocBad = validateMarginAllocation(i.marginAllocationPct);
  if (allocBad) return fail('MARGIN_ALLOCATION_BLOCKED', allocBad.message);

  const avail = Number(i.availableUsd);
  if (i.availableUsd == null || !Number.isFinite(avail) || avail <= 0) {
    return fail('BALANCE_UNKNOWN',
      '가용 잔고를 읽지 못했습니다 — 0으로 두지 않고 주문하지 않습니다');
  }
  const price = Number(i.referencePrice);
  if (i.referencePrice == null || !Number.isFinite(price) || price <= 0) {
    return fail('PRICE_UNKNOWN', '기준가를 읽지 못했습니다');
  }
  const allocatedMargin = avail * (Number(i.marginAllocationPct) / 100);

  // ── ② 위험 판정 ──
  const verdict = planAdaptiveLeverage({ ...i.risk, allocatedMarginUsd: allocatedMargin });
  if (!verdict.ok || verdict.leverage == null) {
    return fail('LEVERAGE_BLOCKED',
      `배율을 정하지 못해 진입하지 않습니다 — ${verdict.message}`,
      { leverageVerdict: verdict });
  }

  // ── ③ 요구 배율은 **낮추는 쪽으로만** 쓴다 ──
  let leverage = verdict.leverage;
  if (i.requestedLeverage != null) {
    const req = Number(i.requestedLeverage);
    if (!Number.isFinite(req)) {
      return fail('LEVERAGE_NOT_ON_LADDER',
        `요구 배율이 숫자가 아닙니다 (${String(i.requestedLeverage)})`,
        { leverageVerdict: verdict });
    }
    // **100은 요구하는 것만으로 끝이다.** 조용히 75로 낮추지 않는다 —
    // 낮춰 주면 호출자는 100배 계약을 이 정책으로 돌릴 수 있다고 믿는다.
    if (req >= FORBIDDEN_LEVERAGE) {
      return fail('HUNDRED_X_FORBIDDEN',
        `이 정책은 ${FORBIDDEN_LEVERAGE}배를 쓰지 않습니다 (요구: ${req}배)`
        + ' — 전용 100배 계약과 섞지 않습니다',
        { leverageVerdict: verdict });
    }
    if (!adaptiveLeverageAllows(req)) {
      return fail('LEVERAGE_NOT_ON_LADDER',
        `요구 배율 ${req}배는 이 정책의 사다리에 없습니다`,
        { leverageVerdict: verdict });
    }
    leverage = Math.min(leverage, req);
  }

  // ── ④ 마지막 관문 ──
  //
  // 여기까지 오면 사다리 값이어야 한다. 아니면 위 판정이 깨진 것이고,
  // 그때 주문을 내는 것보다 멈추는 쪽이 싸다.
  if (leverage >= FORBIDDEN_LEVERAGE) {
    return fail('HUNDRED_X_FORBIDDEN',
      `판정이 ${leverage}배를 냈습니다 — 이 정책에 그 값은 없습니다`,
      { leverageVerdict: verdict });
  }
  if (!adaptiveLeverageAllows(leverage)) {
    return fail('LEVERAGE_NOT_ON_LADDER',
      `판정이 사다리에 없는 ${leverage}배를 냈습니다`,
      { leverageVerdict: verdict });
  }

  // ── ⑤ 수량 ──
  const sizing = planSize100x({
    requiredLeverage: leverage,
    availableUsd: i.availableUsd,
    marginAllocationPct: i.marginAllocationPct,
    referencePrice: i.referencePrice,
  });
  if (!sizing.ok || !(Number(sizing.quantity) > 0)) {
    return fail('SIZING_BLOCKED', sizing.message,
      { leverageVerdict: verdict, sizing });
  }

  const mmr = Number(i.risk?.maintenanceMarginRate) || 0;
  const liq = expectedLiquidationPrice(price, leverage, mmr);

  return {
    ok: true, code: 'OK',
    leverage,
    quantity: Number(sizing.quantity),
    allocatedMargin: Number(sizing.allocatedMargin),
    targetNotional: Number(sizing.targetNotional),
    liquidationPrice: { long: liq.long, short: liq.short },
    leverageVerdict: verdict, sizing,
    message: `${leverage}배 · 수량 ${sizing.quantity} · ${verdict.message}`,
  };
}
