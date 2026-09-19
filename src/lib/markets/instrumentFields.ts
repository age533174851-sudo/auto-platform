// src/lib/markets/instrumentFields.ts
//
// **종목 상세가 어떤 칸을 그려도 되는가 — 한 곳에서 답한다.**
//
// 새 화면을 만들 때 가장 쉬운 실수는 칸을 먼저 만드는 것이다. 배당
// 수익률 자리를 만들어 두면 누군가 숫자를 채우고, 그 숫자가 어디서
// 왔는지는 몇 달 뒤에 아무도 모른다.
//
// 이 저장소에는 이미 그렇게 들어온 값이 있다.
//
//   `MCAP_QUARANTINED_NOT_REAL`  손으로 적은 시가총액 (격리함)
//   `AutoBotLabPage`의 표         삼성전자 시총 4.7e14 · ROE 11.2 ·
//                                 영업이익률 18.5 — 전부 손으로 적은 값
//
// 둘 다 오류를 내지 않는다. 화면에서는 실제 값과 구별되지 않는다.
//
// 그래서 칸을 만들기 전에 **출처가 있는가**를 묻는다. 없으면 칸을 만들지
// 않거나(`HIDDEN`), 없다고 적는다(`UNAVAILABLE`). 채우지 않는다.

/** 이 자산이 어떤 종류인가 — 칸의 유무는 여기서 갈린다 */
export type InstrumentKind = 'CRYPTO' | 'EQUITY' | 'UNKNOWN';

export type FieldAvailability =
  /** 지금 실제 값이 온다 */
  | 'AVAILABLE'
  /** 이 자산에는 그 개념이 없다 — 칸 자체를 그리지 않는다 */
  | 'HIDDEN'
  /** 개념은 있는데 출처가 없다 — 칸은 있고 "확인 불가"라고 적는다 */
  | 'UNAVAILABLE';

export interface FieldVerdict {
  availability: FieldAvailability;
  /** 왜 못 보여주는가. AVAILABLE이면 null */
  reason: string | null;
}

export function instrumentKindOf(market: any): InstrumentKind {
  const m = String(market ?? '').toUpperCase();
  if (m === 'SPOT' || m === 'USDM' || m === 'COINM' || m === 'CRYPTO' || m === 'COIN') return 'CRYPTO';
  if (m === 'STOCK' || m === 'KRSTOCK' || m === 'EQUITY' || m === 'ETF') return 'EQUITY';
  return 'UNKNOWN';
}

const OK: FieldVerdict = { availability: 'AVAILABLE', reason: null };

/**
 * 시가총액.
 *
 * **지금은 어디서도 못 온다.** 유일하게 있던 값이 손으로 적은 표였고
 * 격리했다. 개념 자체는 코인에도 주식에도 있으므로 숨기지 않고 **없다고
 * 적는다** — 칸이 사라지면 "이 자산은 시총이 없다"로 읽힌다.
 */
export function marketCapField(_market: any): FieldVerdict {
  return {
    availability: 'UNAVAILABLE',
    reason: '시가총액 공급자가 연결되어 있지 않습니다 — 0이라는 뜻이 아닙니다',
  };
}

/**
 * 배당.
 *
 * 코인에는 **개념이 없다** — 칸을 그리면 "배당이 0인 자산"으로 읽힌다.
 * 주식에는 있지만 종목별 배당 이력·수익률 공급자가 아직 없다
 * (`/api/eodhd/calendar`는 기간 캘린더라 종목 상세가 아니다).
 */
export function dividendField(market: any): FieldVerdict {
  const kind = instrumentKindOf(market);
  if (kind === 'CRYPTO') {
    return { availability: 'HIDDEN', reason: '암호화폐에는 배당 개념이 없습니다' };
  }
  if (kind === 'EQUITY') {
    return {
      availability: 'UNAVAILABLE',
      reason: '종목별 배당 공급자가 연결되어 있지 않습니다',
    };
  }
  return { availability: 'HIDDEN', reason: '자산 종류를 확인하지 못했습니다' };
}

/**
 * 기업정보(ROE·영업이익률·부채비율 등).
 *
 * `AutoBotLabPage`에 표가 하나 있지만 **손으로 적은 값**이다. 그 표를
 * 상세 화면으로 끌어오면 지어낸 펀더멘털이 실제처럼 읽힌다. 공급자가
 * 생기기 전까지는 없다고 적는다.
 */
export function companyInfoField(market: any): FieldVerdict {
  const kind = instrumentKindOf(market);
  if (kind === 'CRYPTO') {
    return { availability: 'HIDDEN', reason: '암호화폐에는 기업정보가 없습니다' };
  }
  return {
    availability: 'UNAVAILABLE',
    reason: '기업정보 공급자가 연결되어 있지 않습니다',
  };
}

/**
 * 뉴스.
 *
 * 정본은 `/api/news/stored`뿐이다(`affected_assets`로 심볼이 매핑된다).
 * `/api/market/news`의 지어낸 기사는 **여기로 들어오지 않는다.**
 */
export function newsField(_market: any): FieldVerdict {
  return OK;
}

/** 봉·거래량은 `fetchVenueBars` 정본에서 온다 */
export function chartField(market: any): FieldVerdict {
  return instrumentKindOf(market) === 'UNKNOWN'
    ? { availability: 'UNAVAILABLE', reason: '자산 종류를 확인하지 못해 시세 출처를 정하지 못했습니다' }
    : OK;
}

/** 화면이 한 번에 묻는 자리 */
export interface InstrumentFieldPlan {
  kind: InstrumentKind;
  marketCap: FieldVerdict;
  dividend: FieldVerdict;
  companyInfo: FieldVerdict;
  news: FieldVerdict;
  chart: FieldVerdict;
}

export function instrumentFieldPlan(market: any): InstrumentFieldPlan {
  return {
    kind: instrumentKindOf(market),
    marketCap: marketCapField(market),
    dividend: dividendField(market),
    companyInfo: companyInfoField(market),
    news: newsField(market),
    chart: chartField(market),
  };
}
