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
  side?: 'long' | 'short';  // 방향 (롱/숏)
  slPrice?: number;
  tpPrice?: number;
  stratId?: string;
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

// 모의 체결 — 진입 (롱/숏 모두)
export function paperBuy(
  asset: string,
  price: number,
  amountKRW: number,
  opts?: { stopLossPct?: number; takeProfitPct?: number; stratId?: string; side?: 'long' | 'short' },
): { ok: boolean; qty?: number; reason?: string } {
  const b = loadPaperBalance();
  if (b.krw < amountKRW) {
    return { ok: false, reason: `잔고 부족 (보유 ${Math.floor(b.krw).toLocaleString('ko-KR')}원, 필요 ${amountKRW.toLocaleString('ko-KR')}원)` };
  }
  if (price <= 0) return { ok: false, reason: '잘못된 가격' };

  const side = opts?.side ?? 'long';
  const qty = amountKRW / price;
  const pos = b.positions[asset];
  const base = (pos && pos.side === side) ? pos : { qty: 0, avgPrice: 0, side } as PaperPosition;
  const newQty = base.qty + qty;
  const newAvg = (base.qty * base.avgPrice + qty * price) / newQty;

  b.krw -= amountKRW;
  const slPct = opts?.stopLossPct;
  const tpPct = opts?.takeProfitPct;
  const slPrice = slPct && slPct > 0 ? (side === 'short' ? newAvg * (1 + slPct/100) : newAvg * (1 - slPct/100)) : base.slPrice;
  const tpPrice = tpPct && tpPct > 0 ? (side === 'short' ? newAvg * (1 - tpPct/100) : newAvg * (1 + tpPct/100)) : base.tpPrice;
  b.positions[asset] = { qty: newQty, avgPrice: newAvg, side, slPrice, tpPrice, stratId: opts?.stratId ?? base.stratId };
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
  asset: string; reason: 'take_profit' | 'stop_loss' | 'trailing_stop';
  price: number; pnl: number; qty: number; stratId?: string;
}

export function checkPaperExits(priceMap: Record<string, number>): ExitEvent[] {
  const b = loadPaperBalance();
  const exits: ExitEvent[] = [];
  let mutated = false;
  for (const [asset, pos] of Object.entries(b.positions)) {
    if (!pos || pos.qty <= 0) continue;
    const cur = priceMap[asset] ?? priceMap[asset.toUpperCase()];
    if (!cur || cur <= 0) continue;

    const gainPct = ((cur - pos.avgPrice) / pos.avgPrice) * 100;

    // ── 손익 보호: 고점 추적 + 본절 + 트레일링 ──
    const hw = (pos as any).highWater || pos.avgPrice;
    if (cur > hw) { (b.positions[asset] as any).highWater = cur; mutated = true; }
    // +3% → 손절가를 본전으로 (리스크 프리)
    if (gainPct >= 3 && (!pos.slPrice || pos.slPrice < pos.avgPrice)) {
      b.positions[asset].slPrice = pos.avgPrice; mutated = true;
    }
    // +10% 이상 → 트레일링 스탑 (고점 -5%)
    const curHw = (b.positions[asset] as any).highWater || cur;
    if (gainPct >= 10) {
      const trailStop = curHw * 0.95;
      if (!pos.slPrice || pos.slPrice < trailStop) { b.positions[asset].slPrice = trailStop; mutated = true; }
    }

    const p2 = b.positions[asset];
    let hit: 'take_profit' | 'stop_loss' | 'trailing_stop' | null = null;
    if (p2.tpPrice && cur >= p2.tpPrice) hit = 'take_profit';
    else if (p2.slPrice && cur <= p2.slPrice) hit = gainPct > 0 ? 'trailing_stop' : 'stop_loss';
    if (!hit) continue;

    const proceeds = p2.qty * cur;
    const cost     = p2.qty * p2.avgPrice;
    const pnl      = proceeds - cost;
    b.krw += proceeds;
    b.totalPnL += pnl;
    recordDailyPnL(pnl);
    exits.push({ asset, reason: hit as any, price: cur, pnl, qty: p2.qty, stratId: p2.stratId });
    delete b.positions[asset];
    mutated = true;
  }
  if (mutated || exits.length > 0) savePaperBalance(b);
  return exits;
}

// 현재 보유 포지션 목록 (SL/TP 포함)
export function getOpenPositions(): Array<{ asset: string } & PaperPosition> {
  const b = loadPaperBalance();
  return Object.entries(b.positions).map(([asset, pos]) => ({ asset, ...pos }));
}

// ─── 포지션 청산 (수동 매매용) ────────────────────────────────
export function closePaperPosition(asset: string, currentPrice: number, ratio = 1): { ok: boolean; pnl: number; reason?: string } {
  const b = loadPaperBalance();
  const pos = b.positions[asset];
  if (!pos || pos.qty <= 0) return { ok: false, pnl: 0, reason: '포지션 없음' };
  if (currentPrice <= 0) return { ok: false, pnl: 0, reason: '가격 오류' };
  const r = Math.max(0.01, Math.min(1, ratio));
  const closeQty = pos.qty * r;
  const proceeds = closeQty * currentPrice;
  const cost = closeQty * pos.avgPrice;
  const pnl = proceeds - cost;
  b.krw += proceeds;
  b.totalPnL += pnl;
  recordDailyPnL(pnl);
  if (r >= 0.999) { delete b.positions[asset]; }
  else { b.positions[asset] = { ...pos, qty: pos.qty - closeQty }; }
  savePaperBalance(b);
  return { ok: true, pnl };
}

