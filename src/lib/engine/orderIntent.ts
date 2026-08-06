// src/lib/engine/orderIntent.ts
//
// **전송 직전에 주문을 다시 구성한다.**
//
// 왜 필요한가
// ───────────
// 화면의 주문 상태는 사용자가 이것저것 눌러 온 결과다. 지정가에서
// 시장가로 바꿔도 `price`는 상태에 남아 있고, 조건부에서 일반으로 바꿔도
// `stopPrice`가 남는다. 그 값들이 그대로 전송되면:
//
//   · MARKET에 price가 붙어 거래소가 -1106으로 거부하거나
//   · 더 나쁘게는 **의도하지 않은 조건이 붙은 채로 접수된다**
//
// 그래서 **화면이 만든 것을 그대로 보내지 않는다.** 주문 유형이 정한
// 필드만 새로 뽑아서 보낸다. 남아 있던 값은 실려 나가지 않는다.
//
// 그리고 방향
// ───────────
// 이게 이 파일에서 제일 비싼 부분이다.
//
//   롱 보유 + [청산] + 매도  →  롱이 줄어든다
//   롱 보유 + [신규] + 매도  →  **숏이 새로 열린다**
//
// 화면에서는 둘 다 '매도 주문'으로 보인다. UI 상태 하나가 꼬이면
// 청산하려다 반대 포지션을 만든다 — 이 저장소에서 가장 조용한 사고다.
//
// 그래서 청산 모드에서는 세 가지를 **서버가 강제한다**:
//   1. reduceOnly = true
//   2. 수량이 보유 수량을 못 넘는다
//   3. 방향이 포지션의 반대여야 한다

export type OrderKind =
  | 'MARKET' | 'LIMIT' | 'POST_ONLY'
  | 'STOP_MARKET' | 'STOP_LIMIT' | 'TAKE_PROFIT' | 'TRAILING_STOP';

/**
 * 유형별로 **허용되는** 필드.
 *
 * 여기 없는 필드는 그 유형의 주문에 실리지 않는다. 목록을 늘리는 것은
 * 쉽지만, 늘리기 전에 "이 유형에 이 값이 정말 필요한가"를 물어야 한다 —
 * 필요 없는 값이 하나 실릴 때마다 조용히 틀릴 자리가 하나 생긴다.
 */
export const ALLOWED_FIELDS: Record<OrderKind, readonly string[]> = {
  MARKET:        ['symbol', 'side', 'quantity', 'reduceOnly'],
  LIMIT:         ['symbol', 'side', 'quantity', 'price', 'reduceOnly', 'timeInForce'],
  POST_ONLY:     ['symbol', 'side', 'quantity', 'price', 'reduceOnly'],
  STOP_MARKET:   ['symbol', 'side', 'quantity', 'stopPrice', 'reduceOnly', 'closePosition', 'workingType'],
  STOP_LIMIT:    ['symbol', 'side', 'quantity', 'price', 'stopPrice', 'reduceOnly', 'workingType'],
  TAKE_PROFIT:   ['symbol', 'side', 'quantity', 'stopPrice', 'reduceOnly', 'closePosition', 'workingType'],
  TRAILING_STOP: ['symbol', 'side', 'quantity', 'activationPrice', 'callbackRate', 'reduceOnly'],
};

/** 그 유형이 **반드시** 가져야 하는 필드 */
export const REQUIRED_FIELDS: Record<OrderKind, readonly string[]> = {
  MARKET:        ['symbol', 'side', 'quantity'],
  LIMIT:         ['symbol', 'side', 'quantity', 'price'],
  POST_ONLY:     ['symbol', 'side', 'quantity', 'price'],
  STOP_MARKET:   ['symbol', 'side', 'stopPrice'],
  STOP_LIMIT:    ['symbol', 'side', 'quantity', 'price', 'stopPrice'],
  TAKE_PROFIT:   ['symbol', 'side', 'stopPrice'],
  TRAILING_STOP: ['symbol', 'side', 'quantity', 'callbackRate'],
};

export function orderKindOf(raw: any): OrderKind | null {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[-\s]/g, '_');
  return (s in ALLOWED_FIELDS) ? (s as OrderKind) : null;
}

export type PositionMode = 'ONE_WAY' | 'HEDGE';

export interface BuildInput {
  kind: any;
  symbol?: any;
  /** 'BUY' | 'SELL' */
  side?: any;
  quantity?: any;
  price?: any;
  stopPrice?: any;
  activationPrice?: any;
  callbackRate?: any;
  timeInForce?: any;
  workingType?: any;
  closePosition?: any;
  /** 사용자가 [청산] 탭에 있는가 */
  reduceOnly?: any;
  /**
   * 지금 들고 있는 포지션(부호 있는 수량). **못 읽었으면 null이다** —
   * 0으로 눕히면 '포지션 없음'이 되고, 청산 주문이 신규로 나간다.
   */
  positionQty?: number | null;
  /** 거래소의 포지션 모드. 못 읽었으면 null */
  positionMode?: PositionMode | null;
}

