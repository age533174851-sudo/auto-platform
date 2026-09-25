// src/lib/engine/managedPosition.ts
//
// **전략을 가리지 않고 "지금 열려 있는 포지션"을 만든다.**
//
// 왜 필요한가
// ───────────
// 청산 감시는 `ladder_daily_trades` 하나만 읽었다. 그건 계단식 전용
// 표라서 scalp·my-original-v1 포지션은 트레일링도 본전이동도 시간청산도
// 받지 못했다(#201의 커버리지 표가 그 사실을 그대로 보여 준다).
//
// 세 전략이 함께 쓰는 표는 `live_orders`다. 거기에 연결 · 거래소 · 종목 ·
// 방향 · 체결가 · 손절 · 보호주문 번호 · 전략 표식이 전부 있다.
//
// 줄이 있다고 열려 있는 것이 아니다
// ─────────────────────────────────
// `live_orders`는 **의도 장부**다. 보내기 전에 먼저 적고(INTENT),
// 응답을 못 받으면 UNKNOWN으로 남는다. 그래서 줄이 있다는 이유로
// "포지션이 열려 있다"고 읽으면 **없는 포지션의 손절을 옮기게 된다.**
//
// 여기서는 **후보만** 만든다. 실제로 열려 있는지는 그 연결·거래소에
// 물어서 확인한다(부르는 쪽이 `readback`을 넘긴다).
//
// 같은 종목을 두 전략이 자기 것이라 주장하면
// ──────────────────────────────────────────
// 거래소 선물은 대개 **net position**이다. 같은 connection + symbol에
// scalp와 my-original-v1의 줄이 둘 다 있으면, 거래소가 말하는 포지션
// 하나를 누구 것이라 할 수 없다.
//
// 그때 손절을 옮기거나 닫으면 **남의 전략 포지션을 건드리는 것**이다.
// 그래서 `OWNERSHIP_AMBIGUOUS`로 두고 아무 주문도 내지 않는다.
// 고아 보호주문 정리(#201)는 적어 둔 번호로만 하므로 그대로 돈다.

import { strategyOf } from '../strategies/ledger';

export type OwnershipCode =
  /** 이 연결·종목에 이 전략의 줄만 있다 */
  | 'OWNED'
  /** 여러 전략이 같은 자리를 주장한다. **손대지 않는다** */
  | 'OWNERSHIP_AMBIGUOUS'
  /** 주인을 모른다 (표식이 없는 옛 줄) */
  | 'OWNER_UNKNOWN';

/** `live_orders`에서 여기서 쓰는 칸만 */
export interface OrderRowLike {
  id?: string;
  connection_id: string | null;
  exchange: string | null;
  symbol: string | null;
  side: string | null;
  /** 체결가. 못 받았으면 null */
  avg_price: number | string | null;
  price?: number | string | null;
  stop_loss: number | string | null;
  /**
   * 이 주문이 **고정 손절을 쓰는 계약이었는가** (`078`의 `live_orders.stop_policy`).
   *
   * `'NO_FIXED_SL'` · `'FIXED_SL'` · 안 적혀 있으면 null.
   *
   * ★ **없는 손절을 정책으로 추정하지 않는다.** 손절가가 비어 있다는 사실만
   *   보고 "무손절 계약이겠지"라고 읽으면, 손절을 걸다 실패한 주문까지
   *   무손절 전략으로 감시하게 된다. 그 둘은 다루는 법이 정반대다.
   */
  stop_policy?: string | null;
  sl_order_id?: string | null;
  tp_order_id?: string | null;
  status: string | null;
  reduce_only?: boolean | null;
  /** **진입 시각은 이 값이다.** created_at은 INTENT 시점이다 */
  acked_at: string | null;
  created_at?: string | null;
  signal_id?: string | null;
  strategy_id?: string | null;
}

/** 장부에 적힌 손절 정책. **못 읽었으면 null이고, null은 무손절이 아니다** */
export type StopPolicyRead = 'FIXED_SL' | 'NO_FIXED_SL' | null;

