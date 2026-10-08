// src/lib/engine/postEntryRisk.ts
//
// **⑤B-0/1 — 열려 있는 100배 포지션의 위험을 *재기만* 한다.**
//
// 이 파일은 아무것도 닫지 않는다
// ──────────────────────────────
// 종료 판단이 없다. 문턱이 없다. 주문을 낼 수단이 타입에 없다 —
// 거래소를 바꾸는 함수를 하나도 import하지 않는다. ⑤B-2/3가 문턱을
// 유도할 때 **그 근거가 될 관측**을 만드는 것이 전부다.
//
// 왜 재는 것과 판단하는 것을 나누는가: 숫자를 먼저 정하고 측정기를
// 만들면 그 숫자를 정당화하는 측정기가 나온다. 이 저장소가
// `liquidationProximityRatio: 0.35`를 근거 없이 들고 있는 것이 그 모양이다.
//
// 새 공식을 쓰지 않는다
// ─────────────────────
// 청산가 추정은 `assessLiquidationDistance`(→ `solveLiquidationPrice`)
// **하나**를 그대로 부른다. 여기서 다시 풀면 두 벌이 되고, 언젠가 한쪽만
// 고쳐진다.
//
// 다만 그 함수의 `ok`를 **이 측정의 정본으로 쓰지 않는다.** 그 `ok`에는
// "변동성 위험거리와 비교해서 충분한가"가 섞여 있는데, post-entry에는
// 그 비교 기준이 장부(091)에서 오고 없을 수도 있다. 측정 자체를 믿을 수
// 있는가는 `trustworthy`가 답한다 — 그 구분은 이미 그 파일이 세워 둔
// 것이고, 여기서 뒤집지 않는다.
//
// ★ 두 청산가의 출처를 **절대 섞지 않는다**
// ─────────────────────────────────────────
//   거래소값 (1차 정본)  positionRisk.liquidationPrice
//     실제로 청산을 실행하는 주체가 거래소다. 계좌 상태(교차 마진의
//     다른 포지션, 추가 증거금)가 반영될 수 있다.
//
//     ★ 이 값에는 **전용 거래소 시각이 없다.** `positionRisk.updateTime`을
//       "청산가가 계산된 시각"으로 간주하지 않는다 — 문서상 그것은
//       포지션의 갱신 시각이다. 우리가 적을 수 있는 것은 응답을 받은
//       시각(`receivedAtMs`)뿐이고, `exchangeTimeMs`는 **지어내지 않는다.**
//
//   내부값 (독립 검증자)  solveLiquidationPrice
//     브래킷·배율·증거금 구조만으로 푼 값. 거래소값보다 **우선하지 않는다.**
//
// 현재 가격은 둘 중 어느 쪽에서도 오지 않는다. `positionRisk.markPrice`
// 에는 시각이 없으므로 ④의 timestamped MARK(`readMarketSnapshot`)를
// 그대로 쓴다. 신선도 문턱도 ④의 FAST 규칙 그대로다 — **새 문턱을
// 만들지 않는다.**
//
// 두 값이 다르면
// ──────────────
// 이번 단계에서는 **차이를 기록만 한다.** 금지: 평균, 무조건 가까운 쪽
// 선택, 임의 비율·bp tolerance, 한쪽이 없을 때 다른 값으로 조용히 대체.
// `CONSISTENT`/`INCONSISTENT`로 나누지도 않는다 — 나누려면 숫자가
// 필요하고, 그 숫자의 근거가 아직 없다. 가용성만 분류한다.

import {
  assessLiquidationDistance,
  type LiquidationDistanceAssessment,
} from './liquidationDistance';
import {
  assessMarketFreshness, type MarketObservation,
  type MarketFreshnessAssessment,
} from './marketFreshness';
import type { BracketTier } from '../safety/liquidationPrice';

/** 두 청산가가 각각 **있는가.** 값의 일치 여부가 아니다 */
export type LiquidationSourceStatus =
  | 'BOTH_AVAILABLE'
  | 'EXCHANGE_ONLY'
  | 'INTERNAL_ONLY'
  | 'BOTH_UNAVAILABLE';

