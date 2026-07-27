// src/lib/derivatives/history.ts
// 펀딩비 · 미결제약정 히스토리 수집.
//
// 왜 필요한가:
//   5v5의 파생 축이 실시간 값만 쓸 수 있으면 백테스트에서는 계속 중립이다.
//   과거 데이터가 있어야 "파생 축을 켰을 때 엣지가 개선되는가"를 측정할 수 있다.
//
// 데이터 출처 (Binance 공개 엔드포인트, 서명 불필요):
//   펀딩비: /fapi/v1/fundingRate        — 8시간 간격, 최대 1000건/요청
//   OI    : /futures/data/openInterestHist — 최대 500건/요청, 최근 30일만 제공
//
// 주의: OI 히스토리는 Binance가 최근 30일치만 준다. 그 이전 구간은 채울 수 없다.
//       따라서 장기 백테스트에서는 OI 없이(펀딩만) 돌아가는 구간이 생긴다.
//       이 사실을 숨기지 않고 coverage로 표시한다.

export interface FundingPoint {
  t: number;          // ms
  rate: number;       // % (8시간당)
  markPrice?: number;
}

export interface OiPoint {
  t: number;          // ms
  oi: number;         // 계약 수량
  oiValue: number;    // USD
}

export interface DerivativesHistory {
  symbol: string;
  funding: FundingPoint[];
  oi: OiPoint[];
  fundingFrom: number | null;
  fundingTo: number | null;
  oiFrom: number | null;
  oiTo: number | null;
  fetchedAt: number;
  warnings: string[];
}

const BINANCE = 'https://fapi.binance.com';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 펀딩비 히스토리 — 페이지네이션으로 긴 기간을 채운다.
 * 8시간마다 1건이므로 1년 ≈ 1095건.
 */
