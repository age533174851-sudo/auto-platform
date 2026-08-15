// src/lib/markets/venueDerivatives.ts
//
// **판단에 쓰는 파생 지표는 그 거래를 낼 거래소에서 읽는다.**
//
// 실제로 있던 고장
// ────────────────
// daily-ladder는 이렇게 펀딩비를 읽었다:
//
//     const bf = await import('@/lib/exchanges/binanceFutures');
//     const premium = await bf.getPremiumIndex(symbol, useTestnet);
//
// 연결이 Gate여도 **바이낸스 펀딩비**를 읽는다. 봉은 연결된 거래소에서
// 읽도록 이미 고쳐 뒀는데(`fetchVenueBars`) 파생 지표만 남아 있었다.
// 펀딩비는 거래소마다 다르다 — 다른 시장을 보고 주문하는 셈이다.
//
// 그리고 `oiChangePct`는 더 조용했다
// ──────────────────────────────────
//     let oiChangePct: number | undefined;   // 선언
//     ...
//     oiChangePct,                            // 파이프라인에 전달
//
// **그 사이에 대입이 없다.** 언제나 undefined라 Expansion 점수에서 이
// 항목이 통째로 빠진 채 돌고 있었고, 화면 어디에도 그 사실이 없었다.
// 만들어 놓고 배선을 안 한 이 저장소의 대표 고장이다.
//
// 그래서 이 파일의 규칙
// ─────────────────────
// **못 읽으면 null이고, 왜 못 읽었는지 같이 돌려준다.** 0으로 눕히면
// "펀딩비 0%"가 판단에 들어간다 — 그건 측정한 적 없는 값을 근거로
// 쓰는 것이다.

export type Venue = 'binance' | 'gate';

export interface DerivReading {
  /** 값. **못 읽으면 null이다 — 0이 아니다** */
  value: number | null;
  /** 어느 거래소에서 읽었는가 */
  venue: Venue | null;
  /** 못 읽었으면 왜 */
  error: string | null;
}

const miss = (venue: Venue | null, error: string): DerivReading =>
  ({ value: null, venue, error });

const numOf = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 펀딩비(%).
 *
 * 두 거래소 모두 **소수 비율**로 준다(0.0001 = 0.01%). 100을 곱해
 * 퍼센트로 맞춘다 — 이 변환을 호출부마다 하면 한 곳이 빠지고,
 * 그때 100배 틀린 값이 판단에 들어간다.
 */
export async function fundingRatePct(
  venue: Venue, symbol: string, testnet: boolean,
): Promise<DerivReading> {
  try {
    if (venue === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return miss('gate', `Gate 계약 이름을 만들 수 없습니다 (${symbol})`);
      const t: any = await gf.getTickerGateFutures(contract, testnet);
      const n = numOf(t?.funding_rate);
      return n == null
        ? miss('gate', 'Gate ticker에 funding_rate가 없습니다')
        : { value: n * 100, venue: 'gate', error: null };
    }
    const bf = await import('../exchanges/binanceFutures');
    const premium: any = await bf.getPremiumIndex(symbol, testnet);
    const n = numOf(premium?.lastFundingRate);
    return n == null
      ? miss('binance', '바이낸스 premiumIndex에 lastFundingRate가 없습니다')
      : { value: n * 100, venue: 'binance', error: null };
  } catch (e: any) {
    return miss(venue, String(e?.message || e));
  }
}

/**
 * 미결제약정 변화율(%).
 *
 * **선언만 있고 값이 없던 자리다.** 이제 실제로 읽는다.
 *
 * 두 거래소 모두 이력 엔드포인트를 준다. 최신 값과 `lookback`개 전의
 * 값을 비교한다 — 절대값은 종목마다 자릿수가 달라 비교가 안 되고,
 * 판단에 필요한 것은 "늘고 있는가"다.
 *
 * **테스트넷에는 이 엔드포인트가 없을 수 있다.** 그때는 null이고,
 * 호출부가 그 사실을 그대로 적는다 — 0으로 채우면 "변화 없음"이 되어
 * 판단이 조용히 달라진다.
 */
export async function openInterestChangePct(
  venue: Venue, symbol: string, testnet: boolean,
  opts: { period?: string; lookback?: number } = {},
): Promise<DerivReading> {
  const period = opts.period ?? '1h';
  const lookback = Math.max(1, Math.round(opts.lookback ?? 24));

  try {
    if (venue === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return miss('gate', `Gate 계약 이름을 만들 수 없습니다 (${symbol})`);
      const rows: any = await gf.gateReq<any[]>('GET', '/api/v4/futures/usdt/contract_stats', {
        qs: `contract=${contract}&interval=${period}&limit=${lookback + 1}`, testnet,
      });
      return changeOf(
        Array.isArray(rows) ? rows.map((r: any) => numOf(r?.open_interest)) : null,
        'gate', 'Gate contract_stats를 읽지 못했습니다');
    }
    const bf = await import('../exchanges/binanceFutures');
    // 이 엔드포인트는 공개(서명 불필요)다.
    const base = bf.futuresBase(testnet);
    const res = await fetch(
      `${base}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}`
      + `&period=${period}&limit=${lookback + 1}`,
      { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return miss('binance', `openInterestHist ${res.status}`);
    const rows: any = await res.json();
    return changeOf(
      Array.isArray(rows) ? rows.map((r: any) => numOf(r?.sumOpenInterest)) : null,
      'binance', '바이낸스 openInterestHist를 읽지 못했습니다');
  } catch (e: any) {
    return miss(venue, String(e?.message || e));
  }
}

/**
 * 이력 → 변화율(%).
 *
 * **가장 오래된 값이 0이면 계산하지 않는다.** 0으로 나누면 Infinity가
 * 되고, 그 값이 판단에 들어가면 무슨 일이 일어날지 알 수 없다.
 */
function changeOf(series: Array<number | null> | null, venue: Venue, whenMissing: string): DerivReading {
  if (!series || series.length < 2) return miss(venue, whenMissing);
  const clean = series.filter((n): n is number => n != null && Number.isFinite(n));
  if (clean.length < 2) return miss(venue, '미결제약정 값을 읽지 못했습니다');
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (!(first > 0)) return miss(venue, '기준 시점의 미결제약정이 0입니다 — 변화율을 낼 수 없습니다');
  return { value: Number((((last - first) / first) * 100).toFixed(4)), venue, error: null };
}

/**
 * 파생 지표 한 묶음.
 *
 * 화면과 기록이 **무엇을 썼고 무엇을 못 읽었는지** 같이 볼 수 있어야 한다.
 * 지금까지는 둘 다 조용히 빠져 있었다.
 */
export interface DerivativesReading {
  fundingRatePct: number | null;
  oiChangePct: number | null;
  venue: Venue;
  /** 못 읽은 항목과 이유. 비어 있으면 전부 읽었다 */
  missing: Array<{ field: string; reason: string }>;
}

export async function readDerivatives(
  venue: Venue, symbol: string, testnet: boolean,
): Promise<DerivativesReading> {
  const [f, oi] = await Promise.all([
    fundingRatePct(venue, symbol, testnet),
    openInterestChangePct(venue, symbol, testnet),
  ]);
  const missing: Array<{ field: string; reason: string }> = [];
  if (f.value == null) missing.push({ field: 'fundingRatePct', reason: f.error ?? '사유 없음' });
  if (oi.value == null) missing.push({ field: 'oiChangePct', reason: oi.error ?? '사유 없음' });
  return { fundingRatePct: f.value, oiChangePct: oi.value, venue, missing };
}
