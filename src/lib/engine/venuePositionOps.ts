// src/lib/engine/venuePositionOps.ts
//
// **포지션 생명주기가 거래소에 묻는 네 가지.**
//
//   1. 지금 이 종목에 뭐가 열려 있나          readOpenPosition
//   2. 그걸 전량 닫아라                        closeSymbolPosition
//   3. 걸려 있는 조건부 주문을 다 보여 달라    readProtectiveOrders
//   4. 이 id들만 취소해라                      cancelProtectiveOrders
//
// 판정은 전부 순수 함수(positionLifecycle · orderOwnership ·
// protectiveReadback)가 하고, 이 파일은 **묻고 답을 그 모양으로 옮기는
// 일만** 한다. 두 거래소의 응답 차이를 여기 한 곳에서만 흡수한다 —
// 라우트마다 각자 흡수하면 한쪽만 고쳐진다.
//
// 규칙 하나: **실패를 빈 값으로 돌려주지 않는다.**
// 조회 실패는 `ok: false`이거나 `null`이고, 그건 '없다'와 다르다.
// 이 구분이 무너지면 살아 있는 포지션 위로 신규 진입이 나간다.

import { openPositionOf, type OpenPosition } from './positionLifecycle';

export interface VenueCreds {
  exchange: 'binance' | 'gate';
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

/** 지금 열려 있는 포지션 (방향 포함) */
export async function readOpenPosition(c: VenueCreds, symbol: string): Promise<OpenPosition> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return { ok: false, found: false, qty: null, side: null, error: `계약 이름을 만들 수 없습니다 (${symbol})` };
      const pos = await gf.getPositionGateFutures(c.apiKey, c.apiSecret, contract, c.testnet);
      // **null은 조회 실패다.** getPositionGateFutures는 예외를 삼키고
      // null을 준다 — 그걸 '포지션 없음'으로 읽으면 이 PR의 사고가 그대로다.
      if (pos == null) {
        return { ok: false, found: false, qty: null, side: null, error: 'Gate 포지션 조회 실패' };
      }
      const size = Number((pos as any).size);
      if (!Number.isFinite(size)) {
        return { ok: true, found: true, qty: null, side: null, error: null };
      }
      // 계약 수를 기초자산 수량으로 되돌린다. 단위가 섞이면 "0.002가
      // 남았다"가 "2계약이 남았다"로 읽힌다.
      const spec = await gf.getGateContractSpec(contract, c.testnet).catch(() => null);
      const base = spec ? gp.gateBaseFromContracts(Math.abs(size), spec) : Math.abs(size);
      if (Math.abs(size) <= 0) return { ok: true, found: false, qty: 0, side: null, error: null };
      return {
        ok: true, found: true,
        qty: Number.isFinite(Number(base)) && Number(base) > 0 ? Number(base) : Math.abs(size),
        side: size > 0 ? 'LONG' : 'SHORT', error: null,
      };
    }
    const bf = await import('../exchanges/binanceFutures');
    const res = await bf.getFuturesPositions(c.apiKey, c.apiSecret, c.testnet);
    return openPositionOf(res, symbol);
  } catch (e: any) {
    return { ok: false, found: false, qty: null, side: null, error: String(e?.message || e) };
  }
}

/**
 * 이 종목의 포지션을 전량 닫는다.
 *
 * **접수와 체결을 섞지 않는다.** 돌려주는 `ok`는 "거래소가 청산 주문을
 * 접수했다"이고, 닫혔는지는 호출부가 `closeVerdict`로 재조회해 확인한다.
 */
