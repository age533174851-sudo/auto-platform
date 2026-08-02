// src/lib/engine/stopVerify.ts
//
// **손절이 정말 거래소에 걸려 있는가** — 되읽어서 확인한다.
//
// 왜 필요한가
// ───────────
// 주문 실행기는 손절을 걸고 응답의 `success`만 보고 "붙었다"로 친다.
// 그건 **거래소가 200을 줬다**는 뜻이지 그 주문이 지금 주문장에 남아
// 있다는 뜻이 아니다. 접수 직후 사라지는 경우가 실제로 있다:
//
//   · 거래소 리스크 엔진이 접수 후 취소
//   · reduceOnly 조건이 안 맞아 즉시 취소
//   · 그 사이 포지션이 없어져 자동 취소
//   · 접수는 됐는데 다른 심볼/방향으로 들어감
//
// 넷 다 응답은 성공이다. 그리고 넷 다 결과는 같다 — **손절 없는 포지션이
// 열려 있다.** 포지션 크기 자체가 손절 거리로 역산된 값이라(허용손실 ÷
// 손절거리), 손절이 없으면 그 크기를 정당화하는 근거가 사라진다.
//
// 이 저장소에서 오늘만 여섯 번 나온 실패가 정확히 이 모양이다:
// "요청은 성공했는데 실제로는 안 되어 있다." 가장 비싼 자리에서 그것을
// 그냥 두면 안 된다.
//
// 못 읽으면 '없다'고 하지 않는다
// ──────────────────────────────
// 주문 목록 조회가 실패했을 때 "손절 없음"으로 처리하면, 조회 한 번
// 실패로 멀쩡한 포지션을 청산한다. 그건 그것대로 사고다. 그래서 결과를
// 셋으로 나눈다 — 있음 / 없음 / **확인 불가**.

export interface OpenOrderLike {
  /** 'BUY' | 'SELL' */
  side?: string | null;
  type?: string | null;
  symbol?: string | null;
  /** 발동 가격 */
  stopPrice?: number | string | null;
  triggerPrice?: number | string | null;
  price?: number | string | null;
  orderId?: number | string | null;
  reduceOnly?: boolean | null;
  closePosition?: boolean | null;
}

export type StopVerdict = 'attached' | 'missing' | 'unknown';

