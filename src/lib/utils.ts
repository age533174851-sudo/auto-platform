import { CURRENCIES, I18N } from './constants';

export function cvt(p: number, cur = 'KRW'): string {
  if (!Number.isFinite(p) || p == null) p = 0;
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
  const v = p * c.rate;
  if (v >= 1e9) return c.symbol + (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6) return c.symbol + (v/1e6).toFixed(2) + 'M';
  if (v >= 1e3) return c.symbol + v.toFixed(2);
  if (v >= 1)   return c.symbol + v.toFixed(3);
  if (v >= 0.01) return c.symbol + v.toFixed(5);
  if (v > 0)    return c.symbol + v.toFixed(8);  // micro-price
  return c.symbol + '0';
}

export const fmt = (n: number, d = 0): string =>
  Number(n).toLocaleString('ko-KR', {minimumFractionDigits:d, maximumFractionDigits:d});

export const fmtPct = (n: number): string =>
  (n >= 0 ? '+' : '') + Math.abs(n).toFixed(2) + '%';

export const clamp = (v: number, a: number, b: number): number =>
  Math.min(b, Math.max(a, v));

export const tr = (lang: string, key: string): string =>
  I18N[lang]?.[key] ?? I18N.ko[key] ?? key;

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