export async function closeSymbolPosition(
  c: VenueCreds, symbol: string,
  /** 바이낸스는 어느 쪽 포지션을 닫는지 알아야 한다. Gate는 auto_size가 정한다 */
  positionSide?: 'LONG' | 'SHORT' | null,
): Promise<{ attempted: boolean; ok: boolean; error: string | null }> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return { attempted: false, ok: false, error: `계약 이름을 만들 수 없습니다 (${symbol})` };
      const r = await gf.closePositionGateFutures(c.apiKey, c.apiSecret, contract, c.testnet);
      return { attempted: true, ok: r.success === true, error: r.success ? null : r.message };
    }
    // **방향을 모르면 보내지 않는다.** 바이낸스는 어느 쪽을 닫는지
    // 지정해야 하고, 여기서 짐작하면 반대 방향으로 신규 진입이 된다.
    if (positionSide !== 'LONG' && positionSide !== 'SHORT') {
      return { attempted: false, ok: false,
        error: '닫을 포지션의 방향을 읽지 못해 청산 주문을 보내지 않았습니다' };
    }
    const bf = await import('../exchanges/binanceFutures');
    const r: any = await bf.closePositionPercent(c.apiKey, c.apiSecret, symbol, positionSide, 100, c.testnet);
    const ok = r?.success === true || r?.ok === true;
    return { attempted: true, ok, error: ok ? null : String(r?.message || r?.error || '청산 주문 실패') };
  } catch (e: any) {
    // **예외를 '안 보냈다'로 적지 않는다.** 보내고 응답을 못 받았을 수도
    // 있다 — 그 구분은 재조회가 한다.
    return { attempted: true, ok: false, error: String(e?.message || e) };
  }
}

/**
 * 걸려 있는 조건부 주문.
 *
 * **null은 '못 읽음'이고 `[]`는 '없음'이다.** 이 둘을 섞으면 조회 실패가
 * "보호주문 0건"으로 그려진다.
 */
export async function readProtectiveOrders(c: VenueCreds, symbol: string): Promise<any[] | null> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      return await gf.getPriceOrdersGateFutures(c.apiKey, c.apiSecret, contract, c.testnet);
    }
    const bf = await import('../exchanges/binanceFutures');
    const r: any = await bf.getFuturesOpenOrders(c.apiKey, c.apiSecret, c.testnet, symbol);
    if (Array.isArray(r)) return r;
    if (Array.isArray(r?.orders)) return r.orders;
    return null;
  } catch { return null; }
}

/**
 * **이 id들만** 취소한다. 목록을 통째로 지우지 않는다.
 *
 * `cancelAll`은 같은 계좌의 다른 전략이 걸어 둔 손절까지 지운다.
 * 그래서 호출부(`orphanCleanupPlan`)가 내 것이라고 확인한 id만 온다.
 */
export async function cancelProtectiveOrders(
  c: VenueCreds, symbol: string, ids: string[],
): Promise<{ cancelled: string[]; failed: Array<{ id: string; error: string }> }> {
  const cancelled: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    try {
      if (c.exchange === 'gate') {
        const gf = await import('../exchanges/gateFutures');
        const r = await gf.cancelOrderGateFutures(c.apiKey, c.apiSecret, id, { bucket: 'price', testnet: c.testnet });
        if (r.success) cancelled.push(id); else failed.push({ id, error: r.message });
      } else {
        const bf = await import('../exchanges/binanceFutures');
        const r: any = await bf.cancelFuturesOrder(c.apiKey, c.apiSecret, symbol, id, c.testnet);
        if (r?.success === true || r?.ok === true || r?.orderId != null) cancelled.push(id);
        else failed.push({ id, error: String(r?.message || r?.error || '취소 실패') });
      }
    } catch (e: any) {
      failed.push({ id, error: String(e?.message || e) });
    }
  }
  return { cancelled, failed };
}

/** 계약 규격의 호가 단위. 못 읽으면 null — 보정 없이 그대로 간다 */
export async function readTickSize(c: VenueCreds, symbol: string): Promise<number | null> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      const spec = await gf.getGateContractSpec(contract, c.testnet);
      const t = Number((spec as any)?.orderPriceRound);
      return Number.isFinite(t) && t > 0 ? t : null;
    }
    const bf = await import('../exchanges/binanceFutures');
    const f = await bf.getSymbolFilters(symbol, c.testnet);
    const t = Number(f?.tickSize);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch { return null; }
}