export function reversePaperPosition(asset: string, currentPrice: number): { ok: boolean; pnl: number; closedValue: number; newSide?: 'long'|'short' } {
  const b = loadPaperBalance();
  const pos = b.positions[asset];
  if (!pos || pos.qty <= 0) return { ok: false, pnl: 0, closedValue: 0 };
  if (currentPrice <= 0) return { ok: false, pnl: 0, closedValue: 0 };

  const oldSide = pos.side === 'short' ? 'short' : 'long';
  const newSide = oldSide === 'short' ? 'long' : 'short';
  const qty = pos.qty;
  const avgPrice = pos.avgPrice;

  // 1) 기존 포지션 청산 PnL (방향 반영)
  const rawPnl = (currentPrice - avgPrice) * qty;
  const pnl = oldSide === 'short' ? -rawPnl : rawPnl;
  const closedValue = qty * currentPrice;

  // 2) 잔고: 청산금 회수 + PnL 반영, 그리고 반대방향 같은 수량 재진입(증거금 차감)
  b.krw += pnl;            // 실현손익만 반영 (증거금은 그대로 재사용)
  b.totalPnL += pnl;
  recordDailyPnL(pnl);

  // 3) 반대방향 신규 포지션 (같은 수량, 현재가 진입)
  b.positions[asset] = {
    qty,
    avgPrice: currentPrice,
    side: newSide,
    stratId: 'reverse',
  };
  savePaperBalance(b);
  return { ok: true, pnl, closedValue, newSide };
}

// ─── 포트폴리오 전체 리스크 제한 ────────────────────────────────
export interface RiskLimits {
  maxDailyLossPct: number;    // 하루 최대 손실 % (시드 대비)
  maxPositions: number;       // 동시 보유 포지션 수
  maxExposurePct: number;     // 총 노출 한도 % (시드 대비)
}
export const DEFAULT_RISK_LIMITS: RiskLimits = { maxDailyLossPct: 5, maxPositions: 5, maxExposurePct: 80 };

export function getRiskLimits(): RiskLimits {
  try { const r = localStorage.getItem('tg_risk_limits'); return r ? { ...DEFAULT_RISK_LIMITS, ...JSON.parse(r) } : DEFAULT_RISK_LIMITS; }
  catch { return DEFAULT_RISK_LIMITS; }
}
export function saveRiskLimits(l: RiskLimits) {
  try { localStorage.setItem('tg_risk_limits', JSON.stringify(l)); } catch {}
}

// 신규 진입 가능 여부 (전체 리스크 기준)
export function canOpenNewPosition(seed = 10_000_000): { allowed: boolean; reason?: string } {
  const b = loadPaperBalance();
  const limits = getRiskLimits();
  const positions = Object.entries(b.positions).filter(([, p]) => p && p.qty > 0);

  // 1. 동시 포지션 수
  if (positions.length >= limits.maxPositions) {
    return { allowed: false, reason: `동시 포지션 한도 도달 (${positions.length}/${limits.maxPositions})` };
  }
  // 2. 총 노출 한도
  const exposure = positions.reduce((s, [, p]) => s + p.qty * p.avgPrice, 0);
  if (exposure >= seed * (limits.maxExposurePct / 100)) {
    return { allowed: false, reason: `총 노출 한도 도달 (${Math.round(exposure / seed * 100)}% / ${limits.maxExposurePct}%)` };
  }
  // 3. 하루 최대 손실 (오늘 실현손실)
  const today = new Date().toDateString();
  let dayKey = '';
  try { dayKey = localStorage.getItem('tg_day_pnl_date') || ''; } catch {}
  let dayPnL = 0;
  try { dayPnL = +(localStorage.getItem('tg_day_pnl') || '0'); } catch {}
  if (dayKey === today && dayPnL < -seed * (limits.maxDailyLossPct / 100)) {
    return { allowed: false, reason: `하루 최대 손실 한도 도달 (${limits.maxDailyLossPct}%) — 내일까지 신규 진입 중단` };
  }
  // 4. 급락 서킷브레이커
  const circuit = getCircuitState();
  if (circuit.tripped) {
    return { allowed: false, reason: circuit.reason };
  }
  return { allowed: true };
}

// 일일 손익 기록 (청산 시 호출)
export function recordDailyPnL(pnl: number) {
  const today = new Date().toDateString();
  try {
    const dayKey = localStorage.getItem('tg_day_pnl_date') || '';
    let dayPnL = dayKey === today ? +(localStorage.getItem('tg_day_pnl') || '0') : 0;
    dayPnL += pnl;
    localStorage.setItem('tg_day_pnl_date', today);
    localStorage.setItem('tg_day_pnl', String(dayPnL));
  } catch {}
}

// ─── 급락 서킷브레이커 ────────────────────────────────
const CIRCUIT_KEY = 'tg_circuit_breaker';
export interface CircuitState { tripped: boolean; reason: string; until: number; }

export function checkCircuitBreaker(asset: string, changePct1h: number): CircuitState {
  const threshold = asset.toUpperCase().includes('BTC') ? -5 : -7;
  if (changePct1h <= threshold) {
    const state: CircuitState = {
      tripped: true,
      reason: `${asset} 1시간 ${changePct1h.toFixed(1)}% 급락 — 신규 진입 30분 중단`,
      until: Date.now() + 30 * 60 * 1000,
    };
    try { localStorage.setItem(CIRCUIT_KEY, JSON.stringify(state)); } catch {}
    return state;
  }
  return getCircuitState();
}

export function getCircuitState(): CircuitState {
  try {
    const r = localStorage.getItem(CIRCUIT_KEY);
    if (r) { const s: CircuitState = JSON.parse(r); if (s.until > Date.now()) return s; }
  } catch {}
  return { tripped: false, reason: '', until: 0 };
}
