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

/**
 * **이 id들만 취소하고, 재조회로 사라진 것까지 확인한다.**
 *
 * `cancelProtectiveOrders`는 거래소가 200을 주면 취소된 것으로 적었다.
 * 200은 **접수**다. 2026-08-15에 Gate 조건부 주문 2건이 그 뒤에도
 * 남았고, 장부에는 정리된 것으로 적혀 있었다.
 *
 * 그래서 여기서는 한 바퀴가 이렇게 돈다:
 *
 *   요청 → 거래소 응답 → **목록 재조회** → 아직 있으면 다시 요청
 *
 * `attempts`번까지만 돈다(기본 3). **끝까지 남으면 그건 FAIL이지
 * PASS가 아니다** — 판정은 `cancelLedger`가 한다. 목록을 못 읽으면
 * UNKNOWN이고, 그것도 통과가 아니다.
 *
 * `cancelAll`은 쓰지 않는다. 같은 계좌의 다른 전략이 걸어 둔 손절까지
 * 지운다 — 호출부가 내 것이라고 확인한 id만 온다.
 */
export async function cancelExact(
  c: VenueCreds, symbol: string, ids: string[],
  opts: { attempts?: number } = {},
): Promise<{
  attempts: Array<{ id: string; requested: boolean; httpOk: boolean; response: string | null; tries: number }>;
  /** 마지막으로 읽은 조건부 주문 목록. **null이면 못 읽었다** */
  leftover: any[] | null;
  rounds: number;
}> {
  const maxRounds = Math.max(1, Math.min(5, Math.round(Number(opts?.attempts) || 3)));
  const wanted = (Array.isArray(ids) ? ids : []).map(v => String(v ?? '').trim()).filter(Boolean);
  const record = new Map<string, { id: string; requested: boolean; httpOk: boolean; response: string | null; tries: number }>();
  for (const id of wanted) record.set(id, { id, requested: false, httpOk: false, response: null, tries: 0 });

  let leftover: any[] | null = null;
  let rounds = 0;
  let pending = [...wanted];

  while (pending.length > 0 && rounds < maxRounds) {
    rounds++;
    for (const id of pending) {
      const r = record.get(id)!;
      r.tries++;
      try {
        if (c.exchange === 'gate') {
          const gf = await import('../exchanges/gateFutures');
          const res = await gf.cancelOrderGateFutures(c.apiKey, c.apiSecret, id, { bucket: 'price', testnet: c.testnet });
          r.requested = true; r.httpOk = !!res.success;
          r.response = res.success ? `취소 접수 (${res.bucket})` : res.message;
        } else {
          const bf = await import('../exchanges/binanceFutures');
          const res: any = await bf.cancelFuturesOrder(c.apiKey, c.apiSecret, symbol, id, c.testnet);
          const okish = res?.success === true || res?.ok === true || res?.orderId != null;
          r.requested = true; r.httpOk = !!okish;
          r.response = okish ? '취소 접수' : String(res?.message || res?.error || '취소 실패');
        }
      } catch (e: any) {
        r.requested = true; r.httpOk = false; r.response = String(e?.message || e);
      }
    }

    // **여기가 핵심이다.** 요청 결과가 아니라 목록을 다시 읽어 확인한다.
    leftover = await readProtectiveOrders(c, symbol);
    if (leftover == null) break;   // 못 읽었다 — 더 지워도 확인할 수 없다
    const present = leftover.map(row => String((row as any)?.id ?? (row as any)?.orderId ?? '')).filter(Boolean);
    pending = pending.filter(id => present.includes(id));
  }

  return { attempts: [...record.values()], leftover, rounds };
}

// ── 청산 감시가 묻는 것 ─────────────────────────────
//
// exit-monitor는 오래 Binance 함수를 직접 불렀다. 진입은 Gate로 나가는데
// 트레일링·본전이동·손절 확인은 바이낸스에 물어보는 상태였고, 화면에는
// "청산 감시 정상"이 떠 있었다. 아래 셋이 그 자리를 메운다.

