// src/lib/autotrade/chandelier.ts
// Chandelier Exit — 손절선이 최고가를 따라 올라가는 ATR 트레일링.
// 고정 +5% 익절은 +30/80/120% 추세를 놓친다 → 챈들리어는 추세가 꺾일 때까지 보유.
// 롱: stop = 진입 후 최고가 − ATR × mult
// 숏: stop = 진입 후 최저가 + ATR × mult
import { computeATR } from './dynamicSizing';

export interface ChandelierState {
  highWater: number;    // 진입 후 최고가 (숏이면 최저가)
  stop: number;         // 현재 트레일링 손절선
}

export function initChandelier(entryPrice: number): ChandelierState {
  return { highWater: entryPrice, stop: 0 };
}

// 새 가격이 올 때마다 호출 → 상태 갱신 + 청산 여부
export function updateChandelier(
  state: ChandelierState,
  price: number,
  atr: number,
  opts: { mult?: number; side?: 'long' | 'short' } = {}
): { state: ChandelierState; exit: boolean; stop: number } {
  const mult = opts.mult ?? 3;
  const side = opts.side ?? 'long';
  let hw = state.highWater;
  if (side === 'long') {
    if (price > hw) hw = price;                       // 최고가 갱신 → 손절선 상승
    const stop = hw - atr * mult;                     // 손절선은 절대 내려가지 않음
    const newStop = Math.max(state.stop, stop);
    return { state: { highWater: hw, stop: newStop }, exit: price <= newStop && newStop > 0, stop: newStop };
  } else {
    if (price < hw) hw = price;
    const stop = hw + atr * mult;
    const newStop = state.stop > 0 ? Math.min(state.stop, stop) : stop;
    return { state: { highWater: hw, stop: newStop }, exit: price >= newStop && newStop > 0, stop: newStop };
  }
}

// ── 비교 시뮬레이터: 고정 익절 vs Chandelier ──────────────────
export interface ExitCompareResult {
  fixedExitPct: number;      // 고정 +N% 익절의 결과
  chandelierExitPct: number; // 챈들리어 결과
  chandelierExitIndex: number;
  peakPct: number;           // 기간 중 최고 수익
  captured: number;          // 챈들리어가 최고 수익 중 몇 %를 먹었나
  advantage: number;         // 챈들리어 − 고정 (%p)
  stops: number[];           // 시각화용 손절선 궤적
}

export function compareExits(
  prices: number[],
  opts: { fixedTpPct?: number; atrMult?: number; atrPeriod?: number } = {}
): ExitCompareResult {
  const fixedTp = opts.fixedTpPct ?? 5;
  const mult = opts.atrMult ?? 3;
  const period = opts.atrPeriod ?? 14;
  const entry = prices[0];

  // 고정 익절: +fixedTp% 도달 즉시 청산 (도달 못하면 마지막 가격)
  let fixedExitPct = ((prices[prices.length - 1] - entry) / entry) * 100;
  for (const p of prices) {
    const pct = ((p - entry) / entry) * 100;
    if (pct >= fixedTp) { fixedExitPct = pct; break; }
  }

  // Chandelier: 최고가-ATR×mult 손절선이 닿을 때 청산
  let st = initChandelier(entry);
  let chandelierExitPct = ((prices[prices.length - 1] - entry) / entry) * 100;
  let chandelierExitIndex = prices.length - 1;
  const stops: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const atr = computeATR(prices.slice(Math.max(0, i - period), i + 1), period);
    const r = updateChandelier(st, prices[i], atr, { mult });
    st = r.state;
    stops.push(r.stop);
    if (r.exit) {
      chandelierExitPct = ((r.stop - entry) / entry) * 100;   // 손절선 체결 가정
      chandelierExitIndex = i;
      break;
    }
  }

  const peak = Math.max(...prices);
  const peakPct = ((peak - entry) / entry) * 100;
  const captured = peakPct > 0 ? (chandelierExitPct / peakPct) * 100 : 0;
  return { fixedExitPct, chandelierExitPct, chandelierExitIndex, peakPct, captured, advantage: chandelierExitPct - fixedExitPct, stops };
}
