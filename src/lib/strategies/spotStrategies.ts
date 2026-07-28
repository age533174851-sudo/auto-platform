// src/lib/strategies/spotStrategies.ts
//
// 현물 전용 전략 10종.
//
// 이 파일의 첫 번째 규칙
// ──────────────────────
// **의도(SpotIntent)에 레버리지 필드가 없다.** `leverage: 1`이 아니라
// 필드가 존재하지 않는다. 필드가 있으면 언젠가 누가 채우고, 그러면
// 현물 전략이 빌린 돈으로 주문을 낸다.
//
// 두 번째 규칙: 전략을 믿지 않는다
// ────────────────────────────────
// 각 전략은 "얼마를 사고 싶다"만 말한다. 그 값이 예산을 넘는지, 보유를
// 넘는지는 **엔진이 자른다**(clampIntent). 전략 열 개가 각자 검사하면
// 그중 하나는 빠뜨린다. 한 곳에서 자르면 열 개 모두가 안전해진다.
//
// 세 번째 규칙: 모르면 아무것도 하지 않는다
// ─────────────────────────────────────────
// 가격을 못 받았거나 봉이 모자라면 HOLD다. 추정치로 주문을 내면
// 그 추정이 그대로 체결된다.

export interface SpotContext {
  symbol: string;
  /** 현재가. 못 받았으면 null */
  price: number | null;
  /** 일봉 종가, 오래된 것부터. 지표 계산용 */
  closes: number[];
  /** 지금 보유 수량 */
  heldQty: number;
  /** 평균 매수가. 보유가 없으면 null */
  avgPrice: number | null;
  /** 이 전략에 배정된 예산(USD) */
  budgetUsd: number;
  /** 이 전략이 이미 쓴 금액(USD) */
  usedUsd: number;
  /** 포트폴리오 전체 평가액(USD). 리밸런싱에만 쓴다. 모르면 null */
  portfolioValueUsd: number | null;
  /** 현재 시각(ms). 테스트에서 고정할 수 있게 인자로 받는다 */
  now: number;
  /** 이 전략이 마지막으로 매수한 시각. 없으면 null */
  lastBuyAt: number | null;
}

/**
 * 전략의 의도.
 * 레버리지·마진모드·reduceOnly가 **없다.** 현물에 없는 개념이다.
 */
export interface SpotIntent {
  action: 'BUY' | 'SELL' | 'HOLD';
  /** 매수 금액(USDT). BUY일 때만 */
  quoteUsd?: number;
  /** 매도 수량(코인). SELL일 때만 */
  qty?: number;
  reason: string;
}

const HOLD = (reason: string): SpotIntent => ({ action: 'HOLD', reason });

// ── 지표 ──────────────────────────────────────────────
// 작은 것들이라 여기 둔다. 백테스트 쪽 구현은 배열을 돌려주는데
// 여기서는 마지막 값 하나만 필요하다.