export interface ManagedPosition {
  connectionId: string;
  exchange: 'binance' | 'gate';
  symbol: string;
  strategyId: string | null;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  /**
   * 진입 손절. **무손절 계약(`NO_FIXED_SL`)에서는 null이다.**
   *
   * 예전에는 `number`였고, 값이 없는 줄은 후보에서 통째로 빠졌다. 그래서
   * 고정 손절을 쓰지 않기로 한 포지션이 **감시 대상에 들어오지 못했고**,
   * 시간 청산까지 닿지 못했다.
   */
  stopLoss: number | null;
  /** 장부에 적힌 손절 정책. 판단은 이 값으로 한다 — 손절가 유무로 추정하지 않는다 */
  stopPolicy: StopPolicyRead;
  /** 진입(체결) 시각 ms */
  openedAt: number;
  ownedProtectionIds: string[];
  ownership: { code: OwnershipCode; reason: string; claimants: string[] };
  /** 어느 줄에서 왔는가 — 기록·중복 방지에 쓴다 */
  orderId: string | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 진입으로 볼 수 있는 상태. **UNKNOWN은 포함하지 않는다** */
const ENTERED = new Set(['FILLED', 'ACKED', 'RECONCILED']);

function venueOf(v: any): 'binance' | 'gate' | null {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'binance') return 'binance';
  if (s === 'gate' || s === 'gateio' || s === 'gate.io') return 'gate';
  return null;   // **모르는 거래소를 바이낸스로 읽지 않는다**
}

function sideOf(v: any): 'LONG' | 'SHORT' | null {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'BUY' || s === 'LONG') return 'LONG';
  if (s === 'SELL' || s === 'SHORT') return 'SHORT';
  return null;
}

export interface CandidateSkip { code: string; count: number; reason: string }

/**
 * 주문 장부 → 감시 후보.
 *
 * **여기서 거래소에 묻지 않는다.** 순수 함수라 테스트가 값만으로 돌린다.
 * 실제로 열려 있는지는 부르는 쪽이 확인한다.
 */
