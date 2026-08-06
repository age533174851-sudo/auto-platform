// src/lib/markets/priceBasis.ts
//
// **어느 가격으로 재는가.**
//
// 무기한 선물에는 값이 셋 있고, 셋이 서로 다르다.
//
//   체결가(Last)   — 방금 이 거래소에서 실제로 체결된 가격
//   마크가(Mark)   — 여러 거래소의 지수에 펀딩을 얹어 만든 공정가
//   지수가(Index)  — 현물 거래소들의 가중평균
//
// 평소에는 0.0x% 차이라 같은 값처럼 보인다. 그래서 화면은 어느 것을
// 쓰는지 적지 않았고, 아무도 묻지 않았다.
//
// 그런데 **거래소가 무엇으로 판정하는지는 항목마다 다르다.**
//
//   청산       → 마크가. 언제나. 체결가로는 청산되지 않는다
//   미실현손익 → 마크가
//   손절 발동  → 주문의 workingType이 정한다 (이 저장소 기본은 마크가)
//   내 체결가  → 체결가. 마크가로는 체결되지 않는다
//
// 급락 몇 초 동안 둘은 1%씩 벌어진다. 그때 이런 일이 난다:
//
//   · 화면은 체결가 기준 "청산가까지 19.6%"라고 적는데 마크가로는 18.1%다
//   · 차트의 체결가는 손절선을 안 건드렸는데 손절이 발동한다
//     — 마크가가 건드렸기 때문이다. 사용자에게는 이유 없는 손절로 보인다
//
// 이 파일이 하는 일은 하나다: **항목마다 맞는 기준을 고르고, 그 기준을
// 못 구했을 때 조용히 다른 값으로 바꾸지 않는다.**
//
// 대체가 필요하면 부르는 쪽이 명시적으로 허락하고, 그러면 결과에
// `substituted: true`가 붙는다. 화면은 그것을 적어야 한다 — 마크가 자리에
// 체결가를 넣어 놓고 '마크가'라고 쓰면, 그건 없는 것보다 나쁘다.

export type PriceKind = 'LAST' | 'MARK' | 'INDEX';

export type PricePurpose =
  /** 시장가 체결 추정 · 명목가 · 증거금 */
  | 'EXECUTION'
  /** 손절·익절 발동 */
  | 'TRIGGER'
  /** 청산가까지의 거리 */
  | 'LIQUIDATION'
  /** 미실현 손익 */
  | 'PNL'
  /** 펀딩비 */
  | 'FUNDING';

export interface Quotes {
  last?: number | null;
  mark?: number | null;
  index?: number | null;
}

export interface BasisPick {
  /** 실제로 쓴 기준. 아무것도 못 구했으면 null */
  kind: PriceKind | null;
  price: number | null;
  /** 이 항목에 **원래 맞는** 기준 */
  wanted: PriceKind;
  /** 원하는 기준을 못 구해 다른 것으로 바꿨는가 */
  substituted: boolean;
  /** '마크가' — 화면에 그대로 적는다 */
  label: string;
  /** 왜 이 값인가 · 왜 못 구했는가 */
  reason: string;
}

export const LABEL: Record<PriceKind, string> = {
  LAST: '체결가', MARK: '마크가', INDEX: '지수가',
};

/**
 * 체결가와 마크가가 이만큼 벌어지면 화면이 말해야 한다.
 *
 * 평소 차이는 0.0x%다. 0.3%면 "평소가 아니다"라고 할 만하고, 그 구간에서
 * 체결가로 잰 청산 거리는 눈에 띄게 틀린다.
 */
export const DIVERGENCE_WARN_PCT = 0.3;

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 이 항목에 맞는 기준.
 *
 * `workingType`은 손절 주문에만 의미가 있다 — 거래소가 그 주문을 무엇으로
 * 발동시키는지 말해 주는 값이다. 안 주면 마크가로 본다(이 저장소가 거는
 * 주문의 기본값이고, Gate의 조건부 주문도 마크가 기준이다).
 */
export function basisFor(purpose: PricePurpose, workingType?: any): PriceKind {
  if (purpose === 'EXECUTION') return 'LAST';
  if (purpose === 'FUNDING') return 'INDEX';
  if (purpose === 'TRIGGER') {
    const wt = String(workingType ?? '').trim().toUpperCase();
    // 바이낸스: MARK_PRICE | CONTRACT_PRICE. CONTRACT_PRICE가 체결가다.
    if (wt === 'CONTRACT_PRICE' || wt === 'LAST_PRICE' || wt === 'LAST') return 'LAST';
    return 'MARK';
  }
  // LIQUIDATION · PNL — 거래소가 마크가로 판정한다. 예외 없다.
  return 'MARK';
}

