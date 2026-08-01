// src/lib/exchanges/kis.ts
//
// 한국투자증권(KIS) Open API — **네트워크를 타는 부분.**
//
// 판정은 여기 없다. kisCore.ts에 있고 테스트가 붙어 있다. 이 파일은
// 요청을 만들어 보내고 응답을 그쪽에 넘긴다.
//
// 토큰을 반드시 캐시한다
// ──────────────────────
// KIS는 접근토큰 **재발급 횟수를 제한한다.** 매 요청마다 새로 받으면
// 금방 막히고, 막히면 주문도 조회도 전부 실패한다. 그래서 DB에 저장하고
// 만료가 가까울 때만 다시 받는다.
//
// 캐시를 못 읽거나 못 쓰면 **그 사실을 조용히 넘기지 않는다.** 저장이
// 계속 실패하는데 요청은 되는 상태가 제일 나쁘다 — 잘 돌다가 어느 날
// 갑자기 '요청 한도 초과'로 전부 멈춘다.
import {
  KIS_HOSTS, KIS_TR, trIdFor, orderTrId,
  parseKisBody, parseTokenBody, tokenNeedsRefresh,
  buildOrderBody, splitAccountNo, priceFrom, holdingsFrom, cashFrom,
  type KisEnv, type KisSide, type KisOrderType, type KisResult, type KisToken,
} from './kisCore';

export interface KisCreds {
  appKey: string;
  appSecret: string;
  /** '12345678-01' 또는 '1234567801' */
  accountNo: string;
  env: KisEnv;
}

const TIMEOUT_MS = 12_000;

async function kisFetch(
  url: string, init: RequestInit,
): Promise<{ status: number; body: any; error: string | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store' });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch {
      // JSON이 아니다. 점검 페이지나 프록시 오류일 수 있다. 본문 앞부분을
      // 그대로 남긴다 — '알 수 없는 오류'로 적으면 원인을 못 찾는다.
      return { status: r.status, body: null, error: `한국투자증권 응답이 JSON이 아닙니다 (${r.status}): ${text.slice(0, 200)}` };
    }
    return { status: r.status, body, error: null };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return {
      status: 0, body: null,
      error: aborted
        ? `한국투자증권 응답이 ${TIMEOUT_MS / 1000}초 안에 오지 않았습니다`
        : `한국투자증권에 연결하지 못했습니다: ${e?.message || e}`,
    };
  } finally { clearTimeout(timer); }
}

// ── 토큰 ─────────────────────────────────────────────────────

