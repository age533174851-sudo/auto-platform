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
/**
 * COIN-M 서버 시각 (epoch ms). 못 읽으면 null.
 *
 * fapi(USDⓈ-M)나 api(현물)의 시각을 쓰지 않는 이유: 호스트가 다르다.
 * 이 파일이 base()를 따로 두는 것과 같은 이유다 — 다른 호스트에 물어본
 * 시각으로 이 호스트의 recvWindow를 판정하면 그건 다른 값을 재는 것이다.
 */
export async function getCoinMServerTime(testnet = false): Promise<number | null> {
  try {
    const r = await fetch(`${base(testnet)}/dapi/v1/time`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    const t = Number(d?.serverTime);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch { return null; }
}

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

/**
 * 계약 하나의 위험 정보. **수량이 0이어도 돌려준다.**
 *
 * `getCoinMPositions`는 `contracts !== 0`으로 걸러낸다. 목록에는 맞지만
 * **신규 진입 심볼이 목록에 없어서** 마진 모드·배율·청산가를 확인할 수 없다.
 * USDⓈ-M에서 겪은 것과 같은 함정이다(`getSymbolPositionRisk`를 따로 만든 이유):
 * 그때는 마진 모드가 unknown이 되어 모든 첫 주문이 막혔다.
 *
 * 못 읽으면 null이다 — 호출자는 추측하지 않고 멈춰야 한다.
 */
export async function getCoinMSymbolRisk(
  key: string, secret: string, symbol: string, testnet = false,
): Promise<CoinMPosition | null> {
  try {
    const d = await dapiSigned('GET', '/dapi/v1/positionRisk', key, secret, testnet, { symbol });
    const rows = Array.isArray(d) ? d : [d];
    // 헤지 모드에서는 같은 심볼이 LONG/SHORT 두 행으로 온다. 수량이 있는 행을
    // 먼저 고르고, 없으면 첫 행(설정값만 있는 행)을 쓴다.
    const row = rows.find((p: any) => Math.abs(Number(p?.positionAmt) || 0) > 0)
      ?? rows.find((p: any) => String(p?.symbol || '').toUpperCase() === symbol.toUpperCase());
    if (!row) return null;
    return {
      symbol: String(row.symbol),
      contracts: Number(row.positionAmt) || 0,
      entryPrice: Number(row.entryPrice) || 0,
      markPrice: Number(row.markPrice) || 0,
      // 0은 거래소가 주지 않은 것이다. 0을 청산가로 쓰면 청산거리가 100%로 계산된다.
      liquidationPrice: Number(row.liquidationPrice) || 0,
      leverage: Number(row.leverage) || 0,
      marginType: String(row.marginType || ''),
      unrealizedPnlCoin: Number(row.unRealizedProfit) || 0,
    };
  } catch { return null; }
}

/**
 * 손절 주문(STOP_MARKET · 전량 청산).
 *
 * `workingType: 'MARK_PRICE'` — 마지막 체결가로 트리거하면 얇은 호가에서
 * 잘못 터진다. USDⓈ-M 경로가 같은 값을 쓰는 것과 같은 이유다.
 *
 * `closePosition: 'true'`라 수량을 보내지 않는다. 부분 청산이 아니라 '이
 * 포지션을 닫는다'는 주문이므로, 이후 포지션이 늘거나 줄어도 따라간다 —
 * 계약 수를 적어 두면 그 수량만 닫히고 나머지는 보호 없이 남는다.
 */
export async function placeCoinMStop(
  key: string, secret: string,
  opts: { symbol: string; stopSide: 'BUY' | 'SELL'; stopPrice: number; clientOrderId?: string },
  testnet = false,
): Promise<{ success: boolean; orderId?: number; message: string }> {
  if (!Number.isFinite(opts.stopPrice) || opts.stopPrice <= 0) {
    return { success: false, message: `손절가가 유효하지 않습니다 (${opts.stopPrice})` };
  }
  try {
    const params: Record<string, string | number> = {
      symbol: opts.symbol.toUpperCase(),
      side: opts.stopSide,
      type: 'STOP_MARKET',
      stopPrice: opts.stopPrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    if (opts.clientOrderId) params.newClientOrderId = opts.clientOrderId;
    const d = await dapiSigned('POST', '/dapi/v1/order', key, secret, testnet, params);
    return { success: true, orderId: d?.orderId, message: '손절 설정' };
  } catch (e: any) {
    return { success: false, message: `손절 설정 실패: ${e?.message || e}` };
  }
}

/**
 * 계약 하나의 포지션을 전량 닫는다 (비상 회수용).
 *
 * 손절을 붙이지 못했을 때 방금 연 포지션을 되돌리는 데 쓴다 —
 * USDⓈ-M·Gate 경로가 같은 상황에서 하는 것과 같다(감사 지적 3번).
 *
 * MARKET에는 `closePosition`을 쓸 수 없어 수량을 보내야 한다. 그 수량은
 * **거래소에서 읽은 현재 계약 수**다. 우리가 방금 보낸 수량을 쓰면 부분
 * 체결이었을 때 남지 않은 수량까지 닫으려 해 거부된다.
 */
export async function closeCoinMPosition(
  key: string, secret: string, symbol: string, testnet = false,
): Promise<{ success: boolean; message: string }> {
  try {
    const pos = await getCoinMSymbolRisk(key, secret, symbol, testnet);
    if (!pos) {
      return { success: false,
        message: '포지션을 읽지 못해 되돌리지 못했습니다 — 거래소에서 직접 확인하세요' };
    }
    const contracts = Math.abs(pos.contracts);
    if (!contracts) return { success: true, message: '이미 포지션이 없습니다' };

    const r = await placeCoinMOrder(key, secret, {
      symbol,
      // 롱(+)이면 SELL로, 숏(−)이면 BUY로 닫는다
      side: pos.contracts > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      contracts,
      reduceOnly: true,
    }, testnet);
    return r.success
      ? { success: true, message: `포지션 전량 종료 (${contracts}계약)` }
      : { success: false, message: `종료 실패: ${r.message}` };
  } catch (e: any) {
    return { success: false, message: `종료 실패: ${e?.message || e}` };
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