export type BuildBlock =
  | 'UNKNOWN_KIND'
  | 'MISSING_FIELD'
  | 'BAD_QUANTITY'
  /** 청산인데 포지션을 모른다 */
  | 'POSITION_UNKNOWN'
  /** 청산인데 포지션이 없다 */
  | 'NOTHING_TO_CLOSE'
  /** 청산 방향이 포지션과 같다 — 닫는 게 아니라 더 여는 것이다 */
  | 'CLOSE_SIDE_WRONG'
  /** 청산 수량이 보유를 넘는다 */
  | 'CLOSE_QTY_EXCEEDS'
  /** 포지션 모드를 모른다 */
  | 'POSITION_MODE_UNKNOWN';

export interface BuildResult {
  ok: boolean;
  blocked: BuildBlock | null;
  reason: string;
  /** 실제로 전송할 것. 허용된 필드만 들어 있다 */
  payload: Record<string, any>;
  /** 화면이 보냈지만 이 유형에 안 맞아 **버린** 필드 */
  dropped: string[];
  /** 서버가 고친 것 (사용자에게 알려야 한다) */
  adjusted: string[];
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const sideOf = (v: any): 'BUY' | 'SELL' | null => {
  const s = String(v ?? '').trim().toUpperCase();
  return s === 'BUY' || s === 'SELL' ? s : null;
};

/**
 * 전송할 주문을 새로 만든다.
 *
 * **입력을 손보지 않는다 — 새로 뽑는다.** 손보는 방식이면 지우는 것을
 * 한 번 빠뜨렸을 때 그 값이 그대로 나가고, 그 빠뜨림은 코드를 봐서는
 * 안 보인다. 허용 목록에서 뽑아 오면 빠뜨릴 수가 없다.
 */
export interface BuildOptions {
  /**
   * 포지션 모드를 못 읽었을 때 **막을 것인가.** 기본은 막지 않는다.
   *
   * 켜는 순간 모드 조회가 안 되는 계정의 신규 주문이 전부 멎는다.
   * 조회를 붙이고 값이 실제로 오는 것을 확인한 뒤에 켠다.
   */
  requirePositionMode?: boolean;
}

export function buildOrderPayload(
  input: BuildInput | null | undefined, opts: BuildOptions = {},
): BuildResult {
  const i = input ?? ({} as BuildInput);
  const fail = (blocked: BuildBlock, reason: string, extra: Partial<BuildResult> = {}): BuildResult =>
    ({ ok: false, blocked, reason, payload: {}, dropped: [], adjusted: [], ...extra });

  const kind = orderKindOf(i.kind);
  if (!kind) {
    return fail('UNKNOWN_KIND',
      `모르는 주문 유형입니다 (${i.kind}) — 아는 유형이 아니면 보내지 않습니다`);
  }

  const allowed = ALLOWED_FIELDS[kind];
  const adjusted: string[] = [];

  // ── 방향과 청산 ──
  const side = sideOf(i.side);
  const wantClose = i.reduceOnly === true;
  const posQty = num(i.positionQty);

  if (wantClose) {
    // **모르는 포지션을 닫지 않는다.** 0으로 눕히면 '포지션 없음'이
    // 되고, 청산 주문이 신규 진입으로 나간다.
    if (posQty == null) {
      return fail('POSITION_UNKNOWN',
        '보유 수량을 읽지 못해 청산 주문을 만들지 않았습니다 — 모르는 것을 닫으면 신규 진입이 됩니다');
    }
    if (Math.abs(posQty) <= 0) {
      return fail('NOTHING_TO_CLOSE', '닫을 포지션이 없습니다');
    }
    const closeSide: 'BUY' | 'SELL' = posQty > 0 ? 'SELL' : 'BUY';
    if (side && side !== closeSide) {
      // 여기가 조용한 사고의 자리다. 롱을 들고 BUY로 '청산'을 누르면
      // 닫히는 게 아니라 더 열린다.
      return fail('CLOSE_SIDE_WRONG',
        `${posQty > 0 ? '롱' : '숏'} 포지션을 ${side}로 닫을 수 없습니다 — `
        + `${closeSide}가 맞습니다. 이대로면 닫는 게 아니라 더 여는 주문입니다`);
    }
  }

  // ── 수량 ──
  //
  // STOP_MARKET/TAKE_PROFIT은 closePosition=true면 수량이 없어도 된다.
  const closesAll = i.closePosition === true;
  let qty = num(i.quantity);
  const needsQty = REQUIRED_FIELDS[kind].includes('quantity') || !closesAll;

  if (needsQty) {
    if (qty == null || qty <= 0) {
      if (!(closesAll && (kind === 'STOP_MARKET' || kind === 'TAKE_PROFIT'))) {
        return fail('BAD_QUANTITY', `수량이 없습니다 (${i.quantity})`);
      }
    } else if (wantClose && posQty != null) {
      // **보유를 넘는 청산은 잘라 낸다.** 넘겨 보내면 거래소가 거부하거나
      // (reduceOnly가 붙어 있으면) 초과분이 무시되는데, 어느 쪽인지는
      // 거래소마다 다르다. 여기서 자르면 어느 거래소든 같게 동작한다.
      const own = Math.abs(posQty);
      if (qty > own * (1 + 1e-9)) {
        adjusted.push(`수량 ${qty} → ${own} (보유 수량까지)`);
        qty = own;
      }
    }
  }

  // ── 포지션 모드 ──
  //
  // 단방향인데 헤지용 파라미터를 붙이거나 그 반대면 거래소가 거부한다.
  // 추측한 모드로 주문을 만들면, 틀렸을 때 거부가 아니라 반대 포지션이
  // 열릴 수 있다.
  //
  // **기본은 막지 않는다.** 이 검사를 켜는 순간 모드 조회가 안 되는
  // 계정의 신규 주문이 전부 멎는다. 조회를 붙이고, 실제로 값이 오는
  // 것을 확인한 뒤에 켜는 것이 순서다 — 안전장치를 켜다가 기능을
  // 죽이면 그 안전장치는 꺼진다.
  if (opts.requirePositionMode && !wantClose
      && (i.positionMode === undefined || i.positionMode === null)) {
    return fail('POSITION_MODE_UNKNOWN',
      '거래소 포지션 모드(단방향/헤지)를 확인하지 못했습니다 — 추측한 모드로 주문을 만들지 않습니다');
  }

  // ── 허용 필드만 새로 뽑는다 ──
  const source: Record<string, any> = {
    symbol: String(i.symbol ?? '').toUpperCase(),
    side,
    quantity: qty,
    price: num(i.price),
    stopPrice: num(i.stopPrice),
    activationPrice: num(i.activationPrice),
    callbackRate: num(i.callbackRate),
    timeInForce: i.timeInForce,
    workingType: i.workingType,
    closePosition: closesAll || undefined,
    reduceOnly: wantClose || undefined,
  };

  const payload: Record<string, any> = {};
  for (const f of allowed) {
    const v = source[f];
    if (v != null && v !== '') payload[f] = v;
  }

  // **청산이면 reduceOnly를 반드시 붙인다.** 화면이 안 보냈어도 붙인다 —
  // 이게 빠지면 청산이 반대 방향 신규 진입이 된다.
  if (wantClose && allowed.includes('reduceOnly') && payload.reduceOnly !== true) {
    payload.reduceOnly = true;
    adjusted.push('reduceOnly=true를 붙였습니다 (청산 주문)');
  }
  // 청산이면 방향도 확정한다.
  if (wantClose && posQty != null && allowed.includes('side')) {
    payload.side = posQty > 0 ? 'SELL' : 'BUY';
  }

  // ── 무엇을 버렸는가 ──
  //
  // 화면이 보냈는데 이 유형에 안 맞아 실리지 않은 값. **적어서 돌려준다** —
  // 조용히 버리면 "지정가를 넣었는데 시장가로 나갔다"를 설명할 수 없다.
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(source)) {
    if (v == null || v === '') continue;
    if (!allowed.includes(k)) dropped.push(k);
  }

