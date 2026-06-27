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
export async function setLeverage(key: string, secret: string, testnet: boolean, symbol: string, leverage: number) {
  try { await signed('POST', '/fapi/v1/leverage', key, secret, testnet, { symbol, leverage }); } catch {}
}

export async function placeOrder(key: string, secret: string, testnet: boolean, p: {
  symbol: string; side: 'BUY' | 'SELL'; type?: string; quantity: number; price?: number | null; leverage?: number | null; reduceOnly?: boolean;
}): Promise<{ ok: boolean; orderId?: number; avgPrice?: number; error?: string }> {
  try {
    if (p.leverage && p.leverage > 0 && !p.reduceOnly) await setLeverage(key, secret, testnet, p.symbol, p.leverage);
    const f = await symbolFilters(p.symbol, testnet);
    const qty = roundStep(Math.abs(p.quantity), f.stepSize);
    if (qty < f.minQty) return { ok: false, error: `최소 수량 미달 (min ${f.minQty})` };
    const type = (p.type || 'MARKET').toUpperCase();
    const params: Record<string, string | number> = { symbol: p.symbol, side: p.side, type, quantity: qty };
    if (type === 'LIMIT') { params.price = p.price || 0; params.timeInForce = 'GTC'; }
    if (p.reduceOnly) params.reduceOnly = 'true';
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
    // 기존 미체결 TP/SL 정리
    try { await signed('DELETE', '/fapi/v1/allOpenOrders', key, secret, testnet, { symbol }); } catch {}
    if (tpPrice && tpPrice > 0) {
      await signed('POST', '/fapi/v1/order', key, secret, testnet, { symbol, side: exitSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: 'true', workingType: 'MARK_PRICE' });
    }
    if (slPrice && slPrice > 0) {
      await signed('POST', '/fapi/v1/order', key, secret, testnet, { symbol, side: exitSide, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true', workingType: 'MARK_PRICE' });
    }
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || 'tpsl_failed' }; }
}
