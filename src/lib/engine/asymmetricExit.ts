// src/lib/engine/asymmetricExit.ts
// 비대칭 청산 엔진 — "손실은 고정, 이익은 열어둔다".
//
// 왜 필요한가:
//   레버리지를 올리면 손익이 같이 커지지만 청산 거리가 짧아져 오히려 불리해진다.
//   실측: 100배로 +5%를 노리면 도달확률 9%, 기대값 -45.5%.
//   진짜 비대칭은 배율이 아니라 청산 구조에서 나온다.
//     - 손절은 진입 시 고정하고 절대 넓히지 않는다
//     - 일부는 분할 익절로 확보한다
//     - 나머지는 트레일링으로 상단을 열어둔다 (익절 상한 없음)
//
// R = 손절 거리 1배. 손익을 R 배수로 관리하면 배율과 무관하게 비교할 수 있다.

export type ExitEvent = 'STOP' | 'PARTIAL_TP' | 'TRAIL_STOP' | 'TIME_EXIT' | 'LIQUIDATION';

export interface AsymmetricConfig {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;              // 고정 손절 — 절대 넓히지 않는다
  liquidationPrice?: number;
  quantity: number;
  // 분할 익절 사다리: R 배수 도달 시 몇 %를 청산할지
  partialLadder?: { atR: number; closePct: number }[];
  // 트레일링: 이 R 배수를 넘으면 트레일링 시작
  trailStartR?: number;
  trailDistanceR?: number;        // 최고점에서 이만큼 R 물러나면 청산
  breakEvenAtR?: number;          // 이 R 도달 시 손절을 본전으로 이동 (좁히기만)
  maxHoldBars?: number;
}

export interface PositionState {
  remainingQty: number;
  currentStop: number;            // 이동한 손절 (좁아지기만 함)
  highWaterR: number;             // 최고 도달 R
  realizedR: number;              // 확정된 R 합계
  partialsHit: number[];          // 이미 실행한 사다리 인덱스
  trailActive: boolean;
  closed: boolean;
}

export interface ExitAction {
  event: ExitEvent;
  price: number;
  closeQty: number;
  rMultiple: number;              // 이 청산의 R 배수
  note: string;
}

export function initPosition(cfg: AsymmetricConfig): PositionState {
  return {
    remainingQty: cfg.quantity,
    currentStop: cfg.stopPrice,
    highWaterR: 0,
    realizedR: 0,
    partialsHit: [],
    trailActive: false,
    closed: false,
  };
}

// 현재가 → R 배수 (손절 거리를 1R로)
export function toR(cfg: AsymmetricConfig, price: number): number {
  const riskDist = Math.abs(cfg.entryPrice - cfg.stopPrice);
  if (riskDist <= 0) return 0;
  const move = cfg.side === 'LONG' ? price - cfg.entryPrice : cfg.entryPrice - price;
  return move / riskDist;
}

export function rToPrice(cfg: AsymmetricConfig, r: number): number {
  const riskDist = Math.abs(cfg.entryPrice - cfg.stopPrice);
  return cfg.side === 'LONG'
    ? cfg.entryPrice + riskDist * r
    : cfg.entryPrice - riskDist * r;
}

const DEFAULT_LADDER = [
  { atR: 1.5, closePct: 30 },   // 1.5R에서 30% 확보
  { atR: 3.0, closePct: 30 },   // 3R에서 추가 30%
];
// 나머지 40%는 트레일링으로 상단을 열어둔다

/**
 * 캔들 하나를 처리한다. 여러 이벤트가 겹치면 보수적 순서로 판정한다:
 *   청산 > 손절 > 분할익절 > 트레일링
 */
