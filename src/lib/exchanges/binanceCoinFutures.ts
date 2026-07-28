// src/lib/exchanges/binanceCoinFutures.ts
//
// Binance COIN-M(코인 마진) 선물 클라이언트 — dapi.
//
// USDT-M(fapi)과 파일을 나눈 이유
// ───────────────────────────────
// 호스트가 다르고(dapi vs fapi), 수량 단위가 다르고(계약 vs 코인),
// 증거금 통화가 다르다(BTC vs USDT). 한 파일에서 baseUrl만 바꿔 쓰면
// 언젠가 fapi 함수로 COIN-M 주문을 내거나 그 반대가 된다.
//
// 실수하면 어떻게 되나: BTCUSDT(USDⓈ-M)로 계약 수량 3을 보내면 3 BTC
// 주문이 된다. 반대로 BTCUSD_PERP에 0.003을 보내면 소수 계약이라 거부된다.
// 전자는 사고고 후자는 그나마 거부다.
import { createHmac } from 'crypto';

const DAPI = 'https://dapi.binance.com';
const DAPI_TESTNET = 'https://testnet.binancefuture.com';

function base(testnet: boolean): string {
  return testnet ? DAPI_TESTNET : DAPI;
}

function sign(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex');
}

async function dapiSigned(
  method: 'GET' | 'POST' | 'DELETE',
  path: string, key: string, secret: string, testnet: boolean,
  params: Record<string, string | number> = {},
): Promise<any> {
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Date.now()),
    recvWindow: '5000',
  });
  qs.set('signature', sign(qs.toString(), secret));

  const url = `${base(testnet)}${path}?${qs}`;
  const r = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': key },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.msg || `HTTP ${r.status}`);
  }
  return r.json();
}

/**
 * 계약 사양. **contractSize를 여기서만 얻는다.**
 * 못 받으면 null이고, 호출자는 추측하지 않고 멈춰야 한다.
 */
