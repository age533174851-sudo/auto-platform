// src/lib/strategies/spotOrderPlan.ts
//
// 현물 주문 기능 — 분할·예약·TP/SL·트레일링·반복.
//
// 이 파일의 핵심 구분: 보호가 어디에 있는가
// ─────────────────────────────────────────
// 손절을 거래소에 올려두면 앱이 꺼져도 살아 있다. 반면 트레일링 스톱은
// 가격을 계속 보며 값을 옮겨야 하므로 **우리 서버가 돌아야 존재한다.**
// 서버가 죽으면 그 보호는 없는 것과 같다.
//
// 이 둘을 같은 모양으로 보여주면 사용자는 둘 다 걸어놨다고 믿는다.
// 그래서 모든 계획에 guardedBy를 달고, 화면이 그것을 그대로 표시한다.
//
// 두 번째 원칙: 현물에는 공매도가 없다
// ────────────────────────────────────
// 매도 계획은 전부 보유 수량 안에서만 만들어진다. 분할매도 3회를 걸면
// 세 개 합이 보유를 넘지 않아야 한다 — 넘으면 마지막 하나가 거부되는
// 것이 아니라, 먼저 나간 것들 때문에 잔량이 없어 거부된다.

export type Guard =
  | 'EXCHANGE'   // 거래소에 주문이 올라가 있다. 앱이 꺼져도 산다
  | 'APP';       // 우리 서버가 감시해야 동작한다. 서버가 멈추면 사라진다

export interface PlannedOrder {
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  /** 매수 금액(USDT). 시장가 매수에 쓴다 */
  quoteUsd?: number;
  /** 수량(코인) */
  qty?: number;
  /** 지정가 */
  price?: number;
  label: string;
  guardedBy: Guard;
}

export interface PlanResult {
  orders: PlannedOrder[];
  /** 사용자에게 반드시 보여야 하는 경고 */
  warnings: string[];
  ok: boolean;
}

const fail = (reason: string): PlanResult => ({ orders: [], warnings: [reason], ok: false });

// ── 분할 ───────────────────────────────────────────────

export interface SplitSpec {
  side: 'BUY' | 'SELL';
  /** 매수면 총 금액(USDT), 매도면 총 수량(코인) */
  total: number;
  /** 몇 번에 나눌 것인가 */
  tranches: number;
  /** 시작 가격 */
  fromPrice: number;
  /** 끝 가격. fromPrice와 같으면 전부 같은 가격 */
  toPrice: number;
  /** 거래소 최소 주문 금액(USDT). 모르면 생략 */
  minNotionalUsd?: number;
  /** 매도일 때 보유 수량 */
  heldQty?: number;
}

/**
 * 가격 구간을 균등하게 나눠 여러 건으로 만든다.
 *
 * 반올림 때문에 합이 총액과 달라지는 것을 막는다 — 마지막 건에
 * 나머지를 몰아준다. 안 그러면 분할매도 후 먼지 같은 잔량이 남고,
 * 그 잔량은 최소 주문 금액에 미달해 영영 못 판다.
 */
