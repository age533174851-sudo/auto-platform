// src/lib/markets/orderView.ts
//
// 거래소 미체결 주문 원문을 **사람이 읽는 문장**으로 바꾼다.
//
// 왜 필요한가
// ───────────
// 화면에 이렇게 떠 있었다:
//
//   BTCUSDT | STOP_MARKET | BUY | — | Stop 65,352.50
//
// 이 줄만 보고 알 수 있는 게 없다. `BUY`는 사는 것이니 신규 롱처럼 보이는데
// 실제로는 **숏을 닫는 손절**이다. 정확히 반대로 읽힌다. 그리고 그 오독은
// 위험한 쪽으로 기운다 — 사용자는 "롱 예약이 걸려 있네, 지워야지"라고
// 생각하고 자기 포지션의 유일한 보호 장치를 취소한다.
//
// 여기서 하는 일은 번역뿐이다. **주문을 만들지도, 지우지도, 판단하지도
// 않는다.** 네트워크도 타지 않는다 — 그래야 테스트가 붙는다.
//
// 방향을 모르면 지어내지 않는다
// ─────────────────────────────
// reduceOnly도 closePosition도 없는 주문은 신규일 수도, 거래소가 그 필드를
// 안 준 것일 수도 있다. 둘을 같게 취급하면 보호 주문이 '신규 주문'
// 목록에 섞여 들어가고, 사용자는 그걸 정리 대상으로 본다. 그래서 셋째
// 값을 둔다 — 보호 / 신규 / **판단 불가**.

export interface OpenOrderRaw {
  symbol?: any;
  /** 'BUY' | 'SELL' */
  side?: any;
  /** 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'LIMIT' | 'MARKET' ... */
  type?: any;
  origQty?: any;
  quantity?: any;
  price?: any;
  stopPrice?: any;
  triggerPrice?: any;
  reduceOnly?: any;
  closePosition?: any;
  orderId?: any;
  time?: any;
  updateTime?: any;
  createdAt?: any;
  status?: any;
  /** 바이낸스: MARK_PRICE | CONTRACT_PRICE. Gate는 mark를 기본으로 쓴다 */
  workingType?: any;
  /** Gate에서 이 주문이 어느 통에 있는가. 취소 경로가 달라진다 */
  bucket?: any;
}

export type OrderPurpose = 'STOP' | 'TAKE_PROFIT' | 'ENTRY' | 'UNKNOWN';
export type OrderProtection = 'PROTECTIVE' | 'NEW' | 'UNKNOWN';