export async function getCoinMContractSize(
  symbol: string, testnet = false,
): Promise<number | null> {
  try {
    const r = await fetch(`${base(testnet)}/dapi/v1/exchangeInfo`,
      { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const d = await r.json();
    const s = (d.symbols || []).find((x: any) =>
      String(x.symbol).toUpperCase() === symbol.toUpperCase());
    const v = Number(s?.contractSize);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

/** Mark Price. 청산 판단은 마지막 체결가가 아니라 이 값으로 한다 */
export async function getCoinMMarkPrice(
  symbol: string, testnet = false,
): Promise<number | null> {
  try {
    const r = await fetch(`${base(testnet)}/dapi/v1/premiumIndex?symbol=${symbol}`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : d;
    const v = parseFloat(row?.markPrice);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export interface CoinMBalance {
  asset: string;
  /** 지갑 잔고 — **코인 단위**다 */
  balance: number;
  availableBalance: number;
  unrealizedPnl: number;
}

/**
 * COIN-M 지갑. 코인별로 따로 있다 — BTC 잔고와 ETH 잔고는 서로 못 쓴다.
 * USDT-M 지갑과도 완전히 별개다.
 */
export async function getCoinMBalances(
  key: string, secret: string, testnet = false,
): Promise<{ success: boolean; balances: CoinMBalance[]; message?: string }> {
  try {
    const d = await dapiSigned('GET', '/dapi/v1/balance', key, secret, testnet);
    const balances = (Array.isArray(d) ? d : [])
      .map((b: any) => ({
        asset: String(b.asset),
        balance: Number(b.balance) || 0,
        availableBalance: Number(b.availableBalance) || 0,
        unrealizedPnl: Number(b.crossUnPnl) || 0,
      }))
      .filter(b => b.balance !== 0 || b.availableBalance !== 0);
    return { success: true, balances };
  } catch (e: any) {
    return { success: false, balances: [], message: e?.message || 'COIN-M 잔고 조회 실패' };
  }
}

export interface CoinMPosition {
  symbol: string;
  /** 계약 수. 부호 있음 (롱 +, 숏 −) */
  contracts: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number;
  marginType: string;
  /** 미실현 손익 — **코인 단위** */
  unrealizedPnlCoin: number;
}

export async function getCoinMPositions(
  key: string, secret: string, testnet = false,
): Promise<{ success: boolean; positions: CoinMPosition[]; message?: string }> {
  try {
    const d = await dapiSigned('GET', '/dapi/v1/positionRisk', key, secret, testnet);
    const positions = (Array.isArray(d) ? d : [])
      .map((p: any) => ({
        symbol: String(p.symbol),
        contracts: Number(p.positionAmt) || 0,
        entryPrice: Number(p.entryPrice) || 0,
        markPrice: Number(p.markPrice) || 0,
        liquidationPrice: Number(p.liquidationPrice) || 0,
        leverage: Number(p.leverage) || 0,
        marginType: String(p.marginType || ''),
        unrealizedPnlCoin: Number(p.unRealizedProfit) || 0,
      }))
      .filter(p => Math.abs(p.contracts) > 0);
    return { success: true, positions };
  } catch (e: any) {
    return { success: false, positions: [], message: e?.message || 'COIN-M 포지션 조회 실패' };
  }
}

export async function setCoinMLeverage(
  key: string, secret: string, symbol: string, leverage: number, testnet = false,
): Promise<{ success: boolean; message?: string }> {
  try {
    await dapiSigned('POST', '/dapi/v1/leverage', key, secret, testnet, { symbol, leverage });
    return { success: true };
  } catch (e: any) {
    return { success: false, message: e?.message || '레버리지 설정 실패' };
  }
}

export async function setCoinMMarginType(
  key: string, secret: string, symbol: string,
  marginType: 'ISOLATED' | 'CROSSED', testnet = false,
): Promise<{ success: boolean; message?: string; code?: number }> {
  try {
    await dapiSigned('POST', '/dapi/v1/marginType', key, secret, testnet, { symbol, marginType });
    return { success: true };
  } catch (e: any) {
    const msg = String(e?.message || '');
    // -4046: 이미 그 마진 타입이다 — 실패가 아니다
    if (/-4046|No need to change/i.test(msg)) return { success: true };
    return { success: false, message: msg || '마진 타입 설정 실패' };
  }
}

export interface CoinMOrderResult {
  success: boolean;
  orderId?: number;
  /** 체결된 계약 수 */
  filledContracts?: number;
  avgPrice?: number;
  message?: string;
}

/**
 * COIN-M 주문.
 *
 * **quantity는 계약 수다.** 코인 개수가 아니다. 이 함수는 정수만 받는다 —
 * 소수를 받으면 거래소가 거부하지만, 그 전에 여기서 막는 편이
 * "왜 거부됐는지"가 분명하다.
 */
export async function placeCoinMOrder(
  key: string, secret: string,
  opts: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    contracts: number;
    price?: number;
    reduceOnly?: boolean;
    clientOrderId?: string;
  },
  testnet = false,
): Promise<CoinMOrderResult> {
  if (!Number.isInteger(opts.contracts) || opts.contracts <= 0) {
    return { success: false, message: `계약 수는 양의 정수여야 합니다 (받은 값 ${opts.contracts})` };
  }

  try {
    // ── 멱등 확인 ──
    // clientOrderId가 있으면 먼저 거래소에 물어본다. 응답을 못 받고
    // 재시도했을 때 같은 주문이 두 번 나가는 것을 막는다.
    if (opts.clientOrderId) {
      const existing = await findCoinMOrderByClientId(
        key, secret, opts.symbol, opts.clientOrderId, testnet);
      if (existing) {
        return {
          success: true, orderId: existing.orderId,
          filledContracts: Number(existing.executedQty) || 0,
          avgPrice: parseFloat(existing.avgPrice || existing.price || '0'),
          message: '거래소에 이미 존재하는 주문 — 재전송하지 않음',
        };
      }
    }

    const params: Record<string, string | number> = {
      symbol: opts.symbol,
      side: opts.side,
      type: opts.type,
      quantity: opts.contracts,
    };
    if (opts.type === 'LIMIT') {
      if (!opts.price || opts.price <= 0) return { success: false, message: 'LIMIT은 가격이 필요합니다' };
      params.price = opts.price;
      params.timeInForce = 'GTC';
    }
    if (opts.reduceOnly) params.reduceOnly = 'true';
    if (opts.clientOrderId) params.newClientOrderId = opts.clientOrderId;

    const d = await dapiSigned('POST', '/dapi/v1/order', key, secret, testnet, params);
    return {
      success: true,
      orderId: d.orderId,
      filledContracts: Number(d.executedQty) || 0,
      avgPrice: parseFloat(d.avgPrice || d.price || '0'),
    };
  } catch (e: any) {
    return { success: false, message: e?.message || 'COIN-M 주문 실패' };
  }
}

/** clientOrderId로 기존 주문 조회. 재시도 전 중복 확인용 */
export async function findCoinMOrderByClientId(
  key: string, secret: string, symbol: string, clientOrderId: string, testnet = false,
): Promise<any | null> {
  try {
    const d = await dapiSigned('GET', '/dapi/v1/order', key, secret, testnet,
      { symbol, origClientOrderId: clientOrderId });
    return d?.orderId ? d : null;
  } catch (e: any) {
    // -2013 "Order does not exist" 는 '없음'이다. 그 외 오류는 판단 불가라
    // 던져서 호출자가 재전송하지 않게 한다.
    if (/-2013|does not exist|Unknown order/i.test(String(e?.message || ''))) return null;
    throw e;
  }
}

export async function getCoinMOpenOrders(
  key: string, secret: string, testnet = false, symbol?: string,
): Promise<any[]> {
  const d = await dapiSigned('GET', '/dapi/v1/openOrders', key, secret, testnet,
    symbol ? { symbol } : {});
  return Array.isArray(d) ? d : [];
}