export function managedCandidates(rows: OrderRowLike[] | null | undefined): {
  positions: ManagedPosition[];
  skipped: CandidateSkip[];
} {
  const skip = new Map<string, CandidateSkip>();
  const note = (code: string, reason: string) => {
    const cur = skip.get(code);
    if (cur) cur.count += 1; else skip.set(code, { code, count: 1, reason });
  };

  const list = Array.isArray(rows) ? rows : [];
  // (연결 · 종목)마다 어느 전략들이 주장하는가
  const claims = new Map<string, Set<string>>();
  const keep: Array<{ row: OrderRowLike; pos: Omit<ManagedPosition, 'ownership'> }> = [];

  for (const r of list) {
    // 청산 주문은 진입이 아니다.
    if (r?.reduce_only === true) { note('REDUCE_ONLY', '청산 주문은 진입이 아닙니다'); continue; }

    const status = String(r?.status || '').toUpperCase();
    if (!ENTERED.has(status)) {
      // **UNKNOWN을 진입으로도 미진입으로도 읽지 않는다.** 대조(reconcile)가
      // 상태를 확정한 뒤에 다시 후보가 된다.
      note('NOT_ENTERED', `체결이 확인된 주문만 봅니다 (지금 ${status || '상태 없음'})`);
      continue;
    }

    const connectionId = String(r?.connection_id || '').trim();
    if (!connectionId) {
      // **연결을 추측하지 않는다.**
      note('NO_CONNECTION', '어느 계좌인지 적혀 있지 않아 손대지 않습니다');
      continue;
    }
    const exchange = venueOf(r?.exchange);
    if (!exchange) {
      // **거래소를 추측하지 않는다.**
      note('NO_VENUE', '어느 거래소인지 알 수 없어 손대지 않습니다');
      continue;
    }
    const symbol = String(r?.symbol || '').trim().toUpperCase();
    const side = sideOf(r?.side);
    const entryPrice = num(r?.avg_price) ?? num(r?.price);
    const rawStop = num(r?.stop_loss);
    // ★ **정책은 읽는 것이지 추정하는 것이 아니다.**
    //
    //   `NO_FIXED_SL`이라고 **적혀 있을 때만** 무손절로 본다. 손절가가
    //   비어 있다는 사실은 근거가 아니다 — 손절을 걸다 실패한 주문도
    //   똑같이 비어 있고, 그 둘은 다루는 법이 정반대다.
    const pol = String(r?.stop_policy || '').toUpperCase();
    const stopPolicy: StopPolicyRead =
      pol === 'NO_FIXED_SL' ? 'NO_FIXED_SL' : pol === 'FIXED_SL' ? 'FIXED_SL' : null;
    const noFixedSl = stopPolicy === 'NO_FIXED_SL';
    // 무손절 계약에 손절가가 같이 적혀 있으면 **정책을 따른다.** 값 쪽을
    // 믿으면 그 포지션에 R 기반 손절 이동이 붙는데, 그건 이 계약이
    // 하지 않기로 한 일이다. 대신 그런 줄이 있었다는 사실은 남긴다.
    if (noFixedSl && rawStop != null && rawStop > 0) {
      note('POLICY_STOP_CONFLICT',
        '무손절 계약인데 손절가가 함께 적혀 있습니다 — 정책을 따르고 손절가는 쓰지 않습니다');
    }
    const stopLoss = noFixedSl ? null : rawStop;
    // **진입 시각은 acked_at이다.** created_at은 보내기 전에 적는 INTENT
    // 시점이라 체결 시각이 아니다 — 시간청산의 기준으로 쓰면 안 된다.
    const openedAt = r?.acked_at ? Date.parse(String(r.acked_at)) : NaN;

    if (!symbol || !side || entryPrice == null || entryPrice <= 0) {
      note('INCOMPLETE', '종목·방향·체결가 중 빠진 것이 있어 판단하지 않습니다');
      continue;
    }
    // ★ **무손절 계약은 여기서 빠지지 않는다.**
    //
    //   예전에는 손절가가 없다는 이유로 이 줄에서 `continue`했다. 그래서
    //   `NO_FIXED_SL` 포지션이 후보 목록에 **아예 들어오지 못했고**,
    //   `lifecycleDecide`의 시간 청산 판단에 닿지 못했다. 감시되지 않는
    //   포지션이 되는 것이고, 그게 이 수정이 막는 고장이다.
    //
    //   R을 정의할 수 없다는 것은 여전히 사실이다 — 그래서 트레일링과
    //   본전이동은 `lifecycleDecide`가 막는다. 여기서 막을 일이 아니다.
    if (!noFixedSl && (stopLoss == null || stopLoss <= 0)) {
      // 1R을 정의할 수 없고, 무손절이라고 **적혀 있지도 않다.**
      note('NO_STOP', '진입 손절이 없고 무손절 계약이라고 적혀 있지도 않아 판단하지 않습니다');
      continue;
    }
    if (!Number.isFinite(openedAt)) {
      // **추측하지 않는다.** created_at으로 대체하면 시간청산이 앞당겨진다.
      note('NO_ENTRY_TIME', '체결 시각(acked_at)이 없어 보유 시간을 셀 수 없습니다');
      continue;
    }

    const strategyId = strategyOf(r);
    const key = `${connectionId}|${symbol}`;
    if (!claims.has(key)) claims.set(key, new Set());
    claims.get(key)!.add(strategyId ?? '(주인 모름)');

    const ids = [r?.sl_order_id, r?.tp_order_id]
      .map(v => String(v ?? '').trim())
      .filter(v => v && v !== 'null' && v !== 'undefined');

    keep.push({ row: r, pos: {
      connectionId, exchange, symbol, strategyId, side,
      entryPrice, stopLoss, stopPolicy, openedAt,
      ownedProtectionIds: ids,
      orderId: r?.id ? String(r.id) : null,
    } });
  }

  // ══════════ ★ 같은 자리를 가리키는 줄이 여럿이면 **최신 하나만** ══════════
  //
  // 무엇이 고장이었나
  // ─────────────────
  // 후보를 만들 때는 줄마다 하나씩 다 올렸고, 중복 제거는 **판단 뒤**에
  // 있었다(`done`). 그런데 그 등록이 "조치가 있을 때"만 일어나서:
  //
  //   1시간 전 새 진입  → 아직 6시간 안 됨 → NONE → done에 안 들어감
  //   7시간 전 과거 주문 → 같은 계좌·종목·방향 → 시간 초과 → **청산**
  //
  // 즉 **과거 행의 보유 시간이 현재 포지션을 닫는다.** `acked_at`을 쓰는
  // 것만으로는 이 고장이 막히지 않는다 — 각 줄의 시각은 정확했고, 문제는
  // 어느 줄이 현재 포지션을 대표하는지였다.
  //
  // 그래서 **판단 전에** 자리마다 가장 최신 줄만 남긴다. 호출부가 넘기는
  // 순서에 기대지 않고 `openedAt`으로 직접 고른다 — 정렬이 바뀌어도 같은
  // 답이 나와야 한다.
  //
  // ★ **이것으로 소유권이 증명되지는 않는다.** 최신 줄이 현재 열려 있는
  //   포지션과 같은 진입이라는 보장은 거래소가 주지 않는다(우리는 venue가
  //   인정하는 포지션 개시 시각을 읽지 못한다). 그래서 밀려난 줄을
  //   `STALE_DUPLICATE`로 남겨, 그런 자리가 있었다는 사실이 보이게 한다.
  const newest = new Map<string, { row: OrderRowLike; pos: Omit<ManagedPosition, 'ownership'> }>();
  for (const k of keep) {
    // ★ **전략을 키에 넣는다.**
    //
    //   빼면 같은 종목을 주장하는 **다른 전략의 줄**까지 하나로 합쳐지고,
    //   그러면 전략 충돌(`CONTESTED`)을 감지할 수 없다 — 그 판정은 두 줄이
    //   다 올라와야 성립한다. 실제로 그 시험이 깨져서 알았다.
    //
    //   막으려는 것은 **같은 전략의 오래된 줄**이다. 전략이 다르면 서로
    //   다른 주장이고, 그건 합칠 것이 아니라 충돌로 드러내야 한다.
    const key = `${k.pos.connectionId}|${k.pos.symbol}|${k.pos.side}|${k.pos.strategyId ?? ''}`;
    const cur = newest.get(key);
    if (!cur || k.pos.openedAt > cur.pos.openedAt) {
      if (cur) note('STALE_DUPLICATE', '같은 자리를 가리키는 더 오래된 줄은 판단하지 않습니다');
      newest.set(key, k);
    } else {
      note('STALE_DUPLICATE', '같은 자리를 가리키는 더 오래된 줄은 판단하지 않습니다');
    }
  }
  const kept = Array.from(newest.values());

  const positions: ManagedPosition[] = kept.map(({ pos }) => {
    const claimants = Array.from(claims.get(`${pos.connectionId}|${pos.symbol}`) ?? []);
    let ownership: ManagedPosition['ownership'];
    if (claimants.length > 1) {
      // **거래소 선물은 net position이다.** 하나뿐인 포지션을 둘이
      // 자기 것이라 하면, 손절을 옮기는 순간 남의 것을 건드린다.
      ownership = { code: 'OWNERSHIP_AMBIGUOUS', claimants,
        reason: `같은 계좌·종목을 ${claimants.length}개 전략이 주장합니다 `
          + `(${claimants.join(' · ')}) — 어느 쪽 포지션인지 증명할 수 없어 주문을 내지 않습니다` };
    } else if (!pos.strategyId) {
      ownership = { code: 'OWNER_UNKNOWN', claimants,
        reason: '주문에 전략 표식이 없어 어느 전략의 포지션인지 알 수 없습니다' };
    } else {
      ownership = { code: 'OWNED', claimants, reason: '이 계좌·종목을 주장하는 전략이 하나뿐입니다' };
    }
    return { ...pos, ownership };
  });

  return { positions, skipped: Array.from(skip.values()) };
}

/** 이 포지션에 주문을 내도 되는가. **OWNED만 통과한다** */
export function mayActOn(p: Pick<ManagedPosition, 'ownership'>): boolean {
  return p?.ownership?.code === 'OWNED';
}

/**
 * 같은 (연결 · 종목)에 두 번 주문하지 않게 하는 열쇠.
 *
 * 워커가 둘 떠 있거나 한 회차에 같은 자리를 두 줄이 가리켜도, 이 값으로
 * 한 번만 실행한다. **종목만으로 만들지 않는다** — 다른 계좌의 같은
 * 종목은 다른 포지션이다.
 */
export function mutationKeyOf(p: Pick<ManagedPosition, 'connectionId' | 'symbol' | 'side'>): string {
  return `${p.connectionId}|${p.symbol}|${p.side}`;
}
