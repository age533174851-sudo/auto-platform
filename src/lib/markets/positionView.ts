// src/lib/markets/positionView.ts
//
// 거래소가 준 포지션 원본을 화면에 쓸 값으로 바꾼다.
//
// 왜 컴포넌트 밖으로 빼는가
// ─────────────────────────
// 이 카드에서 틀리면 안 되는 계산이 셋 있다. 청산가가 0일 때, 증거금을
// 거래소가 안 줄 때, 수익률의 분모가 0일 때. 셋 다 화면에서는 그럴듯한
// 숫자로 보이기 때문에 눈으로는 틀린 걸 알 수 없다. 그래서 테스트가
// 붙는 자리에 둔다.

export interface RawPosition {
  symbol?: string;
  amount?: any;
  entryPrice?: any;
  markPrice?: any;
  liquidationPrice?: any;
  unrealizedPnl?: any;
  unRealizedProfit?: any;
  leverage?: any;
  marginType?: string;
  isolatedMargin?: any;
  initialMargin?: any;
  margin?: any;
}

export interface PositionView {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  isolated: boolean;
  leverage: number | null;
  entry: number | null;
  mark: number | null;
  /** null이면 청산가가 없다는 뜻. 0이 아니다 */
  liq: number | null;
  pnl: number | null;
  notional: number | null;
  margin: number | null;
  /** 증거금이 거래소 값이 아니라 명목가÷배율로 추정된 값인가 */
  marginEstimated: boolean;
  /** 수익률(%). 분모를 모르면 null */
  roi: number | null;
}

const num = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);

export function derivePosition(p: RawPosition): PositionView {
  const amt = num(p.amount) ?? 0;
  const entry = num(p.entryPrice);
  const lev = num(p.leverage);

  // 청산가 0은 '0달러에 청산'이 아니라 '청산가 없음'이다. 교차 마진에서
  // 흔하다. 0을 그대로 그리면 즉시 청산 직전처럼 보인다 — 정반대다.
  const liqRaw = num(p.liquidationPrice);
  const liq = liqRaw != null && liqRaw > 0 ? liqRaw : null;

  const notional = entry != null ? Math.abs(amt) * entry : null;

  // 거래소가 준 값을 우선한다. 없을 때만 추정하고, 추정했다는 사실을
  // 그대로 들고 나간다. 화면에서 '≈'를 붙여야 하기 때문이다.
  const given = num(p.isolatedMargin ?? p.initialMargin ?? p.margin);
  const hasGiven = given != null && given > 0;
  const est = notional != null && lev != null && lev > 0 ? notional / lev : null;
  const margin = hasGiven ? given : est;

  const pnl = num(p.unrealizedPnl ?? p.unRealizedProfit);
  // 분모가 0이면 나누지 않는다. Infinity가 화면에 '∞%'로 나가면
  // 사용자는 그걸 대박으로 읽는다.
  const roi = pnl != null && margin != null && margin > 0 ? (pnl / margin) * 100 : null;

  return {
    symbol: String(p.symbol ?? ''),
    side: amt > 0 ? 'LONG' : 'SHORT',
    qty: Math.abs(amt),
    isolated: p.marginType === 'isolated',
    leverage: lev,
    entry, mark: num(p.markPrice), liq, pnl, notional, margin,
    marginEstimated: !hasGiven && est != null,
    roi,
  };
}