export function planSplit(spec: SplitSpec): PlanResult {
  const warnings: string[] = [];
  const n = Math.floor(spec.tranches);

  if (!Number.isFinite(spec.total) || spec.total <= 0) return fail('총량이 유효하지 않습니다');
  if (!Number.isFinite(n) || n < 1) return fail('분할 횟수는 1 이상이어야 합니다');
  if (n > 50) return fail('분할 횟수가 너무 많습니다 (최대 50)');
  if (!Number.isFinite(spec.fromPrice) || spec.fromPrice <= 0) return fail('가격이 유효하지 않습니다');
  if (!Number.isFinite(spec.toPrice) || spec.toPrice <= 0) return fail('가격이 유효하지 않습니다');

  // 현물 매도는 보유 안에서만. 여기서 막지 않으면 앞의 주문들이 체결된 뒤
  // 뒤의 주문이 잔량 부족으로 거부된다 — 계획이 반만 실행된다.
  if (spec.side === 'SELL') {
    if (spec.heldQty == null) {
      return fail('보유 수량을 몰라 분할매도를 계획할 수 없습니다');
    }
    if (spec.total > spec.heldQty) {
      return fail(
        `보유(${spec.heldQty})보다 많이 팔 수 없습니다 (요청 ${spec.total}). 현물에 공매도는 없습니다.`);
    }
  }

  const step = n === 1 ? 0 : (spec.toPrice - spec.fromPrice) / (n - 1);
  const each = spec.total / n;

  const orders: PlannedOrder[] = [];
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const price = spec.fromPrice + step * i;
    // 마지막 건에 나머지를 몰아준다. 반올림 오차로 먼지가 남지 않게.
    const amount = i === n - 1 ? spec.total - assigned : each;
    assigned += amount;

    const notional = spec.side === 'BUY' ? amount : amount * price;
    if (spec.minNotionalUsd != null && notional < spec.minNotionalUsd) {
      return fail(
        `${n}분할하면 1회 주문이 ${notional.toFixed(2)} USD로 ` +
        `최소 주문 금액(${spec.minNotionalUsd})에 미달합니다. 분할 횟수를 줄이세요.`);
    }

    orders.push({
      side: spec.side, type: 'LIMIT', price,
      ...(spec.side === 'BUY' ? { quoteUsd: amount, qty: amount / price } : { qty: amount }),
      label: `${i + 1}/${n} @ ${price.toFixed(2)}`,
      // 지정가 주문은 거래소에 올라간다 — 앱이 꺼져도 살아 있다
      guardedBy: 'EXCHANGE',
    });
  }

  if (n > 1 && spec.fromPrice === spec.toPrice) {
    warnings.push('시작가와 끝가가 같아 모든 주문이 같은 가격에 놓입니다');
  }

  return { orders, warnings, ok: true };
}

// ── TP · SL ────────────────────────────────────────────

export interface BracketSpec {
  /** 보유 수량 — 이만큼만 보호할 수 있다 */
  heldQty: number;
  /** 평균 매수가. 손익 판단 기준 */
  avgPrice: number;
  /** 익절가. 없으면 안 건다 */
  takeProfit?: number | null;
  /** 손절가. 없으면 안 건다 */
  stopLoss?: number | null;
  /** 보호할 비율(%). 100이면 전량 */
  coverPct?: number;
}

/**
 * 현물 보유분에 익절·손절을 건다.
 *
 * 선물과 달리 현물의 TP/SL은 **매도 주문**이다. 그래서 보유를 넘을 수
 * 없고, TP와 SL이 같은 물량을 두고 겹치면 하나가 체결된 뒤 나머지는
 * 잔량 부족으로 거부된다. 거래소 OCO가 없는 경우를 대비해 그 사실을
 * 경고로 남긴다.
 */
export function planBracket(spec: BracketSpec): PlanResult {
  const warnings: string[] = [];

  if (!Number.isFinite(spec.heldQty) || spec.heldQty <= 0) {
    return fail('보유 수량이 없어 익절·손절을 걸 수 없습니다');
  }
  if (!Number.isFinite(spec.avgPrice) || spec.avgPrice <= 0) {
    return fail('평균 매수가를 몰라 익절·손절 방향을 판단할 수 없습니다');
  }

  const tp = spec.takeProfit ?? null;
  const sl = spec.stopLoss ?? null;
  if (tp == null && sl == null) return fail('익절가와 손절가가 모두 비어 있습니다');

  // 방향이 뒤집혀 있으면 그 주문은 즉시 체결되거나 영영 안 걸린다.
  // 사용자는 보호를 걸었다고 믿는다.
  if (tp != null && tp <= spec.avgPrice) {
    return fail(`익절가(${tp})가 평균 매수가(${spec.avgPrice}) 이하입니다 — 손실 확정 주문이 됩니다`);
  }
  if (sl != null && sl >= spec.avgPrice) {
    return fail(`손절가(${sl})가 평균 매수가(${spec.avgPrice}) 이상입니다 — 즉시 체결될 수 있습니다`);
  }
  if (tp != null && sl != null && sl >= tp) {
    return fail('손절가가 익절가보다 높습니다');
  }

  const pct = Math.min(100, Math.max(0, spec.coverPct ?? 100));
  const qty = spec.heldQty * (pct / 100);
  if (qty <= 0) return fail('보호할 수량이 0입니다');

  const orders: PlannedOrder[] = [];
  if (tp != null) {
    orders.push({
      side: 'SELL', type: 'LIMIT', price: tp, qty,
      label: `익절 @ ${tp.toFixed(2)}`,
      guardedBy: 'EXCHANGE',
    });
  }
  if (sl != null) {
    orders.push({
      side: 'SELL', type: 'LIMIT', price: sl, qty,
      label: `손절 @ ${sl.toFixed(2)}`,
      guardedBy: 'EXCHANGE',
    });
  }

  if (tp != null && sl != null) {
    // 같은 물량에 두 개를 걸면 하나가 체결된 뒤 나머지가 잔량 부족으로
    // 거부된다. OCO가 없으면 사용자가 직접 취소해야 한다.
    warnings.push(
      '익절과 손절이 같은 물량을 대상으로 합니다. 한쪽이 체결되면 다른 쪽을 취소해야 합니다 ' +
      '(현물은 포지션이 아니라 잔고라 자동 해제되지 않습니다).');
  }
  if (pct < 100) {
    warnings.push(`보유의 ${pct}%만 보호합니다. 나머지 ${(100 - pct).toFixed(0)}%는 보호되지 않습니다.`);
  }

  return { orders, warnings, ok: true };
}

