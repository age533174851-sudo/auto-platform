/**
 * src/lib/format.ts — Safe number formatting (never returns NaN/Infinity/undefined)
 */

/** Returns 0 if value is not a finite number */
export function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Safe percentage string: "±X.XX%" */
export function safePercent(value: unknown, decimals = 2): string {
  const n = safeNumber(value, 0);
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

/** Safe KRW price string: "₩1,234,567" */
export function formatKRW(value: unknown): string {
  const n = safeNumber(value, 0);
  if (n >= 1e12) return '₩' + (n / 1e12).toFixed(1) + '조';
  if (n >= 1e8)  return '₩' + (n / 1e8).toFixed(1)  + '억';
  if (n >= 1e4)  return '₩' + Math.round(n).toLocaleString('ko-KR');
  if (n >= 1)    return '₩' + n.toFixed(2);
  if (n > 0)     return '₩' + n.toFixed(8); // SHIB etc.
  return '₩0';
}

/** Safe price: auto-format KRW or USD */
export function formatPrice(value: unknown, currency = 'KRW', symbol = '₩'): string {
  const n = safeNumber(value, 0);
  if (n === 0) return symbol + '0';
  if (currency === 'KRW') return formatKRW(n);
  if (n >= 1e6) return symbol + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return symbol + n.toFixed(2);
  if (n >= 1)   return symbol + n.toFixed(3);
  return symbol + n.toFixed(8);
}

/** Safe volume: "1.2B", "345M", "12.3K" */
export function formatVolume(value: unknown): string {
  const n = safeNumber(value, 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

/** Replace NaN/Infinity with dash */
export function safeDisplay(value: unknown, fallback = '-'): string {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return String(value);
}


/** Safe date formatter — returns '방금 전' for invalid dates */
export function formatNewsDate(value: unknown): string {
  if (!value) return '방금 전';
  try {
    const d = new Date(value as any);
    if (!Number.isFinite(d.getTime())) return '방금 전';
    return d.toLocaleString('ko-KR', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '방금 전';
  }
}

/** Relative time: "5분 전", "2시간 전", "어제" */
export function formatRelativeTime(value: unknown): string {
  if (!value) return '방금 전';
  try {
    const d = new Date(value as any);
    const t = d.getTime();
    if (!Number.isFinite(t)) return '방금 전';
    const diffSec = Math.floor((Date.now() - t) / 1000);
    if (diffSec < 60)      return '방금 전';
    if (diffSec < 3600)    return Math.floor(diffSec / 60) + '분 전';
    if (diffSec < 86400)   return Math.floor(diffSec / 3600) + '시간 전';
    if (diffSec < 604800)  return Math.floor(diffSec / 86400) + '일 전';
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  } catch {
    return '방금 전';
  }
}

/* ── Standardized fallback helpers (item 18) ── */
export function safeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  try { return String(value); } catch { return fallback; }
}

export function safeArray<T>(value: unknown, fallback: T[] = []): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}
