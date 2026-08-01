// src/lib/engine/exitRules.ts
//
// **언제 어떤 가격에 나가는가** — 데모와 백테스트가 함께 쓰는 하나의 규칙.
//
// 왜 하나로 합치는가
// ──────────────────
// 지금까지 둘이 달랐다. 데모(paperRunner)는 손절·익절·청산가·보유시간을
// 다 보는데, 백테스트(backtest/engine)는 **넷 다 없었다.** 전략 신호로만
// 사고팔았다.
//
// 그 차이는 한 방향으로만 작동한다: 백테스트에는 손절로 끝나는 거래도,
// 청산으로 날아가는 거래도 없다. 그래서 **백테스트가 항상 더 좋게 나온다.**
// 그리고 그 성적표가 전략 점수(strategyScore) → 자금 배분(allocation)으로
// 흘러 실제 돈의 크기를 정한다. 검증되지 않은 낙관이 자금을 받는다.
//
// 백테스트가 실전보다 유리하면 그 백테스트는 없는 것보다 나쁘다. 없으면
// 모른다는 것을 알지만, 있으면 안다고 믿기 때문이다.
//
// 봉 안에서 무슨 일이 먼저 일어났는가
// ───────────────────────────────────
// OHLC만으로는 고가와 저가 중 **무엇이 먼저였는지 알 수 없다.** 손절과
// 익절이 같은 봉에서 둘 다 닿았을 때, 어느 쪽을 골랐느냐로 성적이 통째로
// 달라진다.
//
// 그래서 **나쁜 쪽을 고른다.** 청산 → 손절 → 익절 → 보유시간 순이다.
// 모르는 것을 유리하게 읽으면 그 성적표는 검증이 아니라 희망이다.

/**
 * 손절·익절·보유시간의 **기본값 한 벌.**
 *
 * 데모(DEFAULT_RUNNER)와 백테스트가 이것을 함께 쓴다. 두 곳에 따로 적으면
 * 한쪽만 바뀌고, 그때 두 성적표는 다른 기계의 성적이 된다.
 */
export const DEFAULT_EXIT = {
  stopPct: 2,
  takeProfitPct: 4,
  maxHoldHours: 72,
} as const;

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ExitPos {
  side: 'LONG' | 'SHORT';
  /** 진입가 */
  entry: number;
  /** 손절가. 없으면 손절이 없다 */
  stop?: number | null;
  /** 익절가. 없으면 익절이 없다 */
  takeProfit?: number | null;
  /** 청산가. 없으면 청산 판정을 하지 않는다 */
  liquidation?: number | null;
  /** 진입 시각(ms) */
  openedAt: number;
}

export type ExitReason = 'LIQUIDATION' | 'SL' | 'TP' | 'MAX_HOLD';

export interface ExitHit {
  reason: ExitReason;
  /** 실제로 체결됐다고 보는 가격 */
  price: number;
  /** 화면·기록에 그대로 쓴다 */
  note: string;
  /** 봉이 그 값을 **뛰어넘어** 열렸다 — 걸어 둔 가격에 못 받았다는 뜻 */
  gapped: boolean;
}

export interface ExitRuleConfig {
  /** 최대 보유 시간(시간). 0이면 시간 청산을 하지 않는다 */
  maxHoldHours: number;
}

const pos = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 이 봉에서 나가는가.
 *
 * 나가지 않으면 null.
 *
 * **진입한 봉에 이 함수를 쓰면 안 된다.** 그 봉의 저가는 진입 *전에* 찍힌
 * 것일 수 있어서, 들어가자마자 손절당한 것으로 계산된다. 부르는 쪽이
 * 다음 봉부터 넘겨야 한다.
 */