export interface OrderCardView {
  symbol: string;
  /** 원문 종류 (디버깅·거래소 대조용으로 남긴다) */
  rawType: string;
  /** 원문 방향 */
  rawSide: string;
  /** '조건부 시장가' 같은 한국어 종류 */
  kindLabel: string;
  /** '숏 손절' — 카드 제목 옆 한 줄 */
  purposeLabel: string;
  purpose: OrderPurpose;
  protection: OrderProtection;
  /** '숏 포지션 종료용 매수' — BUY/SELL을 그대로 보여 주지 않기 위한 문장 */
  sideLabel: string;
  /** '마크가' | '체결가' | null(모름) */
  triggerBasisLabel: string | null;
  /** 65352.5 — 없으면 null */
  triggerPrice: number | null;
  /** '마크가 ≥ 65,352.5' 형태. 발동가가 없으면 null */
  triggerLabel: string | null;
  /** '시장가' | '지정가 64,000.0' */
  execLabel: string;
  /** '전량 종료' | '0.9748' | '수량 미상' */
  qtyLabel: string;
  /** 전량 종료 주문인가 */
  closeAll: boolean;
  /** '활성' | 원문 상태 */
  statusLabel: string;
  /** 생성 시각(ms). 포맷은 화면이 한다 — 순수 함수에 로캘을 넣지 않는다 */
  createdAt: number | null;
  orderId: string | null;
  /** Gate 취소 경로 힌트 */
  bucket: 'price' | 'normal' | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const upper = (v: any): string => String(v ?? '').trim().toUpperCase();

/** 숫자를 천단위로. 소수는 있는 만큼만 — 0.0001을 '0'으로 만들지 않는다 */
export function fmtNum(n: number | null | undefined, maxFrac = 8): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const trimmed = Number(v.toFixed(maxFrac));
  const [int, frac] = String(Math.abs(trimmed)).split('.');
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${trimmed < 0 ? '-' : ''}${withSep}${frac ? `.${frac}` : ''}`;
}

/**
 * 이 주문이 포지션을 **줄이는** 주문인가.
 *
 * 0과 없음을 구분한다. `reduceOnly: false`는 "신규다"이고, 필드 자체가
 * 없는 것은 "모른다"이다. 둘을 같게 보면 거래소가 그 필드를 안 주는 순간
 * 모든 보호 주문이 신규 주문 칸으로 내려간다.
 */
export function protectionOf(o: OpenOrderRaw): OrderProtection {
  const ro = o?.reduceOnly;
  const cp = o?.closePosition;
  if (cp === true || ro === true) return 'PROTECTIVE';
  // 조건부 주문은 그 자체로 보호 주문이다. 거래소가 reduceOnly를 안 실어
  // 보내도(Gate의 price_orders가 그렇다) 손절을 신규 주문으로 부르지 않는다.
  const t = upper(o?.type);
  if (t.includes('STOP') || t.includes('TAKE_PROFIT')) return 'PROTECTIVE';
  if (cp === false && ro === false) return 'NEW';
  if (ro === false || cp === false) return 'NEW';
  return 'UNKNOWN';
}

/** 손절인가 익절인가 신규인가 */
export function purposeOf(o: OpenOrderRaw): OrderPurpose {
  const t = upper(o?.type);
  if (t.includes('TAKE_PROFIT')) return 'TAKE_PROFIT';
  if (t.includes('STOP')) return 'STOP';
  if (t === 'LIMIT' || t === 'MARKET' || t.includes('LIMIT') || t.includes('MARKET')) return 'ENTRY';
  return 'UNKNOWN';
}

/**
 * 이 주문이 닫는 포지션의 방향.
 *
 * 매수로 닫는 것은 숏이고, 매도로 닫는 것은 롱이다. 이걸 뒤집으면
 * 카드에 '롱 손절'이라고 적힌 채 실제로는 숏의 손절이 걸려 있게 된다.
 * 줄이는 주문이 아니면 방향을 말할 수 없다 — null이다.
 */
export function closesSideOf(o: OpenOrderRaw): 'LONG' | 'SHORT' | null {
  if (protectionOf(o) !== 'PROTECTIVE') return null;
  const s = upper(o?.side);
  if (s === 'BUY') return 'SHORT';
  if (s === 'SELL') return 'LONG';
  return null;
}

/** 종류를 한국어로. 원문은 카드가 따로 들고 있으므로 여기서는 뜻만 적는다 */
function kindLabelOf(o: OpenOrderRaw): string {
  const t = upper(o?.type);
  if (t.includes('STOP_MARKET') || t.includes('TAKE_PROFIT_MARKET')) return '조건부 시장가';
  if (t.includes('STOP') || t.includes('TAKE_PROFIT')) return '조건부 지정가';
  if (t === 'LIMIT') return '지정가';
  if (t === 'MARKET') return '시장가';
  if (t === 'TRAILING_STOP_MARKET') return '추적 손절';
  return t || '알 수 없는 종류';
}

/**
 * 주문 원문 하나 → 카드 한 장.
 *
 * `positionSide`를 주면 방향 설명이 더 정확해진다. 없어도 동작한다 —
 * reduceOnly 주문은 자기 방향으로 닫는 포지션을 역산할 수 있기 때문이다.
 */
export function describeOrder(
  o: OpenOrderRaw,
  ctx?: { positionSide?: 'LONG' | 'SHORT' | null },
): OrderCardView {
  const purpose = purposeOf(o);
  const protection = protectionOf(o);
  const closes = closesSideOf(o) ?? (ctx?.positionSide ?? null);
  const rawSide = upper(o?.side);

  const trig = num(o?.stopPrice) ?? num(o?.triggerPrice);
  const limitPx = num(o?.price);

  // 발동 기준. 바이낸스는 workingType으로 말해 주고, Gate의 조건부 주문은
  // 마크가 기준이다. **모르면 적지 않는다** — '체결가'라고 지어 놓으면
  // 사용자가 그 기준으로 발동 시점을 계산한다.
  const wt = upper(o?.workingType);
  const triggerBasisLabel =
    wt === 'MARK_PRICE' ? '마크가'
    : wt === 'CONTRACT_PRICE' || wt === 'LAST_PRICE' ? '체결가'
    : null;

  // 부등호 방향. 롱을 닫는 손절은 아래로 내려갈 때(≤), 숏을 닫는 손절은
  // 위로 올라갈 때(≥) 발동한다. 익절은 그 반대다.
  let cmp: '≥' | '≤' | null = null;
  if (trig != null) {
    if (purpose === 'STOP' && closes === 'LONG') cmp = '≤';
    else if (purpose === 'STOP' && closes === 'SHORT') cmp = '≥';
    else if (purpose === 'TAKE_PROFIT' && closes === 'LONG') cmp = '≥';
    else if (purpose === 'TAKE_PROFIT' && closes === 'SHORT') cmp = '≤';
  }

  const triggerLabel = trig == null ? null
    : `${triggerBasisLabel ?? '기준가'} ${cmp ?? '='} ${fmtNum(trig)}`;

  const purposeLabel =
    purpose === 'STOP'
      ? (closes === 'LONG' ? '롱 손절' : closes === 'SHORT' ? '숏 손절' : '손절')
    : purpose === 'TAKE_PROFIT'
      ? (closes === 'LONG' ? '롱 익절' : closes === 'SHORT' ? '숏 익절' : '익절')
    : purpose === 'ENTRY'
      ? (protection === 'PROTECTIVE'
          ? (closes === 'LONG' ? '롱 청산 예약' : closes === 'SHORT' ? '숏 청산 예약' : '청산 예약')
          : (rawSide === 'BUY' ? '신규 롱 지정가 주문'
             : rawSide === 'SELL' ? '신규 숏 지정가 주문' : '신규 지정가 주문'))
    : '용도 확인 불가';

  // **BUY/SELL을 그대로 내보내지 않는다.** 숏을 닫는 매수를 'BUY'라고만
  // 적으면 신규 롱으로 읽힌다 — 이 화면에서 가장 비싼 오독이다.
  const sideLabel =
    protection === 'PROTECTIVE'
      ? (rawSide === 'BUY' ? '숏 포지션 종료용 매수'
         : rawSide === 'SELL' ? '롱 포지션 종료용 매도' : '종료용 주문')
      : (rawSide === 'BUY' ? '신규 매수(롱)'
         : rawSide === 'SELL' ? '신규 매도(숏)' : '방향 확인 불가');

  const closeAll = o?.closePosition === true;
  const qty = num(o?.origQty) ?? num(o?.quantity);
  const qtyLabel = closeAll ? '전량 종료'
    : qty != null && qty !== 0 ? fmtNum(Math.abs(qty))
    : '수량 미상';

  const execLabel =
    kindLabelOf(o).includes('시장가') || upper(o?.type).includes('MARKET') ? '시장가'
    : limitPx != null ? `지정가 ${fmtNum(limitPx)}`
    : '지정가';

  const st = upper(o?.status);
  const statusLabel =
    st === '' || st === 'NEW' || st === 'OPEN' || st === 'PARTIALLY_FILLED' ? '활성' : st;

  const created = num(o?.time) ?? num(o?.createdAt) ?? num(o?.updateTime);

  const bucketRaw = String(o?.bucket ?? '').trim().toLowerCase();

  return {
    symbol: String(o?.symbol ?? ''),
    rawType: upper(o?.type),
    rawSide,
    kindLabel: kindLabelOf(o),
    purposeLabel,
    purpose,
    protection,
    sideLabel,
    triggerBasisLabel,
    triggerPrice: trig,
    triggerLabel,
    execLabel,
    qtyLabel,
    closeAll,
    statusLabel,
    createdAt: created,
    orderId: o?.orderId == null ? null : String(o.orderId),
    bucket: bucketRaw === 'price' ? 'price' : bucketRaw === 'normal' ? 'normal' : null,
  };
}

/**
 * 목록을 보호 주문과 일반 주문으로 가른다.
 *
 * 섞어 놓으면 '미체결 3건'이 되고, 그 셋 중 어느 것이 포지션을 지키고
 * 있는지는 각 줄을 읽어야 안다. 그러면 [전체 취소]를 누르는 사람은
 * 자기가 손절까지 지우는 줄 모른다.
 *
 * 판단 불가는 **보호 쪽에 두지 않는다.** 보호로 두면 없는 안전을 세고,
 * 신규로 두면 취소 대상으로 보인다. 그래서 따로 센다.
 */
export function splitOrders(
  orders: OpenOrderRaw[] | null | undefined,
  ctx?: { positionSide?: 'LONG' | 'SHORT' | null },
): { protective: OrderCardView[]; normal: OrderCardView[]; unknown: OrderCardView[]; total: number } {
  if (!Array.isArray(orders)) return { protective: [], normal: [], unknown: [], total: 0 };
  const protective: OrderCardView[] = [];
  const normal: OrderCardView[] = [];
  const unknown: OrderCardView[] = [];
  for (const o of orders) {
    if (!o) continue;
    const v = describeOrder(o, ctx);
    if (v.protection === 'PROTECTIVE') protective.push(v);
    else if (v.protection === 'NEW') normal.push(v);
    else unknown.push(v);
  }
  return { protective, normal, unknown, total: protective.length + normal.length + unknown.length };
}
