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

export interface ManagedPosition {
  connectionId: string;
  exchange: 'binance' | 'gate';
  symbol: string;
  strategyId: string | null;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
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
    const stopLoss = num(r?.stop_loss);
    // **진입 시각은 acked_at이다.** created_at은 보내기 전에 적는 INTENT
    // 시점이라 체결 시각이 아니다 — 시간청산의 기준으로 쓰면 안 된다.
    const openedAt = r?.acked_at ? Date.parse(String(r.acked_at)) : NaN;

    if (!symbol || !side || entryPrice == null || entryPrice <= 0) {
      note('INCOMPLETE', '종목·방향·체결가 중 빠진 것이 있어 판단하지 않습니다');
      continue;
    }
    if (stopLoss == null || stopLoss <= 0) {
      // 1R을 정의할 수 없으면 트레일링·본전이동을 계산할 수 없다.
      note('NO_STOP', '진입 손절이 없어 R을 정의할 수 없습니다');
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
      entryPrice, stopLoss, openedAt,
      ownedProtectionIds: ids,
      orderId: r?.id ? String(r.id) : null,
    } });
  }

  const positions: ManagedPosition[] = keep.map(({ pos }) => {
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