export async function fetchFundingHistory(
  symbol: string,
  startTime: number,
  endTime: number = Date.now(),
  opts: { maxPages?: number; delayMs?: number } = {}
): Promise<{ points: FundingPoint[]; warnings: string[] }> {
  const sym = symbol.toUpperCase().replace('/', '').replace('_', '');
  const maxPages = opts.maxPages ?? 20;      // 20 × 1000 = 20,000건 ≈ 18년
  const delay = opts.delayMs ?? 250;          // 레이트리밋 배려
  const out: FundingPoint[] = [];
  const warnings: string[] = [];

  let cursor = startTime;
  for (let page = 0; page < maxPages; page++) {
    const url = `${BINANCE}/fapi/v1/fundingRate?symbol=${sym}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
      if (!r.ok) {
        warnings.push(`펀딩비 조회 실패 (HTTP ${r.status}) — ${out.length}건까지만 수집`);
        break;
      }
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        out.push({
          t: Number(row.fundingTime),
          rate: parseFloat(row.fundingRate) * 100,
          markPrice: row.markPrice != null ? parseFloat(row.markPrice) : undefined,
        });
      }

      const last = Number(rows[rows.length - 1].fundingTime);
      if (rows.length < 1000 || last >= endTime) break;
      cursor = last + 1;
      if (delay) await sleep(delay);
    } catch (e: any) {
      warnings.push(`펀딩비 수집 중단: ${e?.message || e}`);
      break;
    }
  }

  // 중복 제거 + 정렬
  const seen = new Set<number>();
  const dedup = out.filter(p => { if (seen.has(p.t)) return false; seen.add(p.t); return true; })
                   .sort((a, b) => a.t - b.t);
  return { points: dedup, warnings };
}

/**
 * OI 히스토리 — Binance는 최근 30일치만 제공한다.
 * period: 5m|15m|30m|1h|2h|4h|6h|12h|1d
 */
export async function fetchOiHistory(
  symbol: string,
  period: '1h' | '4h' | '1d' = '1d',
  limit = 500
): Promise<{ points: OiPoint[]; warnings: string[] }> {
  const sym = symbol.toUpperCase().replace('/', '').replace('_', '');
  const warnings: string[] = [];
  try {
    const url = `${BINANCE}/futures/data/openInterestHist?symbol=${sym}&period=${period}&limit=${Math.min(limit, 500)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
    if (!r.ok) return { points: [], warnings: [`OI 조회 실패 (HTTP ${r.status})`] };
    const rows = await r.json();
    if (!Array.isArray(rows)) return { points: [], warnings: ['OI 응답 형식 오류'] };

    const points: OiPoint[] = rows.map((row: any) => ({
      t: Number(row.timestamp),
      oi: parseFloat(row.sumOpenInterest),
      oiValue: parseFloat(row.sumOpenInterestValue),
    })).filter(p => isFinite(p.t) && isFinite(p.oi)).sort((a, b) => a.t - b.t);

    if (points.length) {
      const days = (points[points.length - 1].t - points[0].t) / 86400000;
      if (days < 25) warnings.push(`OI 히스토리 ${days.toFixed(0)}일치만 제공됨 (Binance 제약: 최근 30일)`);
    }
    return { points, warnings };
  } catch (e: any) {
    return { points: [], warnings: [`OI 수집 실패: ${e?.message || e}`] };
  }
}

export async function fetchDerivativesHistory(
  symbol: string,
  startTime: number,
  endTime: number = Date.now()
): Promise<DerivativesHistory> {
  const [f, o] = await Promise.all([
    fetchFundingHistory(symbol, startTime, endTime),
    fetchOiHistory(symbol, '1d', 500),
  ]);

  const warnings = [...f.warnings, ...o.warnings];
  if (f.points.length === 0) warnings.push('펀딩비 데이터를 전혀 받지 못했습니다');

  return {
    symbol: symbol.toUpperCase(),
    funding: f.points,
    oi: o.points,
    fundingFrom: f.points[0]?.t ?? null,
    fundingTo: f.points[f.points.length - 1]?.t ?? null,
    oiFrom: o.points[0]?.t ?? null,
    oiTo: o.points[o.points.length - 1]?.t ?? null,
    fetchedAt: Date.now(),
    warnings,
  };
}

// ── 백테스트용 일자별 조회 인덱스 ──────────────────────

export interface DailyDerivatives {
  fundingRate: number | null;      // 그날의 평균 펀딩비 (%)
  oiChangePct: number | null;      // 전일 대비 OI 변화율 (%)
  coverage: 'full' | 'funding_only' | 'none';
}

/**
 * 히스토리를 일자 인덱스로 변환한다.
 * 백테스트가 각 일봉마다 O(1)로 조회할 수 있게 한다.
 */
export function buildDailyIndex(hist: DerivativesHistory): Map<string, DailyDerivatives> {
  const idx = new Map<string, DailyDerivatives>();
  const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

  // 펀딩: 하루 3건(8시간마다)을 평균
  const fundingByDay = new Map<string, number[]>();
  for (const p of hist.funding) {
    const k = dayKey(p.t);
    if (!fundingByDay.has(k)) fundingByDay.set(k, []);
    fundingByDay.get(k)!.push(p.rate);
  }

  // OI: 전일 대비 변화율
  const oiByDay = new Map<string, number>();
  for (const p of hist.oi) oiByDay.set(dayKey(p.t), p.oi);
  const oiDays = [...oiByDay.keys()].sort();
  const oiChangeByDay = new Map<string, number>();
  for (let i = 1; i < oiDays.length; i++) {
    const prev = oiByDay.get(oiDays[i - 1])!;
    const cur = oiByDay.get(oiDays[i])!;
    if (prev > 0) oiChangeByDay.set(oiDays[i], ((cur - prev) / prev) * 100);
  }

  const allDays = new Set([...fundingByDay.keys(), ...oiChangeByDay.keys()]);
  for (const d of allDays) {
    const rates = fundingByDay.get(d);
    const fundingRate = rates && rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
    const oiChangePct = oiChangeByDay.get(d) ?? null;
    const coverage: DailyDerivatives['coverage'] =
      fundingRate != null && oiChangePct != null ? 'full'
      : fundingRate != null ? 'funding_only'
      : 'none';
    idx.set(d, { fundingRate, oiChangePct, coverage });
  }
  return idx;
}

// 커버리지 요약 — 백테스트 결과 해석에 필요
export interface CoverageReport {
  totalDays: number;
  fullDays: number;
  fundingOnlyDays: number;
  noneDays: number;
  fullPct: number;
  note: string;
}

export function coverageReport(idx: Map<string, DailyDerivatives>, backtestDays: number): CoverageReport {
  let full = 0, fundingOnly = 0;
  for (const v of idx.values()) {
    if (v.coverage === 'full') full++;
    else if (v.coverage === 'funding_only') fundingOnly++;
  }
  const none = Math.max(0, backtestDays - full - fundingOnly);
  const fullPct = backtestDays > 0 ? (full / backtestDays) * 100 : 0;

  const note = fullPct >= 80
    ? '파생 데이터 커버리지 충분 — 파생 축이 정상 작동합니다'
    : fullPct >= 20
      ? `전체 기간의 ${fullPct.toFixed(0)}%만 OI 데이터가 있습니다. 나머지 구간은 펀딩비만으로 판단하므로 파생 축의 판별력이 낮아집니다.`
      : `OI 데이터가 ${fullPct.toFixed(0)}%뿐입니다 (Binance는 최근 30일만 제공). 장기 백테스트에서 파생 축은 사실상 펀딩비 전용입니다.`;

  return { totalDays: backtestDays, fullDays: full, fundingOnlyDays: fundingOnly, noneDays: none, fullPct, note };
}
