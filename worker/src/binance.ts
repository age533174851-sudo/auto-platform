// worker/src/binance.ts — USDT-M 선물 (서명) — 워커가 필요한 최소 기능만
import { createHmac } from 'crypto';

const FUTURES_BASE = 'https://fapi.binance.com';
const TESTNET_BASE = 'https://demo-fapi.binance.com';
const base = (t: boolean) => (t ? TESTNET_BASE : FUTURES_BASE);

function sign(qs: string, secret: string) { return createHmac('sha256', secret).update(qs).digest('hex'); }

async function signed(method: 'GET' | 'POST' | 'DELETE', path: string, key: string, secret: string, testnet: boolean, params: Record<string, string | number> = {}) {
  const qsObj: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) qsObj[k] = String(v);
  qsObj.timestamp = String(Date.now());
  qsObj.recvWindow = '5000';
  const qs = new URLSearchParams(qsObj).toString();
  const sig = sign(qs, secret);
  const r = await fetch(`${base(testnet)}${path}?${qs}&signature=${sig}`, {
    method, headers: { 'X-MBX-APIKEY': key }, signal: AbortSignal.timeout(30000),  // 거래소 30초 지연 대비
  });
  if (!r.ok) { const e: any = await r.json().catch(() => ({})); throw new Error(e?.msg ? `[${e.code}] ${e.msg}` : `HTTP ${r.status}`); }
  return r.json();
}

export interface Pos { symbol: string; amount: number; entryPrice: number; markPrice: number; unrealizedPnl: number; leverage: number; liquidationPrice: number; }

export async function getPositions(key: string, secret: string, testnet: boolean): Promise<Pos[]> {
  const data = await signed('GET', '/fapi/v2/positionRisk', key, secret, testnet);
  return (Array.isArray(data) ? data : [])
    .map((p: any) => ({ symbol: p.symbol, amount: parseFloat(p.positionAmt), entryPrice: parseFloat(p.entryPrice), markPrice: parseFloat(p.markPrice), unrealizedPnl: parseFloat(p.unRealizedProfit), leverage: parseInt(p.leverage || '1', 10), liquidationPrice: parseFloat(p.liquidationPrice || '0') }))
    .filter((p: Pos) => Math.abs(p.amount) > 0);
}

export async function getUsdtEquity(key: string, secret: string, testnet: boolean): Promise<number> {
  const data = await signed('GET', '/fapi/v2/balance', key, secret, testnet);
  const u = (Array.isArray(data) ? data : []).find((b: any) => b.asset === 'USDT');
  return u ? parseFloat(u.balance || '0') + parseFloat(u.crossUnPnl || '0') : 0;
}

