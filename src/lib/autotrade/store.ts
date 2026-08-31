// src/lib/autotrade/store.ts
// 실행 로그 + 모의 잔고 (paper 모드용) localStorage

import type { ExecutionLog } from './types';
import { mayMutatePracticeLedger, practiceBlocked } from './practiceEnv';
import type { TradeEnv } from './practiceEnv';

// **이 파일은 브라우저 로컬 연습 장부다. 정본 모의 장부가 아니다.**
//
// 정본 모의(PAPER)는 서버에 있다 — `paper_accounts` · `paper_positions`,
// 단위는 USDT. 여기 있는 것은 원화(KRW) 연습 장부이고, 통화도 체결 방식도
// 다르다. **두 장부의 잔고·손익을 합치지 않는다.**
//
// 그리고 **TESTNET·LIVE는 여기에 적지 않는다.** 예전에는 적었고, 그래서
// 한 장부에 세 환경이 섞였다(`practiceEnv.ts`의 머리말 참조). 이제 잔고를
// 바꾸는 함수는 전부 환경을 받고, MOCK이 아니면 **아무것도 하지 않는다.**
//
// ─── 이 장부에는 자동 손절·익절이 없다 ───────────────────────
//
// 예전에는 `checkPaperExits()`가 있었다. 브라우저가 현재가 맵을 받아
// 연습 포지션의 SL/TP·본절·트레일링을 직접 판정하는 함수였다. **부르는
// 곳이 없었다.** 그런데 화면에는 SL/TP를 입력하는 자리가 남아 있었고,
// 그 값은 여기 저장까지 됐다 — 아무도 보지 않는 값이었다. 사용자가
// 손절선을 적어 두고 잠들면, 아침에 손절되지 않은 포지션을 본다.
//
// 그래서 판정기와 그 값을 담던 칸을 **둘 다** 걷어냈다. 연습 포지션은
// 사용자가 화면에서 직접 닫는다. 자동 청산이 필요한 것은 정본 PAPER이고,
// 그것은 서버가 한다(`/api/paper/exit-monitor` · Worker).
//
// 되살리지 않는다. 되살리려면 "탭을 닫아도 도는 실행자"부터 있어야 한다.

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
  stratId?: string;
  // slPrice·tpPrice·tp1Price·tp1Done·highWater는 없다. 그 값을 읽어
  // 청산할 실행자가 이 장부에는 없기 때문이다. 위 머리말 참조.
}
interface PaperBalance {
  krw:       number;
  positions: Record<string, PaperPosition>;
  totalPnL:  number;
  /**
   * 저장된 값을 **읽지 못했다**는 표시.
   *
   * 키가 없는 것(처음 쓰는 사용자)과 읽기가 깨진 것은 다르다. 둘 다
   * 종잣돈 1000만원으로 그리면, 사흘 돌린 모의 성과가 사라진 자리에
   * 멀쩡해 보이는 초기 잔고가 뜬다 — 그리고 사용자는 그게 조회 실패였다는
   * 것을 영영 모른다. 화면이 구분할 수 있게 사실만 붙여 둔다.
   */
  readFailed?: boolean;
}

const DEFAULT_BALANCE: PaperBalance = {
  krw:       10_000_000,    // 시작 자금 1000만원
  positions: {},
  totalPnL:  0,
};

/**
 * 저장된 연습 장부를 읽는다.
 *
 * **키도 값도 바꾸지 않는다.** `tg_paper_balance_v1`은 그대로 두고,
 * 예전 포지션에 붙어 있던 `slPrice`·`tpPrice` 같은 칸도 지우지 않는다 —
 * `parsed.positions`를 그대로 넘긴다. 지금 코드가 안 읽을 뿐이다.
 * 읽는 코드가 없어진 것을 사용자의 저장 데이터를 지울 이유로 삼지 않는다.
 */
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
  } catch {
    // 파싱이 깨졌다. 값은 기본값으로 두되 **깨졌다는 사실을 지우지 않는다.**
    return { ...DEFAULT_BALANCE, readFailed: true };
  }
}

/**
 * 잔고를 실제로 쓴다. **환경을 받는다.**
 *
 * 환경을 인자로 강제하는 이유는 호출하는 쪽이 "지금 어느 환경인가"를
 * 반드시 답하게 하기 위해서다. 기본값을 MOCK으로 두면 안 적은 자리가
 * 곧 실전을 연습 장부에 적는 자리가 된다.
 */
export function savePaperBalance(env: TradeEnv | 'UNKNOWN', b: PaperBalance): void {
  if (!mayMutatePracticeLedger(env)) return;
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(PAPER_BAL_KEY, JSON.stringify(b)); } catch {}
}

export function resetPaperBalance(env: TradeEnv | 'UNKNOWN'): void {
  if (!mayMutatePracticeLedger(env)) return;
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(PAPER_BAL_KEY, JSON.stringify(DEFAULT_BALANCE)); } catch {}
}

