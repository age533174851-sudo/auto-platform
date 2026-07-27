import { CURRENCIES, I18N } from './constants';
import { getUsdKrw } from './currency';

export function cvt(p: number | null | undefined, cur = 'KRW'): string {
  // 유효하지 않은 값은 '—'로 표시 (0인 척하면 사용자 혼란)
  if (p == null || !Number.isFinite(Number(p))) return '—';
  p = Number(p);
  const c = CURRENCIES[cur] ?? CURRENCIES.KRW;
  if (cur === 'KRW') {
    if (p >= 1e12) return '₩' + (p/1e12).toFixed(1) + '조';
    if (p >= 1e8)  return '₩' + (p/1e8).toFixed(1) + '억';
    if (p >= 1e4)  return '₩' + Math.round(p).toLocaleString('ko-KR');
    if (p >= 1)    return '₩' + p.toFixed(2);
    if (p >= 0.01) return '₩' + p.toFixed(4);
    if (p > 0)     return '₩' + p.toFixed(8);   // SHIB, PEPE 등 극소가격
    return '₩0';
  }
  // 비-KRW: 실시간/캐시 환율 사용 (하드코딩 rate 대신). p는 KRW base 가정.
  let rate = c.rate;
  if (cur === 'USD') { const live = getUsdKrw(); if (live > 0) rate = 1 / live; }
  const v = p * rate;
  if (v >= 1e9) return c.symbol + (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6) return c.symbol + (v/1e6).toFixed(2) + 'M';
  if (v >= 1e3) return c.symbol + v.toFixed(2);
  if (v >= 1)   return c.symbol + v.toFixed(3);
  if (v >= 0.01) return c.symbol + v.toFixed(5);
  if (v > 0)    return c.symbol + v.toFixed(8);  // micro-price
  return c.symbol + '0';
}

export const fmt = (n: number | null | undefined, d = 0): string => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const fmtPct = (n: number | null | undefined): string => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + Math.abs(v).toFixed(2) + '%';
};

// "—" 대신 다른 placeholder가 필요할 때
export const fmtSafe = (n: number | null | undefined, fallback = '—', d = 0): string => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const fmtPctSafe = (n: number | null | undefined, fallback = '—'): string => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return (v >= 0 ? '+' : '') + Math.abs(v).toFixed(2) + '%';
};

export const clamp = (v: number, a: number, b: number): number =>
  Math.min(b, Math.max(a, v));

// 다국어 번역 헬퍼
// 우선순위: 선택 언어 → English → Korean → key 그대로
// zh-CN/zh-TW 같은 지역 코드는 정확 매칭 후 'zh' 기본형 시도
export const tr = (lang: string, key: string): string => {
  if (!key) return '';
  const direct = I18N[lang]?.[key];
  if (direct) return direct;
  // 지역코드 → 기본 코드 (zh-CN → zh)
  if (lang.includes('-')) {
    const base = lang.split('-')[0];
    const baseHit = I18N[base]?.[key];
    if (baseHit) return baseHit;
  }
  return I18N.en?.[key] ?? I18N.ko?.[key] ?? key;
};

export const gS = (k: string, fb: string): string => {
  if (typeof window === 'undefined') return fb;
  try { return localStorage.getItem(k) ?? fb; } catch { return fb; }
};

export const sS = (k: string, v: string): void => {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(k, v); } catch {}
};

export const uid = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2);
