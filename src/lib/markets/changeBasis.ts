// src/lib/markets/changeBasis.ts
//
// **"얼마나 올랐나"가 무엇 대비인지 적는다.**
//
// 두 가지가 섞여 있었다
// ─────────────────────
// 주식의 `전일대비`는 **어제 종가** 대비다. 장이 닫혀 있는 동안 값이
// 고정되고, 그래서 "어제보다 +2.3%"가 성립한다.
//
// 코인에는 어제 종가가 없다. 장이 닫히지 않으므로 종가라는 것 자체가
// 없다. 지금 화면이 쓰는 값은 거래소 티커의 **24시간 롤링 변동률**이다 —
// 24시간 전 그 시각 대비이고, 매초 기준점이 움직인다.
//
// 이 둘을 같은 `전일대비`라는 말로 적으면 사용자는 코인 숫자를 어제
// 종가 대비로 읽는다. 장 마감이 없는 시장에서 그 해석은 틀렸고, 틀린 줄
// 알 방법도 없다 — 숫자는 멀쩡해 보인다.
//
// **없는 기준을 만들지 않는다**
// ─────────────────────────────
// 주식에 전일 종가가 없으면 24시간 변동률로 대신 적지 않는다. 반대도
// 마찬가지다. 기준을 모르면 `UNKNOWN`이고, 화면은 값을 비운다.

export type ChangeBasis =
  /** 어제 종가 대비 — 장이 닫히는 시장 */
  | 'PREVIOUS_CLOSE'
  /** 24시간 롤링 — 장이 닫히지 않는 시장 */
  | 'ROLLING_24H'
  /** 무엇 대비인지 모른다. 숫자를 적지 않는다 */
  | 'UNKNOWN';

/** 값이 아니라 **말**이다. 화면이 이 문구를 그대로 쓴다. */
export interface ChangeLabel {
  basis: ChangeBasis;
  /** 옆에 붙는 기준 이름 */
  label: string;
  /** 길게 적을 자리가 있을 때 */
  full: string;
}

const LABELS: Record<ChangeBasis, ChangeLabel> = {
  PREVIOUS_CLOSE: { basis: 'PREVIOUS_CLOSE', label: '전일대비', full: '어제 종가 대비' },
  ROLLING_24H: { basis: 'ROLLING_24H', label: '24시간', full: '24시간 전 대비' },
  UNKNOWN: { basis: 'UNKNOWN', label: '기준 미상', full: '무엇 대비인지 확인하지 못했습니다' },
};

/**
 * 이 시장의 변동률은 무엇 대비인가.
 *
 * 시장 종류가 정한다 — 화면이 고르지 않는다. 모르는 시장은 `UNKNOWN`이고,
 * 그때는 **숫자를 적지 않는 쪽**이 맞다.
 */
export function changeBasisOf(market: any): ChangeBasis {
  const m = String(market ?? '').toUpperCase();
  // 장이 닫히지 않는 시장 — 종가가 없다
  if (m === 'SPOT' || m === 'USDM' || m === 'COINM' || m === 'CRYPTO') return 'ROLLING_24H';
  // 장이 닫히는 시장 — 어제 종가가 있다
  if (m === 'STOCK' || m === 'KRSTOCK' || m === 'EQUITY' || m === 'ETF') return 'PREVIOUS_CLOSE';
  return 'UNKNOWN';
}

export function changeLabelOf(market: any): ChangeLabel {
  return LABELS[changeBasisOf(market)];
}

export interface ChangeView {
  basis: ChangeBasis;
  label: string;
  /** 변동률(%). 기준이나 값을 모르면 null — **0이 아니다** */
  pct: number | null;
  /** 변동액. 기준가를 모르면 null */
  amount: number | null;
  /** 값을 못 적는 이유. 적을 수 있으면 null */
  unknownReason: string | null;
}

/**
 * 화면에 그대로 쓸 한 벌.
 *
 * `referencePrice`는 **그 기준의 가격**이다 — 주식이면 어제 종가, 코인이면
 * 24시간 전 값. 안 주면 변동액을 내지 않는다. **여기서 지어내지 않는다.**
 */
export function changeView(i: {
  market: any;
  price?: any;
  referencePrice?: any;
  /** 거래소가 이미 준 변동률이 있으면 그것을 쓴다 (다시 계산하지 않는다) */
  changePct?: any;
}): ChangeView {
  const basis = changeBasisOf(i.market);
  const label = LABELS[basis].label;

  if (basis === 'UNKNOWN') {
    return {
      basis, label, pct: null, amount: null,
      unknownReason: '이 시장의 변동률 기준을 정하지 못했습니다',
    };
  }

  const price = num(i.price);
  const ref = num(i.referencePrice);
  const given = num(i.changePct);

  // 거래소가 준 변동률이 먼저다. 우리가 다시 계산하면 반올림이 갈린다.
  const pct = given != null ? given
    : (price != null && ref != null && ref !== 0) ? ((price - ref) / ref) * 100
    : null;
  const amount = (price != null && ref != null) ? price - ref : null;

  return {
    basis, label, pct, amount,
    unknownReason: pct == null
      ? `${LABELS[basis].full} 값을 받지 못했습니다 — 0이라는 뜻이 아닙니다`
      : null,
  };
}

/** `Number(null)`은 0이다. 못 읽은 값이 0이 되면 "변동 없음"으로 읽힌다. */
function num(v: any): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