  // ── 필수 필드 ──
  const missing = REQUIRED_FIELDS[kind].filter(f => {
    if (f === 'quantity' && closesAll && (kind === 'STOP_MARKET' || kind === 'TAKE_PROFIT')) return false;
    return payload[f] == null;
  });
  if (missing.length > 0) {
    return fail('MISSING_FIELD',
      `${kind} 주문에는 ${missing.join(', ')}이(가) 필요합니다`,
      { payload, dropped, adjusted });
  }

  return {
    ok: true, blocked: null, reason: '',
    payload, dropped, adjusted,
  };
}

/**
 * 화면이 주문 유형을 바꿨을 때 **비워야 하는** 상태 키.
 *
 * 화면 쪽에서도 지워 두면 사용자가 "지정가를 적었는데 칸이 사라졌다"를
 * 눈으로 본다. 서버가 어차피 버리지만, **버리는 것과 안 보이는 것은
 * 다르다** — 안 보이면 애초에 잘못된 기대를 안 한다.
 */
export function fieldsToClearOnKindChange(from: any, to: any): string[] {
  const a = orderKindOf(from);
  const b = orderKindOf(to);
  if (!b) return [];
  const before = a ? ALLOWED_FIELDS[a] : [];
  const after = ALLOWED_FIELDS[b];
  return before.filter(f => !after.includes(f));
}
