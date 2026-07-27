// src/lib/exchanges/gateFutures.ts
// Gate.io USDT-M 선물 어댑터 (서버 전용)
// 테스트넷 우선. 서명은 Gate v4 규격: 본문 SHA-512 해시 + HMAC-SHA512 서명.
// 주문 식별자(text)는 Gate 규격상 't-' 접두사가 필요하다 → clientOrderId 추적에 사용.
import { createHmac, createHash } from 'crypto';

const LIVE_BASE = 'https://api.gateio.ws';
const TESTNET_BASE = 'https://api-testnet.gateapi.io';

export function gateBase(testnet: boolean): string {
  return testnet ? TESTNET_BASE : LIVE_BASE;
}

// ── 서명 ─────────────────────────────────────────────
export function signGateV4(method: string, path: string, qs: string, body: string, secret: string, ts: string): string {
  const bodyHash = createHash('sha512').update(body).digest('hex');
  const payload = `${method.toUpperCase()}\n${path}\n${qs}\n${bodyHash}\n${ts}`;
  return createHmac('sha512', secret).update(payload).digest('hex');
}

function authHeaders(method: string, path: string, qs: string, body: string, key: string, secret: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    KEY: key,
    Timestamp: ts,
    SIGN: signGateV4(method, path, qs, body, secret, ts),
  };
}

async function gateReq<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { key?: string; secret?: string; qs?: string; body?: any; testnet?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  const { key, secret, qs = '', body, testnet = true, timeoutMs = 10000 } = opts;
  const bodyStr = body ? JSON.stringify(body) : '';
  const url = `${gateBase(testnet)}${path}${qs ? '?' + qs : ''}`;

  const headers: Record<string, string> = key && secret
    ? authHeaders(method, path, qs, bodyStr, key, secret)
    : { 'Content-Type': 'application/json', Accept: 'application/json' };

  const res = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.message || j.label || text; } catch {}
    throw new Error(`Gate ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : ({} as T);
}

// ── 공개 시세 (서명 불필요) ──────────────────────────
export interface GateTicker { contract: string; last: string; index_price?: string; funding_rate?: string; volume_24h?: string }

export async function getTickerGateFutures(contract: string, testnet = true): Promise<GateTicker | null> {
  const list = await gateReq<GateTicker[]>('GET', '/api/v4/futures/usdt/tickers', { qs: `contract=${contract}`, testnet });
  return Array.isArray(list) && list.length ? list[0] : null;
}

// ── 계좌 조회 (서명 필요) ────────────────────────────
export interface GateFuturesAccount { total: string; available: string; unrealised_pnl?: string; currency?: string }

export async function getAccountGateFutures(key: string, secret: string, testnet = true): Promise<GateFuturesAccount> {
  return gateReq<GateFuturesAccount>('GET', '/api/v4/futures/usdt/accounts', { key, secret, testnet });
}

// ── 포지션 조회 ──────────────────────────────────────
export interface GatePosition { contract: string; size: number; entry_price: string; leverage: string; unrealised_pnl: string; liq_price?: string }

export async function getPositionsGateFutures(key: string, secret: string, testnet = true): Promise<GatePosition[]> {
  const rows = await gateReq<GatePosition[]>('GET', '/api/v4/futures/usdt/positions', { key, secret, testnet });
  return Array.isArray(rows) ? rows.filter(p => Number(p.size) !== 0) : [];
}

// ── 레버리지 설정 ────────────────────────────────────
export async function setLeverageGateFutures(key: string, secret: string, contract: string, leverage: number, testnet = true) {
  return gateReq('POST', `/api/v4/futures/usdt/positions/${contract}/leverage`, {
    key, secret, qs: `leverage=${leverage}`, testnet,
  });
}

// ── 주문 ─────────────────────────────────────────────
export interface GateOrderInput {
  contract: string;          // 'BTC_USDT'
  size: number;              // 계약 수량. 양수=롱, 음수=숏
  price?: string;            // '0' = 시장가
  tif?: 'gtc' | 'ioc' | 'poc' | 'fok';
  reduceOnly?: boolean;
  clientOrderId?: string;    // 't-' 접두사 자동 부여
}

export interface GateOrderResult { id: number; contract: string; size: number; price: string; status: string; text?: string }

// Gate text 규격: 't-' 로 시작, 영숫자/밑줄/하이픈만
export function toGateText(clientOrderId?: string): string | undefined {
  if (!clientOrderId) return undefined;
  const cleaned = clientOrderId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28);
  return cleaned ? `t-${cleaned}` : undefined;
}

export async function placeOrderGateFutures(
  key: string, secret: string, input: GateOrderInput, testnet = true
): Promise<GateOrderResult> {
  const body: Record<string, any> = {
    contract: input.contract,
    size: input.size,
    price: input.price ?? '0',                       // '0' = 시장가
    tif: input.tif ?? (input.price && input.price !== '0' ? 'gtc' : 'ioc'),
  };
  if (input.reduceOnly) body.reduce_only = true;
  const text = toGateText(input.clientOrderId);
  if (text) body.text = text;

  return gateReq<GateOrderResult>('POST', '/api/v4/futures/usdt/orders', { key, secret, body, testnet });
}

// 중복 주문 방지: 재시도 전에 같은 clientOrderId 주문이 이미 있는지 조회
export async function findOrderByClientIdGateFutures(
  key: string, secret: string, contract: string, clientOrderId: string, testnet = true
): Promise<GateOrderResult | null> {
  const text = toGateText(clientOrderId);
  if (!text) return null;
  try {
    // 미체결 + 최근 완료 주문 조회
    for (const status of ['open', 'finished']) {
      const rows = await gateReq<GateOrderResult[]>('GET', '/api/v4/futures/usdt/orders', {
        key, secret, qs: `contract=${contract}&status=${status}&limit=100`, testnet,
      });
      const hit = Array.isArray(rows) ? rows.find(o => o.text === text) : null;
      if (hit) return hit;
    }
  } catch { /* 조회 실패 시 null — 호출측에서 신중히 처리 */ }
  return null;
}

// ── 연결 진단 ────────────────────────────────────────
export interface GateConnCheck {
  ok: boolean;
  testnet: boolean;
  publicOk: boolean;
  privateOk: boolean;
  lastPrice?: string;
  balance?: string;
  latencyMs?: number;
  error?: string;
}

export async function checkGateFuturesConnection(
  key: string | undefined, secret: string | undefined, contract = 'BTC_USDT', testnet = true
): Promise<GateConnCheck> {
  const t0 = Date.now();
  const out: GateConnCheck = { ok: false, testnet, publicOk: false, privateOk: false };
  try {
    const ticker = await getTickerGateFutures(contract, testnet);
    out.publicOk = !!ticker;
    out.lastPrice = ticker?.last;
  } catch (e: any) {
    out.error = `시세 조회 실패: ${e?.message || e}`;
    out.latencyMs = Date.now() - t0;
    return out;
  }
  if (!key || !secret) {
    out.latencyMs = Date.now() - t0;
    out.error = 'API 키 미설정 — 시세만 확인됨';
    return out;
  }
  try {
    const acct = await getAccountGateFutures(key, secret, testnet);
    out.privateOk = true;
    out.balance = acct?.available ?? acct?.total;
  } catch (e: any) {
    out.error = `계좌 조회 실패: ${e?.message || e}`;
  }
  out.latencyMs = Date.now() - t0;
  out.ok = out.publicOk && out.privateOk;
  return out;
}
