// src/lib/exchanges/kisCore.ts
//
// 한국투자증권(KIS) Open API — **판정만 하는 순수 부분.**
//
// 네트워크를 타는 부분(kis.ts)과 나눈 이유는 늘 같다: 여기 있는 것들이
// 조용히 틀리면 "주문했는데 안 나갔다"가 되는데, IO에 섞여 있으면
// 테스트로 잡을 수가 없다.
//
// 이 파일이 특히 조심하는 것
// ──────────────────────────
// **KIS는 실패해도 HTTP 200을 준다.** 성공 여부는 본문의 `rt_cd`에 있다
// ('0'이 성공). 그래서 `res.ok`만 보고 넘어가면 잔고 부족·장 마감·종목
// 코드 오류가 전부 "주문 성공"이 된다.
//
// 오늘 이 저장소에서 계속 나온 그 모양이다 — 요청은 200인데 실제로는
// 아무것도 안 됐다. 거래소가 바뀌어도 같은 함정이 있다는 뜻이라, 아예
// 응답 해석을 한 함수로 못 박는다.

export type KisEnv = 'PAPER' | 'LIVE';
export type KisSide = 'BUY' | 'SELL';
export type KisOrderType = 'MARKET' | 'LIMIT';

/**
 * 실전과 모의는 **주소도 앱키도 다르다.**
 *
 * 섞으면 인증 자체가 안 되므로 조용히 실전에 주문이 나가는 사고는 없다.
 * 다만 반대로, 모의 키로 실전 주소를 부르면 "인증 실패"만 뜨고 원인이
 * 안 보인다 — 그래서 아래 verdict 문구에 어느 환경인지 항상 적는다.
 */
export const KIS_HOSTS: Record<KisEnv, string> = {
  LIVE: 'https://openapi.koreainvestment.com:9443',
  PAPER: 'https://openapivts.koreainvestment.com:29443',
};

/**
 * 거래 ID(tr_id). KIS는 이 헤더 하나로 무슨 요청인지 구분한다.
 *
 * 모의투자는 실전 ID의 **첫 글자 T를 V로** 바꾼 것이다. 손으로 두 벌을
 * 적으면 한쪽만 고치게 되므로 규칙으로 만든다.
 *
 * ⚠️ 이 값이 틀리면 KIS는 인증은 통과시키고 `rt_cd`에 오류를 담아 준다.
 *    그래서 parseKisBody가 그 메시지를 **그대로** 실어 올린다 — 여기서
 *    'API 오류' 같은 말로 뭉개면 무엇이 틀렸는지 영영 알 수 없다.
 */
export const KIS_TR = {
  /** 국내주식 현금 매수 */
  ORDER_BUY: 'TTTC0802U',
  /** 국내주식 현금 매도 */
  ORDER_SELL: 'TTTC0801U',
  /** 국내주식 잔고 조회 */
  BALANCE: 'TTTC8434R',
  /** 국내주식 현재가 (실전·모의 공통) */
  PRICE: 'FHKST01010100',
} as const;

/** 실전 tr_id를 그 환경에 맞게 바꾼다 */
export function trIdFor(base: string, env: KisEnv): string {
  const s = String(base || '');
  if (!s) return s;
  // 시세 조회(FH…)는 모의에도 같은 ID를 쓴다. 앞글자만 보고 바꾸면
  // FHKST…가 VHKST…가 되어 없는 요청이 된다.
  if (env === 'LIVE' || !s.startsWith('T')) return s;
  return `V${s.slice(1)}`;
}

export function orderTrId(side: KisSide, env: KisEnv): string {
  return trIdFor(side === 'BUY' ? KIS_TR.ORDER_BUY : KIS_TR.ORDER_SELL, env);
}

// ── 응답 해석 ────────────────────────────────────────────────

export interface KisResult {
  ok: boolean;
  /** KIS의 rt_cd. '0'이 성공 */
  code: string | null;
  /** 사람이 읽을 메시지 — KIS가 준 문장을 그대로 옮긴다 */
  message: string;
  /** 성공했을 때의 본문 */
  output: any;
  output1: any;
  output2: any;
}

/**
 * KIS 응답 본문을 해석한다.
 *
 * **HTTP 상태는 안 본다** — 호출부가 이미 봤고, 여기서 봐야 하는 것은
 * `rt_cd`다. KIS는 잔고 부족도 장 마감도 200으로 준다.
 *
 * 본문이 아예 없거나 rt_cd가 없으면 **성공이 아니다.** 모양이 바뀐 것도
 * 실패다 — 모르는 것을 유리하게 읽지 않는다.
 */