/**
 * 이 측정을 **쓸 수 있는가.**
 *
 * ★ `RISK_DATA_UNUSABLE`은 **종료 사유가 아니다.** 감시 상태다.
 *   모르는 것을 "위험하다"로 읽으면 멀쩡한 포지션을 닫게 된다 —
 *   `positionGuard`가 마크가를 못 읽었을 때 ALERT에서 멈추는 것과
 *   같은 이유다. 이 값이 무엇이든 시장가 주문은 0건이다.
 */
export type PostEntryRiskStatus =
  /** 쟀다. 판단했다는 뜻이 **아니다** */
  | 'MEASURED'
  /** 재지 못했다. **위험하다는 뜻이 아니다** */
  | 'RISK_DATA_UNUSABLE';

/** 어느 값이 어디서 왔는가. **두 출처를 한 칸에 담지 않는다** */
export interface LiquidationProvenance {
  /**
   * `liquidationPrice`를 준 엔드포인트. 못 받았으면 null.
   *
   * 포지션 조회는 한 번의 왕복이 아니다(v2 → v3 → account). 어느 쪽이
   * 답했는지를 적어야 아래 두 시각이 무엇의 경계인지 말할 수 있다.
   */
  positionRiskSource: 'V2' | 'V3' | null;
  /** 그 요청을 **보내기 직전** 시각 */
  positionRiskRequestStartedAtMs: number | null;
  /**
   * 그 응답을 **받은 직후** 시각.
   *
   * ★ 부르는 쪽이 helper 호출 **전에** 찍은 시각이 아니다. 그렇게 하면
   *   왕복 두세 번만큼 앞선 값이 "받은 시각"으로 기록된다 — ⑤B-0이
   *   모으려는 관측이 그 자리에서 오염된다.
   * ★ 그 뒤 계정 조회를 더 해도 이 값을 덮어쓰지 않는다. 청산가는 그
   *   응답에 들어 있지 않다.
   */
  positionRiskReceivedAtMs: number | null;
  /**
   * wall-clock 두 시각의 차(ms). **provenance 참고값이다.**
   *
   * ★ ⑤B-3의 지연 표본으로 **이 값을 쓰지 않는다.** epoch 기반이라
   *   NTP 보정이나 시계 점프에 오염된다 — 보정 한 번이 문턱을 바꾼다.
   *   그 용도는 아래 `positionRiskElapsedMs`(단조)다.
   */
  positionRiskWallClockDeltaMs: number | null;
  /**
   * **단조 시계로 잰** 성공한 positionRisk 왕복 시간(ms).
   *
   * duration이지 timestamp가 아니다. epoch 칸과 섞지 않는다.
   * v2 실패 후 v3면 이것은 v3 왕복이고, helper 전체는 아래 칸이다.
   */
  positionRiskElapsedMs: number | null;
  /** 계정 조회 왕복(ms, 단조) */
  accountElapsedMs: number | null;
  /** helper 전체(실패한 v2 시도 포함, ms 단조). **위 둘과 다른 값이다** */
  helperElapsedMs: number | null;
  /** 마진 모드·배율을 채우려고 부른 계정 조회. 안 불렀으면 null */
  accountRequestStartedAtMs: number | null;
  accountReceivedAtMs: number | null;
  /**
   * 거래소가 적어 준 포지션 갱신 시각. **청산가 계산 시각이 아니다.**
   *
   * 공식 응답에 `liquidationPrice` 전용 시각이 없고, 문서는 이 값을
   * 그냥 "update time"이라고만 적는다. 기록만 하고 신선도 판정에
   * 쓰지 않는다. 이름을 `liquidation…`으로 바꾸지 않는다.
   */
  positionUpdateTimeMs: number | null;
  /** 마크가의 거래소 시각 (`/fapi/v1/premiumIndex`의 `time`) */
  markExchangeTimeMs: number | null;
  markReceivedAtMs: number | null;
  markObservedAtMs: number | null;
  /** 브래킷을 관측한 시각 */
  bracketObservedAtMs: number | null;
}