export interface GuardSnapshot {
  /** 조회가 성공했는가 */
  ok: boolean;
  /** 그 종목의 포지션이 있는가 */
  found: boolean;
  side: 'LONG' | 'SHORT' | null;
  entryPrice: number | null;
  /** **못 읽으면 null이다.** 0으로 눕히면 "청산가를 지났다"가 된다 */
  markPrice: number | null;
  liquidationPrice: number | null;
  marginType: string | null;
  /** 이 포지션을 닫는 손절이 거래소에 살아 있는가. **못 읽으면 null** */
  hasProtectiveStop: boolean | null;
  error: string | null;
}

/** `BTC_USDT` · `BTC/USDT` · `btcusdt` 를 한 모양으로 */
const norm = (v: any): string => String(v ?? '').toUpperCase().replace(/[_/\-\s]/g, '');

const EMPTY_SNAPSHOT = (error: string | null): GuardSnapshot => ({
  ok: false, found: false, side: null, entryPrice: null, markPrice: null,
  liquidationPrice: null, marginType: null, hasProtectiveStop: null, error,
});

/**
 * 사고 점검이 보는 한 장면.
 *
 * **거래소를 가리지 않는다.** 포지션은 `futuresListPositions`(공용)이,
 * 손절 존재는 `readProtectiveOrders` + 판별표가 답한다.
 *
 * Gate는 포지션 응답에 지금 가격이 없다 — ticker를 따로 읽는다.
 * 그래도 못 읽으면 **null로 남긴다.** 0으로 채우면 멀쩡한 포지션이
 * "청산가 도달"로 읽혀 강제 청산된다.
 */
export async function readGuardSnapshot(c: VenueCreds, symbol: string): Promise<GuardSnapshot> {
  try {
    const { futuresListPositions } = await import('../exchanges/futuresExec');
    const res = await futuresListPositions({
      exchange: c.exchange, key: c.apiKey, secret: c.apiSecret, testnet: c.testnet,
    } as any);
    if (!res?.ok) return EMPTY_SNAPSHOT(res?.error ?? '포지션 조회 실패');

    const want = norm(symbol);
    const p = (res.positions || []).find((x: any) => norm(x?.symbol) === want);
    if (!p) return { ...EMPTY_SNAPSHOT(null), ok: true, found: false };

    // 지금 가격. Gate는 포지션에 없으므로 ticker로 채운다.
    let mark = Number((p as any).markPrice);
    if (!Number.isFinite(mark) || mark <= 0) {
      const t = await tickerOf(c, symbol);
      mark = t == null ? NaN : t;
    }

    // 이 포지션을 닫는 손절이 있는가. **못 읽으면 null이다** —
    // 없는 것으로 읽으면 "손절이 사라졌다"로 포지션을 닫는다.
    const orders = await readProtectiveOrders(c, symbol);
    let hasStop: boolean | null = null;
    if (orders != null && (p as any).side) {
      const { readbackProtective } = await import('./protectiveReadback');
      const rb = readbackProtective({
        orders, venue: c.exchange, positionSide: (p as any).side,
      });
      hasStop = rb.stop.found;
    }

    return {
      ok: true, found: true,
      side: (p as any).side ?? null,
      entryPrice: numOrNull((p as any).entryPrice),
      markPrice: Number.isFinite(mark) && mark > 0 ? mark : null,
      liquidationPrice: numOrNull((p as any).liquidationPrice),
      marginType: (p as any).marginType ?? null,
      hasProtectiveStop: hasStop,
      error: null,
    };
  } catch (e: any) {
    return EMPTY_SNAPSHOT(String(e?.message || e));
  }
}

