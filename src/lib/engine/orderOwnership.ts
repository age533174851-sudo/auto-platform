// src/lib/engine/orderOwnership.ts
//
// **이 조건부 주문은 누구 것인가.**
//
// 실제로 있던 일
// ──────────────
// Gate Orders 탭에 조건부 주문이 **4개** 남아 있었다. 이전 날짜의
// SL/TP가 안 치워진 채 새 SL/TP까지 붙은 것이다. 포지션은 그 사이에
// 상계되어 0.01 ETH짜리 찌꺼기만 남았는데, 조건부 주문은 그대로였다.
//
// 이걸 치우는 가장 쉬운 방법은 `cancelAll`이다. 그리고 그게 가장
// 위험하다 — 같은 계좌·같은 종목에 daily-ladder가 걸어 둔 손절이
// 있으면 **그 포지션의 방어선을 남이 지운다.** 못 여는 것은 불편이고
// 못 닫는 것은 사고인데, 손절을 남이 지우는 것은 그중에서도 최악이다.
//
// 그래서 소유권이 필요하다
// ────────────────────────
// 주문 하나하나가 **누가 · 무엇을 위해** 냈는지를 들고 다녀야 한다.
// 거래소가 우리에게 돌려주는 식별자는 사실상 하나뿐이다 —
// clientOrderId(Gate는 `text`). 그래서 그 안에 소유권을 새긴다.
//
// 규칙 둘
// ───────
//   1. **내 것이라고 읽히는 주문만 취소한다.** 남의 것도, 모르는 것도
//      건드리지 않는다. 모르는 것을 치우는 것은 cancelAll과 같다.
//   2. **포지션이 0이라고 확인됐을 때만 고아다.** 조회 실패 상태에서
//      치우면 살아 있는 포지션의 손절을 지우게 된다.

/** 이 주문이 무엇을 하려고 나갔는가 */
export type OrderPurpose = 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'EXIT';

/**
 * 목적 한 글자.
 *
 * clientOrderId는 거래소마다 길이 제한이 다르고 Gate는 28자에서
 * 잘린다(`toGateText`). 그래서 목적은 **한 글자**로 새긴다.
 */
export const PURPOSE_CODE: Record<OrderPurpose, string> = {
  ENTRY: 'E', STOP_LOSS: 'S', TAKE_PROFIT: 'P', EXIT: 'X',
};
const CODE_PURPOSE: Record<string, OrderPurpose> = {
  E: 'ENTRY', S: 'STOP_LOSS', P: 'TAKE_PROFIT', X: 'EXIT',
};

export interface OrderOwner {
  strategyId: string;
  strategyVersion?: string | null;
  scheduleId?: string | null;
  connectionId?: string | null;
  symbol: string;
  mode?: string | null;
}

/** 전략을 id에 새길 때 쓰는 짧은 머리글자. 충돌하면 안 되므로 표로 둔다 */
const STRATEGY_PREFIX: Record<string, string> = {
  'my-original-v1': 'mo1',
  'daily-ladder': 'dl',
  scalp: 'sc',
};