export interface PostEntryRiskInput {
  side: 'LONG' | 'SHORT' | null | undefined;
  /** ④ timestamped MARK. **`positionRisk.markPrice`가 아니다** */
  mark: MarketObservation | null | undefined;
  /** 브래킷 관측 (SLOW fact) */
  bracket: MarketObservation | null | undefined;
  /** 거래소가 준 청산가. 0은 "없음"이지 "0원 청산"이 아니다 */
  exchangeLiquidationPrice: number | null | undefined;
  entryPrice: number | null | undefined;
  quantity: number | null | undefined;
  leverage: number | null | undefined;
  marginMode: 'isolated' | 'cross' | null | undefined;
  brackets: BracketTier[] | null | undefined;
  /** 091 불변 스냅숏. **없으면 null이고 0이 아니다** */
  entryAdverseDistancePct: number | null | undefined;
  entryLiquidationDistancePctRaw: number | null | undefined;
  /**
   * 출처 좌표. **`positionRiskLatencyMs`는 받지 않는다** — 파생값이라
   * 여기서 계산한다. 부르는 쪽이 넘기면 두 벌이 된다.
   */
  provenance: Omit<LiquidationProvenance, 'positionRiskWallClockDeltaMs'>;
  /** 판정 시각. **이 파일은 `Date.now()`를 부르지 않는다** */
  nowMs: number | null | undefined;
}

export interface PostEntryRiskMeasurement {
  status: PostEntryRiskStatus;
  /** 왜 못 쟀는가. 쟀으면 빈 문자열 */
  reason: string;
  /**
   * **내부 추정**(독립 검증자)을 믿을 수 있는가.
   *
   * ★ 이름이 중요하다. 예전에는 이 값이 측정 전체에 붙은
   *   `trustworthy`였는데, 그러면 브래킷을 못 읽어 내부 계산만 실패한
   *   `EXCHANGE_ONLY` 샘플이 "거래소 값도 못 믿음"으로 읽힌다.
   *   설계상 거래소 청산가가 1차 venue 관측이므로 그건 거짓이다.
   *
   *   측정 전체를 쓸 수 있는가는 `status`·`liquidationSources`·
   *   `freshness`가 이미 말한다. 새 위험 판단 boolean을 만들지 않는다.
   */
  internalTrustworthy: boolean;
  side: 'LONG' | 'SHORT' | null;
  markPrice: number | null;

  exchangeLiquidationPrice: number | null;
  estimatedLiquidationPrice: number | null;
  /** 거래소 청산가 기준 남은 여유(%). 못 구하면 null */
  exchangeHeadroomPct: number | null;
  /** 내부 추정 기준 남은 여유(%). 못 구하면 null */
  estimatedHeadroomPct: number | null;
  /** 두 청산가의 절대 차이. 한쪽이라도 없으면 null */
  absoluteDelta: number | null;
  /** 그 차이를 거래소 청산가로 나눈 비율(%). 한쪽이라도 없으면 null */
  deltaPct: number | null;
  liquidationSources: LiquidationSourceStatus;

  /** 091 스냅숏 그대로. **여기서 계산하거나 대체하지 않는다** */
  entryAdverseDistancePct: number | null;
  entryLiquidationDistancePctRaw: number | null;

  provenance: LiquidationProvenance;
  freshness: MarketFreshnessAssessment | null;
  /** 내부 추정의 원본 판정. `ok`를 정본으로 쓰지 마라 */
  internal: LiquidationDistanceAssessment | null;
}