const numOrNull = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 지금 가격. **못 읽으면 null** */
export async function tickerOf(c: VenueCreds, symbol: string): Promise<number | null> {
  try {
    if (c.exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      const t: any = await gf.getTickerGateFutures(contract, c.testnet);
      const n = Number(t?.mark_price ?? t?.last);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const bf = await import('../exchanges/binanceFutures');
    const n = await bf.getFuturesTicker(symbol, c.testnet);
    return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
  } catch { return null; }
}

/**
 * 지금 거래소에 **실제로 걸려 있는** 손절 트리거 가격.
 *
 * 트레일링이 이 값을 읽는다. DB의 `stop_loss`는 진입 시점 값이고 1R을
 * 정의하므로, 그 칸을 옮길 때마다 덮어쓰면 1R이 매번 커져 트레일링이
 * 한 번 움직인 뒤 멈춘다.
 *
 * **못 읽으면 null이다** — 0을 주면 손절이 바닥에 있는 것으로 읽힌다.
 */
export async function liveStopPrice(
  c: VenueCreds, symbol: string, positionSide: 'LONG' | 'SHORT',
): Promise<number | null> {
  const orders = await readProtectiveOrders(c, symbol);
  if (orders == null) return null;
  const { readbackProtective } = await import('./protectiveReadback');
  const rb = readbackProtective({ orders, venue: c.exchange, positionSide });
  return rb.stop.found ? rb.stop.triggerPrice : null;
}

/**
 * 손절을 새로 건다.
 *
 * **거래소별 분기는 `futuresSetTpsl` 한 곳에 있다** — 여기서 다시 짜면
 * 진입 경로와 청산 감시가 서로 다른 방식으로 손절을 걸게 된다.
 */
export async function placeStop(
  c: VenueCreds,
  i: {
    symbol: string; positionSide: 'LONG' | 'SHORT'; stopPrice: number; refPrice?: number | null;
    /**
     * 이 손절에 새길 식별자.
     *
     * **없으면 표식 없는 주문이 나간다.** 그러면 나중에 그 주문이 고아로
     * 남았을 때 소유 증거가 거래소 주문 번호 하나뿐이고, 그 번호를
     * 장부에 안 적어 두면 아무것도 증명하지 못한다 — 정리 코드는 안전을
     * 이유로 안 지우고, 손절은 거래소에 계속 남는다.
     */
    clientOrderId?: string | null;
  },
): Promise<{ ok: boolean; orderId: string | null; message: string }> {
  try {
    const { futuresSetTpsl } = await import('../exchanges/futuresExec');
    const r: any = await futuresSetTpsl({
      exchange: c.exchange, key: c.apiKey, secret: c.apiSecret, testnet: c.testnet,
    } as any, {
      symbol: i.symbol, positionSide: i.positionSide,
      tpPrice: null, slPrice: i.stopPrice, refPrice: i.refPrice ?? null,
      clientOrderId: i.clientOrderId ?? null,
    } as any);
    const id = r?.sl?.orderId ?? r?.sl?.id ?? null;
    return { ok: r?.ok === true, orderId: id != null ? String(id) : null,
      message: String(r?.message ?? '') };
  } catch (e: any) {
    return { ok: false, orderId: null, message: String(e?.message || e) };
  }
}

/**
 * 이 포지션을 닫는 손절 중 **방금 건 것 말고** 전부 취소한다.
 *
 * `keepId`가 null이면 아무것도 취소하지 않는다 — 무엇을 남겨야 할지
 * 모르는 채로 지우면 손절이 없는 포지션이 된다.
 * **익절과 분할 사다리는 건드리지 않는다.**
 */
export async function cancelOtherStops(
  c: VenueCreds, symbol: string, positionSide: 'LONG' | 'SHORT', keepId: string | null,
): Promise<{ cancelled: number; note: string }> {
  if (!keepId) return { cancelled: 0, note: '남길 손절을 모르므로 아무것도 취소하지 않았습니다' };
  const orders = await readProtectiveOrders(c, symbol);
  if (orders == null) return { cancelled: 0, note: '주문 목록을 읽지 못해 옛 손절을 취소하지 못했습니다' };

  const { gateProtectiveKind } = await import('../exchanges/gatePlan');
  const { binanceProtectiveKind } = await import('./protectiveReadback');
  const ids: string[] = [];
  for (const row of orders) {
    const cls = c.exchange === 'binance' ? binanceProtectiveKind(row) : gateProtectiveKind(row);
    if (cls.kind !== 'STOP' || cls.closes !== positionSide) continue;
    const id = String((c.exchange === 'binance' ? (row?.orderId ?? row?.id) : row?.id) ?? '');
    if (!id || id === keepId) continue;
    ids.push(id);
  }
  if (ids.length === 0) return { cancelled: 0, note: '취소할 옛 손절이 없습니다' };
  const r = await cancelProtectiveOrders(c, symbol, ids);
  return {
    cancelled: r.cancelled.length,
    note: r.failed.length
      ? `옛 손절 ${r.failed.length}건을 취소하지 못했습니다 — 손절이 둘 남습니다(위험하지는 않습니다)`
      : `옛 손절 ${r.cancelled.length}건 취소`,
  };
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
