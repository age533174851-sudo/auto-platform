// src/lib/engine/protectionCleanup.ts
//
// **포지션이 0일 때 내 보호주문을 치우는 길은 하나뿐이다.**
//
// 왜 하나여야 하나
// ────────────────
// 이 절차가 세 곳에서 필요하다:
//
//   1. 신규 진입 직전 — 포지션이 이미 0인데 형제 보호주문이 남아 있는 경우
//   2. 반전 — 기존 포지션을 닫은 직후
//   3. 청산 감시 — 거래소 SL/TP가 포지션을 닫아 준 직후
//
// 셋에 각자 두면 **한쪽만 고쳐진다.** 실제로 그렇게 났다: 스모크는
// 자기 settle에서 재조회까지 확인하며 지웠고, 실제 자동매매는 반전
// 분기에만 정리가 있었으며 그나마 HTTP 200만 보고 "지웠다"고 적었다.
// 그 결과가 Gate의 Positions 0 / Orders 1이다.
//
// 절대 하지 않는 것
// ─────────────────
// **Cancel All을 부르지 않는다.** 내 것으로 증명된 정확한 번호만 지운다.
// 소유 증거의 1순위는 **걸 때 받아 적어 둔 거래소 주문 번호**이고,
// 식별자(text) 파싱이 2순위다 — 형식이 한 번 깨지면 내 주문이 UNKNOWN이
// 되고, UNKNOWN은 안전을 이유로 안 지우므로 거래소에 계속 쌓인다.

import { flatCleanupPlan, flatCleanupVerdict, type FlatCleanupVerdict } from './flatCleanup';
import { cancelLedger } from './protectionLedger';
import { parseOwnedClientOrderId } from './orderOwnership';
import { venueIdOf } from '../exchanges/losslessJson';

export interface CleanupVenue {
  exchange: 'binance' | 'gate';
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export interface FlatCleanupResult extends FlatCleanupVerdict {
  /** 취소 한 건 한 건의 증거. **비밀은 담지 않는다** — 번호와 응답 요약뿐 */
  attempts: Array<{ id: string; requested: boolean; httpOk: boolean; response: string | null; tries: number }>;
  rounds: number;
  /** 재조회로 목록을 읽었는가 */
  leftoverReadable: boolean;
}

/**
 * 포지션이 0인 지금, **내 보호주문만** 정확한 번호로 지우고 재조회로 확인한다.
 *
 * `position`은 **호출부가 이미 읽은 값**을 넘긴다 — 여기서 다시 읽으면
 * 같은 순간에 두 번 조회하게 되고, 두 답이 다를 때 어느 쪽을 믿을지가
 * 또 하나의 갈림길이 된다.
 */
export async function cleanupOwnedProtectionWhenFlat(
  venue: CleanupVenue,
  symbol: string,
  i: {
    position: { ok: boolean; found: boolean; qty?: number | null };
    myStrategyId: string;
    ownedIds?: string[] | null;
    /** 적어 둔 번호와 일치하는 것만 내 것으로 본다 (전략 id를 모를 때) */
    ownedOnly?: boolean;
    /** 재조회 바퀴 수. 기본 3 */
    attempts?: number;
  },
): Promise<FlatCleanupResult> {
  const ops = await import('./venuePositionOps');

  // 포지션이 0으로 확인되지 않았으면 **거래소를 더 부르지 않는다.**
  if (!i.position || i.position.ok !== true || i.position.found) {
    const plan = flatCleanupPlan({ position: i.position, orders: null, myStrategyId: i.myStrategyId });
    return { ...flatCleanupVerdict({ plan, ledger: null }), attempts: [], rounds: 0, leftoverReadable: false };
  }

  const orders = await ops.readProtectiveOrders(venue, symbol);
  const plan = flatCleanupPlan({
    position: i.position, orders, myStrategyId: i.myStrategyId,
    ownedIds: i.ownedIds ?? null, ownedOnly: i.ownedOnly === true,
  });

  if (plan.cancel.length === 0) {
    return { ...flatCleanupVerdict({ plan, ledger: null }), attempts: [], rounds: 0,
      leftoverReadable: orders != null };
  }

  // **요청 → 재조회 → 아직 있으면 재시도.** 200은 접수이지 삭제가 아니다.
  const cx = await ops.cancelExact(venue, symbol, plan.cancel, { attempts: i.attempts ?? 3 });
  const ledger = cancelLedger({ ids: plan.cancel, attempts: cx.attempts, leftover: cx.leftover });

  return {
    ...flatCleanupVerdict({ plan, ledger }),
    attempts: cx.attempts, rounds: cx.rounds, leftoverReadable: cx.leftover != null,
  };
}

/**
 * 이 종목에 대해 **우리가 걸어 두고 번호를 적어 둔** 보호주문 번호들.
 *
 * 식별자 파싱은 형식이 깨지면 무너진다. 그때 이 번호가 남는다 —
 * `live_orders.sl_order_id` · `tp_order_id`는 **TEXT**라 Gate의 int64
 * 주문 번호도 자릿수 그대로 보존된다(#139).
 *
 * **못 읽으면 빈 배열이 아니라 그냥 없는 것으로 둔다** — 여기서 실패해도
 * 식별자 파싱이라는 2순위 증거가 남아 있고, 이 조회 실패가 정리 자체를
 * 막으면 보호주문이 더 오래 남는다.
 */
export async function loadOwnedProtectionIds(
  sb: any,
  i: { connectionId?: string | null; userId?: string | null; symbol: string; limit?: number },
): Promise<{ ids: string[]; strategyIds: string[] }> {
  const out = { ids: [] as string[], strategyIds: [] as string[] };
  try {
    let q = (sb as any).from('live_orders')
      .select('client_order_id, sl_order_id, tp_order_id, created_at')
      .eq('symbol', i.symbol);
    if (i.connectionId) q = q.eq('connection_id', i.connectionId);
    else if (i.userId) q = q.eq('user_id', i.userId);
    else return out;
    const { data } = await q.order('created_at', { ascending: false }).limit(Math.max(1, i.limit ?? 5));

    for (const row of (Array.isArray(data) ? data : [])) {
      for (const raw of [row?.sl_order_id, row?.tp_order_id]) {
        // **정밀도를 잃은 번호는 되살리지 않는다.** `String()`으로 만든
        // 번호로 취소를 보내면 거래소는 "그런 주문 없다"고 답한다.
        const id = venueIdOf(raw);
        if (id && !out.ids.includes(id)) out.ids.push(id);
      }
      const p = parseOwnedClientOrderId(row?.client_order_id);
      if (p.ok && p.strategyPrefix && !out.strategyIds.includes(p.strategyPrefix)) {
        out.strategyIds.push(p.strategyPrefix);
      }
    }
  } catch { /* 2순위 증거(식별자 파싱)가 남아 있다 */ }
  return out;
}
