// src/lib/engine/paperRunner.ts
//
// 모의 자동매매 한 사이클의 **판정** — 순수 함수.
//
// 왜 따로 만드는가 (daily-ladder가 이미 있는데)
// ────────────────────────────────────────────
// daily-ladder는 `ladder_cycles`·`ladder_daily_trades`(마이그레이션 017)를
// 쓴다. 그게 적용되기 전에는 아예 못 돈다. 데모는 **지금 바로** 돌아야
// 하므로 010(paper_positions·paper_accounts)만 있으면 되는 경로를 따로 둔다.
//
// 그리고 데모에는 daily-ladder에 없는 것이 하나 더 필요하다: **청산**.
// 모의 포지션은 지금 손으로 닫지 않으면 영원히 열려 있다. 손절·익절이
// 자동으로 걸리지 않는 연습은 실전과 다른 것을 연습하는 것이다.
//
// 진입 규칙은 단순하고 **명시적**이다
// ──────────────────────────────────
// 여기서 정교한 알파를 만들지 않는다. 만들 수 없고, 만들었다고 말해서도
// 안 된다. 이 파일이 하는 일은 "규칙을 정해 두고 그대로 지키는 기계"를
// 돌려 보는 것이다 — 그 규칙에 우위가 있는지는 백테스트가 답할 질문이다.

export interface PaperBar {
  close: number;
}

export interface OpenPaperPos {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  fillPrice: number;
  quantity: number;
  stopLoss: number | null;
  takeProfit: number | null;
  liquidationPrice: number | null;
  openedAt: number;
}

export interface RunnerConfig {
  /** 한 번에 걸 위험(가용 잔고 대비 %) */
  riskPctPerTrade: number;
  /** 손절 폭(%) */
  stopPct: number;
  /** 익절 폭(%). 0이면 익절을 걸지 않는다 */
  takeProfitPct: number;
  leverage: number;
  /** 동시에 열어 둘 수 있는 포지션 수 */
  maxOpenPositions: number;
  /** 최대 보유 시간(시간). 지나면 시간 청산 */
  maxHoldHours: number;
}

export const DEFAULT_RUNNER: RunnerConfig = {
  riskPctPerTrade: 1,
  stopPct: 2,
  takeProfitPct: 4,
  leverage: 5,
  maxOpenPositions: 1,
  maxHoldHours: 72,
};

export type RunnerActionKind = 'OPEN' | 'CLOSE' | 'NONE';

export interface RunnerAction {
  kind: RunnerActionKind;
  reason: string;
  /** OPEN */
  side?: 'LONG' | 'SHORT';
  quantity?: number;
  stopPrice?: number;
  takeProfit?: number;
  /** CLOSE */
  positionId?: string;
  exitReason?: 'SL' | 'TP' | 'LIQUIDATION' | 'MAX_HOLD';
}

/**
 * 열린 포지션들을 지금 가격으로 점검한다.
 *
 * **청산이 진입보다 먼저다.** 자리를 비워야 새로 들어갈 수 있고, 무엇보다
 * 손절은 미룰 수 없다.
 *
 * 순서도 중요하다: 청산가 → 손절 → 익절. 같은 봉 안에서 셋이 다 닿았다면
 * 가장 나쁜 것이 먼저 일어났다고 본다 — 모의가 실전보다 유리하게 나오면
 * 그 성적표는 쓸모가 없다.
 */
export function planExits(
  positions: OpenPaperPos[] | null | undefined,
  markPrice: number | null,
  nowMs: number,
  cfg: RunnerConfig = DEFAULT_RUNNER,
): RunnerAction[] {
  if (!Array.isArray(positions) || positions.length === 0) return [];
  if (markPrice == null || !Number.isFinite(markPrice) || markPrice <= 0) {
    // 가격을 모르면 아무것도 닫지 않는다. 추측한 가격으로 닫으면 그 손익이
    // 장부에 남고, 그 뒤의 모든 수치가 그 위에 쌓인다.
    return [];
  }

  const out: RunnerAction[] = [];
  for (const p of positions) {
    const long = p.side === 'LONG';

    // 1) 청산 — 가장 나쁜 것부터
    if (p.liquidationPrice != null && p.liquidationPrice > 0
        && (long ? markPrice <= p.liquidationPrice : markPrice >= p.liquidationPrice)) {
      out.push({ kind: 'CLOSE', positionId: p.id, exitReason: 'LIQUIDATION',
        reason: `청산가 ${p.liquidationPrice} 도달 (현재 ${markPrice})` });
      continue;
    }

    // 2) 손절
    if (p.stopLoss != null && p.stopLoss > 0
        && (long ? markPrice <= p.stopLoss : markPrice >= p.stopLoss)) {
      out.push({ kind: 'CLOSE', positionId: p.id, exitReason: 'SL',
        reason: `손절 ${p.stopLoss} 도달 (현재 ${markPrice})` });
      continue;
    }

    // 3) 익절
    if (p.takeProfit != null && p.takeProfit > 0
        && (long ? markPrice >= p.takeProfit : markPrice <= p.takeProfit)) {
      out.push({ kind: 'CLOSE', positionId: p.id, exitReason: 'TP',
        reason: `익절 ${p.takeProfit} 도달 (현재 ${markPrice})` });
      continue;
    }

    // 4) 시간 청산
    const heldMs = nowMs - p.openedAt;
    if (Number.isFinite(heldMs) && heldMs >= cfg.maxHoldHours * 3_600_000) {
      out.push({ kind: 'CLOSE', positionId: p.id, exitReason: 'MAX_HOLD',
        reason: `최대 보유 ${cfg.maxHoldHours}시간 초과` });
    }
  }
  return out;
}