async function symbolFilters(symbol: string, testnet: boolean): Promise<{ stepSize: number; minQty: number }> {
  try {
    const r = await fetch(`${base(testnet)}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(8000) });
    const d: any = await r.json();
    const s = (d.symbols || []).find((x: any) => x.symbol === symbol);
    const lot = (s?.filters || []).find((f: any) => f.filterType === 'LOT_SIZE');
    return { stepSize: parseFloat(lot?.stepSize || '0.001'), minQty: parseFloat(lot?.minQty || '0.001') };
  } catch { return { stepSize: 0.001, minQty: 0.001 }; }
}

function roundStep(qty: number, step: number) {
  if (step <= 0) return qty;
  const dec = Math.max(0, Math.round(-Math.log10(step)));
  return parseFloat((Math.floor(qty / step) * step).toFixed(dec));
}

export async function cancelAllOrders(key: string, secret: string, testnet: boolean): Promise<{ ok: boolean; symbols: string[] }> {
  const pos = await getPositions(key, secret, testnet);
  const open: any = await signed('GET', '/fapi/v1/openOrders', key, secret, testnet).catch(() => []);
  const syms = Array.from(new Set([...(Array.isArray(open) ? open.map((o: any) => o.symbol) : []), ...pos.map(p => p.symbol)]));
  let ok = true;
  for (const s of syms) { try { await signed('DELETE', '/fapi/v1/allOpenOrders', key, secret, testnet, { symbol: s }); } catch { ok = false; } }
  return { ok, symbols: syms };
}

// 포지션 0 될 때까지 reduce-only MARKET (최대 maxRetry, 3초 간격)
export async function closeAllPositions(key: string, secret: string, testnet: boolean, maxRetry = 5): Promise<{ ok: boolean; remaining: number; retries: number }> {
  for (let i = 1; i <= maxRetry; i++) {
    const pos = await getPositions(key, secret, testnet);
    if (pos.length === 0) return { ok: true, remaining: 0, retries: i - 1 };
    for (const p of pos) {
      const f = await symbolFilters(p.symbol, testnet);
      const qty = roundStep(Math.abs(p.amount), f.stepSize);
      if (qty < f.minQty) continue;
      const side = p.amount > 0 ? 'SELL' : 'BUY';
      try { await signed('POST', '/fapi/v1/order', key, secret, testnet, { symbol: p.symbol, side, type: 'MARKET', quantity: qty, reduceOnly: 'true' }); } catch {}
    }
    if (i < maxRetry) await new Promise(r => setTimeout(r, 3000));
  }
  const pos = await getPositions(key, secret, testnet);
  return { ok: pos.length === 0, remaining: pos.length, retries: maxRetry };
}

export async function countOpen(key: string, secret: string, testnet: boolean): Promise<{ positions: number; orders: number }> {
  const pos = await getPositions(key, secret, testnet);
  const open: any = await signed('GET', '/fapi/v1/openOrders', key, secret, testnet).catch(() => []);
  return { positions: pos.length, orders: Array.isArray(open) ? open.length : 0 };
}

// ── 단일 주문 (PLACE_ORDER) — MARKET/LIMIT, 레버리지 옵션, reduceOnly ──
export async function setLeverage(
  key: string, secret: string, testnet: boolean, symbol: string, leverage: number,
): Promise<{ ok: boolean; error?: string }> {
  // 레버리지 설정 실패를 삼키면 안 된다.
  // 실패하면 계정에 남아있던 이전 배율(예: 20배)로 체결되어 위험 계산이 완전히 어긋난다.
  try {
    await signed('POST', '/fapi/v1/leverage', key, secret, testnet, { symbol, leverage });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || '레버리지 설정 실패' };
  }
}

/** clientOrderId로 기존 주문을 찾는다. 재시도 전 중복 확인용. */
export async function findOrderByClientId(
  key: string, secret: string, testnet: boolean, symbol: string, clientOrderId: string,
): Promise<any | null> {
  try {
    const d: any = await signed('GET', '/fapi/v1/order', key, secret, testnet, {
      symbol, origClientOrderId: clientOrderId,
    });
    return d?.orderId ? d : null;
  } catch {
    // -2013 "Order does not exist" 도 여기로 온다 — 없는 것으로 본다
    return null;
  }
}

export async function placeOrder(key: string, secret: string, testnet: boolean, p: {
  symbol: string; side: 'BUY' | 'SELL'; type?: string; quantity: number; price?: number | null; leverage?: number | null; reduceOnly?: boolean;
  /**
   * 멱등 키. 잡 id처럼 재시도해도 같은 값을 주면 중복 주문을 막을 수 있다.
   * 주지 않으면 거래소가 임의 id를 부여하므로 재시도가 그대로 중복이 된다.
   */
  clientOrderId?: string;
}): Promise<{ ok: boolean; orderId?: number; avgPrice?: number; error?: string; duplicate?: boolean }> {
  try {
    // ── 멱등 확인 ──
    // 워커는 실패 시 잡을 PENDING으로 되돌려 재시도한다. 그런데 "실패"에는
    // 거래소가 주문을 받아들인 뒤 응답만 못 받은 경우도 포함된다. 그때
    // 그냥 재전송하면 같은 주문이 두 번 나간다. clientOrderId가 있으면
    // 먼저 거래소에 물어보고, 이미 있으면 그것을 결과로 돌려준다.
    if (p.clientOrderId) {
      const existing = await findOrderByClientId(key, secret, testnet, p.symbol, p.clientOrderId);
      if (existing) {
        return {
          ok: true, duplicate: true, orderId: existing.orderId,
          avgPrice: parseFloat(existing.avgPrice || existing.price || '0'),
        };
      }
    }

    // 레버리지 설정이 실패하면 주문하지 않는다 (의도한 배율이 아니면 위험 계산이 무의미)
    if (p.leverage && p.leverage > 0 && !p.reduceOnly) {
      const lev = await setLeverage(key, secret, testnet, p.symbol, p.leverage);
      if (!lev.ok) return { ok: false, error: `레버리지 ${p.leverage}배 설정 실패로 주문 중단: ${lev.error}` };
    }
    const f = await symbolFilters(p.symbol, testnet);
    const qty = roundStep(Math.abs(p.quantity), f.stepSize);
    if (qty < f.minQty) return { ok: false, error: `최소 수량 미달 (min ${f.minQty})` };
    const type = (p.type || 'MARKET').toUpperCase();
    const params: Record<string, string | number> = { symbol: p.symbol, side: p.side, type, quantity: qty };
    if (type === 'LIMIT') { params.price = p.price || 0; params.timeInForce = 'GTC'; }
    if (p.reduceOnly) params.reduceOnly = 'true';
    if (p.clientOrderId) params.newClientOrderId = p.clientOrderId;
    const res: any = await signed('POST', '/fapi/v1/order', key, secret, testnet, params);
    return { ok: true, orderId: res.orderId, avgPrice: parseFloat(res.avgPrice || res.price || '0') };
  } catch (e: any) { return { ok: false, error: e?.message || 'order_failed' }; }
}

// ── 부분/전량 종료 (CLOSE_POSITION) — percent 비율, reduce-only MARKET ──
export async function closePositionPct(key: string, secret: string, testnet: boolean, symbol: string, positionSide: 'LONG' | 'SHORT', percent: number): Promise<{ ok: boolean; closedQty?: number; error?: string }> {
  try {
    const pos = (await getPositions(key, secret, testnet)).find(p => p.symbol === symbol);
    if (!pos || Math.abs(pos.amount) === 0) return { ok: true, closedQty: 0 };  // 이미 없음 → 성공 취급
    const isLong = pos.amount > 0;
    if ((positionSide === 'LONG') !== isLong) return { ok: false, error: '포지션 방향 불일치' };
    const f = await symbolFilters(symbol, testnet);
    const pct = Math.max(1, Math.min(100, percent || 100));
    let qty = roundStep(Math.abs(pos.amount) * (pct / 100), f.stepSize);
    if (qty < f.minQty) qty = roundStep(Math.abs(pos.amount), f.stepSize);  // 너무 작으면 전량
    if (qty < f.minQty) return { ok: false, error: '종료 수량이 최소 단위 미만' };
    const side = isLong ? 'SELL' : 'BUY';
    await signed('POST', '/fapi/v1/order', key, secret, testnet, { symbol, side, type: 'MARKET', quantity: qty, reduceOnly: 'true' });
    return { ok: true, closedQty: qty };
  } catch (e: any) { return { ok: false, error: e?.message || 'close_failed' }; }
}

// ── TP/SL 설정 (SET_TPSL) — 기존 TP/SL 취소 후 closePosition stop 주문 ──
export async function setTpsl(key: string, secret: string, testnet: boolean, symbol: string, positionSide: 'LONG' | 'SHORT', tpPrice: number | null, slPrice: number | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const pos = (await getPositions(key, secret, testnet)).find(p => p.symbol === symbol);
    if (!pos || Math.abs(pos.amount) === 0) return { ok: false, error: '포지션 없음' };
    const isLong = pos.amount > 0;
    const exitSide = isLong ? 'SELL' : 'BUY';
    // ── 기존 TP/SL만 골라서 취소한다 ──
    // 예전에는 DELETE /fapi/v1/allOpenOrders로 그 종목의 미체결 주문을 전부
    // 지웠다. 그러면 다른 전략의 진입 지정가, 분할 익절 사다리, 사용자가 직접
    // 걸어둔 주문까지 같이 날아간다. 이 함수의 책임은 TP/SL 갱신뿐이므로
    // STOP_MARKET / TAKE_PROFIT_MARKET 계열만 개별 취소한다.
    try {
      const open: any = await signed('GET', '/fapi/v1/openOrders', key, secret, testnet, { symbol });
      const TPSL_TYPES = ['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET'];
      for (const o of (Array.isArray(open) ? open : [])) {
        if (!TPSL_TYPES.includes(String(o?.type || '').toUpperCase())) continue;
        // 분할 익절(수량 지정 + reduceOnly)은 남긴다 — 전량 청산용 TP/SL만 교체한다
        if (o?.closePosition !== true) continue;
        try {
          await signed('DELETE', '/fapi/v1/order', key, secret, testnet, { symbol, orderId: o.orderId });
        } catch { /* 이미 체결·취소됐을 수 있다 */ }
      }
    } catch { /* 조회 실패 시 취소를 건너뛴다 — 중복 TP/SL이 남는 편이 남의 주문을 지우는 것보다 낫다 */ }
    if (tpPrice && tpPrice > 0) {
      await signed('POST', '/fapi/v1/order', key, secret, testnet, { symbol, side: exitSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: 'true', workingType: 'MARK_PRICE' });
    }
    if (slPrice && slPrice > 0) {
      await signed('POST', '/fapi/v1/order', key, secret, testnet, { symbol, side: exitSide, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true', workingType: 'MARK_PRICE' });
    }
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || 'tpsl_failed' }; }
}
