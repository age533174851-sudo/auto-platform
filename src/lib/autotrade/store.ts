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
interface PaperPosition {
  qty: number;
  avgPrice: number;
  slPrice?: number;       // 손절 가격
  tpPrice?: number;       // 익절 가격
  stratId?: string;       // 어느 전략이 진입했는지
}
interface PaperBalance {
  krw:       number;
  positions: Record<string, PaperPosition>;
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
  opts?: { stopLossPct?: number; takeProfitPct?: number; stratId?: string },
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
  const slPct = opts?.stopLossPct;
  const tpPct = opts?.takeProfitPct;
  b.positions[asset] = {
    qty: newQty, avgPrice: newAvg,
    slPrice: slPct && slPct > 0 ? newAvg * (1 - slPct / 100) : pos.slPrice,
    tpPrice: tpPct && tpPct > 0 ? newAvg * (1 + tpPct / 100) : pos.tpPrice,
    stratId: opts?.stratId ?? pos.stratId,
  };
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

// ─── SL/TP 자동청산 감시 ──────────────────────────────────────
// 현재가 맵을 받아 손절/익절 도달한 포지션을 청산. 청산된 내역 반환.
export interface ExitEvent {
  asset: string; reason: 'take_profit' | 'stop_loss';
  price: number; pnl: number; qty: number; stratId?: string;
}

export function checkPaperExits(priceMap: Record<string, number>): ExitEvent[] {
  const b = loadPaperBalance();
  const exits: ExitEvent[] = [];
  for (const [asset, pos] of Object.entries(b.positions)) {
    if (!pos || pos.qty <= 0) continue;
    const cur = priceMap[asset] ?? priceMap[asset.toUpperCase()];
    if (!cur || cur <= 0) continue;

    let hit: 'take_profit' | 'stop_loss' | null = null;
    if (pos.tpPrice && cur >= pos.tpPrice) hit = 'take_profit';
    else if (pos.slPrice && cur <= pos.slPrice) hit = 'stop_loss';
    if (!hit) continue;

    // 전량 청산
    const proceeds = pos.qty * cur;
    const cost     = pos.qty * pos.avgPrice;
    const pnl      = proceeds - cost;
    b.krw += proceeds;
    b.totalPnL += pnl;
    exits.push({ asset, reason: hit, price: cur, pnl, qty: pos.qty, stratId: pos.stratId });
    delete b.positions[asset];
  }
  if (exits.length > 0) savePaperBalance(b);
  return exits;
}

// 현재 보유 포지션 목록 (SL/TP 포함)
export function getOpenPositions(): Array<{ asset: string } & PaperPosition> {
  const b = loadPaperBalance();
  return Object.entries(b.positions).map(([asset, pos]) => ({ asset, ...pos }));
}