export function smaLast(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsiLast(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  const avgG = gain / period, avgL = loss / period;
  // 손실이 하나도 없으면 RS가 무한이다. 100으로 둔다.
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

// ── 엔진이 자르는 부분 ─────────────────────────────────

export interface ClampResult {
  intent: SpotIntent;
  /** 잘렸으면 그 사실을 남긴다. 조용히 줄이면 왜 적게 샀는지 모른다 */
  clamped: boolean;
  note?: string;
}

/**
 * 전략이 낸 의도를 예산과 보유 안으로 자른다.
 *
 * 전략 코드를 신뢰하지 않는 것이 요점이다. 열 개 중 하나가 계산을
 * 틀려도 여기서 막힌다.
 */
export function clampIntent(intent: SpotIntent, ctx: SpotContext): ClampResult {
  if (intent.action === 'HOLD') return { intent, clamped: false };

  if (intent.action === 'BUY') {
    const want = intent.quoteUsd ?? 0;
    const avail = Math.max(0, ctx.budgetUsd - ctx.usedUsd);
    if (want <= 0) {
      return { intent: HOLD('매수 금액이 0 이하입니다'), clamped: true };
    }
    if (avail <= 0) {
      return { intent: HOLD('이 전략의 예산을 모두 썼습니다'), clamped: true, note: '예산 소진' };
    }
    if (want > avail) {
      return {
        intent: { ...intent, quoteUsd: avail },
        clamped: true,
        note: `예산에 맞춰 ${want.toFixed(2)} → ${avail.toFixed(2)} USD로 줄였습니다`,
      };
    }
    return { intent, clamped: false };
  }

  // SELL — 현물에는 공매도가 없다. 보유를 넘길 수 없다.
  const want = intent.qty ?? 0;
  if (want <= 0) {
    return { intent: HOLD('매도 수량이 0 이하입니다'), clamped: true };
  }
  if (ctx.heldQty <= 0) {
    return { intent: HOLD('보유 수량이 없어 매도할 수 없습니다'), clamped: true };
  }
  if (want > ctx.heldQty) {
    return {
      intent: { ...intent, qty: ctx.heldQty },
      clamped: true,
      note: `보유 수량에 맞춰 ${want} → ${ctx.heldQty}로 줄였습니다 (현물에 공매도는 없습니다)`,
    };
  }
  return { intent, clamped: false };
}

// ── 전략 ───────────────────────────────────────────────

export type SpotStrategyId =
  | 'dca'            // 적립식 매수
  | 'dip-buy'        // 하락 시 분할매수
  | 'scale-out'      // 상승 시 분할매도
  | 'rebalance'      // 목표 비중 리밸런싱
  | 'ma-dca'         // 이동평균 적립
  | 'rsi-dip'        // RSI 분할매수
  | 'breakout'       // 돌파 매수
  | 'hodl'           // 장기 보유
  | 'grid'           // 현물 그리드
  | 'profit-recover';// 수익금 원금 회수

export interface SpotStrategyConfig {
  /** 1회 매수 금액(USD) */
  trancheUsd?: number;
  /** 며칠마다 (적립식) */
  intervalDays?: number;
  /** 하락/상승 판정 기준(%) */
  thresholdPct?: number;
  /** 이동평균·RSI·돌파 기간 */
  period?: number;
  /** RSI 매수 기준 */
  rsiBelow?: number;
  /** 매도 비율(%) */
  sellPct?: number;
  /** 목표 비중(%) — 리밸런싱 */
  targetWeightPct?: number;
  /** 리밸런싱 허용 오차(%) */
  driftPct?: number;
  /** 그리드 간격(%) */
  gridStepPct?: number;
  /** 원금 회수 기준 수익률(%) */
  recoverAtPct?: number;
}

const DEFAULTS: Required<Pick<SpotStrategyConfig,
  'trancheUsd' | 'intervalDays' | 'thresholdPct' | 'period' | 'rsiBelow' |
  'sellPct' | 'targetWeightPct' | 'driftPct' | 'gridStepPct' | 'recoverAtPct'>> = {
  trancheUsd: 100, intervalDays: 7, thresholdPct: 5, period: 20,
  rsiBelow: 30, sellPct: 25, targetWeightPct: 30, driftPct: 5,
  gridStepPct: 3, recoverAtPct: 100,
};

function cfg<K extends keyof typeof DEFAULTS>(c: SpotStrategyConfig, k: K): number {
  const v = c[k as keyof SpotStrategyConfig];
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[k];
}

const DAY_MS = 86_400_000;

/** 전략 하나를 돌린다. 반환값은 아직 잘리지 않은 '의도'다. */
export function runSpotStrategy(
  id: SpotStrategyId, ctx: SpotContext, config: SpotStrategyConfig = {},
): SpotIntent {
  // 가격을 모르면 어떤 전략도 판단할 수 없다. 추정치로 사지 않는다.
  if (ctx.price == null || !Number.isFinite(ctx.price) || ctx.price <= 0) {
    return HOLD('현재가를 확인하지 못해 판단을 보류합니다');
  }
  const px = ctx.price;
  const tranche = cfg(config, 'trancheUsd');

  switch (id) {
    // ── 적립식 매수 ──
    case 'dca': {
      const days = cfg(config, 'intervalDays');
      if (ctx.lastBuyAt != null && ctx.now - ctx.lastBuyAt < days * DAY_MS) {
        const left = Math.ceil((days * DAY_MS - (ctx.now - ctx.lastBuyAt)) / DAY_MS);
        return HOLD(`적립 주기까지 ${left}일 남았습니다`);
      }
      return { action: 'BUY', quoteUsd: tranche, reason: `${days}일 주기 적립 매수` };
    }

    // ── 하락 시 분할매수 ──
    case 'dip-buy': {
      // 평균가가 없으면 첫 진입이다. 하락 판단의 기준이 없으므로
      // 첫 한 번만 사고 그다음부터 하락을 잰다.
      if (ctx.avgPrice == null) {
        return { action: 'BUY', quoteUsd: tranche, reason: '첫 진입 — 이후 하락 시 분할매수' };
      }
      const drop = ((ctx.avgPrice - px) / ctx.avgPrice) * 100;
      const th = cfg(config, 'thresholdPct');
      if (drop < th) {
        // drop이 음수면 평균가보다 '위'라는 뜻이다. -6.45% 하락이라고
        // 적으면 떨어진 것처럼 읽힌다.
        return HOLD(drop < 0
          ? `평균가보다 ${(-drop).toFixed(2)}% 높습니다 — 하락 매수 조건이 아닙니다`
          : `평균가 대비 ${drop.toFixed(2)}% 하락 — 기준 ${th}% 미달`);
      }
      return { action: 'BUY', quoteUsd: tranche, reason: `평균가 대비 ${drop.toFixed(2)}% 하락 — 분할매수` };
    }

    // ── 상승 시 분할매도 ──
    case 'scale-out': {
      if (ctx.avgPrice == null || ctx.heldQty <= 0) return HOLD('보유가 없어 분할매도할 것이 없습니다');
      const gain = ((px - ctx.avgPrice) / ctx.avgPrice) * 100;
      const th = cfg(config, 'thresholdPct');
      if (gain < th) return HOLD(`평균가 대비 +${gain.toFixed(2)}% — 기준 ${th}% 미달`);
      const pct = cfg(config, 'sellPct');
      return {
        action: 'SELL', qty: ctx.heldQty * (pct / 100),
        reason: `+${gain.toFixed(2)}% — 보유의 ${pct}% 분할매도`,
      };
    }

    // ── 목표 비중 리밸런싱 ──
    case 'rebalance': {
      // 전체 평가액을 모르면 비중을 낼 수 없다. 임의 값으로 팔거나 사면
      // 목표와 정반대로 갈 수 있다.
      if (ctx.portfolioValueUsd == null || ctx.portfolioValueUsd <= 0) {
        return HOLD('포트폴리오 평가액을 몰라 비중을 계산할 수 없습니다');
      }
      const target = cfg(config, 'targetWeightPct');
      const drift = cfg(config, 'driftPct');
      const cur = ((ctx.heldQty * px) / ctx.portfolioValueUsd) * 100;
      const gap = cur - target;
      if (Math.abs(gap) < drift) {
        return HOLD(`현재 비중 ${cur.toFixed(1)}% — 목표 ${target}%와 허용 오차 안`);
      }
      const targetValue = ctx.portfolioValueUsd * (target / 100);
      const curValue = ctx.heldQty * px;
      if (gap < 0) {
        return {
          action: 'BUY', quoteUsd: targetValue - curValue,
          reason: `비중 ${cur.toFixed(1)}% → 목표 ${target}% 매수 조정`,
        };
      }
      return {
        action: 'SELL', qty: (curValue - targetValue) / px,
        reason: `비중 ${cur.toFixed(1)}% → 목표 ${target}% 매도 조정`,
      };
    }

    // ── 이동평균 적립 ──
    case 'ma-dca': {
      const period = cfg(config, 'period');
      const ma = smaLast(ctx.closes, period);
      if (ma == null) return HOLD(`${period}일 이동평균을 계산할 봉이 모자랍니다`);
      const days = cfg(config, 'intervalDays');
      if (ctx.lastBuyAt != null && ctx.now - ctx.lastBuyAt < days * DAY_MS) {
        return HOLD('적립 주기 안입니다');
      }
      // 평균 아래면 더 사고, 위면 덜 산다. 적립을 멈추지는 않는다 —
      // 멈추면 상승장에서 아예 못 담는다.
      const below = px < ma;
      const amount = below ? tranche * 1.5 : tranche * 0.5;
      return {
        action: 'BUY', quoteUsd: amount,
        reason: `${period}일선 ${below ? '아래' : '위'} — ${below ? '1.5배' : '0.5배'} 적립`,
      };
    }

    // ── RSI 분할매수 ──
    case 'rsi-dip': {
      const period = cfg(config, 'period');
      const r = rsiLast(ctx.closes, Math.max(2, Math.min(period, 30)));
      if (r == null) return HOLD('RSI를 계산할 봉이 모자랍니다');
      const th = cfg(config, 'rsiBelow');
      if (r >= th) return HOLD(`RSI ${r.toFixed(1)} — 기준 ${th} 이상`);
      return { action: 'BUY', quoteUsd: tranche, reason: `RSI ${r.toFixed(1)} — 과매도 분할매수` };
    }

    // ── 돌파 매수 ──
    case 'breakout': {
      const period = cfg(config, 'period');
      if (ctx.closes.length < period + 1) return HOLD('돌파를 판단할 봉이 모자랍니다');
      // 직전 봉까지의 최고가와 비교한다. 현재 봉을 포함하면 자기 자신을
      // 넘을 수 없어 영원히 신호가 안 난다.
      const prior = ctx.closes.slice(-(period + 1), -1);
      const high = Math.max(...prior);
      if (px <= high) return HOLD(`${period}일 최고가 ${high.toFixed(2)} 미돌파`);
      return { action: 'BUY', quoteUsd: tranche, reason: `${period}일 최고가 돌파 매수` };
    }

    // ── 장기 보유 ──
    case 'hodl': {
      // 한 번 사고 팔지 않는다. 파는 조건이 아예 없다 —
      // 조건을 넣으면 그건 장기 보유가 아니다.
      if (ctx.heldQty > 0) return HOLD('장기 보유 — 매도하지 않습니다');
      return { action: 'BUY', quoteUsd: tranche, reason: '장기 보유 최초 매수' };
    }

    // ── 현물 그리드 ──
    case 'grid': {
      if (ctx.avgPrice == null) {
        return { action: 'BUY', quoteUsd: tranche, reason: '그리드 최초 진입' };
      }
      const step = cfg(config, 'gridStepPct');
      const diff = ((px - ctx.avgPrice) / ctx.avgPrice) * 100;
      if (diff <= -step) {
        return { action: 'BUY', quoteUsd: tranche, reason: `그리드 −${step}% 도달 매수` };
      }
      if (diff >= step && ctx.heldQty > 0) {
        const pct = cfg(config, 'sellPct');
        return {
          action: 'SELL', qty: ctx.heldQty * (pct / 100),
          reason: `그리드 +${step}% 도달 — ${pct}% 매도`,
        };
      }
      return HOLD(`그리드 대기 (평균가 대비 ${diff.toFixed(2)}%)`);
    }

    // ── 수익금 원금 회수 ──
    case 'profit-recover': {
      if (ctx.avgPrice == null || ctx.heldQty <= 0) return HOLD('보유가 없습니다');
      const gainPct = ((px - ctx.avgPrice) / ctx.avgPrice) * 100;
      const th = cfg(config, 'recoverAtPct');
      if (gainPct < th) return HOLD(`수익률 ${gainPct.toFixed(1)}% — 회수 기준 ${th}% 미달`);
      // 원금(투입액)만큼을 회수한다. 남는 것은 수익분이라 그대로 둔다.
      const principal = ctx.avgPrice * ctx.heldQty;
      const qty = principal / px;
      return {
        action: 'SELL', qty: Math.min(qty, ctx.heldQty),
        reason: `수익률 ${gainPct.toFixed(1)}% — 원금 ${principal.toFixed(2)} USD 회수, 수익분은 보유 유지`,
      };
    }
  }
}

/** 전략을 돌리고 예산·보유 안으로 자른다. 실제로 쓸 때는 이것을 부른다. */
export function decideSpot(
  id: SpotStrategyId, ctx: SpotContext, config: SpotStrategyConfig = {},
): ClampResult {
  return clampIntent(runSpotStrategy(id, ctx, config), ctx);
}

export const SPOT_STRATEGY_LABEL: Record<SpotStrategyId, string> = {
  'dca': '적립식 매수',
  'dip-buy': '하락 시 분할매수',
  'scale-out': '상승 시 분할매도',
  'rebalance': '목표 비중 리밸런싱',
  'ma-dca': '이동평균 적립',
  'rsi-dip': 'RSI 분할매수',
  'breakout': '돌파 매수',
  'hodl': '장기 보유',
  'grid': '현물 그리드',
  'profit-recover': '수익금 원금 회수',
};

export const SPOT_STRATEGY_IDS = Object.keys(SPOT_STRATEGY_LABEL) as SpotStrategyId[];