export interface PriceForOptions {
  /** 손절 주문의 발동 기준 (TRIGGER에만 쓰인다) */
  workingType?: any;
  /**
   * 원하는 기준을 못 구했을 때 **다른 값으로 대체해도 되는가.**
   *
   * 기본은 안 된다. 청산 거리를 체결가로 재고 '마크가 기준'이라고 적으면,
   * 그건 모르는 것보다 나쁘다 — 사용자가 그 숫자를 믿고 크기를 정한다.
   */
  allowSubstitute?: boolean;
}

/** 대체 순서. 가까운 값부터 — 마크가가 없으면 지수가가 체결가보다 가깝다 */
const FALLBACK: Record<PriceKind, PriceKind[]> = {
  MARK: ['INDEX', 'LAST'],
  INDEX: ['MARK', 'LAST'],
  LAST: ['MARK', 'INDEX'],
};

/**
 * 이 항목을 잴 가격.
 *
 * **못 구한 것을 조용히 메우지 않는다.** allowSubstitute 없이 마크가가
 * 비면 price는 null이고, 화면은 숫자 대신 '확인 불가'를 적어야 한다.
 */
export function priceFor(
  purpose: PricePurpose, q: Quotes | null | undefined, opts: PriceForOptions = {},
): BasisPick {
  const quotes = q ?? {};
  const values: Record<PriceKind, number | null> = {
    LAST: num(quotes.last), MARK: num(quotes.mark), INDEX: num(quotes.index),
  };
  const wanted = basisFor(purpose, opts.workingType);

  const direct = values[wanted];
  if (direct != null) {
    return {
      kind: wanted, price: direct, wanted, substituted: false,
      label: LABEL[wanted], reason: '',
    };
  }

  if (!opts.allowSubstitute) {
    return {
      kind: null, price: null, wanted, substituted: false,
      label: LABEL[wanted],
      reason: `${LABEL[wanted]}를 읽지 못했습니다 — 다른 가격으로 대신 계산하지 않습니다`,
    };
  }

  for (const alt of FALLBACK[wanted]) {
    const v = values[alt];
    if (v == null) continue;
    return {
      kind: alt, price: v, wanted, substituted: true,
      label: LABEL[alt],
      reason: `${LABEL[wanted]}를 읽지 못해 ${LABEL[alt]}로 대신 계산했습니다 — 실제 판정 기준과 다릅니다`,
    };
  }

  return {
    kind: null, price: null, wanted, substituted: false,
    label: LABEL[wanted], reason: '가격을 하나도 읽지 못했습니다',
  };
}

export interface BasisGap {
  /** (마크가 - 체결가) / 마크가 × 100. 부호 있음. 못 구하면 null */
  pct: number | null;
  /** 평소가 아닌가 */
  diverged: boolean;
  /** 화면에 적을 한 줄. 벌어지지 않았으면 빈 문자열 */
  text: string;
}

/**
 * 체결가와 마크가가 얼마나 벌어져 있는가.
 *
 * 이 값이 커지는 순간이 정확히 **화면의 숫자가 거짓말하는 순간**이다.
 * 차트는 체결가로 그려지는데 청산과 손절은 마크가로 판정되므로,
 * 사용자가 보는 선과 거래소가 보는 선이 다르다.
 */
export function basisGap(q: Quotes | null | undefined): BasisGap {
  const last = num(q?.last);
  const mark = num(q?.mark);
  if (last == null || mark == null) {
    return { pct: null, diverged: false, text: '' };
  }
  const pct = ((mark - last) / mark) * 100;
  const diverged = Math.abs(pct) >= DIVERGENCE_WARN_PCT;
  return {
    pct,
    diverged,
    text: diverged
      ? `체결가와 마크가가 ${Math.abs(pct).toFixed(2)}% 벌어져 있습니다`
        + ` — 청산과 손절은 ${LABEL.MARK}로 판정됩니다`
      : '',
  };
}

/**
 * 가격 옆에 붙일 짧은 꼬리표.
 *
 * 평소에는 굳이 안 띄워도 된다 — 셋이 붙어 있을 때 매번 '체결가'라고
 * 적으면 글자만 늘고, 정작 벌어졌을 때의 경고가 그 사이에 묻힌다.
 * `always`를 켜면 언제나 적는다(진단 화면용).
 */
export function basisTag(p: BasisPick, q?: Quotes | null, always = false): string {
  if (p.substituted) return `${p.label}(대체)`;
  if (p.kind == null) return '확인 불가';
  if (always) return p.label;
  return basisGap(q).diverged ? p.label : '';
}