// ── 트레일링 스톱 ──────────────────────────────────────

export interface TrailingState {
  /** 지금까지의 최고가 */
  highWater: number;
  /** 현재 손절선 */
  stopPrice: number;
  /** 최고가 대비 몇 % 아래에 둘 것인가 */
  trailPct: number;
}

export interface TrailingUpdate {
  state: TrailingState;
  /** 손절선이 올라갔는가 */
  moved: boolean;
  /** 지금 팔아야 하는가 */
  triggered: boolean;
  guardedBy: Guard;
  note: string;
}

/**
 * 트레일링 스톱을 갱신한다.
 *
 * **손절선은 절대 내려가지 않는다.** 내려가면 트레일링이 아니라 그냥
 * 손절선을 계속 물리는 것이고, 하락장에서 영원히 안 팔린다.
 *
 * 이 보호는 거래소가 아니라 우리 서버에 있다. 서버가 멈추면 값이 멈추고,
 * 값이 멈춘 손절선은 보호가 아니다. guardedBy가 항상 'APP'인 이유다.
 */
export function updateTrailing(state: TrailingState, price: number): TrailingUpdate {
  const base = { guardedBy: 'APP' as Guard };

  if (!Number.isFinite(price) || price <= 0) {
    // 가격을 모르면 아무것도 하지 않는다. 특히 '발동'으로 처리하면
    // 조회 실패 한 번에 보유분이 팔린다.
    return {
      ...base, state, moved: false, triggered: false,
      note: '가격을 확인하지 못해 트레일링을 갱신하지 않았습니다',
    };
  }
  if (!Number.isFinite(state.trailPct) || state.trailPct <= 0 || state.trailPct >= 100) {
    return { ...base, state, moved: false, triggered: false, note: '트레일링 비율이 유효하지 않습니다' };
  }

  let { highWater, stopPrice } = state;
  let moved = false;

  if (price > highWater) {
    highWater = price;
    const next = highWater * (1 - state.trailPct / 100);
    if (next > stopPrice) { stopPrice = next; moved = true; }
  }

  const next: TrailingState = { ...state, highWater, stopPrice };
  const triggered = price <= stopPrice;

  return {
    ...base, state: next, moved, triggered,
    note: triggered
      ? `현재가 ${price.toFixed(2)}가 손절선 ${stopPrice.toFixed(2)}에 닿았습니다 — 매도`
      : moved
        ? `최고가 ${highWater.toFixed(2)} 갱신 — 손절선 ${stopPrice.toFixed(2)}로 올림`
        : `대기 (최고 ${highWater.toFixed(2)} / 손절 ${stopPrice.toFixed(2)})`,
  };
}

/** 트레일링 시작 상태 */
export function startTrailing(entryPrice: number, trailPct: number): TrailingState {
  return {
    highWater: entryPrice,
    stopPrice: entryPrice * (1 - trailPct / 100),
    trailPct,
  };
}

