// src/lib/derivatives/index.ts
// 파생시장 데이터 — 펀딩비 + 미결제약정(OI).
//
// 왜 둘을 같이 봐야 하나:
//   가격과 OI의 조합은 각각 다른 의미를 갖는다.
//     가격↑ OI↑ : 신규 롱 유입 — 추세 강함 (건전한 상승)
//     가격↑ OI↓ : 숏 커버링 — 상승이지만 연료 소진 (되돌림 위험)
//     가격↓ OI↑ : 신규 숏 유입 — 하락 추세 강함
//     가격↓ OI↓ : 롱 청산 — 하락이지만 바닥 가능성
//   여기에 펀딩비를 더하면 롱/숏 쏠림까지 판단할 수 있다.
//
// 원칙: OI/펀딩 단독으로 방향을 결정하지 않는다. 확인(confirmation) 지표로만 쓴다.

export interface DerivativesSnapshot {
  symbol: string;
  fundingRate: number | null;        // % (8시간당)
  nextFundingTime: number | null;
  openInterest: number | null;       // 계약 수량
  openInterestValue: number | null;  // USD 환산
  oiChangePct24h: number | null;     // 24시간 변화율 %
  priceChangePct24h: number | null;
  markPrice: number | null;
  source: 'binance' | 'gate' | 'fallback';
  fetchedAt: number;
  error?: string;
}

export type OiPricePattern =
  | 'NEW_LONGS'        // 가격↑ OI↑ — 신규 롱 유입
  | 'SHORT_COVERING'   // 가격↑ OI↓ — 숏 커버링
  | 'NEW_SHORTS'       // 가격↓ OI↑ — 신규 숏 유입
  | 'LONG_LIQUIDATION' // 가격↓ OI↓ — 롱 청산
  | 'NEUTRAL';

export interface DerivativesSignal {
  pattern: OiPricePattern;
  patternLabel: string;
  patternMeaning: string;
  // 확인 지표로서의 점수 (방향을 결정하지 않고, 추세를 지지/반박만 한다)
  longConfirmation: number;    // 0~100
  shortConfirmation: number;
  crowding: 'long_crowded' | 'short_crowded' | 'balanced';
  crowdingNote: string;
  reliability: number;         // 0~100 — 데이터 신뢰도 (누락 시 낮아짐)
  notes: string[];
}

