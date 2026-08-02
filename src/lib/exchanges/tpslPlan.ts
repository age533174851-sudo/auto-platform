// src/lib/exchanges/tpslPlan.ts
//
// **TP/SL·트레일링을 거래소에 보내기 전에 판단한다.**
//
// 여기서 막지 않으면 무슨 일이 나는가
// ───────────────────────────────────
// 익절·손절은 **방향이 틀려도 거래소가 받아 준다.** 롱인데 손절을 현재가
// 위에 걸면 주문은 정상 접수되고, 다음 틱에 발동해서 즉시 청산된다.
// 화면에는 그때까지 '설정됨'으로 떠 있다 — 사용자는 보호가 걸린 줄 안다.
//
// 청산가 옆에 손절을 붙이는 것도 같은 종류다. 거래소도 경고만 하고 받는다
// ("setting a stop loss trigger price close to the liquidation price could
// result in the order failing to execute"). 그러면 손절이 발동하기 전에
// 청산이 먼저 온다.
//
// 그래서 **보내기 전에** 판단하고, 판단은 순수 함수로 둔다.

export type PosSide = 'LONG' | 'SHORT';

/**
 * 트리거 기준가.
 *
 * MARK_PRICE  — 마크가(지수 기반). 순간적인 꼬리에 덜 걸린다
 * CONTRACT_PRICE — 최종 체결가(Last). 거래소 화면의 'Last'가 이것이다
 *
 * 기본을 MARK로 두는 이유: 얇은 호가에서 한 틱짜리 꼬리에 손절이 털리는
 * 것을 줄인다. 다만 **고를 수 있어야 한다** — 지금까지는 코드에 박혀
 * 있어서 사용자가 Last를 원해도 방법이 없었다.
 */
export type TriggerSource = 'MARK_PRICE' | 'CONTRACT_PRICE';

export function normalizeTrigger(v: any): TriggerSource {
  const s = String(v || '').toUpperCase();
  if (s === 'CONTRACT_PRICE' || s === 'LAST' || s === 'LAST_PRICE') return 'CONTRACT_PRICE';
  return 'MARK_PRICE';
}

export interface Verdict {
  ok: boolean;
  reason: string;
}
const OK: Verdict = { ok: true, reason: '' };
const no = (reason: string): Verdict => ({ ok: false, reason });

/**
 * 익절가가 맞는 쪽에 있는가.
 *
 * 롱 익절은 기준가 **위**, 숏 익절은 **아래**다. 반대로 걸면 걸자마자
 * 발동해서 그 자리에서 청산된다.
 */
export function checkTakeProfit(price: number, ref: number | null, side: PosSide): Verdict {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return no('익절가가 올바르지 않습니다');
  // 기준가를 모르면 방향을 판단할 수 없다. **통과시키지 않는다** —
  // 여기서 봐주면 조회가 실패한 순간에만 위험한 값이 걸리는 길이 생긴다.
  if (ref == null || !Number.isFinite(ref) || ref <= 0) {
    return no('기준가를 확인하지 못해 익절 방향을 판단할 수 없습니다');
  }
  const bad = side === 'LONG' ? p <= ref : p >= ref;
  return bad
    ? no(`${side === 'LONG' ? '롱' : '숏'} 익절 ${p}은 기준가 ${ref}의 `
       + `${side === 'LONG' ? '아래' : '위'}입니다 — 걸자마자 발동합니다`)
    : OK;
}

/**
 * 손절가가 맞는 쪽에 있고, **청산가 안쪽인가.**
 *
 * 두 번째가 중요하다. 손절이 청산가 너머면 청산이 먼저 닿아 손절은
 * 작동할 기회가 없다. 화면에는 둘 다 '설정됨'으로 보인다.
 *
 * @param liq 청산가. 모르면 null — 그때는 방향만 본다(그 사실을 응답에 남긴다)
 */
export function checkStopLoss(
  price: number, ref: number | null, side: PosSide, liq: number | null,
): Verdict {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return no('손절가가 올바르지 않습니다');
  if (ref == null || !Number.isFinite(ref) || ref <= 0) {
    return no('기준가를 확인하지 못해 손절 방향을 판단할 수 없습니다');
  }
  const wrongSide = side === 'LONG' ? p >= ref : p <= ref;
  if (wrongSide) {
    return no(`${side === 'LONG' ? '롱' : '숏'} 손절 ${p}은 기준가 ${ref}의 `
      + `${side === 'LONG' ? '위' : '아래'}입니다 — 걸자마자 발동합니다`);
  }
  if (liq != null && Number.isFinite(liq) && liq > 0) {
    // 롱은 청산가가 아래에 있다. 손절이 그보다 아래면 청산이 먼저다.
    const beyond = side === 'LONG' ? p <= liq : p >= liq;
    if (beyond) {
      return no(`손절 ${p}이 청산가 ${liq} 너머입니다 — 청산이 먼저 닿아 `
        + '손절은 작동하지 못합니다');
    }
  }
  return OK;
}