// ── 예약 주문 ──────────────────────────────────────────

export interface ReservedSpec {
  side: 'BUY' | 'SELL';
  /** 이 가격을 기준으로 */
  triggerPrice: number;
  /** 위로 뚫으면(above) / 아래로 내려오면(below) */
  direction: 'above' | 'below';
  /** 매수 금액 또는 매도 수량 */
  amount: number;
  /** 매도일 때 보유 수량 */
  heldQty?: number;
}

export interface ReservedCheck {
  triggered: boolean;
  guardedBy: Guard;
  reason: string;
}

/**
 * 예약 주문이 발동됐는가.
 *
 * 거래소의 STOP 주문과 달리 이건 우리가 가격을 보고 판단한다.
 * 서버가 멈추면 발동하지 않는다 — 그래서 guardedBy가 'APP'이다.
 * 지정가로 미리 올려둘 수 있는 경우(현재가보다 유리한 쪽)에는
 * planSplit처럼 거래소에 올리는 편이 안전하다.
 */
export function checkReserved(spec: ReservedSpec, price: number | null): ReservedCheck {
  const base = { guardedBy: 'APP' as Guard };

  if (price == null || !Number.isFinite(price) || price <= 0) {
    return { ...base, triggered: false, reason: '현재가를 확인하지 못해 발동 여부를 판단하지 않습니다' };
  }
  if (!Number.isFinite(spec.triggerPrice) || spec.triggerPrice <= 0) {
    return { ...base, triggered: false, reason: '기준 가격이 유효하지 않습니다' };
  }
  if (spec.side === 'SELL' && (spec.heldQty == null || spec.amount > spec.heldQty)) {
    return {
      ...base, triggered: false,
      reason: spec.heldQty == null
        ? '보유 수량을 몰라 예약매도를 발동하지 않습니다'
        : `보유(${spec.heldQty})보다 많은 예약매도입니다 (${spec.amount})`,
    };
  }

  const hit = spec.direction === 'above' ? price >= spec.triggerPrice : price <= spec.triggerPrice;
  return {
    ...base, triggered: hit,
    reason: hit
      ? `현재가 ${price.toFixed(2)}가 기준 ${spec.triggerPrice.toFixed(2)} ${spec.direction === 'above' ? '이상' : '이하'} — 발동`
      : `대기 (현재 ${price.toFixed(2)} / 기준 ${spec.triggerPrice.toFixed(2)})`,
  };
}

// ── 반복 매수 ──────────────────────────────────────────

export interface RepeatSpec {
  /** 며칠마다 */
  everyDays: number;
  /** 몇 번까지 */
  maxCount: number;
  /** 지금까지 실행한 횟수 */
  doneCount: number;
  /** 마지막 실행 시각. 없으면 아직 한 번도 안 함 */
  lastAt: number | null;
}

export interface RepeatCheck {
  due: boolean;
  remaining: number;
  reason: string;
}

const DAY_MS = 86_400_000;

/**
 * 반복 매수가 지금 실행될 차례인가.
 *
 * 횟수를 다 쓰면 멈춘다. 멈추지 않으면 "10회 반복"이 무한 적립이 된다.
 */
export function checkRepeat(spec: RepeatSpec, now: number): RepeatCheck {
  const remaining = Math.max(0, spec.maxCount - spec.doneCount);
  if (remaining <= 0) {
    return { due: false, remaining: 0, reason: `${spec.maxCount}회를 모두 실행했습니다` };
  }
  if (!Number.isFinite(spec.everyDays) || spec.everyDays <= 0) {
    return { due: false, remaining, reason: '반복 주기가 유효하지 않습니다' };
  }
  if (spec.lastAt == null) {
    return { due: true, remaining, reason: '첫 실행' };
  }
  const elapsed = now - spec.lastAt;
  const need = spec.everyDays * DAY_MS;
  if (elapsed < need) {
    const left = Math.ceil((need - elapsed) / DAY_MS);
    return { due: false, remaining, reason: `다음 실행까지 ${left}일 (${remaining}회 남음)` };
  }
  return { due: true, remaining, reason: `주기 도래 (${remaining}회 남음)` };
}