export function parseKisBody(body: any): KisResult {
  const fail = (message: string, code: string | null = null): KisResult =>
    ({ ok: false, code, message, output: null, output1: null, output2: null });

  if (body == null || typeof body !== 'object') {
    return fail('한국투자증권 응답을 읽지 못했습니다 (본문 없음)');
  }
  // 토큰 발급처럼 rt_cd가 없는 응답도 있다. 그건 전용 파서를 쓴다.
  const rt = body.rt_cd;
  if (rt == null) {
    // 인증 오류는 error_description으로 온다
    const authMsg = body.error_description || body.error_code || body.msg1;
    return fail(authMsg ? String(authMsg) : '한국투자증권 응답에 결과 코드(rt_cd)가 없습니다');
  }

  const code = String(rt);
  const msg = String(body.msg1 || body.msg_cd || '').trim();
  if (code !== '0') {
    // 실패 사유를 그대로 올린다. 'API 오류'로 뭉개면 종목코드가 틀린
    // 것인지 장이 닫힌 것인지 잔고가 없는 것인지 구분이 안 된다.
    return fail(msg || `한국투자증권이 거부했습니다 (rt_cd=${code})`, code);
  }

  return {
    ok: true, code,
    message: msg || '성공',
    output: body.output ?? null,
    output1: body.output1 ?? null,
    output2: body.output2 ?? null,
  };
}

// ── 토큰 ─────────────────────────────────────────────────────

export interface KisToken {
  accessToken: string;
  /** 만료 시각(ms) */
  expiresAtMs: number;
}

/**
 * 토큰 발급 응답을 해석한다.
 *
 * `expires_in`(초)을 안 주면 **24시간으로 넘겨짚지 않는다.** 넘겨짚으면
 * 실제로는 만료된 토큰을 계속 쓰다가 하루 종일 인증 실패한다.
 */
export function parseTokenBody(body: any, nowMs: number): { token: KisToken | null; error: string | null } {
  if (body == null || typeof body !== 'object') {
    return { token: null, error: '토큰 응답을 읽지 못했습니다' };
  }
  const t = body.access_token;
  if (!t) {
    const why = body.error_description || body.error_code || body.msg1;
    return { token: null, error: why ? String(why) : '토큰이 응답에 없습니다' };
  }
  const secs = Number(body.expires_in);
  if (!Number.isFinite(secs) || secs <= 0) {
    return { token: null, error: '토큰 만료 시간(expires_in)이 응답에 없습니다 — 추측해서 쓰지 않습니다' };
  }
  return { token: { accessToken: String(t), expiresAtMs: nowMs + secs * 1000 }, error: null };
}

/**
 * 캐시된 토큰을 다시 받아야 하는가.
 *
 * **KIS는 토큰 재발급 횟수를 제한한다.** 매 요청마다 새로 받으면 금방
 * 막히고, 막히면 주문도 조회도 전부 실패한다. 그래서 반드시 캐시하고,
 * 만료가 가까울 때만 다시 받는다.
 *
 * @param skewMs 만료 몇 밀리초 전부터 미리 받을지. 기본 10분 —
 *               요청이 날아가는 도중에 만료되는 일을 막는다.
 */
export function tokenNeedsRefresh(
  token: KisToken | null | undefined,
  nowMs: number,
  skewMs = 10 * 60_000,
): boolean {
  if (!token || !token.accessToken) return true;
  if (!Number.isFinite(token.expiresAtMs)) return true;
  return nowMs >= token.expiresAtMs - Math.max(0, skewMs);
}

// ── 주문 ─────────────────────────────────────────────────────

export interface KisOrderInput {
  /** 계좌번호 앞 8자리 */
  cano: string;
  /** 계좌상품코드 뒤 2자리 — 보통 '01' */
  acntPrdtCd: string;
  /** 종목코드 6자리 */
  symbol: string;
  side: KisSide;
  /** 주수 (정수) */
  quantity: number;
  /** 지정가일 때만 */
  price?: number | null;
  orderType: KisOrderType;
}

export interface KisOrderPlan {
  ok: boolean;
  reason: string;
  body: Record<string, string> | null;
}

/**
 * 주문 본문을 만든다.
 *
 * 못 만들면 **본문을 만들지 않는다.** 예전 코드들이 그랬듯 0이나 빈 문자열로
 * 채워 보내면 KIS가 그것대로 해석해서 엉뚱한 주문이 나간다.
 */
