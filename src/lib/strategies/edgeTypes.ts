// src/lib/strategies/edgeTypes.ts
//
// **가정한 우위와 측정한 우위를 타입으로 갈라 놓는다.**
//
// `edgePp`는 몬테카를로에서 승률을 임의로 올려 넣는 **가정값**이다.
// 무우위 승률이 33%일 때 `+10%p`를 넣으면 43%라고 치고 돌린다. 당연히
// 결과가 좋아진다 — 그건 전략이 우위를 가졌다는 뜻이 아니라 **계산기에
// 유리한 값을 넣은 것**이다.
//
// 그런데 화면의 버튼 라벨이 `우위 +10%p`였다. 사람은 그 숫자를 전략의
// 속성으로 읽었고, "우위 10%를 켜면 돈을 벌고 끄면 청산이 쏟아진다"는
// 관찰이 나왔다. 맞는 관찰이지만 **전략의 성질이 아니라 산수의 성질**이다.
//
// 왜 주석이 아니라 타입인가
// ────────────────────────
// "실행 코드에서는 쓰지 마세요"라는 주석은 언젠가 지나친다. 두 값이
// 그냥 `number`면 대입이 되고, 대입되는 순간 아무도 못 알아챈다.
//
// 그래서 서로 대입할 수 없게 만든다. `MeasuredEdge`가 필요한 자리에
// `AssumedEdge`를 넣으면 **컴파일이 실패한다.**

/** 사람이 넣은 가정. **연구용이고, 증거가 아니다** */
export type AssumedEdge = number & { readonly __edge: 'ASSUMED' };

/** 실제 결과에서 잰 값. 비용을 뺀 뒤의 것이다 */
export type MeasuredEdge = number & { readonly __edge: 'MEASURED' };

/**
 * 가정값을 만든다.
 *
 * **이 함수는 연구 코드에서만 부른다.** 실행 경로가 이걸 부르면
 * `scripts/check-research-isolation.mjs`가 CI에서 실패시킨다.
 */
export function assumedEdge(pp: number): AssumedEdge {
  const n = Number(pp);
  return (Number.isFinite(n) ? n : 0) as AssumedEdge;
}

export interface MeasuredEdgeInput {
  /** 표본 수 (거래 건수) */
  trades: number | null | undefined;
  /** 이긴 거래 수 */
  wins: number | null | undefined;
  /** **비용을 뺀 뒤**의 1회 기대값 */
  expectancyAfterCost: number | null | undefined;
  /** 표본 밖(OOS) 거래 수 */
  oosTrades?: number | null;
}

export interface MeasuredEdgeResult {
  /** 잰 값. **증거가 모자라면 null이다** */
  edge: MeasuredEdge | null;
  /** 승률 (0~1). 못 재면 null */
  winRate: number | null;
  code: 'MEASURED' | 'NOT_ENOUGH_SAMPLE' | 'NO_OOS' | 'NEGATIVE_AFTER_COST' | 'UNKNOWN';
  reason: string;
}

/** 이 표본보다 적으면 우위를 쟀다고 말하지 않는다 */
export const MIN_TRADES = 100;
/** 표본 밖 거래가 이보다 적으면 과최적화를 배제할 수 없다 */
export const MIN_OOS_TRADES = 30;

/**
 * 실제 결과에서 우위를 잰다.
 *
 * **비용을 뺀 뒤가 아니면 우위가 아니다.** 100배로 자주 들어가면
 * 수수료가 손익보다 커지는 구간이 있고, 무기한은 8시간마다 펀딩을 낸다.
 * 비용 전 기대값이 양수인 것은 흔하고, 그건 우위가 아니다.
 *
 * **표본이 모자라면 null이다.** 20번 이겨서 나온 60% 승률은 우연과
 * 구분되지 않는다.
 */
export function measuredEdgeOf(i: MeasuredEdgeInput | null | undefined): MeasuredEdgeResult {
  // **`Number(null)`은 0이다.** 그냥 Number()로 감싸면 "못 읽음"이
  // "0건"으로 읽히고, 0건은 NOT_ENOUGH_SAMPLE이라는 **다른 사실**이 된다.
  // 이 저장소가 가장 자주 고친 고장이 정확히 그것이라 여기서 갈라 둔다.
  const numOrNull = (v: any): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const trades = numOrNull(i?.trades);
  const wins = numOrNull(i?.wins);
  const exp = numOrNull(i?.expectancyAfterCost);

  if (trades == null || wins == null) {
    return { edge: null, winRate: null, code: 'UNKNOWN',
      reason: '거래 표본을 읽지 못했습니다 — 우위를 쟀다고 말하지 않습니다' };
  }
  if (trades < MIN_TRADES) {
    return { edge: null, winRate: null, code: 'NOT_ENOUGH_SAMPLE',
      reason: `거래 ${trades}건으로는 우위를 재지 않습니다 (최소 ${MIN_TRADES}건) — `
        + '적은 표본의 승률은 우연과 구분되지 않습니다' };
  }
  // 표본 밖 거래는 **안 준 것과 0건이 같은 뜻이다** (검증 안 됨).
  const oos = numOrNull(i?.oosTrades) ?? 0;
  if (oos < MIN_OOS_TRADES) {
    return { edge: null, winRate: null, code: 'NO_OOS',
      reason: `표본 밖 거래가 ${oos}건입니다 (최소 ${MIN_OOS_TRADES}건) — `
        + '표본 안에서만 좋은 것은 과최적화와 구분되지 않습니다' };
  }
  if (exp == null) {
    return { edge: null, winRate: null, code: 'UNKNOWN',
      reason: '비용을 뺀 기대값을 읽지 못했습니다 — 0으로 치지 않습니다' };
  }
  if (exp <= 0) {
    return { edge: null, winRate: trades > 0 ? wins / trades : null, code: 'NEGATIVE_AFTER_COST',
      reason: '수수료·펀딩·슬리피지를 뺀 기대값이 0 이하입니다 — 우위가 없습니다' };
  }

  const winRate = wins / trades;
  return {
    edge: winRate as MeasuredEdge, winRate, code: 'MEASURED',
    reason: `거래 ${trades}건(표본 밖 ${oos}건) · 비용 차감 후 기대값 ${exp.toFixed(4)}`,
  };
}

// ── 화면에 무엇을 적을 것인가 ──

export interface EdgeDisplay {
  /** 화면에 그대로 쓸 한 줄 */
  label: string;
  /** 이것이 증거인가 */
  isEvidence: boolean;
  detail: string;
}

/**
 * 실제 전략 카드에 적을 말.
 *
 * **증거가 없으면 "검증된 우위 없음"이다.** 가정값을 그 자리에 적지 않는다.
 */
export function edgeDisplay(m: MeasuredEdgeResult | null | undefined): EdgeDisplay {
  if (!m || m.code !== 'MEASURED' || m.edge == null) {
    return {
      label: '검증된 우위 없음',
      isEvidence: false,
      detail: m?.reason || '아직 재지 않았습니다',
    };
  }
  return {
    label: `측정된 승률 ${(m.winRate! * 100).toFixed(1)}%`,
    isEvidence: true,
    detail: m.reason,
  };
}
