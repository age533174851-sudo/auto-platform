// src/lib/autotrade/store.ts
// 실행 로그 + 모의 잔고 (paper 모드용) localStorage

import type { ExecutionLog } from './types';

const LOG_KEY      = 'tg_autotrade_logs_v1';
const PAPER_BAL_KEY = 'tg_paper_balance_v1';
const RUN_STATE_KEY = 'tg_autotrade_state_v1';   // 마지막 평가 시각 (전략 ID별)

const MAX_LOGS = 200;

// ─── 실행 로그 ────────────────────────────────────────────
export function loadLogs(): ExecutionLog[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveLog(log: ExecutionLog): void {
  if (typeof window === 'undefined') return;
  try {
    const cur = loadLogs();
    const next = [log, ...cur].slice(0, MAX_LOGS);
    window.localStorage.setItem(LOG_KEY, JSON.stringify(next));
  } catch {}
}

export function clearLogs(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(LOG_KEY); } catch {}
}

// ─── 평가 상태 ────────────────────────────────────────────
// 같은 전략을 너무 자주 평가하지 않도록 마지막 평가 시각 저장
export function getLastEvaluatedAt(strategyId: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(RUN_STATE_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw);
    return typeof map?.[strategyId] === 'number' ? map[strategyId] : 0;
  } catch { return 0; }
}

export function setLastEvaluatedAt(strategyId: string, at: number): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(RUN_STATE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[strategyId] = at;
    window.localStorage.setItem(RUN_STATE_KEY, JSON.stringify(map));
  } catch {}
}

// ─── 모의 잔고 (paper 모드) ───────────────────────────────
interface PaperBalance {
  krw:       number;
  positions: Record<string, { qty: number; avgPrice: number }>;
  totalPnL:  number;
}

const DEFAULT_BALANCE: PaperBalance = {
  krw:       10_000_000,    // 시작 자금 1000만원
  positions: {},
  totalPnL:  0,
};

export function loadPaperBalance(): PaperBalance {
  if (typeof window === 'undefined') return { ...DEFAULT_BALANCE };
  try {
    const raw = window.localStorage.getItem(PAPER_BAL_KEY);
    if (!raw) return { ...DEFAULT_BALANCE };
    const parsed = JSON.parse(raw);
    return {
      krw:       typeof parsed.krw === 'number' ? parsed.krw : DEFAULT_BALANCE.krw,
      positions: parsed.positions && typeof parsed.positions === 'object' ? parsed.positions : {},
      totalPnL:  typeof parsed.totalPnL === 'number' ? parsed.totalPnL : 0,
    };
  } catch { return { ...DEFAULT_BALANCE }; }
}

export function savePaperBalance(b: PaperBalance): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(PAPER_BAL_KEY, JSON.stringify(b)); } catch {}
}

export function resetPaperBalance(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(PAPER_BAL_KEY, JSON.stringify(DEFAULT_BALANCE)); } catch {}
}

// 모의 체결 — 매수
export function paperBuy(
  asset: string,
  price: number,
  amountKRW: number,
): { ok: boolean; qty?: number; reason?: string } {
  const b = loadPaperBalance();
  if (b.krw < amountKRW) {
    return { ok: false, reason: `잔고 부족 (보유 ${Math.floor(b.krw).toLocaleString('ko-KR')}원, 필요 ${amountKRW.toLocaleString('ko-KR')}원)` };
  }
  if (price <= 0) return { ok: false, reason: '잘못된 가격' };

  const qty = amountKRW / price;
  const pos = b.positions[asset] || { qty: 0, avgPrice: 0 };
  const newQty = pos.qty + qty;
  const newAvg = (pos.qty * pos.avgPrice + qty * price) / newQty;

  b.krw -= amountKRW;
  b.positions[asset] = { qty: newQty, avgPrice: newAvg };
  savePaperBalance(b);
  return { ok: true, qty };
}

// 모의 체결 — 매도
export function paperSell(
  asset: string,
  price: number,
  amountKRW: number,
): { ok: boolean; qty?: number; reason?: string; pnl?: number } {
  const b = loadPaperBalance();
  const pos = b.positions[asset];
  if (!pos || pos.qty <= 0) return { ok: false, reason: `${asset} 보유 없음` };
  if (price <= 0) return { ok: false, reason: '잘못된 가격' };

  const qtyToSell = Math.min(amountKRW / price, pos.qty);
  const proceeds = qtyToSell * price;
  const cost     = qtyToSell * pos.avgPrice;
  const pnl      = proceeds - cost;

  b.krw += proceeds;
  pos.qty -= qtyToSell;
  if (pos.qty < 0.000001) delete b.positions[asset];
  else b.positions[asset] = pos;
  b.totalPnL += pnl;
  savePaperBalance(b);
  return { ok: true, qty: qtyToSell, pnl };
}