export function buildOrderBody(input: KisOrderInput): KisOrderPlan {
  const bad = (reason: string): KisOrderPlan => ({ ok: false, reason, body: null });

  const cano = String(input?.cano || '').trim();
  if (!/^\d{8}$/.test(cano)) return bad('계좌번호 앞 8자리가 올바르지 않습니다');
  const prdt = String(input?.acntPrdtCd || '').trim();
  if (!/^\d{2}$/.test(prdt)) return bad('계좌상품코드 2자리가 올바르지 않습니다');

  const symbol = String(input?.symbol || '').trim();
  // 국내주식은 여섯 자리다. 다섯 자리를 보내면 KIS가 앞을 0으로 채워 주지
  // 않고 '종목 없음'으로 거부한다 — 여기서 잡는 편이 낫다.
  if (!/^\d{6}$/.test(symbol)) return bad(`국내 종목코드는 여섯 자리입니다: ${symbol || '(없음)'}`);

  const qty = Number(input?.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return bad('수량이 올바르지 않습니다');
  // 주식은 소수 주가 없다. 반올림해서 보내면 의도와 다른 수량이 나간다.
  if (!Number.isInteger(qty)) return bad(`주식은 소수점 수량을 낼 수 없습니다: ${qty}`);

  const side = String(input?.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return bad(`방향이 올바르지 않습니다: ${side || '(없음)'}`);

  const type = String(input?.orderType || '').toUpperCase();
  let ordDvsn: string;
  let unpr: string;
  if (type === 'MARKET') {
    // 시장가는 단가를 0으로 보낸다. KIS 규약이다.
    ordDvsn = '01';
    unpr = '0';
  } else if (type === 'LIMIT') {
    const px = Number(input?.price);
    if (!Number.isFinite(px) || px <= 0) return bad('지정가 주문인데 가격이 없습니다');
    if (!Number.isInteger(px)) return bad(`국내주식 호가는 정수입니다: ${px}`);
    ordDvsn = '00';
    unpr = String(px);
  } else {
    return bad(`주문 종류가 올바르지 않습니다: ${type || '(없음)'}`);
  }

  return {
    ok: true,
    reason: `${symbol} ${side === 'BUY' ? '매수' : '매도'} ${qty}주 (${type === 'MARKET' ? '시장가' : `지정가 ${unpr}`})`,
    body: {
      CANO: cano,
      ACNT_PRDT_CD: prdt,
      PDNO: symbol,
      ORD_DVSN: ordDvsn,
      ORD_QTY: String(qty),
      ORD_UNPR: unpr,
    },
  };
}

/** 계좌번호 '12345678-01' 또는 '1234567801' → {cano, acntPrdtCd} */
export function splitAccountNo(raw: string | null | undefined): { cano: string; acntPrdtCd: string } | null {
  const s = String(raw || '').replace(/[^0-9]/g, '');
  if (s.length !== 10) return null;
  return { cano: s.slice(0, 8), acntPrdtCd: s.slice(8) };
}

// ── 조회 해석 ────────────────────────────────────────────────

/**
 * 현재가 응답에서 가격을 꺼낸다.
 *
 * **못 찾으면 null이다. 0이 아니다.** 0으로 두면 명목가가 0이 되어
 * 증거금 검사도 손절 계산도 전부 통과해 버린다.
 */
export function priceFrom(res: KisResult): number | null {
  if (!res?.ok) return null;
  const raw = res.output?.stck_prpr;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface KisHolding {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  evalAmount: number;
  pnl: number;
}

/**
 * 잔고 응답에서 보유 종목을 꺼낸다.
 *
 * 수량 0인 줄은 뺀다 — KIS는 당일 전량 매도한 종목도 한동안 0주로 남긴다.
 */
export function holdingsFrom(res: KisResult): KisHolding[] | null {
  if (!res?.ok) return null;
  const rows = Array.isArray(res.output1) ? res.output1 : null;
  // 배열이 아니면 **빈 배열로 바꾸지 않는다.** 응답 모양이 바뀐 것을
  // '보유 없음'으로 읽으면 자산이 0으로 보인다.
  if (!rows) return null;

  const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return rows
    .map((r: any) => ({
      symbol: String(r?.pdno || ''),
      name: String(r?.prdt_name || ''),
      quantity: num(r?.hldg_qty),
      avgPrice: num(r?.pchs_avg_pric),
      currentPrice: num(r?.prpr),
      evalAmount: num(r?.evlu_amt),
      pnl: num(r?.evlu_pfls_amt),
    }))
    .filter(h => h.symbol && h.quantity > 0);
}

/**
 * 주문 가능 현금.
 *
 * **없으면 null이다.** 0으로 두면 "돈이 없다"가 되어 주문이 막히는데,
 * 그건 확인한 사실이 아니라 못 읽은 것이다. 반대로 큰 값으로 두면
 * 증거금 검사가 껍데기가 된다.
 */
export function cashFrom(res: KisResult): number | null {
  if (!res?.ok) return null;
  const rows = Array.isArray(res.output2) ? res.output2 : null;
  if (!rows || rows.length === 0) return null;
  // dnca_tot_amt = 예수금 총액. 주문가능현금(ord_psbl_cash)이 있으면 그쪽이 정확하다.
  const raw = rows[0]?.ord_psbl_cash ?? rows[0]?.dnca_tot_amt;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
