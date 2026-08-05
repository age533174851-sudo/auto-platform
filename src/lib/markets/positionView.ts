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
  /**
   * 보유 수량. **부호가 방향이다** — 양수 롱, 음수 숏.
   *
   * 그런데 거래소 어댑터가 여기에 절대값을 넣는 일이 실제로 있었다. Gate
   * 라우트가 `Math.abs(...)`로 실어 보냈고, 이 파일은 부호에서 방향을
   * 뽑았으므로 **모든 Gate 숏이 화면에 롱으로 떴다.** 그래서 이제 부호
   * 하나만 믿지 않는다 — `side`가 오면 그걸 먼저 본다.
   */
  amount?: any;
  /** 거래소·어댑터가 방향을 직접 말해 줬다면 이게 부호보다 우선한다 */
  side?: any;
  positionSide?: any;
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
  /**
   * 방향을 **확인했는가.**
   *
   * false면 `side`는 표시용 기본값일 뿐 근거가 없다. 방향을 모르는 채로
   * 청산·뒤집기·손절 판정을 하면 반대로 나간다 — 롱을 닫으려던 매도가
   * 숏 진입이 되고, 숏의 손절을 '없음'으로 본다. 그래서 이 값이 false면
   * 화면은 조작을 막고 그 사실을 적어야 한다.
   */
  sideKnown: boolean;
  /** 방향을 무엇으로 판정했는가 — 근거를 화면과 로그가 볼 수 있어야 한다 */
  sideSource: 'field' | 'sign' | 'none';
  /**
   * 서로 다른 근거가 어긋난다. null이면 어긋난 것이 없다.
   *
   * 예: 거래소는 SHORT라는데 청산가가 진입가보다 낮다(= 롱의 모양).
   * 둘 중 하나는 오래된 값이거나 어댑터가 틀린 것이므로 **조용히 한쪽을
   * 고르지 않는다.**
   */
  sideConflict: string | null;
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

/** 문자열 방향을 읽는다. 'LONG'/'SHORT'만 방향이다 — 'BOTH'·'FLAT'·빈 값은 아니다 */
function sideField(v: any): 'LONG' | 'SHORT' | null {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'LONG' || s === 'BUY') return 'LONG';
  if (s === 'SHORT' || s === 'SELL') return 'SHORT';
  return null;
}

/**
 * 청산가가 말하는 방향.
 *
 * 롱은 가격이 내려가야 청산되므로 청산가가 진입가보다 **아래**다. 숏은 위다.
 * 이건 거래소가 준 두 숫자만으로 방향을 교차검증할 수 있는 유일한 수단이라,
 * 부호와 필드가 둘 다 의심스러울 때 심판 역할을 한다.
 *
 * 교차마진이면 청산가가 0/없음으로 오므로 null이다 — **그건 모순이 아니라
 * 근거 없음이다.** 둘을 섞으면 교차 포지션마다 가짜 경고가 뜬다.
 */
function sideByLiquidation(entry: number | null, liq: number | null): 'LONG' | 'SHORT' | null {
  if (entry == null || liq == null || entry <= 0 || liq <= 0) return null;
  // 진입가와 청산가가 사실상 같으면 방향을 말할 수 없다.
  if (Math.abs(liq - entry) / entry < 0.0005) return null;
  return liq < entry ? 'LONG' : 'SHORT';
}

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

  // ── 방향 ──
  //
  // 예전에는 이 한 줄이었다:
  //
  //   side: amt > 0 ? 'LONG' : 'SHORT'
  //
  // 부호가 언제나 있다는 전제였는데, Gate 라우트가 수량을 절대값으로
  // 실어 보내면서 그 전제가 깨졌다. 결과는 **모든 Gate 숏이 롱으로 표시**.
  // 그리고 방향이 뒤집히면 그 하나로 끝나지 않는다 — 손절 조회가 반대
  // 방향을 찾아 "손절 없음"이 되고, 청산가 경고문이 반대로 계산되고,
  // 청산 버튼이 반대로 나간다. 화면 하나가 아니라 **판단 전부**가 뒤집힌다.
  //
  // 그래서 근거를 셋 쓴다: 명시 필드 → 수량 부호 → (검증용) 청산가 방향.
  const declared = sideField(p.side) ?? sideField(p.positionSide);
  const bySign: 'LONG' | 'SHORT' | null = amt > 0 ? 'LONG' : amt < 0 ? 'SHORT' : null;
  const byLiq = sideByLiquidation(entry, liq);

  const resolved = declared ?? bySign;
  const sideSource: 'field' | 'sign' | 'none' =
    declared != null ? 'field' : bySign != null ? 'sign' : 'none';

  // 어긋남은 **덮지 않고 들고 나간다.** 조용히 한쪽을 고르면 어느 쪽이
  // 맞았는지 아무도 모르는 채로 반대 주문이 나간다.
  //
  // **양수는 진술이 아니다.** 어떤 어댑터는 수량을 절대값으로 보낸다 —
  // 그때 양수는 "롱이다"가 아니라 "부호가 지워졌다"이다. 그래서 필드가
  // SHORT인데 수량이 양수인 것은 모순이 아니라 정보 부족이고, 필드를
  // 믿으면 된다. 반대로 **음수는 진술이다** — 롱에 -0.97을 보내는
  // 거래소는 없다. 그러니 필드가 LONG인데 수량이 음수면 진짜 모순이다.
  let sideConflict: string | null = null;
  if (declared === 'LONG' && amt < 0) {
    sideConflict = `거래소는 LONG이라는데 수량이 음수(${amt})입니다`;
  } else if (resolved != null && byLiq != null && resolved !== byLiq) {
    sideConflict = `방향은 ${resolved}인데 청산가(${liq})가 진입가(${entry}) ${liq! < entry! ? '아래' : '위'}입니다 — ${byLiq}의 모양입니다`;
  }

  return {
    symbol: String(p.symbol ?? ''),
    // 모르면 LONG으로 적되 **sideKnown=false로 그 사실을 함께 넘긴다.**
    // 여기서 null을 돌려주면 호출부가 전부 널 검사를 빠뜨리고, 빠뜨린
    // 자리에서는 방향이 다시 조용히 한쪽으로 정해진다.
    side: resolved ?? 'LONG',
    sideKnown: resolved != null && sideConflict == null,
    sideSource,
    sideConflict,
    qty: Math.abs(amt),
    isolated: p.marginType === 'isolated',
    leverage: lev,
    entry, mark: num(p.markPrice), liq, pnl, notional, margin,
    marginEstimated: !hasGiven && est != null,
    roi,
  };
}

/**
 * 이 포지션을 닫으려면 어느 방향으로 주문해야 하는가.
 *
 * 롱은 팔아서 닫고, 숏은 사서 닫는다. 이걸 반대로 잡으면 청산이 아니라
 * **포지션이 두 배가 된다.** 화면에는 둘 다 '주문 접수됨'으로 보이고,
 * 다음 조회 때 수량이 늘어난 걸 보고서야 알게 된다.
 *
 * reduceOnly와 함께 써야 한다. 방향만 맞고 reduceOnly가 빠지면 기존
 * 포지션을 닫은 뒤 남은 수량으로 반대 포지션이 열릴 수 있다.
 */
export function closeSideFor(side: 'LONG' | 'SHORT'): 'BUY' | 'SELL' {
  return side === 'LONG' ? 'SELL' : 'BUY';
}