/** 토큰을 새로 받는다. 캐시는 보지 않는다 — 호출부가 판단한다. */
export async function issueToken(
  creds: KisCreds, nowMs = Date.now(),
): Promise<{ token: KisToken | null; error: string | null }> {
  const host = KIS_HOSTS[creds.env];
  if (!host) return { token: null, error: `모르는 환경입니다: ${creds.env}` };

  const r = await kisFetch(`${host}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: creds.appKey,
      appsecret: creds.appSecret,
    }),
  });
  if (r.error) return { token: null, error: r.error };
  return parseTokenBody(r.body, nowMs);
}

/**
 * 캐시를 보고, 필요하면 새로 받는다.
 *
 * 캐시 저장소는 주입받는다 — 이 파일이 Supabase를 직접 알면 테스트도
 * 못 하고 다른 곳에서 재사용도 안 된다.
 */
export interface TokenCache {
  read(): Promise<KisToken | null>;
  write(t: KisToken): Promise<void>;
}

export async function getAccessToken(
  creds: KisCreds, cache: TokenCache | null, nowMs = Date.now(),
): Promise<{ token: string | null; error: string | null; cacheNote: string | null }> {
  let cached: KisToken | null = null;
  let cacheNote: string | null = null;

  if (cache) {
    try { cached = await cache.read(); }
    catch (e: any) { cacheNote = `토큰 캐시를 읽지 못했습니다: ${e?.message || e}`; }
  } else {
    // 캐시 없이 돌면 요청마다 새 토큰을 받게 되고, KIS의 재발급 제한에
    // 걸린다. 동작은 하니까 막지는 않되 조용히 넘어가지도 않는다.
    cacheNote = '토큰 캐시가 없습니다 — 요청마다 새로 발급하면 한도에 걸립니다';
  }

  if (!tokenNeedsRefresh(cached, nowMs)) {
    return { token: cached!.accessToken, error: null, cacheNote };
  }

  const fresh = await issueToken(creds, nowMs);
  if (!fresh.token) {
    // 새로 못 받았다. 캐시에 아직 안 죽은 토큰이 있으면 그걸 쓴다 —
    // 발급이 잠깐 막힌 것 때문에 멀쩡한 토큰을 버릴 이유가 없다.
    if (cached && Number.isFinite(cached.expiresAtMs) && nowMs < cached.expiresAtMs) {
      return {
        token: cached.accessToken, error: null,
        cacheNote: `토큰 재발급에 실패해 기존 토큰을 씁니다 (${fresh.error})`,
      };
    }
    return { token: null, error: fresh.error, cacheNote };
  }

  if (cache) {
    try { await cache.write(fresh.token); }
    catch (e: any) {
      // 저장 실패가 이번 요청을 막지는 않는다. 다만 계속 실패하면
      // 매번 새로 받게 되므로 반드시 보이게 남긴다.
      cacheNote = `토큰을 저장하지 못했습니다 — 다음 요청도 새로 발급합니다: ${e?.message || e}`;
    }
  }
  return { token: fresh.token.accessToken, error: null, cacheNote };
}

// ── 공통 호출 ────────────────────────────────────────────────

function baseHeaders(creds: KisCreds, token: string, trId: string): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
    appkey: creds.appKey,
    appsecret: creds.appSecret,
    tr_id: trId,
    // 개인. 법인이면 'B'인데 이 앱은 개인 계좌만 다룬다.
    custtype: 'P',
  };
}

async function callKis(
  creds: KisCreds, token: string, trId: string,
  path: string, opts: { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: any } = {},
): Promise<{ res: KisResult; error: string | null }> {
  const host = KIS_HOSTS[creds.env];
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
  const r = await kisFetch(`${host}${path}${qs}`, {
    method: opts.method || 'GET',
    headers: baseHeaders(creds, token, trId),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.error) {
    return {
      res: { ok: false, code: null, message: r.error, output: null, output1: null, output2: null },
      error: r.error,
    };
  }
  // **HTTP 상태만 보고 넘어가지 않는다.** KIS는 잔고 부족도 장 마감도 200이다.
  const res = parseKisBody(r.body);
  return { res, error: res.ok ? null : res.message };
}

// ── 시세 ─────────────────────────────────────────────────────

/** 국내주식 현재가. 못 읽으면 null이다 — 0이 아니다. */
export async function getKisPrice(
  creds: KisCreds, token: string, symbol: string,
): Promise<{ price: number | null; message: string }> {
  const { res } = await callKis(creds, token, trIdFor(KIS_TR.PRICE, creds.env),
    '/uapi/domestic-stock/v1/quotations/inquire-price', {
      query: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: String(symbol || '') },
    });
  return { price: priceFrom(res), message: res.message };
}

// ── 잔고 ─────────────────────────────────────────────────────

export async function getKisBalance(creds: KisCreds, token: string) {
  const acct = splitAccountNo(creds.accountNo);
  if (!acct) {
    return { ok: false, holdings: null, cash: null, message: '계좌번호가 올바르지 않습니다 (10자리)' };
  }
  const { res } = await callKis(creds, token, trIdFor(KIS_TR.BALANCE, creds.env),
    '/uapi/domestic-stock/v1/trading/inquire-balance', {
      query: {
        CANO: acct.cano, ACNT_PRDT_CD: acct.acntPrdtCd,
        AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00',
        CTX_AREA_FK100: '', CTX_AREA_NK100: '',
      },
    });
  return {
    ok: res.ok,
    holdings: holdingsFrom(res),
    cash: cashFrom(res),
    message: res.message,
  };
}

// ── 주문 ─────────────────────────────────────────────────────

export interface KisOrderArgs {
  symbol: string;
  side: KisSide;
  quantity: number;
  orderType: KisOrderType;
  price?: number | null;
}

/**
 * 국내주식 현금 주문.
 *
 * **hashkey를 붙인다.** KIS가 본문 위변조를 확인하는 값이고, 없으면
 * 거부하는 요청이 있다. 해시 발급이 실패하면 **주문을 보내지 않는다** —
 * 없는 채로 보내서 거부당하면 "왜 안 됐는지"가 두 겹이 된다.
 */
export async function placeKisOrder(
  creds: KisCreds, token: string, args: KisOrderArgs,
): Promise<{ ok: boolean; orderNo: string | null; message: string; plan: string }> {
  const acct = splitAccountNo(creds.accountNo);
  if (!acct) {
    return { ok: false, orderNo: null, message: '계좌번호가 올바르지 않습니다 (10자리)', plan: '' };
  }

  const plan = buildOrderBody({
    cano: acct.cano, acntPrdtCd: acct.acntPrdtCd,
    symbol: args.symbol, side: args.side,
    quantity: args.quantity, orderType: args.orderType, price: args.price ?? null,
  });
  if (!plan.ok || !plan.body) {
    return { ok: false, orderNo: null, message: plan.reason, plan: '' };
  }

  const host = KIS_HOSTS[creds.env];
  const hashed = await kisFetch(`${host}/uapi/hashkey`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      appkey: creds.appKey, appsecret: creds.appSecret,
    },
    body: JSON.stringify(plan.body),
  });
  const hash = hashed.body?.HASH;
  if (hashed.error || !hash) {
    return {
      ok: false, orderNo: null, plan: plan.reason,
      message: `주문 해시(hashkey)를 받지 못해 주문하지 않았습니다: ${hashed.error || '응답에 HASH가 없습니다'}`,
    };
  }

  const trId = orderTrId(args.side, creds.env);
  const r = await kisFetch(`${host}/uapi/domestic-stock/v1/trading/order-cash`, {
    method: 'POST',
    headers: { ...baseHeaders(creds, token, trId), hashkey: String(hash) },
    body: JSON.stringify(plan.body),
  });
  if (r.error) return { ok: false, orderNo: null, message: r.error, plan: plan.reason };

  const res = parseKisBody(r.body);
  if (!res.ok) return { ok: false, orderNo: null, message: res.message, plan: plan.reason };

  // 주문번호가 없으면 성공이라고 하지 않는다. rt_cd가 0인데 번호가
  // 없다는 것은 응답 모양이 바뀌었다는 뜻이고, 그러면 나중에 이 주문을
  // 조회하거나 취소할 방법이 없다.
  const no = res.output?.ODNO;
  if (!no) {
    return {
      ok: false, orderNo: null, plan: plan.reason,
      message: `주문은 접수됐다고 하는데 주문번호(ODNO)가 없습니다 — 거래소에서 직접 확인하세요 (${res.message})`,
    };
  }
  return { ok: true, orderNo: String(no), message: res.message, plan: plan.reason };
}

/**
 * 연결 확인 — 키가 맞는지, 계좌를 읽을 수 있는지.
 *
 * 토큰만 받아 보고 끝내지 않는다. 토큰은 앱키만 맞으면 나오므로,
 * **계좌번호가 틀려도 통과한다.** 잔고까지 읽어야 진짜 확인이다.
 */
export async function testKisConnection(creds: KisCreds, cache: TokenCache | null) {
  const t = await getAccessToken(creds, cache);
  if (!t.token) {
    return { ok: false, message: `앱키 인증 실패: ${t.error}`, cacheNote: t.cacheNote };
  }
  const bal = await getKisBalance(creds, t.token);
  if (!bal.ok) {
    return { ok: false, message: `앱키는 맞는데 계좌 조회가 안 됩니다: ${bal.message}`, cacheNote: t.cacheNote };
  }
  const n = bal.holdings?.length ?? 0;
  return {
    ok: true,
    message: `${creds.env === 'PAPER' ? '모의투자' : '실전'} 연결됨 · 보유 ${n}종목`
      + (bal.cash == null ? ' · 예수금 확인 불가' : ` · 예수금 ${Math.round(bal.cash).toLocaleString('ko-KR')}원`),
    cacheNote: t.cacheNote,
  };
}
