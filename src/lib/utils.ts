import { CURRENCIES, I18N } from './constants';

export function cvt(p: number, cur = 'KRW'): string {
  if (!Number.isFinite(p) || p == null) p = 0;
  const c = CURRENCIES[cur] ?? CURRENCIES.KRW;
  if (cur === 'KRW') {
    if (p >= 1e12) return '₩' + (p/1e12).toFixed(1) + '조';
    if (p >= 1e8)  return '₩' + (p/1e8).toFixed(1) + '억';
    if (p >= 1e4)  return '₩' + Math.round(p).toLocaleString('ko-KR');
    return '₩' + p.toFixed(2);
  }
  const v = p * c.rate;
  if (v >= 1e9) return c.symbol + (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6) return c.symbol + (v/1e6).toFixed(2) + 'M';
  if (v >= 1e3) return c.symbol + v.toFixed(2);
  if (v >= 1)   return c.symbol + v.toFixed(3);
  return c.symbol + v.toFixed(6);
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
