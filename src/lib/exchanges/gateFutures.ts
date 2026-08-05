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

export async function gateReq<T>(
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
export interface GateTicker { contract: string; last: string; mark_price?: string; index_price?: string; funding_rate?: string; volume_24h?: string }

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

/**
 * Gate 서버 시각 (epoch ms). 못 읽으면 null.
 *
 * 바이낸스의 시각을 쓰지 않는 이유: 다른 회사의 서버다. 시계 오차 검사는
 * "내 시계가 **이 거래소**와 맞는가"이므로, 다른 호스트에 물어본 값으로
 * 판정하면 그건 다른 것을 재는 것이다.
 *
 * 선물 전용 time 엔드포인트가 없어 같은 호스트의 spot/time을 쓴다.
 * 시계는 호스트 단위라 그걸로 충분하다.
 */
export async function getGateServerTime(testnet = true): Promise<number | null> {
  try {
    const r = await gateReq<{ server_time?: number }>('GET', '/api/v4/spot/time', { testnet });
    const t = Number(r?.server_time);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch { return null; }
}

/**
 * 미체결 일반 주문. 상태 대조에서 앱 기록과 짝을 맞추는 데 쓴다.
 *
 * contract를 주지 않으면 전체다. Gate는 status=open 필터를 요구한다.
 */
export async function getOpenOrdersGateFutures(
  key: string, secret: string, testnet = true, contract?: string,
): Promise<GateOrderResult[]> {
  const qs = contract ? `status=open&contract=${contract}&limit=100` : 'status=open&limit=100';
  const rows = await gateReq<GateOrderResult[]>('GET', '/api/v4/futures/usdt/orders', {
    key, secret, qs, testnet,
  });
  return Array.isArray(rows) ? rows : [];
}

/** 걸려 있는 조건부 주문(손절·익절). 못 읽으면 null — 빈 배열과 구분한다 */
export async function getPriceOrdersGateFutures(
  key: string, secret: string, contract: string, testnet = true,
): Promise<any[] | null> {
  try {
    const rows = await gateReq<any[]>('GET', '/api/v4/futures/usdt/price_orders', {
      key, secret, qs: `status=open&contract=${contract}`, testnet,
    });
    return Array.isArray(rows) ? rows : [];
  } catch { return null; }
}

/**
 * 계약 하나의 포지션. **수량이 0이어도 돌려준다.**
 *
 * getPositionsGateFutures는 `size !== 0`으로 걸러낸다. 목록에는 맞지만 신규
 * 진입 전에는 그 계약이 목록에 없어서 **레버리지·마진 모드를 확인할 수 없다.**
 * 바이낸스에서 겪은 것과 같은 함정이다(getSymbolPositionRisk를 따로 만든 이유).
 *
 * 못 읽으면 null이다 — 호출자는 그걸 '격리 아님'으로 다뤄야 한다.
 */
export async function getPositionGateFutures(
  key: string, secret: string, contract: string, testnet = true,
): Promise<GatePosition | null> {
  try {
    const p = await gateReq<GatePosition>(
      'GET', `/api/v4/futures/usdt/positions/${contract}`, { key, secret, testnet });
    return p && (p as any).contract ? p : null;
  } catch { return null; }
}

/**
 * 손익 원장 (account_book). 일일 손실 한도가 읽는 것.
 *
 * Gate의 모양은 바이낸스와 다르다:
 *   · 시각이 **초 단위**다 (`time`) — ms로 비교하면 1970년으로 읽힌다
 *   · 종류가 `pnl` / `fee` / `fund` 소문자다
 *   · 금액 필드 이름이 `change`다
 *
 * 그래서 여기서 바이낸스 모양(IncomeItem)으로 맞춰 돌려준다. 합산은
 * `lib/risk/dailyLoss.ts`의 순수 함수 하나가 두 거래소를 같이 처리한다 —
 * 한도 판정이 거래소마다 갈리면 한쪽만 고쳐진다.
 *
 * **못 받으면 null이다.** 빈 배열이면 '오늘 거래 없음'으로 읽혀 한도가 사라진다.
 *
 * ⚠ 이 호출은 실계좌로 검증되지 않았다 (Gate 경로 전반과 같다).
 */
export async function getGateAccountBook(
  key: string, secret: string, testnet = true,
  opts: { fromSec?: number; limit?: number } = {},
): Promise<{ incomeType: string; income: number; time: number }[] | null> {
  try {
    const qs = [`limit=${opts.limit ?? 300}`, opts.fromSec ? `from=${opts.fromSec}` : '']
      .filter(Boolean).join('&');
    const rows = await gateReq<any[]>('GET', '/api/v4/futures/usdt/account_book', {
      key, secret, qs, testnet,
    });
    if (!Array.isArray(rows)) return null;
    return rows.map(r => {
      const t = String(r?.type || '').toLowerCase();
      return {
        // 바이낸스 이름으로 맞춘다. 합산 함수가 이 이름을 본다.
        incomeType: t === 'pnl' ? 'REALIZED_PNL'
          : t === 'fee' ? 'COMMISSION'
          : t === 'fund' ? 'FUNDING_FEE'
          : t.toUpperCase(),
        income: Number(r?.change),
        // 초 → ms. 이걸 빼먹으면 오늘 기록이 전부 '어제 이전'으로 걸러진다.
        time: Number(r?.time) * 1000,
      };
    });
  } catch { return null; }
}

// ── 레버리지 설정 ────────────────────────────────────
/**
 * 레버리지를 설정하고 **결과를 확인한다.**
 *
 * 예전에는 이 함수의 반환값을 호출자가 버렸다. 실패해도 주문이 나갔고, 그러면
 * 계좌에 설정된 배율이 무엇이든 그대로 포지션이 열린다 — 100배 계좌에서
 * 10배로 계산한 수량을 보내면 청산거리가 10분의 1이 된다.
 *
 * Gate v4에서 포지션 레버리지 **0은 교차 마진**이다. 0이 아닌 값이 격리다.
 * 그래서 설정 뒤 실제 값을 되읽어 확인한다 — 200을 받았다는 것과 계좌가
 * 격리라는 것은 다른 얘기다.
 */
export async function setLeverageGateFutures(
  key: string, secret: string, contract: string, leverage: number, testnet = true,
): Promise<{ success: boolean; isolated: boolean; leverage: number | null; message: string }> {
  if (!Number.isFinite(leverage) || leverage < 1) {
    return { success: false, isolated: false, leverage: null,
      message: `배율이 유효하지 않습니다 (${leverage}). Gate에서 0은 교차 마진입니다` };
  }
  try {
    await gateReq('POST', `/api/v4/futures/usdt/positions/${contract}/leverage`, {
      key, secret, qs: `leverage=${leverage}`, testnet,
    });
  } catch (e: any) {
    return { success: false, isolated: false, leverage: null,
      message: `레버리지 설정 실패: ${e?.message || e}` };
  }

  // 되읽어 확인한다. 여기서 확인하지 못하면 격리로 보지 않는다.
  const pos = await getPositionGateFutures(key, secret, contract, testnet);
  const { isGateIsolated } = await import('./gatePlan');
  const actual = pos?.leverage != null ? Number(pos.leverage) : null;
  const isolated = isGateIsolated(pos?.leverage);

  if (!isolated) {
    return { success: false, isolated: false, leverage: actual,
      message: actual === 0
        ? 'Gate 포지션이 교차 마진(leverage=0)입니다. 격리로 바꾸지 못해 주문을 중단합니다'
        : '레버리지를 되읽지 못해 격리 여부를 확인할 수 없습니다 — 주문을 중단합니다' };
  }
  if (actual !== leverage) {
    // 설정은 됐지만 값이 다르다. 거래소가 상한으로 깎았을 수 있다.
    return { success: true, isolated: true, leverage: actual,
      message: `요청 ${leverage}배 / 실제 ${actual}배 — 거래소가 조정했습니다` };
  }
  return { success: true, isolated: true, leverage: actual, message: `${actual}배 격리` };
}

// ── 손절/익절 (price-triggered order) ─────────────────
/**
 * 가격 트리거 주문. 전량 청산용 손절·익절에 쓴다.
 *
 * Gate는 조건부 주문을 `/futures/usdt/price_orders`로 받는다. `initial.size: 0`과
 * `auto_size`를 함께 주면 "발동 시 그 방향 포지션을 전량 닫는다"가 된다 —
 * 바이낸스의 `closePosition=true`에 해당한다. 수량을 박아 두면 부분 청산 뒤에
 * 남은 양과 어긋난다.
 *
 * `price_type: 1`은 마크 가격이다. 바이낸스 경로가 `workingType: 'MARK_PRICE'`를
 * 쓰는 것과 같은 이유 — 마지막 체결가로 트리거하면 얇은 호가에서 잘못 터진다.
 *
 * ⚠ 이 호출은 **실계좌로 검증되지 않았다.** 그래서 호출자(orderExecutor)는 이
 *   주문이 실패하면 방금 연 포지션을 즉시 닫는다. API 모양이 틀렸더라도
 *   결과는 '보호 없는 포지션'이 아니라 '포지션 없음 + 실패 보고'다.
 */
export async function placeStopGateFutures(
  key: string, secret: string,
  input: {
    contract: string;
    /**
     * `gateStopSpec()`이 돌려준 것을 **그대로** 넘긴다.
     *
     * 예전에는 rule·autoSize·triggerPrice를 따로 받았다. 그래서 이런 일이
     * 났다 — 호출부가 rule과 autoSize는 spec에서 꺼내 쓰면서 triggerPrice는
     * **원본 손절가를 그대로** 넘겼다. spec이 호가 단위에 맞춰 둔 값은
     * 아무 데도 안 쓰였고, 거래소는 그대로 거부했다:
     *
     *   Gate 400: trigger.price price is not an integer multiple of a price unit
     *
     * 계산을 만들어 놓고 배선을 안 한 것이다. 이 저장소에서 반복된 실패라
     * (roundToStep이 자동매매에서만 불리던 것과 같다) 아예 **섞을 수 없는
     * 모양**으로 바꿨다. 세 값이 한 덩어리로 들어오면 하나만 옛날 값일 수 없다.
     */
    spec: { rule: 1 | 2; autoSize: 'close_long' | 'close_short'; triggerPrice: number | null };
    clientOrderId?: string;
  },
  testnet = true,
): Promise<{ success: boolean; orderId?: string; message: string }> {
  const trigger = Number(input?.spec?.triggerPrice);
  if (!Number.isFinite(trigger) || trigger <= 0) {
    // 여기까지 오면 안 되지만, 온다면 **보내지 않는다.** 0이나 NaN을 보내면
    // 거래소가 무엇으로 해석할지 모른다.
    return { success: false,
      message: `손절 설정 실패: 트리거 가격이 유효하지 않습니다 (${input?.spec?.triggerPrice})` };
  }
  try {
    const body: Record<string, any> = {
      initial: {
        contract: input.contract,
        // size 0 + auto_size = 발동 시 전량 청산
        size: 0,
        price: '0',       // 시장가
        tif: 'ioc',
        reduce_only: true,
        auto_size: input.spec.autoSize,
      },
      trigger: {
        strategy_type: 0,          // 가격 트리거
        price_type: 1,             // 마크 가격
        // **호가 단위에 맞춰진 값이다.** gateStopSpec이 계약 규격을 보고
        // 진입에서 멀어지는 쪽으로 밀어 둔다.
        price: String(trigger),
        rule: input.spec.rule,
      },
    };
    const text = toGateText(input.clientOrderId);
    if (text) body.initial.text = text;

    const r = await gateReq<{ id?: number | string }>(
      'POST', '/api/v4/futures/usdt/price_orders', { key, secret, body, testnet });
    return { success: true, orderId: r?.id != null ? String(r.id) : undefined, message: '손절 설정' };
  } catch (e: any) {
    return { success: false, message: `손절 설정 실패: ${e?.message || e}` };
  }
}

/**
 * 계약 하나의 포지션을 전량 닫는다 (비상 회수용).
 *
 * 손절을 붙이지 못했을 때 방금 연 포지션을 되돌리는 데 쓴다. 바이낸스 경로가
 * 같은 상황에서 하는 것과 같다(감사 지적 3번: 손절 실패인데 진입 성공 →
 * 즉시 청산 + ok:false).
 */
export async function closePositionGateFutures(
  key: string, secret: string, contract: string, testnet = true,
): Promise<{ success: boolean; message: string }> {
  try {
    const pos = await getPositionGateFutures(key, secret, contract, testnet);
    const size = Number(pos?.size ?? 0);
    if (!size) return { success: true, message: '이미 포지션이 없습니다' };
    // size 0 + auto_size로 전량 청산. 부호를 직접 계산하지 않는다 —
    // 거기서 틀리면 닫는 대신 두 배가 된다.
    await gateReq('POST', '/api/v4/futures/usdt/orders', {
      key, secret, testnet,
      body: {
        contract, size: 0, price: '0', tif: 'ioc',
        reduce_only: true,
        auto_size: size > 0 ? 'close_long' : 'close_short',
      },
    });
    return { success: true, message: '포지션 전량 종료' };
  } catch (e: any) {
    return { success: false, message: `종료 실패: ${e?.message || e}` };
  }
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

export interface GateOrderResult {
  id: number; contract: string; size: number; price: string; status: string; text?: string;
  /** 미체결 수량. ioc 주문이 하나도 못 붙으면 size와 같다 (gateFillOf가 읽는다) */
  left?: number;
  fill_price?: string;
  finish_as?: string;
}

/**
 * Gate text 규격: 't-' 로 시작, 영숫자/밑줄/하이픈만, 30자 이내.
 *
 * 이 변환이 **서로 다른 주문을 같은 이름으로 뭉갤 수 있다.**
 * 예전 구현은 특수문자를 지우고 28자에서 자르기만 했다:
 *
 *   'MF/1:2'  →  't-MF12'
 *   'MF12'    →  't-MF12'      ← 다른 주문인데 같은 이름
 *
 * 이름이 겹치면 중복 확인(findOrderByClientIdGateFutures)이 **남의 주문을
 * 내 주문으로 읽는다.** 결과는 RECONCILED — "이미 주문돼 있습니다"가 되어
 * 실제로는 주문하지 않은 채 성공으로 보고된다. 손절 이름이 `${id}SL`인 것도
 * 같은 문제다: 원본이 28자에 가까우면 잘려서 진입 주문과 같은 이름이 된다.
 *
 * 그래서 값이 **바뀌었을 때만** 원문 해시 6자리를 붙여 구분을 유지한다.
 * 바뀌지 않은 이름(현재 쓰는 `LD…`·`MF…` 키)은 그대로 둔다.
 */
export function toGateText(clientOrderId?: string): string | undefined {
  if (!clientOrderId) return undefined;
  const raw = String(clientOrderId);
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned) return undefined;
  if (cleaned === raw && cleaned.length <= 28) return `t-${cleaned}`;
  // 21 + '-' + 6 = 28자
  const h = createHash('sha256').update(raw).digest('hex').slice(0, 6);
  return `t-${cleaned.slice(0, 21)}-${h}`;
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

/**
 * 중복 주문 방지: 재시도 전에 같은 clientOrderId 주문이 이미 있는지 조회.
 *
 * **조회 실패와 "없음"을 구분해서 돌려준다.** 예전에는 둘 다 `null`이었다.
 * 호출자는 그걸 "중복 아님"으로 읽고 주문을 보냈으므로, 레이트리밋이나
 * 일시적 오류 한 번이 그대로 중복 체결이 될 수 있었다 — 바이낸스 경로는
 * 같은 상황에서 "중복 확인 실패로 주문 중단"을 한다.
 *
 * strict:false에서는 판별 유니온이 좁혀지지 않아 단일 인터페이스로 둔다.
 */
export interface GateOrderLookup {
  /** 조회 자체가 성공했는가. false면 order가 null이어도 "없음"이 아니다 */
  ok: boolean;
  order: GateOrderResult | null;
  error?: string;
}

export async function findOrderByClientIdGateFutures(
  key: string, secret: string, contract: string, clientOrderId: string, testnet = true
): Promise<GateOrderLookup> {
  const text = toGateText(clientOrderId);
  if (!text) {
    return { ok: false, order: null, error: 'clientOrderId로 Gate 주문 이름을 만들 수 없습니다' };
  }
  try {
    // 미체결 + 최근 완료 주문 조회
    for (const status of ['open', 'finished']) {
      const rows = await gateReq<GateOrderResult[]>('GET', '/api/v4/futures/usdt/orders', {
        key, secret, qs: `contract=${contract}&status=${status}&limit=100`, testnet,
      });
      const hit = Array.isArray(rows) ? rows.find(o => o.text === text) : null;
      if (hit) return { ok: true, order: hit };
    }
    return { ok: true, order: null };
  } catch (e: any) {
    return { ok: false, order: null, error: e?.message || String(e) };
  }
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

// ── 계약 규격 ────────────────────────────────────────
//
// **이게 없어서 Gate 선물 주문은 BTC에서 절대 나갈 수 없었다.**
//
// Gate의 주문 수량(`size`)은 **정수 계약 수**다. 한 계약이 몇 개의 기초자산인지는
// 계약마다 다르다 — BTC_USDT는 `quanto_multiplier`가 0.0001이라 1계약 = 0.0001 BTC다.
//
// 저장소는 이 값을 **한 번도 읽은 적이 없다.** `toGateSize`가 기초자산 수량을
// 그대로 계약 수로 보고 내림했다. 그래서 0.05 BTC 주문은 floor(0.05) = 0계약이
// 되어 "1계약 미만입니다"로 거부됐다. 실제로는 500계약이었어야 했다.
//
// 반대로 SOL_USDT처럼 배수가 1인 계약에서는 우연히 맞았다. 그래서 "어떤 종목은
// 되고 BTC만 안 되는" 모양이었고, 원인이 수량 단위라는 걸 알 방법이 없었다.
//
// **못 읽으면 null이다.** 배수를 1로 가정하면 BTC 주문이 10000배로 나간다.
// 그건 거부당하는 것보다 비교할 수 없이 나쁘다.
export interface GateContractSpec {
  contract: string;
  /** 1계약 = 몇 개의 기초자산인가. BTC_USDT는 0.0001 */
  quantoMultiplier: number;
  /** 최소 주문 계약 수 */
  orderSizeMin: number;
  /** 최대 주문 계약 수. 못 읽으면 null */
  orderSizeMax: number | null;
  /** 가격 호가 단위. 못 읽으면 null */
  orderPriceRound: number | null;
}

const _gateSpecCache: Record<string, GateContractSpec & { at: number }> = {};

/**
 * 계약 하나의 규격. 못 읽으면 null.
 *
 * 캐시 열쇠에 호스트를 넣는다 — 테스트넷과 실전의 규격이 같다는 보장이 없고,
 * 한쪽에서 읽은 값으로 다른 쪽 수량을 만들면 조용히 틀린 크기가 나간다
 * (바이낸스 `getSymbolFilters`에서 같은 실수를 이미 한 번 했다).
 */
export async function getGateContractSpec(
  contract: string, testnet = true,
): Promise<GateContractSpec | null> {
  const name = String(contract || '').toUpperCase();
  if (!name) return null;
  const cacheKey = `${testnet ? 'demo' : 'live'}:${name}`;
  const cached = _gateSpecCache[cacheKey];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;

  try {
    const c = await gateReq<any>('GET', `/api/v4/futures/usdt/contracts/${name}`, { testnet });
    const mult = Number(c?.quanto_multiplier);
    // 배수가 없거나 0이면 규격을 못 읽은 것이다. 여기서 1을 채우지 않는다.
    if (!Number.isFinite(mult) || mult <= 0) return null;

    const minRaw = Number(c?.order_size_min);
    const maxRaw = Number(c?.order_size_max);
    const roundRaw = Number(c?.order_price_round);

    const spec: GateContractSpec & { at: number } = {
      contract: String(c?.name || name),
      quantoMultiplier: mult,
      // 최소 계약 수를 못 읽으면 1이다. 이건 지어낸 값이 아니라 "정수 계약"이라는
      // 규격 자체가 주는 하한이다.
      orderSizeMin: Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 1,
      orderSizeMax: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null,
      orderPriceRound: Number.isFinite(roundRaw) && roundRaw > 0 ? roundRaw : null,
      at: Date.now(),
    };
    _gateSpecCache[cacheKey] = spec;
    return spec;
  } catch { return null; }
}

/** 테스트가 캐시를 비우기 위해 쓴다 */
export function __clearGateSpecCache() {
  for (const k of Object.keys(_gateSpecCache)) delete _gateSpecCache[k];
}

// ── 비상 정리 (전량 취소 · 전량 종료) ────────────────
//
// **못 여는 것은 불편이고 못 닫는 것은 사고다.**
//
// 바이낸스에는 `cancelAllOpenOrders`·`closeAllPositions`가 있어서 화면의
// [미체결 취소]·[전량 청산]·[KILL] 버튼이 그걸 부른다. Gate에는 없었다.
// 그래서 Gate 연결로 포지션이 열리면 **그 버튼들이 전부 죽어 있었다** —
// 열 수는 있는데 닫을 수 없는 상태다. 그건 열지 못하는 것보다 나쁘다.

/**
 * 미체결 주문 전체 취소 (일반 주문 + 조건부 주문).
 *
 * Gate의 DELETE는 계약을 요구한다. 그래서 열린 주문을 먼저 읽어 계약을
 * 모으고 계약별로 지운다. 손절·익절은 `price_orders`라는 다른 통에 있어서
 * **따로 지워야 한다** — 이걸 빼면 포지션을 닫은 뒤에도 손절 주문이 남아,
 * 반대 방향으로 새 포지션을 여는 사고가 난다.
 *
 * 조회에 실패하면 성공이라고 말하지 않는다. 여기서 "0건 취소 완료"를
 * 돌려주면 사용자는 정리됐다고 믿고 손을 뗀다.
 */
export async function cancelAllOpenOrdersGateFutures(
  key: string, secret: string, testnet = true,
): Promise<{ success: boolean; count: number | null; results: any[]; message: string }> {
  const results: any[] = [];

  let open: GateOrderResult[];
  try {
    open = await getOpenOrdersGateFutures(key, secret, testnet);
  } catch (e: any) {
    return { success: false, count: null, results,
      message: `미체결 주문을 읽지 못해 취소하지 못했습니다: ${e?.message || e}` };
  }

  // 조건부 주문(손절·익절)은 계약 없이 전체 조회가 안 된다. 포지션이 있는
  // 계약도 함께 모아야 손절만 남는 일이 없다.
  const contracts = new Set<string>();
  for (const o of open) if (o?.contract) contracts.add(String(o.contract));
  try {
    for (const p of await getPositionsGateFutures(key, secret, testnet)) {
      if (p?.contract) contracts.add(String(p.contract));
    }
  } catch { /* 포지션을 못 읽어도 열린 주문 쪽은 지운다 */ }

  if (contracts.size === 0) {
    return { success: true, count: 0, results, message: '미체결 주문이 없습니다' };
  }

  let ok = true;
  let count = 0;
  for (const contract of contracts) {
    try {
      const r = await gateReq<any[]>('DELETE', '/api/v4/futures/usdt/orders', {
        key, secret, qs: `contract=${contract}`, testnet,
      });
      const n = Array.isArray(r) ? r.length : 0;
      count += n;
      results.push({ contract, kind: 'orders', success: true, count: n });
    } catch (e: any) {
      ok = false;
      results.push({ contract, kind: 'orders', success: false, error: String(e?.message || e) });
    }
    try {
      const r = await gateReq<any[]>('DELETE', '/api/v4/futures/usdt/price_orders', {
        key, secret, qs: `contract=${contract}`, testnet,
      });
      const n = Array.isArray(r) ? r.length : 0;
      count += n;
      results.push({ contract, kind: 'price_orders', success: true, count: n });
    } catch (e: any) {
      ok = false;
      results.push({ contract, kind: 'price_orders', success: false, error: String(e?.message || e) });
    }
  }

  return {
    success: ok, count, results,
    message: ok ? `미체결 주문 취소 완료 (${count}건)`
                : '일부 계약에서 취소가 실패했습니다 — 거래소에서 직접 확인하세요',
  };
}

/**
 * 포지션 전체 종료.
 *
 * **닫은 뒤에 다시 읽어 확인한다.** 주문이 200을 받았다는 것과 포지션이
 * 없다는 것은 다른 얘기다 — 유동성이 없으면 `ioc`는 그대로 취소되고,
 * 그때 "종료 완료"라고 적으면 사용자는 없는 안전을 믿는다.
 */
export async function closeAllPositionsGateFutures(
  key: string, secret: string, testnet = true, retries = 3,
): Promise<{ success: boolean; remaining: number | null; retries: number; results: any[]; message: string }> {
  const results: any[] = [];
  let attempt = 0;

  for (attempt = 1; attempt <= Math.max(1, retries); attempt++) {
    let positions: GatePosition[];
    try {
      positions = await getPositionsGateFutures(key, secret, testnet);
    } catch (e: any) {
      return { success: false, remaining: null, retries: attempt, results,
        message: `포지션을 읽지 못해 종료를 확인할 수 없습니다: ${e?.message || e}` };
    }
    if (positions.length === 0) {
      return { success: true, remaining: 0, retries: attempt, results, message: '포지션 전체 종료 완료' };
    }
    for (const p of positions) {
      const r = await closePositionGateFutures(key, secret, String(p.contract), testnet);
      results.push({ contract: p.contract, size: p.size, ...r });
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 1200));
  }

  // 마지막으로 한 번 더 확인한다. 못 읽으면 remaining은 null이다 —
  // 0으로 적으면 '전부 닫혔다'가 사실이 된다.
  let remaining: number | null = null;
  try { remaining = (await getPositionsGateFutures(key, secret, testnet)).length; } catch { /* null */ }

  return {
    success: remaining === 0,
    remaining, retries: attempt - 1, results,
    message: remaining === 0
      ? '포지션 전체 종료 완료'
      : `포지션 ${remaining ?? '?'}개가 남았습니다 — 거래소에서 직접 확인하세요`,
  };
}

/**
 * 주문 하나 취소.
 *
 * Gate는 주문을 **두 통에 나눠 담는다.** 일반 주문은 `/orders`, 조건부
 * 주문(손절·익절)은 `/price_orders`. 같은 id 공간이 아니고, 엉뚱한 통에
 * 지우러 가면 404가 난다.
 *
 * 그래서 통을 아는 쪽이 알려 준다(`bucket`). 모르면 조건부 쪽을 먼저
 * 본다 — 화면의 취소 버튼이 붙는 주문은 대부분 손절이고, 손절을 못 지우면
 * 사용자는 거래소 앱까지 들어가야 한다.
 *
 * **첫 통에서 실패해도 실패로 끝내지 않는다.** 다른 통에서 다시 시도하고,
 * 둘 다 실패했을 때만 실패다. 취소는 여러 번 해도 결과가 같은 동작이라
 * 재시도가 안전하다.
 */
export async function cancelOrderGateFutures(
  key: string, secret: string, orderId: string | number,
  opts?: { bucket?: 'price' | 'normal' | null; testnet?: boolean },
): Promise<{ success: boolean; bucket: 'price' | 'normal' | null; message: string }> {
  const testnet = opts?.testnet !== false;
  const id = String(orderId ?? '').trim();
  if (!id) return { success: false, bucket: null, message: '주문 번호가 없어 취소하지 못했습니다' };

  const order: Array<'price' | 'normal'> =
    opts?.bucket === 'normal' ? ['normal', 'price'] : ['price', 'normal'];

  const errs: string[] = [];
  for (const b of order) {
    const path = b === 'price'
      ? `/api/v4/futures/usdt/price_orders/${encodeURIComponent(id)}`
      : `/api/v4/futures/usdt/orders/${encodeURIComponent(id)}`;
    try {
      await gateReq<any>('DELETE', path, { key, secret, testnet });
      return { success: true, bucket: b, message: '주문을 취소했습니다' };
    } catch (e: any) {
      errs.push(`${b}: ${e?.message || e}`);
    }
  }
  return { success: false, bucket: null, message: `취소 실패 — ${errs.join(' / ')}` };
}