export interface StopCheck {
  status: StopVerdict;
  reason: string;
  /** 찾았다면 그 주문의 id */
  orderId: string | null;
  /** 실제로 걸려 있는 발동가 (요청한 값과 다를 수 있다 — 틱 반올림) */
  foundStopPrice: number | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 손절로 볼 수 있는 주문 종류인가 */
function isStopType(t: any): boolean {
  const s = String(t || '').toUpperCase();
  // TAKE_PROFIT은 제외한다 — 익절은 손절이 아니다. 둘을 섞으면 익절만
  // 걸린 포지션이 '손절 있음'으로 통과한다.
  if (s.includes('TAKE_PROFIT')) return false;
  return s.includes('STOP');
}

/**
 * 되읽은 주문 목록에서 이 손절을 찾는다.
 *
 * 순수 함수다 — 네트워크를 타지 않는다.
 *
 * @param orders 못 읽었으면 **null**을 넘긴다. 빈 배열(진짜로 없음)과
 *               구분해야 한다 — 앞은 확인 불가, 뒤는 손절 없음이다.
 * @param tolPct 발동가 허용 오차(%). 거래소가 틱 단위로 반올림하므로
 *               정확히 같기를 요구하면 멀쩡한 손절을 '없음'으로 본다.
 */
export function verifyStopAttached(
  orders: OpenOrderLike[] | null | undefined,
  want: { symbol: string; side: 'BUY' | 'SELL'; stopPrice: number },
  tolPct = 0.5,
): StopCheck {
  const none = (status: StopVerdict, reason: string): StopCheck =>
    ({ status, reason, orderId: null, foundStopPrice: null });

  // **못 읽은 것과 없는 것을 구분한다.** 조회 실패를 '손절 없음'으로
  // 처리하면 조회 한 번 실패로 멀쩡한 포지션을 청산한다.
  if (!Array.isArray(orders)) {
    return none('unknown', '거래소 주문 목록을 읽지 못해 손절 부착을 확인하지 못했습니다');
  }

  const wantPx = num(want?.stopPrice);
  if (wantPx == null || wantPx <= 0) {
    return none('unknown', '확인할 손절가가 없습니다');
  }
  const sym = String(want?.symbol || '').toUpperCase();
  const side = String(want?.side || '').toUpperCase();

  const tol = Math.abs(wantPx) * (Math.max(0, tolPct) / 100);

  for (const o of orders) {
    if (!o) continue;
    if (sym && String(o.symbol || '').toUpperCase() !== sym) continue;
    // 방향이 다르면 이 포지션의 손절이 아니다. 롱을 닫는 손절은 SELL이다.
    if (side && String(o.side || '').toUpperCase() !== side) continue;
    if (!isStopType(o.type)) continue;

    const px = num(o.stopPrice) ?? num(o.triggerPrice) ?? num(o.price);
    if (px == null) continue;
    if (Math.abs(px - wantPx) > tol) continue;

    return {
      status: 'attached',
      reason: `손절이 거래소에 걸려 있습니다 (발동가 ${px})`,
      orderId: o.orderId == null ? null : String(o.orderId),
      foundStopPrice: px,
    };
  }

  // 목록은 읽었는데 없다. 이건 확인된 '없음'이다.
  return none('missing',
    `손절 주문이 거래소 주문 목록에 없습니다 (찾던 값: ${sym} ${side} ${wantPx})`);
}

/**
 * 이 포지션에 **손절이 하나라도** 걸려 있는가.
 *
 * `verifyStopAttached`와 묻는 것이 다르다. 저쪽은 "내가 방금 건 그 손절이
 * 실제로 붙었나"라서 목표 발동가가 필요하다. 이쪽은 화면이 묻는 질문 —
 * "지금 이 포지션, 손절 있나?" — 이고 값은 모른다.
 *
 * 이게 없어서 실제로 이런 일이 났다: 테스트넷에 5배 포지션이 열렸는데
 * 거래소 화면에는 `Open Orders (0)`이었다. 앱의 포지션 카드에는 그 사실이
 * 어디에도 안 적혀 있어서, 손절이 붙었는지를 **사람이 거래소에 직접
 * 들어가서** 확인해야 했다.
 *
 * @param orders 못 읽었으면 **null**. 빈 배열(진짜로 없음)과 다르다.
 * @param positionSide 들고 있는 방향. 롱을 닫는 손절은 SELL이다.
 */
export function findAnyStop(
  orders: OpenOrderLike[] | null | undefined,
  want: { symbol: string; positionSide: 'LONG' | 'SHORT' },
): StopCheck {
  const none = (status: StopVerdict, reason: string): StopCheck =>
    ({ status, reason, orderId: null, foundStopPrice: null });

  if (!Array.isArray(orders)) {
    return none('unknown', '미체결 주문을 읽지 못해 손절이 걸렸는지 확인하지 못했습니다');
  }

  const sym = String(want?.symbol || '').toUpperCase();
  // 포지션을 닫는 방향. 이걸 안 보면 반대 방향 진입 예약이 손절로 잡힌다.
  const closeSide = want?.positionSide === 'LONG' ? 'SELL' : 'BUY';

  for (const o of orders) {
    if (!o) continue;
    if (sym && String(o.symbol || '').toUpperCase() !== sym) continue;
    if (String(o.side || '').toUpperCase() !== closeSide) continue;
    if (!isStopType(o.type)) continue;

    const px = num(o.stopPrice) ?? num(o.triggerPrice) ?? num(o.price);
    return {
      status: 'attached',
      reason: px == null
        ? '손절 주문이 걸려 있습니다 (발동가를 읽지 못했습니다)'
        : `손절 ${px}에 걸려 있습니다`,
      orderId: o.orderId == null ? null : String(o.orderId),
      foundStopPrice: px,
    };
  }

  return none('missing', '이 포지션에 걸린 손절 주문이 없습니다');
}

/**
 * 이 결과로 포지션을 되돌려야 하는가.
 *
 * **'확인 불가'로는 청산하지 않는다.** 조회 실패 한 번으로 멀쩡한 포지션을
 * 시장가로 닫으면 수수료와 슬리피지를 확정 손실로 물면서 아무것도 얻지
 * 못한다. 대신 그 사실을 남겨 청산 감시가 다음 주기에 다시 본다.
 */
export function shouldUnwind(check: StopCheck): boolean {
  return check.status === 'missing';
}