const PATTERN_META: Record<OiPricePattern, { label: string; meaning: string }> = {
  NEW_LONGS:        { label: '신규 롱 유입',  meaning: '가격 상승 + OI 증가 — 새 자금이 들어오는 건전한 상승' },
  SHORT_COVERING:   { label: '숏 커버링',    meaning: '가격 상승 + OI 감소 — 숏이 청산되며 오르는 것, 연료가 줄어듦' },
  NEW_SHORTS:       { label: '신규 숏 유입',  meaning: '가격 하락 + OI 증가 — 새 숏이 들어오는 하락 추세' },
  LONG_LIQUIDATION: { label: '롱 청산',      meaning: '가격 하락 + OI 감소 — 롱이 털리는 중, 바닥 근접 가능성' },
  NEUTRAL:          { label: '중립',        meaning: '뚜렷한 패턴 없음' },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── Binance 파생 데이터 (공개 엔드포인트, 서명 불필요) ──
export async function fetchBinanceDerivatives(symbol: string, testnet = false): Promise<DerivativesSnapshot> {
  const sym = symbol.toUpperCase().replace('/', '').replace('_', '');
  const base = testnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
  const snap: DerivativesSnapshot = {
    symbol: sym, fundingRate: null, nextFundingTime: null,
    openInterest: null, openInterestValue: null,
    oiChangePct24h: null, priceChangePct24h: null, markPrice: null,
    source: 'binance', fetchedAt: Date.now(),
  };

  try {
    // premiumIndex: 펀딩비 + 마크가격
    const [pi, oi, stats, oiHist] = await Promise.allSettled([
      fetch(`${base}/fapi/v1/premiumIndex?symbol=${sym}`, { signal: AbortSignal.timeout(6000), cache: 'no-store' }).then(r => r.json()),
      fetch(`${base}/fapi/v1/openInterest?symbol=${sym}`, { signal: AbortSignal.timeout(6000), cache: 'no-store' }).then(r => r.json()),
      fetch(`${base}/fapi/v1/ticker/24hr?symbol=${sym}`, { signal: AbortSignal.timeout(6000), cache: 'no-store' }).then(r => r.json()),
      // OI 히스토리는 futures data 엔드포인트 (테스트넷 미지원일 수 있음)
      fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=1d&limit=2`,
        { signal: AbortSignal.timeout(6000), cache: 'no-store' }).then(r => r.json()),
    ]);

    if (pi.status === 'fulfilled' && pi.value) {
      const v = pi.value;
      if (v.lastFundingRate != null) snap.fundingRate = parseFloat(v.lastFundingRate) * 100;
      if (v.nextFundingTime != null) snap.nextFundingTime = Number(v.nextFundingTime);
      if (v.markPrice != null) snap.markPrice = parseFloat(v.markPrice);
    }
    if (oi.status === 'fulfilled' && oi.value?.openInterest != null) {
      snap.openInterest = parseFloat(oi.value.openInterest);
      if (snap.markPrice) snap.openInterestValue = snap.openInterest * snap.markPrice;
    }
    if (stats.status === 'fulfilled' && stats.value?.priceChangePercent != null) {
      snap.priceChangePct24h = parseFloat(stats.value.priceChangePercent);
    }
    if (oiHist.status === 'fulfilled' && Array.isArray(oiHist.value) && oiHist.value.length >= 2) {
      const prev = parseFloat(oiHist.value[0].sumOpenInterest);
      const cur = parseFloat(oiHist.value[oiHist.value.length - 1].sumOpenInterest);
      if (prev > 0) snap.oiChangePct24h = ((cur - prev) / prev) * 100;
    }
  } catch (e: any) {
    snap.error = e?.message || '파생 데이터 조회 실패';
  }
  return snap;
}

// ── Gate 파생 데이터 ──
export async function fetchGateDerivatives(symbol: string, testnet = false): Promise<DerivativesSnapshot> {
  const contract = symbol.toUpperCase().replace('USDT', '_USDT').replace('__', '_');
  const base = testnet ? 'https://api-testnet.gateapi.io' : 'https://api.gateio.ws';
  const snap: DerivativesSnapshot = {
    symbol: contract, fundingRate: null, nextFundingTime: null,
    openInterest: null, openInterestValue: null,
    oiChangePct24h: null, priceChangePct24h: null, markPrice: null,
    source: 'gate', fetchedAt: Date.now(),
  };
  try {
    const r = await fetch(`${base}/api/v4/futures/usdt/tickers?contract=${contract}`,
      { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    const list = await r.json();
    const t = Array.isArray(list) ? list[0] : null;
    if (t) {
      if (t.funding_rate != null) snap.fundingRate = parseFloat(t.funding_rate) * 100;
      if (t.mark_price != null) snap.markPrice = parseFloat(t.mark_price);
      if (t.change_percentage != null) snap.priceChangePct24h = parseFloat(t.change_percentage);
      // Gate는 tickers에 total_size(OI)를 제공
      if (t.total_size != null) {
        snap.openInterest = parseFloat(t.total_size);
        if (snap.markPrice) snap.openInterestValue = snap.openInterest * snap.markPrice;
      }
    }
  } catch (e: any) {
    snap.error = e?.message || '파생 데이터 조회 실패';
  }
  return snap;
}

/**
 * 파생 데이터 → 확인 지표 신호.
 *
 * 중요: 이 함수는 방향을 "결정"하지 않는다.
 * longConfirmation/shortConfirmation은 다른 축이 낸 방향을 지지하거나 반박하는 값이다.
 */
export function analyzeDerivatives(snap: DerivativesSnapshot): DerivativesSignal {
  const notes: string[] = [];
  let reliability = 100;

  const price = snap.priceChangePct24h;
  const oiChg = snap.oiChangePct24h;
  const funding = snap.fundingRate;

  // 데이터 누락 시 신뢰도 하락
  if (price == null) { reliability -= 35; notes.push('가격 변화 데이터 없음'); }
  if (oiChg == null) { reliability -= 35; notes.push('OI 변화 데이터 없음'); }
  if (funding == null) { reliability -= 30; notes.push('펀딩비 데이터 없음'); }
  reliability = clamp(reliability, 0, 100);

  // ── OI × 가격 패턴 ──
  let pattern: OiPricePattern = 'NEUTRAL';
  const PRICE_TH = 0.5;   // 0.5% 이상 움직여야 방향으로 인정
  const OI_TH = 1.0;      // OI 1% 이상 변해야 유의미

  if (price != null && oiChg != null && Math.abs(price) >= PRICE_TH && Math.abs(oiChg) >= OI_TH) {
    if (price > 0 && oiChg > 0) pattern = 'NEW_LONGS';
    else if (price > 0 && oiChg < 0) pattern = 'SHORT_COVERING';
    else if (price < 0 && oiChg > 0) pattern = 'NEW_SHORTS';
    else pattern = 'LONG_LIQUIDATION';
  }

  // ── 패턴별 확인 점수 ──
  // 50 = 중립. 패턴이 뚜렷할수록 한쪽으로 기운다.
  let longConf = 50, shortConf = 50;
  const strength = (price != null && oiChg != null)
    ? clamp((Math.abs(price) / 3) * (Math.abs(oiChg) / 5), 0, 1)
    : 0;

  switch (pattern) {
    case 'NEW_LONGS':
      longConf = 50 + strength * 30;
      notes.push(`신규 롱 유입 (가격 ${price!.toFixed(1)}% · OI ${oiChg!.toFixed(1)}%) — 상승 추세 지지`);
      break;
    case 'SHORT_COVERING':
      // 상승이지만 신규 자금이 아니라 숏 청산 — 지속성 의심
      longConf = 50 + strength * 8;
      shortConf = 50 + strength * 12;
      notes.push(`숏 커버링 (가격 ${price!.toFixed(1)}% · OI ${oiChg!.toFixed(1)}%) — 상승 연료 소진 중`);
      break;
    case 'NEW_SHORTS':
      shortConf = 50 + strength * 30;
      notes.push(`신규 숏 유입 (가격 ${price!.toFixed(1)}% · OI ${oiChg!.toFixed(1)}%) — 하락 추세 지지`);
      break;
    case 'LONG_LIQUIDATION':
      // 하락이지만 롱 청산 — 바닥 가능성
      shortConf = 50 + strength * 10;
      longConf = 50 + strength * 14;
      notes.push(`롱 청산 (가격 ${price!.toFixed(1)}% · OI ${oiChg!.toFixed(1)}%) — 투매 후 반등 여지`);
      break;
    default:
      notes.push('OI·가격에 뚜렷한 패턴 없음');
  }

  // ── 펀딩비 쏠림 ──
  let crowding: DerivativesSignal['crowding'] = 'balanced';
  let crowdingNote = '펀딩비 정상 범위';
  if (funding != null) {
    if (funding > 0.05) {
      crowding = 'long_crowded';
      crowdingNote = `펀딩비 +${funding.toFixed(4)}% — 롱 과밀, 청산 연쇄 위험`;
      shortConf += 12; longConf -= 8;
    } else if (funding > 0.02) {
      crowding = 'long_crowded';
      crowdingNote = `펀딩비 +${funding.toFixed(4)}% — 롱 우세`;
      shortConf += 5; longConf -= 3;
    } else if (funding < -0.05) {
      crowding = 'short_crowded';
      crowdingNote = `펀딩비 ${funding.toFixed(4)}% — 숏 과밀, 숏스퀴즈 위험`;
      longConf += 12; shortConf -= 8;
    } else if (funding < -0.02) {
      crowding = 'short_crowded';
      crowdingNote = `펀딩비 ${funding.toFixed(4)}% — 숏 우세`;
      longConf += 5; shortConf -= 3;
    } else {
      crowdingNote = `펀딩비 ${funding >= 0 ? '+' : ''}${funding.toFixed(4)}% — 균형`;
    }
  }

  longConf = clamp(longConf, 10, 90);
  shortConf = clamp(shortConf, 10, 90);
  // 합이 100이 되도록 정규화 (5v5 축과 형식 통일)
  const total = longConf + shortConf;
  longConf = (longConf / total) * 100;
  shortConf = 100 - longConf;

  // 신뢰도가 낮으면 중립 쪽으로 수축 — 데이터 없이 확신하지 않는다
  const conf = reliability / 100;
  longConf = 50 + (longConf - 50) * conf;
  shortConf = 100 - longConf;

  const meta = PATTERN_META[pattern];
  return {
    pattern, patternLabel: meta.label, patternMeaning: meta.meaning,
    longConfirmation: longConf, shortConfirmation: shortConf,
    crowding, crowdingNote, reliability, notes,
  };
}

// 캐시 (같은 심볼 반복 조회 방지)
const cache = new Map<string, { snap: DerivativesSnapshot; at: number }>();
const TTL = 60_000;

export async function getDerivatives(
  symbol: string,
  exchange: 'binance' | 'gate' = 'binance',
  testnet = false
): Promise<DerivativesSnapshot> {
  const key = `${exchange}:${symbol}:${testnet}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.snap;

  const snap = exchange === 'gate'
    ? await fetchGateDerivatives(symbol, testnet)
    : await fetchBinanceDerivatives(symbol, testnet);

  cache.set(key, { snap, at: Date.now() });
  return snap;
}