/** 트레일링 콜백 비율의 거래소 허용 범위(바이낸스 USDⓈ-M) */
export const CALLBACK_MIN = 0.1;
export const CALLBACK_MAX = 10;

/**
 * 트레일링 스톱을 걸 수 있는가.
 *
 * 콜백 비율은 거래소가 0.1~10%만 받는다. 범위 밖을 그대로 보내면 거래소가
 * 거부하는데, 그 메시지("Parameter callbackRate is invalid")로는 무엇이
 * 잘못됐는지 알기 어렵다.
 *
 * 발동가(activationPrice)는 **선택**이다. 넣으면 그 가격에 닿아야 추적이
 * 시작된다. 방향이 틀리면 영원히 시작되지 않는다 — 그건 '걸었는데 안 도는'
 * 상태이고 화면에서는 걸린 것처럼 보인다.
 */
export function checkTrailing(
  callbackRate: number, activationPrice: number | null, ref: number | null, side: PosSide,
): Verdict {
  const r = Number(callbackRate);
  if (!Number.isFinite(r)) return no('콜백 비율을 입력하세요');
  if (r < CALLBACK_MIN || r > CALLBACK_MAX) {
    return no(`콜백 비율은 ${CALLBACK_MIN}~${CALLBACK_MAX}% 사이여야 합니다 (입력 ${r}%)`);
  }
  if (activationPrice == null) return OK;

  const a = Number(activationPrice);
  if (!Number.isFinite(a) || a <= 0) return no('발동가가 올바르지 않습니다');
  if (ref == null || !Number.isFinite(ref) || ref <= 0) {
    return no('기준가를 확인하지 못해 발동가 방향을 판단할 수 없습니다');
  }
  // 롱은 이익 쪽(위)으로 가야 추적이 시작된다. 아래에 걸면 즉시 발동이라
  // 트레일링을 쓰는 이유가 사라진다.
  const bad = side === 'LONG' ? a <= ref : a >= ref;
  return bad
    ? no(`${side === 'LONG' ? '롱' : '숏'} 발동가 ${a}는 기준가 ${ref}의 `
       + `${side === 'LONG' ? '아래' : '위'}입니다 — 즉시 발동해 추적 의미가 없습니다`)
    : OK;
}

/**
 * 청산할 수량. **전량이면 null**이다.
 *
 * null과 0을 섞으면 안 된다. 거래소는 quantity가 없으면 `closePosition=true`
 * (전량)로 걸고, 0을 보내면 거부한다. 화면에서 '0%'를 고른 것과 '전량'을
 * 고른 것이 같은 값이 되면 그중 하나는 반드시 틀린다.
 *
 * @param pct 1~100. null이나 100이면 전량
 */
export function portionQty(positionQty: number, pct: number | null): { qty: number | null; reason: string } {
  const total = Number(positionQty);
  if (!Number.isFinite(total) || total <= 0) {
    return { qty: null, reason: '포지션 수량을 확인하지 못했습니다' };
  }
  if (pct == null) return { qty: null, reason: '' };          // 전량
  const p = Number(pct);
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    return { qty: null, reason: `비율은 1~100 사이여야 합니다 (입력 ${pct})` };
  }
  if (p >= 100) return { qty: null, reason: '' };             // 전량
  return { qty: total * (p / 100), reason: '' };
}

/**
 * 이 가격에 닿으면 손익이 얼마인가.
 *
 * 모르면 **null이다.** 0으로 두면 '손익 없음'이 되는데, 그건 이 화면에서
 * 가장 위험한 거짓말이다 — 손절을 걸면서 얼마를 잃는지 0으로 보게 된다.
 */
export function pnlAt(
  price: number, entry: number | null, qty: number | null, side: PosSide,
): number | null {
  const p = Number(price), e = Number(entry), q = Number(qty);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (!Number.isFinite(e) || e <= 0) return null;
  if (!Number.isFinite(q) || q <= 0) return null;
  return (side === 'LONG' ? p - e : e - p) * q;
}