export function exitOnBar(
  p: ExitPos,
  bar: Bar,
  cfg: ExitRuleConfig,
): ExitHit | null {
  if (!bar || !Number.isFinite(bar.h) || !Number.isFinite(bar.l)) return null;
  const long = p.side !== 'SHORT';
  const open = Number(bar.o);

  const liq = pos(p.liquidation);
  const stop = pos(p.stop);
  const tp = pos(p.takeProfit);

  // ── 1) 청산 ────────────────────────────────────────────────
  // 가장 나쁜 것이 먼저다. 청산은 손절보다 뒤에 있는 가격이므로, 봉이
  // 거기까지 갔다면 손절도 지나쳐 갔다는 뜻이다. 그래도 순서상 청산을
  // 먼저 보는 이유는 **손절이 실제로 안 걸렸을 수 있기 때문**이다
  // (거래소가 주문을 못 받았거나, 갭으로 건너뛰었거나).
  if (liq != null && (long ? bar.l <= liq : bar.h >= liq)) {
    return fill('LIQUIDATION', liq, `청산가 ${liq} 도달`, long, open, true);
  }

  // ── 2) 손절 ────────────────────────────────────────────────
  if (stop != null && (long ? bar.l <= stop : bar.h >= stop)) {
    return fill('SL', stop, `손절 ${stop} 도달`, long, open, true);
  }

  // ── 3) 익절 ────────────────────────────────────────────────
  //
  // **걸어 둔 가격보다 좋게 받았다고 치지 않는다.** 갭이 유리하게 벌어지면
  // 실제로는 더 좋은 값에 체결되지만, 그 이득을 계산에 넣기 시작하면
  // 백테스트가 실전보다 좋아지는 방향으로만 어긋난다.
  if (tp != null && (long ? bar.h >= tp : bar.l <= tp)) {
    return { reason: 'TP', price: tp, note: `익절 ${tp} 도달`, gapped: false };
  }

  // ── 4) 보유 시간 ───────────────────────────────────────────
  if (cfg.maxHoldHours > 0) {
    const held = bar.t - p.openedAt;
    if (Number.isFinite(held) && held >= cfg.maxHoldHours * 3_600_000) {
      // 시간 청산은 시장가다 — 종가로 나간다
      return {
        reason: 'MAX_HOLD', price: bar.c,
        note: `최대 보유 ${cfg.maxHoldHours}시간 초과`, gapped: false,
      };
    }
  }

  return null;
}

/**
 * 걸어 둔 가격에 받았는가, 아니면 봉이 그것을 뛰어넘어 열렸는가.
 *
 * 갭은 **손절에서 가장 비싸다.** 밤사이 -8%로 열리면 -2% 손절은 -2%가
 * 아니라 -8%다. 손절가에 받았다고 계산하는 백테스트는 그 손실을 통째로
 * 지워 버린다 — 실제로 계좌를 없애는 것이 정확히 그 차이다.
 */
function fill(
  reason: ExitReason, level: number, note: string,
  long: boolean, open: number, adverse: boolean,
): ExitHit {
  if (!adverse || !Number.isFinite(open)) {
    return { reason, price: level, note, gapped: false };
  }
  // 롱: 시가가 손절보다 아래면 그 시가에 체결된다 (더 나쁘다)
  const gapped = long ? open < level : open > level;
  return {
    reason,
    price: gapped ? open : level,
    note: gapped
      ? `${note} — 시가 ${open}로 갭, 걸어 둔 가격에 못 받았습니다`
      : note,
    gapped,
  };
}

/**
 * 지금 시세 하나만 아는 경우(실시간 데모).
 *
 * 봉이 없으므로 시가=고가=저가=종가인 봉으로 만들어 **같은 함수**에 넘긴다.
 * 규칙을 두 벌 쓰지 않기 위해서다 — 데모와 백테스트가 다른 답을 내면
 * 어느 쪽이 맞는지 알 방법이 없다.
 */
export function exitOnMark(
  p: ExitPos, markPrice: number | null, nowMs: number, cfg: ExitRuleConfig,
): ExitHit | null {
  const m = Number(markPrice);
  // 가격을 모르면 아무것도 닫지 않는다. 추측한 가격으로 닫으면 그 손익이
  // 장부에 남고, 그 뒤의 모든 수치가 그 위에 쌓인다.
  if (!Number.isFinite(m) || m <= 0) return null;
  return exitOnBar(p, { t: nowMs, o: m, h: m, l: m, c: m }, cfg);
}