// 모의 체결 — 진입 (롱/숏 모두)
/**
 * 연습 장부 진입.
 *
 * **손절·익절 비율은 받지 않는다.** 예전에는 받아서 `slPrice`·`tpPrice`로
 * 적었는데, 그 값을 보고 청산하는 실행자가 없었다. 받아서 적기만 하면
 * 화면은 "손절이 걸렸다"고 말하고 장부는 아무것도 하지 않는다.
 */
export function paperBuy(
  env: TradeEnv | 'UNKNOWN',
  asset: string,
  price: number,
  amountKRW: number,
  opts?: { stratId?: string; side?: 'long' | 'short' },
): { ok: boolean; qty?: number; reason?: string; blocked?: true } {
  if (!mayMutatePracticeLedger(env)) return practiceBlocked(env);
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
  b.positions[asset] = { qty: newQty, avgPrice: newAvg, side, stratId: opts?.stratId ?? base.stratId };
  savePaperBalance(env, b);
  return { ok: true, qty };
}

// 모의 체결 — 매도
export function paperSell(
  env: TradeEnv | 'UNKNOWN',
  asset: string,
  price: number,
  amountKRW: number,
): { ok: boolean; qty?: number; reason?: string; pnl?: number; blocked?: true } {
  if (!mayMutatePracticeLedger(env)) return practiceBlocked(env);
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
  savePaperBalance(env, b);
  return { ok: true, qty: qtyToSell, pnl };
}

// 현재 보유 포지션 목록
export function getOpenPositions(): Array<{ asset: string } & PaperPosition> {
  const b = loadPaperBalance();
  return Object.entries(b.positions).map(([asset, pos]) => ({ asset, ...pos }));
}

// ─── 포지션 청산 (수동 매매용) ────────────────────────────────
export function closePaperPosition(
  env: TradeEnv | 'UNKNOWN',
  asset: string,
  currentPrice: number,
  ratio = 1,
): { ok: boolean; pnl: number; reason?: string; blocked?: true } {
  // **거래소 청산이 끝난 뒤 여기를 부르지 않는다.** 예전에는 모드와 무관하게
  // 불렀고, 그래서 TESTNET·LIVE 청산이 연습 장부의 손익으로 쌓였다.
  if (!mayMutatePracticeLedger(env)) return { ...practiceBlocked(env), pnl: 0 };
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
  recordDailyPnL(env, pnl);
  if (r >= 0.999) { delete b.positions[asset]; }
  else { b.positions[asset] = { ...pos, qty: pos.qty - closeQty }; }
  savePaperBalance(env, b);
  return { ok: true, pnl };
}

export function reversePaperPosition(
  env: TradeEnv | 'UNKNOWN',
  asset: string,
  currentPrice: number,
): { ok: boolean; pnl: number; closedValue: number; newSide?: 'long'|'short'; blocked?: true; reason?: string } {
  if (!mayMutatePracticeLedger(env)) return { ...practiceBlocked(env), pnl: 0, closedValue: 0 };
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
  recordDailyPnL(env, pnl);

  // 3) 반대방향 신규 포지션 (같은 수량, 현재가 진입)
  b.positions[asset] = {
    qty,
    avgPrice: currentPrice,
    side: newSide,
    stratId: 'reverse',
  };
  savePaperBalance(env, b);
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
/**
 * 연습 장부의 **실현손익 누계**. 이것도 장부다.
 *
 * 잔고·포지션만 막고 여기를 열어 두면, 실전 손익이 연습 성과로 남는다.
 * 화면은 "오늘 얼마 벌었나"를 이 값으로 읽는다 — 잔고보다 눈에 먼저 띄는
 * 숫자다. 그래서 같은 계약을 건다: **환경을 먼저 받고 MOCK에서만 쓴다.**
 *
 * `window.localStorage`로 통일했다. 예전에는 맨 `localStorage`를 썼는데,
 * 그러면 창이 없는 곳에서 예외가 나고 `catch`가 삼켜 **아무 일도 안 한 것과
 * 실패한 것이 같은 모양**이 됐다.
 */
export function recordDailyPnL(env: TradeEnv | 'UNKNOWN', pnl: number) {
  if (!mayMutatePracticeLedger(env)) return;
  if (typeof window === 'undefined') return;
  const today = new Date().toDateString();
  try {
    const dayKey = window.localStorage.getItem(DAY_PNL_DATE_KEY) || '';
    let dayPnL = dayKey === today ? +(window.localStorage.getItem(DAY_PNL_KEY) || '0') : 0;
    dayPnL += pnl;
    window.localStorage.setItem(DAY_PNL_DATE_KEY, today);
    window.localStorage.setItem(DAY_PNL_KEY, String(dayPnL));
  } catch {}
}

// ─── 급락 서킷브레이커 ────────────────────────────────
const CIRCUIT_KEY = 'tg_circuit_breaker';
/** 연습 장부의 실현손익 누계 — 잔고·포지션과 같은 장부다 */
const DAY_PNL_KEY = 'tg_day_pnl';
const DAY_PNL_DATE_KEY = 'tg_day_pnl_date';
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