// ── 보호 요약 ──────────────────────────────────────────

export interface GuardSummary {
  exchange: number;
  app: number;
  /** 앱 보호가 있으면 반드시 보여야 하는 문장 */
  warning: string | null;
}

/**
 * 지금 걸린 보호가 어디에 있는지 센다.
 *
 * 앱 보호가 하나라도 있으면 경고를 만든다. 사용자는 "손절 걸어놨다"고
 * 기억하지, "그 손절이 서버가 살아 있어야 동작한다"까지는 기억하지 않는다.
 */
export function summarizeGuards(orders: { guardedBy: Guard }[]): GuardSummary {
  const exchange = orders.filter(o => o.guardedBy === 'EXCHANGE').length;
  const app = orders.filter(o => o.guardedBy === 'APP').length;
  return {
    exchange, app,
    warning: app > 0
      ? `${app}건은 앱이 감시해야 동작합니다. 서버가 멈추면 그 보호는 없는 것과 같습니다 ` +
        '— 장기 보유라면 거래소에 올라가는 지정가 손절을 함께 거는 편이 안전합니다.'
      : null,
  };
}

// ── 감시 등록 검증 ─────────────────────────────────────
//
// 이 검사가 라우트 안에 있으면 테스트할 수 없다. 실제로 그랬고, 연결
// 소유권 검사에 가려 동작을 확인할 방법이 없었다. 규칙은 순수 함수로 둔다.

export interface WatchSpec {
  kind: 'TRAILING' | 'RESERVED';
  side: 'BUY' | 'SELL';
  qty?: number | null;
  quoteUsd?: number | null;
  /** 트레일링 */
  entryPrice?: number | null;
  trailPct?: number | null;
  /** 예약 */
  triggerPrice?: number | null;
  direction?: 'above' | 'below' | null;
}

export interface WatchValidation { ok: boolean; code?: string; reason?: string }

const no = (code: string, reason: string): WatchValidation => ({ ok: false, code, reason });

/**
 * 감시를 걸어도 되는 값인가.
 *
 * 트레일링 매수를 막는 이유: 이 앱의 트레일링은 "고점 대비 하락하면 판다"는
 * 뜻이다. 매수 쪽에도 같은 이름을 붙이면 "저점 대비 상승하면 산다"인지
 * "떨어지면 산다"인지 사람마다 다르게 읽는다. 매수는 예약 주문으로 표현한다.
 */
export function validateWatchSpec(s: WatchSpec): WatchValidation {
  const hasQty = s.qty != null && Number.isFinite(s.qty) && s.qty > 0;
  const hasQuote = s.quoteUsd != null && Number.isFinite(s.quoteUsd) && s.quoteUsd > 0;
  if (!hasQty && !hasQuote) return no('invalid_amount', '수량 또는 금액이 필요합니다');

  // 매도는 코인 수량으로만 건다. 금액으로 걸면 발동 시점 가격으로 수량을
  // 되계산해야 하는데, 그 값이 보유를 넘으면 거부된다.
  if (s.side === 'SELL' && !hasQty) {
    return no('sell_needs_qty', '매도 감시는 코인 수량으로 지정해야 합니다');
  }

  if (s.kind === 'TRAILING') {
    if (s.side !== 'SELL') {
      return no('sell_only', '트레일링은 매도만 지원합니다. 하락 시 매수는 예약 주문을 쓰세요.');
    }
    const e = Number(s.entryPrice);
    if (!Number.isFinite(e) || e <= 0) return no('invalid_entry', '시작가가 올바르지 않습니다');
    const p = Number(s.trailPct);
    if (!Number.isFinite(p) || p <= 0 || p >= 100) {
      return no('invalid_pct', '트레일링 비율은 0보다 크고 100보다 작아야 합니다');
    }
    return { ok: true };
  }

  const t = Number(s.triggerPrice);
  if (!Number.isFinite(t) || t <= 0) return no('invalid_trigger', '기준 가격이 올바르지 않습니다');
  if (s.direction !== 'above' && s.direction !== 'below') {
    return no('invalid_direction', '발동 방향(이상/이하)이 필요합니다');
  }
  return { ok: true };
}