const num = (v: unknown): number | null => {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 0과 음수는 **없음**이다. 0을 청산가로 쓰면 "이미 청산가를 지났다"가 된다 */
const price = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

const blank = (
  status: PostEntryRiskStatus, reason: string,
  p: Partial<PostEntryRiskMeasurement> = {},
): PostEntryRiskMeasurement => ({
  status, reason, internalTrustworthy: false,
  side: null, markPrice: null,
  exchangeLiquidationPrice: null, estimatedLiquidationPrice: null,
  exchangeHeadroomPct: null, estimatedHeadroomPct: null,
  absoluteDelta: null, deltaPct: null, liquidationSources: 'BOTH_UNAVAILABLE',
  entryAdverseDistancePct: null, entryLiquidationDistancePctRaw: null,
  provenance: {
    positionRiskSource: null,
    positionRiskRequestStartedAtMs: null, positionRiskReceivedAtMs: null,
    positionRiskWallClockDeltaMs: null,
    positionRiskElapsedMs: null, accountElapsedMs: null, helperElapsedMs: null,
    accountRequestStartedAtMs: null, accountReceivedAtMs: null,
    positionUpdateTimeMs: null,
    markExchangeTimeMs: null, markReceivedAtMs: null, markObservedAtMs: null,
    bracketObservedAtMs: null,
  },
  freshness: null, internal: null,
  ...p,
});

/**
 * 불리한 방향으로 마크가에서 청산가까지 남은 거리(%).
 *
 * LONG은 청산가가 **아래**, SHORT는 **위**다. 방향이 반대로 나오면
 * 이미 지난 것이므로 음수가 되고, **그 음수를 그대로 돌려준다** —
 * 0으로 깎으면 "닿았다"가 "여유 없음"이 되어 사실이 흐려진다.
 */
function headroomPct(
  side: 'LONG' | 'SHORT', mark: number, liq: number,
): number | null {
  if (!(mark > 0)) return null;
  const d = side === 'LONG' ? mark - liq : liq - mark;
  return (d / mark) * 100;
}

/**
 * **잰다. 판단하지 않는다.**
 *
 * 돌려주는 어떤 값도 "닫아라"를 뜻하지 않는다. ⑤B-2/3가 문턱을 유도할
 * 때 쓸 관측이다.
 */
export function measurePostEntryRisk(
  i: PostEntryRiskInput | null | undefined,
): PostEntryRiskMeasurement {
  const started = num(i?.provenance?.positionRiskRequestStartedAtMs);
  const received = num(i?.provenance?.positionRiskReceivedAtMs);
  const prov: LiquidationProvenance = {
    positionRiskSource: i?.provenance?.positionRiskSource ?? null,
    positionRiskRequestStartedAtMs: started,
    positionRiskReceivedAtMs: received,
    // **파생값이다.** 둘 중 하나라도 없으면 null이고 0이 아니다.
    positionRiskWallClockDeltaMs:
      started != null && received != null ? received - started : null,
    // ★ 단조 측정은 **받은 그대로 들고 다닌다.** 여기서 wall-clock으로
    //   다시 계산하지 않는다 — 그러면 분리한 의미가 되돌아간다.
    positionRiskElapsedMs: num(i?.provenance?.positionRiskElapsedMs),
    accountElapsedMs: num(i?.provenance?.accountElapsedMs),
    helperElapsedMs: num(i?.provenance?.helperElapsedMs),
    accountRequestStartedAtMs: num(i?.provenance?.accountRequestStartedAtMs),
    accountReceivedAtMs: num(i?.provenance?.accountReceivedAtMs),
    positionUpdateTimeMs: num(i?.provenance?.positionUpdateTimeMs),
    markExchangeTimeMs: num(i?.provenance?.markExchangeTimeMs),
    markReceivedAtMs: num(i?.provenance?.markReceivedAtMs),
    markObservedAtMs: num(i?.provenance?.markObservedAtMs),
    bracketObservedAtMs: num(i?.provenance?.bracketObservedAtMs),
  };
  // 091 스냅숏은 **그대로 들고 다닌다.** 없으면 null이다 — 0으로 바꾸거나
  // 지금 ATR을 재서 채우지 않는다.
  const snap = {
    entryAdverseDistancePct: num(i?.entryAdverseDistancePct),
    entryLiquidationDistancePctRaw: num(i?.entryLiquidationDistancePctRaw),
  };
  const base = { provenance: prov, ...snap };

  const side = i?.side === 'LONG' || i?.side === 'SHORT' ? i.side : null;
  if (side == null) {
    return blank('RISK_DATA_UNUSABLE', '포지션 방향을 읽지 못했습니다', base);
  }

  // ── 신선도는 ④ 정본이 판정한다. **여기에 문턱을 적지 않는다** ──
  const freshness = assessMarketFreshness({
    observations: [i?.mark ?? null, i?.bracket ?? null],
    required: ['MARK'],
    nowMs: num(i?.nowMs),
  });
  const markPrice = price(i?.mark?.value);
  if (!freshness.ok || markPrice == null) {
    return blank('RISK_DATA_UNUSABLE',
      markPrice == null
        ? '기준 마크가를 읽지 못했습니다 — 거리를 잴 기준이 없습니다'
        : `시장 데이터 신선도 (${freshness.code}) — ${freshness.reason}`,
      { ...base, side, freshness });
  }

  // ── 내부 추정 (독립 검증자) ──
  //
  // `adverseDistancePct`를 **넘기지 않는다.** 진입 허가의 비교는 이미
  // 끝났고, post-entry 비교 기준은 091 스냅숏이지 지금 재는 ATR이 아니다.
  // 넘기지 않으면 `ADVERSE_DISTANCE_UNKNOWN`으로 `ok: false`가 되지만
  // `trustworthy`는 참이다 — 그 구분이 여기서 쓰는 것이다.
  const internal = assessLiquidationDistance({
    side, referencePrice: markPrice, entryPrice: price(i?.entryPrice) ?? markPrice,
    quantity: num(i?.quantity), leverage: num(i?.leverage),
    marginMode: i?.marginMode ?? null, brackets: i?.brackets ?? null,
    adverseDistancePct: null, headroomKind: 'RAW',
  });

  const exLiq = price(i?.exchangeLiquidationPrice);
  const inLiq = internal.trustworthy ? price(internal.estimatedLiquidationPrice) : null;

  const sources: LiquidationSourceStatus =
    exLiq != null && inLiq != null ? 'BOTH_AVAILABLE'
      : exLiq != null ? 'EXCHANGE_ONLY'
        : inLiq != null ? 'INTERNAL_ONLY'
          : 'BOTH_UNAVAILABLE';

  // ★ **한쪽이 없을 때 다른 쪽으로 대체하지 않는다.** 각 칸은 자기
  //   출처의 값만 담는다. 비는 칸은 null이고, 그 null이 상태에 드러난다.
  const exHead = exLiq == null ? null : headroomPct(side, markPrice, exLiq);
  const inHead = inLiq == null ? null : headroomPct(side, markPrice, inLiq);

  // ★ 차이는 **기록만** 한다. 평균도, 가까운 쪽 선택도, tolerance도 없다.
  const absoluteDelta = exLiq != null && inLiq != null ? Math.abs(exLiq - inLiq) : null;
  const deltaPct = absoluteDelta != null && exLiq != null && exLiq > 0
    ? (absoluteDelta / exLiq) * 100 : null;

  const measured: PostEntryRiskMeasurement = {
    // ★ 내부 검증자의 신뢰도일 뿐이다. 측정 전체의 신뢰도가 아니다.
    status: 'MEASURED', reason: '', internalTrustworthy: internal.trustworthy,
    side, markPrice,
    exchangeLiquidationPrice: exLiq, estimatedLiquidationPrice: inLiq,
    exchangeHeadroomPct: exHead, estimatedHeadroomPct: inHead,
    absoluteDelta, deltaPct, liquidationSources: sources,
    ...snap, provenance: prov, freshness, internal,
  };

  if (sources === 'BOTH_UNAVAILABLE') {
    return { ...measured, status: 'RISK_DATA_UNUSABLE',
      reason: `청산가를 어느 쪽에서도 구하지 못했습니다`
        + ` (거래소 응답 ${i?.exchangeLiquidationPrice == null ? '없음' : '0/음수'}`
        + ` · 내부 추정 ${internal.code})` };
  }
  return measured;
}