/** 표에 없는 전략도 안정적인 3글자를 갖는다 — 이름이 바뀌면 id도 바뀐다 */
export function strategyPrefixOf(strategyId: string): string {
  const known = STRATEGY_PREFIX[String(strategyId)];
  if (known) return known;
  const s = String(strategyId ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return (s.slice(0, 3) || 'unk');
}

/**
 * **같은 논리적 행동은 같은 id를 갖는다.**
 *
 * 이게 멱등성의 전부다. Worker가 재시도하든, GitHub 예비 실행기가
 * 동시에 깨우든, HTTP 타임아웃 뒤 다시 보내든 — 같은 (전략 · 거래일 ·
 * 종목 · 목적 · 회차) 조합이면 같은 id가 나오고, 거래소는 그 id를 이미
 * 본 주문으로 처리한다.
 *
 * **시각을 넣지 않는다.** `Date.now()`를 섞으면 재시도마다 새 id가 되고,
 * 그건 멱등이 아니라 중복이다.
 */
export function ownedClientOrderId(i: {
  owner: OrderOwner;
  /** 이 행동을 유일하게 정하는 열쇠. 보통 거래일(YYYY-MM-DD) */
  logicalKey: string;
  purpose: OrderPurpose;
  /** 같은 열쇠 안에서 여러 건이 나갈 때(분할 익절 등). 기본 0 */
  seq?: number;
}): string {
  const p = strategyPrefixOf(i.owner.strategyId);
  const key = String(i.logicalKey ?? '').replace(/[^a-zA-Z0-9]/g, '');
  const sym = String(i.owner.symbol ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
  const seq = Math.max(0, Math.round(Number(i.seq) || 0));
  // **머리글자 뒤에 구분자를 둔다.** 머리글자는 2~3자인데 뒤가 바로
  // 숫자면 `dl2…`인지 `dl` + `2…`인지 되읽을 때 가를 수 없다 —
  // 그러면 남의 주문을 내 것으로 읽는다.
  // 3 + 1 + 8 + 6 + 1 + 1 = 20자 — Gate의 28자 안이라 해시 없이 그대로 남는다.
  return `${p}-${key}${sym}${PURPOSE_CODE[i.purpose]}${seq}`;
}

export interface ParsedOwnership {
  ok: boolean;
  strategyPrefix: string | null;
  purpose: OrderPurpose | null;
  reason: string;
}

/**
 * clientOrderId(또는 Gate `text`)에서 소유권을 읽는다.
 *
 * **못 읽으면 ok=false다.** '아마 내 것'은 없다 — 그 추측 위에서
 * 남의 손절을 취소하게 된다.
 */
export function parseOwnedClientOrderId(raw: any): ParsedOwnership {
  let s = String(raw ?? '').trim();
  if (!s) return { ok: false, strategyPrefix: null, purpose: null, reason: '식별자가 비어 있습니다' };
  // Gate는 `t-` 접두사를 붙이고, 28자를 넘으면 `-해시6`을 덧붙인다.
  if (s.startsWith('t-')) s = s.slice(2);
  const hashed = /-[0-9a-f]{6}$/i.test(s);
  if (hashed) {
    // 잘린 id는 목적 글자가 날아갔을 수 있다. **추측하지 않는다.**
    return { ok: false, strategyPrefix: null, purpose: null,
      reason: '길이 제한으로 잘린 식별자입니다 — 목적을 확정할 수 없습니다' };
  }
  const m = /^([a-z][a-z0-9]{1,2})-([A-Za-z0-9]*?)([ESPX])(\d+)$/.exec(s);
  if (!m) {
    return { ok: false, strategyPrefix: null, purpose: null,
      reason: `이 형식으로 만든 식별자가 아닙니다 (${s})` };
  }
  return { ok: true, strategyPrefix: m[1], purpose: CODE_PURPOSE[m[3]] ?? null, reason: '' };
}

// ── 고아 보호주문 ────────────────────────────────────

export type OwnerClass =
  /** 이 전략이 만든 것이 확실하다 */
  | 'MINE'
  /** 다른 전략의 것이 확실하다 */
  | 'FOREIGN'
  /** 누구 것인지 못 읽었다. **건드리지 않는다** */
  | 'UNKNOWN';

export interface ClassifiedOrder {
  id: string;
  class: OwnerClass;
  purpose: OrderPurpose | null;
  reason: string;
}

/** 조건부 주문 한 줄이 내 것인가 */
export function classifyOrder(row: any, myStrategyId: string): ClassifiedOrder {
  const id = String(row?.id ?? row?.orderId ?? '');
  // Gate의 조건부 주문은 `initial.text`에 우리가 넣은 값이 들어 있다.
  const text = row?.initial?.text ?? row?.text ?? row?.clientOrderId ?? row?.client_order_id;
  const p = parseOwnedClientOrderId(text);
  if (!p.ok) {
    return { id, class: 'UNKNOWN', purpose: null,
      reason: `소유 전략을 읽지 못했습니다 — ${p.reason}. 건드리지 않습니다` };
  }
  const mine = p.strategyPrefix === strategyPrefixOf(myStrategyId);
  return {
    id, class: mine ? 'MINE' : 'FOREIGN', purpose: p.purpose,
    reason: mine ? '이 전략이 만든 주문입니다'
      : `다른 전략(${p.strategyPrefix})의 주문입니다 — 취소하지 않습니다`,
  };
}

export interface CleanupPlan {
  /** 취소해도 되는 주문 id. **여기 없는 것은 절대 취소하지 않는다** */
  cancel: string[];
  /** 남기는 것과 그 이유 */
  keep: Array<{ id: string; class: OwnerClass; reason: string }>;
  /** 지금 정리해도 되는가. false면 cancel은 항상 비어 있다 */
  ok: boolean;
  code: 'CLEAN' | 'NOTHING_TO_DO' | 'POSITION_OPEN' | 'POSITION_UNKNOWN' | 'ORDERS_UNKNOWN';
  reason: string;
}

/**
 * 고아 보호주문 정리 계획.
 *
 * **포지션이 0이라고 확인됐을 때만 고아다.** 이 조건이 이 함수의 전부다:
 *   · 조회 실패 → 아무것도 취소하지 않는다 (살아 있는 손절을 지울 수 있다)
 *   · 포지션이 남아 있음 → 그 보호주문은 고아가 아니라 **방어선**이다
 *   · 목록을 못 읽음 → '없다'가 아니다. 정리했다고 적지 않는다
 *
 * 그리고 통과해도 **내 것만** 취소한다.
 */
export function orphanCleanupPlan(i: {
  /** 포지션 재조회 결과 */
  position: { ok: boolean; found: boolean; qty?: number | null };
  /** 조건부 주문 목록. **null은 '못 읽음'이고 []는 '없음'이다** */
  orders: any[] | null;
  myStrategyId: string;
}): CleanupPlan {
  const empty = { cancel: [] as string[], keep: [] as CleanupPlan['keep'] };

  if (!i.position || i.position.ok !== true) {
    return { ...empty, ok: false, code: 'POSITION_UNKNOWN',
      reason: '포지션을 조회하지 못해 고아 여부를 판단할 수 없습니다 — '
        + '살아 있는 포지션의 손절을 지울 수 있으므로 아무것도 취소하지 않습니다' };
  }
  if (i.position.found) {
    return { ...empty, ok: false, code: 'POSITION_OPEN',
      reason: `포지션이 남아 있습니다${i.position.qty != null ? ` (${i.position.qty})` : ''} — `
        + '이 조건부 주문들은 고아가 아니라 그 포지션의 방어선입니다' };
  }
  if (i.orders == null) {
    return { ...empty, ok: false, code: 'ORDERS_UNKNOWN',
      reason: '조건부 주문 목록을 읽지 못했습니다 — 0건과 다릅니다. 정리했다고 적지 않습니다' };
  }

  const cancel: string[] = [];
  const keep: CleanupPlan['keep'] = [];
  for (const row of i.orders) {
    const c = classifyOrder(row, i.myStrategyId);
    if (c.class === 'MINE' && c.id) cancel.push(c.id);
    else keep.push({ id: c.id, class: c.class, reason: c.reason });
  }

  if (cancel.length === 0 && keep.length === 0) {
    return { cancel, keep, ok: true, code: 'NOTHING_TO_DO',
      reason: '포지션 0 · 남은 조건부 주문 없음' };
  }
  return {
    cancel, keep, ok: true, code: 'CLEAN',
    reason: `포지션 0 확인 — 이 전략이 만든 조건부 주문 ${cancel.length}건을 취소합니다`
      + (keep.length ? ` · 다른 소유/불명 ${keep.length}건은 그대로 둡니다` : ''),
  };
}

// ── 같은 종목에 전략이 둘 ─────────────────────────────

export interface ConflictVerdict {
  /** 지금 이 전략이 이 종목에 들어가도 되는가 */
  ok: boolean;
  code: 'CLEAR' | 'BLOCK_CONFLICT' | 'SCHEDULES_UNKNOWN';
  /** 겹치는 전략들 */
  others: string[];
  reason: string;
}

/**
 * 같은 연결·같은 종목에 **켜져 있는** 다른 전략이 있는가.
 *
 * 지금 DB에는 daily-ladder BTCUSDT와 my-original-v1 BTCUSDT가 같이
 * 있다. 둘 다 켜지면 한쪽의 청산이 다른 쪽 포지션을 닫고, 한쪽의
 * 손절이 다른 쪽 진입에 발동한다 — ONE_WAY 계좌에서 포지션은 하나뿐이기
 * 때문이다. 위의 소유권 표시는 **주문**을 가르지만 **포지션**은 못 가른다.
 *
 * 그래서 포지션 단위 소유권(ownership slicing)이 생기기 전까지는
 * **겹치면 들어가지 않는다.** 꺼져 있는 예약은 겹치는 것이 아니다 —
 * 지금 BTCUSDT/ETHUSDT가 전부 꺼져 있는 상태가 그렇다.
 *
 * `rows`가 **null이면 '못 읽음'이다.** 그때는 '겹치는 것이 없다'가
 * 아니라 확인 실패이고, 확인하지 못한 것은 통과가 아니다.
 */
export function symbolOwnershipConflict(i: {
  rows: any[] | null;
  myStrategyId: string;
  symbol: string;
  connectionId?: string | null;
}): ConflictVerdict {
  if (i?.rows == null) {
    return { ok: false, code: 'SCHEDULES_UNKNOWN', others: [],
      reason: '같은 종목의 다른 예약을 확인하지 못했습니다 — 확인하지 못한 것은 통과가 아닙니다' };
  }
  const want = String(i.symbol ?? '').toUpperCase().replace(/[_/\-\s]/g, '');
  const conn = i.connectionId == null ? null : String(i.connectionId);

  const others = new Set<string>();
  for (const r of i.rows) {
    // **enabled === true만 켜진 것이다.** 문자열 'false'는 truthy다.
    if (r?.enabled !== true) continue;
    if (String(r?.symbol ?? '').toUpperCase().replace(/[_/\-\s]/g, '') !== want) continue;
    // 연결이 다르면 다른 계좌다 — 포지션이 겹치지 않는다.
    if (conn != null && r?.connection_id != null && String(r.connection_id) !== conn) continue;
    const sid = String(r?.strategy_id ?? '').trim();
    if (!sid || sid === String(i.myStrategyId)) continue;
    others.add(sid);
  }

  if (others.size === 0) {
    return { ok: true, code: 'CLEAR', others: [],
      reason: `${i.symbol}에 켜져 있는 다른 전략이 없습니다` };
  }
  const list = Array.from(others);
  return {
    ok: false, code: 'BLOCK_CONFLICT', others: list,
    reason: `${i.symbol}에 다른 전략(${list.join(' · ')})이 같은 연결로 켜져 있습니다 — `
      + 'ONE_WAY 계좌는 종목당 포지션이 하나라, 한쪽의 청산과 손절이 다른 쪽을 건드립니다. '
      + '포지션 단위 소유권이 생기기 전까지 같은 종목에 두 전략을 동시에 돌리지 않습니다',
  };
}

/**
 * 정리 결과 → `reversalProgress`가 읽는 값.
 *
 * **취소를 시도했는데 실패한 것을 true로 적지 않는다.** 그러면 남아
 * 있는 주문 위로 새 포지션이 열린다.
 */
export function cleanupOutcome(i: {
  plan: CleanupPlan;
  /** 실제로 취소에 성공한 id들 */
  cancelled?: string[] | null;
}): { cleaned: boolean | null; reason: string } {
  if (!i.plan.ok) return { cleaned: null, reason: i.plan.reason };
  if (i.plan.cancel.length === 0) return { cleaned: true, reason: i.plan.reason };
  if (i.cancelled == null) {
    return { cleaned: null, reason: '취소 결과를 확인하지 못했습니다' };
  }
  const missed = i.plan.cancel.filter(id => !i.cancelled!.includes(id));
  if (missed.length > 0) {
    return { cleaned: false, reason: `취소하지 못한 조건부 주문이 있습니다: ${missed.join(', ')}` };
  }
  return { cleaned: true, reason: `조건부 주문 ${i.cancelled.length}건 취소 완료` };
}