export interface EntryInput {
  symbol: string;
  /** 국면 판정 결과. 'ok'가 아니면 진입하지 않는다 */
  regimeStatus: 'ok' | 'blocked' | 'unknown';
  regimeReason: string;
  /** 국면이 알려준 추세 방향 */
  trend: 'uptrend' | 'downtrend' | 'sideways' | null;
  markPrice: number | null;
  /** 진입에 쓸 수 있는 가상 잔고 */
  availableUsd: number | null;
  openCount: number;
  cfg?: Partial<RunnerConfig>;
}

/**
 * 지금 새로 들어갈 것인가.
 *
 * 규칙은 하나다: **추세 방향으로만 들어간다.** 상승 추세면 롱, 하락 추세면
 * 숏, 횡보면 들어가지 않는다.
 *
 * 이 규칙이 돈을 번다고 말하지 않는다. 정해진 규칙을 그대로 지키는지
 * 보려는 것이고, 우위가 있는지는 백테스트가 답할 질문이다.
 */
export function planEntry(i: EntryInput): RunnerAction {
  const cfg: RunnerConfig = { ...DEFAULT_RUNNER, ...(i.cfg ?? {}) };

  if (i.openCount >= cfg.maxOpenPositions) {
    return { kind: 'NONE', reason: `이미 ${i.openCount}개 열려 있습니다 (최대 ${cfg.maxOpenPositions})` };
  }
  if (i.regimeStatus !== 'ok') {
    return { kind: 'NONE', reason: i.regimeReason || '국면 판정이 진입을 허용하지 않습니다' };
  }
  if (!i.trend || i.trend === 'sideways') {
    return { kind: 'NONE', reason: '횡보장 — 추세 방향이 없어 진입하지 않습니다' };
  }
  const price = Number(i.markPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { kind: 'NONE', reason: '시세를 확인하지 못해 진입하지 않습니다' };
  }
  const avail = i.availableUsd;
  if (avail == null || !Number.isFinite(Number(avail)) || Number(avail) <= 0) {
    return { kind: 'NONE', reason: '가용 잔고를 확인하지 못했습니다 — 충전이 필요할 수 있습니다' };
  }

  const side: 'LONG' | 'SHORT' = i.trend === 'uptrend' ? 'LONG' : 'SHORT';

  // 수량: 걸 위험 금액 ÷ 손절까지의 거리.
  //
  // 배율로 곱해 최대치를 잡지 않는다. "잔고 × 배율"로 크기를 정하면 손절이
  // 얼마나 먼지와 무관하게 같은 수량이 나오고, 그건 위험을 정한 것이 아니다.
  const riskUsd = Number(avail) * (cfg.riskPctPerTrade / 100);
  const stopDist = price * (cfg.stopPct / 100);
  if (stopDist <= 0) return { kind: 'NONE', reason: '손절 폭이 0입니다' };
  let qty = riskUsd / stopDist;

  // 증거금 상한도 지킨다. 위험 기준 수량이 잔고로 감당 못 할 만큼 크면 줄인다.
  const maxQtyByMargin = (Number(avail) * cfg.leverage) / price;
  if (qty > maxQtyByMargin) qty = maxQtyByMargin;

  qty = Number(qty.toFixed(6));
  if (!(qty > 0)) {
    return { kind: 'NONE', reason: `잔고가 작아 주문 수량이 0입니다 (가용 ${Number(avail).toFixed(2)})` };
  }

  const stopPrice = side === 'LONG'
    ? price * (1 - cfg.stopPct / 100)
    : price * (1 + cfg.stopPct / 100);
  const takeProfit = cfg.takeProfitPct > 0
    ? (side === 'LONG'
        ? price * (1 + cfg.takeProfitPct / 100)
        : price * (1 - cfg.takeProfitPct / 100))
    : undefined;

  return {
    kind: 'OPEN', side, quantity: qty,
    stopPrice: Number(stopPrice.toFixed(6)),
    takeProfit: takeProfit != null ? Number(takeProfit.toFixed(6)) : undefined,
    reason: `${i.trend === 'uptrend' ? '상승' : '하락'} 추세 — ${side} 진입 `
          + `(위험 ${cfg.riskPctPerTrade}% · 손절 ${cfg.stopPct}%)`,
  };
}

/** 환경변수에서 데모 설정을 읽는다 */
export function readRunnerConfig(env: (k: string) => string | undefined): RunnerConfig {
  const num = (k: string, fallback: number): number => {
    const raw = env(k);
    if (raw == null || String(raw).trim() === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    riskPctPerTrade: num('PAPER_RISK_PCT', DEFAULT_RUNNER.riskPctPerTrade),
    stopPct: num('PAPER_STOP_PCT', DEFAULT_RUNNER.stopPct),
    takeProfitPct: num('PAPER_TP_PCT', DEFAULT_RUNNER.takeProfitPct),
    leverage: num('PAPER_LEVERAGE', DEFAULT_RUNNER.leverage),
    maxOpenPositions: num('PAPER_MAX_POSITIONS', DEFAULT_RUNNER.maxOpenPositions),
    maxHoldHours: num('PAPER_MAX_HOLD_HOURS', DEFAULT_RUNNER.maxHoldHours),
  };
}
