// src/lib/currency.ts
// 통합 통화 포매터 — 값의 base 통화를 display 통화로 실시간 환율로 변환.
// 실시간 환율 실패 → 마지막 캐시 → 그래도 없으면 기본값(1 USD = 1375 KRW).
// 핵심: 숫자를 실제로 환산하고, 잘못된 "₩421.45"(달러값에 ₩만) 표시를 방지.

const FALLBACK_USDKRW = 1375;
const RATE_KEY = 'tg_fx_usdkrw_v1';
const RATE_TS_KEY = 'tg_fx_usdkrw_ts_v1';
const SYMBOL: Record<string, string> = { KRW: '₩', USD: '$', JPY: '¥', EUR: '€', GBP: '£' };

let memRate = 0; // 메모리 캐시 (1 USD = ? KRW)

// 캐시된 USD→KRW 환율 로드
export function getUsdKrw(): number {
  if (memRate > 0) return memRate;
  if (typeof window !== 'undefined') {
    try {
      const c = Number(window.localStorage.getItem(RATE_KEY));
      if (c > 0) { memRate = c; return c; }
    } catch {}
  }
  return FALLBACK_USDKRW;
}

// 실시간 환율 갱신 (앱 로드 시 1회 + 주기적). 실패해도 조용히 캐시/폴백 유지.
export async function refreshUsdKrw(): Promise<number> {
  // 12시간 이내 캐시면 skip
  try {
    if (typeof window !== 'undefined') {
      const ts = Number(window.localStorage.getItem(RATE_TS_KEY));
      if (ts && Date.now() - ts < 12 * 3600 * 1000 && getUsdKrw() > 0) return getUsdKrw();
    }
  } catch {}
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      const krw = d?.rates?.KRW;
      if (krw && krw > 500 && krw < 3000) {   // sanity 범위
        memRate = krw;
        try { window.localStorage.setItem(RATE_KEY, String(krw)); window.localStorage.setItem(RATE_TS_KEY, String(Date.now())); } catch {}
        return krw;
      }
    }
  } catch {}
  return getUsdKrw(); // 실패 → 캐시/폴백
}

// base 통화 → display 통화 환산 계수
function factor(base: string, display: string): number {
  if (base === display) return 1;
  const usdkrw = getUsdKrw();
  // 모든 변환을 KRW 축으로
  const toKrw = base === 'KRW' ? 1 : base === 'USD' ? usdkrw : usdkrw; // 그 외는 USD로 간주
  const fromKrw = display === 'KRW' ? 1 : display === 'USD' ? 1 / usdkrw : 1 / usdkrw;
  return toKrw * fromKrw;
}

/**
 * 통합 통화 포매터.
 * @param value  숫자
 * @param display 표시 통화 (KRW/USD 등)
 * @param base   값의 원래 통화 (기본 KRW). 미국주식 등 USD 데이터는 'USD' 전달.
 */
export function formatMoney(value: number | null | undefined, display = 'KRW', base = 'KRW'): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const v = Number(value) * factor(base, display);
  const sym = SYMBOL[display] || '';
  if (display === 'KRW') {
    if (Math.abs(v) >= 1e12) return sym + (v / 1e12).toFixed(1) + '조';
    if (Math.abs(v) >= 1e8)  return sym + (v / 1e8).toFixed(1) + '억';
    if (Math.abs(v) >= 1e4)  return sym + Math.round(v).toLocaleString('ko-KR');
    if (Math.abs(v) >= 1)    return sym + v.toFixed(0);
    if (Math.abs(v) >= 0.01) return sym + v.toFixed(2);
    if (v !== 0)             return sym + v.toFixed(6);
    return sym + '0';
  }
  if (Math.abs(v) >= 1e9) return sym + (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return sym + (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return sym + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1)   return sym + v.toFixed(2);
  if (Math.abs(v) >= 0.01) return sym + v.toFixed(4);
  if (v !== 0)            return sym + v.toFixed(8);
  return sym + '0';
}