export function processBar(
  cfg: AsymmetricConfig,
  state: PositionState,
  bar: { high: number; low: number; close: number },
  barIndex = 0
): { state: PositionState; actions: ExitAction[] } {
  const actions: ExitAction[] = [];
  if (state.closed || state.remainingQty <= 0) return { state, actions };

  const isLong = cfg.side === 'LONG';
  const s = { ...state, partialsHit: [...state.partialsHit] };
  const ladder = cfg.partialLadder ?? DEFAULT_LADDER;

  // ① 청산 (가장 치명적 — 먼저 확인)
  if (cfg.liquidationPrice != null) {
    const liqHit = isLong ? bar.low <= cfg.liquidationPrice : bar.high >= cfg.liquidationPrice;
    if (liqHit) {
      const r = toR(cfg, cfg.liquidationPrice);
      actions.push({ event: 'LIQUIDATION', price: cfg.liquidationPrice, closeQty: s.remainingQty, rMultiple: r,
        note: '청산 — 손절보다 먼저 도달했습니다. 배율이 너무 높습니다.' });
      s.realizedR += r * (s.remainingQty / cfg.quantity);
      s.remainingQty = 0; s.closed = true;
      return { state: s, actions };
    }
  }

  // ② 손절 (현재 손절 = 이동됐을 수 있음)
  const stopHit = isLong ? bar.low <= s.currentStop : bar.high >= s.currentStop;
  if (stopHit) {
    const r = toR(cfg, s.currentStop);
    const event: ExitEvent = s.trailActive || s.currentStop !== cfg.stopPrice ? 'TRAIL_STOP' : 'STOP';
    actions.push({ event, price: s.currentStop, closeQty: s.remainingQty, rMultiple: r,
      note: event === 'STOP' ? `고정 손절 -1R` : `트레일링 청산 ${r >= 0 ? '+' : ''}${r.toFixed(2)}R` });
    s.realizedR += r * (s.remainingQty / cfg.quantity);
    s.remainingQty = 0; s.closed = true;
    return { state: s, actions };
  }

  // ③ 유리한 방향 최고점 갱신
  const favorablePrice = isLong ? bar.high : bar.low;
  const barR = toR(cfg, favorablePrice);
  if (barR > s.highWaterR) s.highWaterR = barR;

  // ④ 본전 이동 (손절을 좁히기만 — 절대 넓히지 않는다)
  if (cfg.breakEvenAtR != null && s.highWaterR >= cfg.breakEvenAtR) {
    const be = cfg.entryPrice;
    const improves = isLong ? be > s.currentStop : be < s.currentStop;
    if (improves) {
      s.currentStop = be;
      actions.push({ event: 'PARTIAL_TP', price: be, closeQty: 0, rMultiple: 0,
        note: `${cfg.breakEvenAtR}R 도달 — 손절을 본전으로 이동` });
    }
  }

  // ⑤ 분할 익절 사다리
  for (let i = 0; i < ladder.length; i++) {
    if (s.partialsHit.includes(i)) continue;
    const step = ladder[i];
    if (s.highWaterR >= step.atR) {
      const targetPrice = rToPrice(cfg, step.atR);
      const qty = cfg.quantity * (step.closePct / 100);
      const closeQty = Math.min(qty, s.remainingQty);
      if (closeQty > 0) {
        actions.push({ event: 'PARTIAL_TP', price: targetPrice, closeQty, rMultiple: step.atR,
          note: `${step.atR}R 도달 — ${step.closePct}% 분할 익절 (수익 확보)` });
        s.realizedR += step.atR * (closeQty / cfg.quantity);
        s.remainingQty -= closeQty;
        s.partialsHit.push(i);
      }
    }
  }

  // ⑥ 트레일링 — 여기서 상단이 열린다 (익절 상한 없음)
  const trailStart = cfg.trailStartR ?? 2;
  const trailDist = cfg.trailDistanceR ?? 1;
  if (s.highWaterR >= trailStart) {
    if (!s.trailActive) {
      s.trailActive = true;
      actions.push({ event: 'PARTIAL_TP', price: bar.close, closeQty: 0, rMultiple: s.highWaterR,
        note: `${trailStart}R 돌파 — 트레일링 시작 (익절 상한 없음)` });
    }
    const trailR = s.highWaterR - trailDist;
    const trailPrice = rToPrice(cfg, trailR);
    const improves = isLong ? trailPrice > s.currentStop : trailPrice < s.currentStop;
    if (improves) s.currentStop = trailPrice;
  }

  // ⑦ 시간 청산
  if (cfg.maxHoldBars && barIndex >= cfg.maxHoldBars && s.remainingQty > 0) {
    const r = toR(cfg, bar.close);
    actions.push({ event: 'TIME_EXIT', price: bar.close, closeQty: s.remainingQty, rMultiple: r,
      note: `최대 보유시간 도달 — ${r >= 0 ? '+' : ''}${r.toFixed(2)}R 청산` });
    s.realizedR += r * (s.remainingQty / cfg.quantity);
    s.remainingQty = 0; s.closed = true;
  }

  if (s.remainingQty <= 0.00000001) s.closed = true;
  return { state: s, actions };
}

// ── 비대칭 구조 비교 ──
export interface PayoffComparison {
  label: string;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;      // 1회당 기대 R
  profitFactor: number;
  note: string;
}

/**
 * 고정 익절 vs 비대칭(트레일링) 기대값 비교.
 * 같은 승률이라도 상단을 열어두면 기대값이 달라진다.
 */
export function comparePayoff(winRate: number, fixedTpR: number, trailAvgWinR: number): PayoffComparison[] {
  const fixedEV = winRate * fixedTpR - (1 - winRate) * 1;
  // 트레일링은 승률이 다소 낮아진다(되돌림에 걸림) — 보수적으로 85% 적용
  const trailWinRate = winRate * 0.85;
  const trailEV = trailWinRate * trailAvgWinR - (1 - trailWinRate) * 1;

  return [
    {
      label: `고정 익절 ${fixedTpR}R`,
      winRate: winRate * 100, avgWinR: fixedTpR, avgLossR: 1,
      expectancyR: fixedEV,
      profitFactor: (winRate * fixedTpR) / ((1 - winRate) * 1),
      note: `이익 상한 ${fixedTpR}R로 고정 — 큰 추세를 놓친다`,
    },
    {
      label: `비대칭 (트레일링)`,
      winRate: trailWinRate * 100, avgWinR: trailAvgWinR, avgLossR: 1,
      expectancyR: trailEV,
      profitFactor: (trailWinRate * trailAvgWinR) / ((1 - trailWinRate) * 1),
      note: `승률은 낮아지지만 이익 상한이 없다`,
    },
  ];
}
