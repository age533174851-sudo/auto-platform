// src/lib/strategies/combined.ts
//
// 현물 + 선물 결합 전략.
//
// 가장 위험한 것: 반쪽 실행
// ─────────────────────────
// 결합 전략은 두 시장에 각각 주문을 낸다. 거래소가 다르니 원자적으로
// 묶을 수 없다. 그래서 **한쪽만 체결되는 상태가 반드시 생긴다.**
//
// 현물을 사고 선물 헤지가 실패하면, 사용자는 헤지된 줄 알고 그 전제로
// 크기를 정했는데 실제로는 전액 롱이다. **헤지를 안 한 것보다 나쁘다.**
//
// 그래서 이 파일은
//   1. 다리(leg)에 실행 순서를 매기고
//   2. 순서를 "실패했을 때 덜 위험한 쪽부터"로 정하고
//   3. 두 번째가 실패하면 그 사실을 조용히 넘기지 않고 상태로 돌려준다
//
// 순서를 정하는 기준
// ──────────────────
// '현물 매수 + 선물 숏 헤지'는 현물부터 산다. 헤지가 실패하면 롱이 남는데,
// 그건 원래 의도한 기본 상태다. 반대로 숏을 먼저 내고 현물이 실패하면
// **맨몸 숏**이 된다 — 현물 중심 사용자에게 훨씬 나쁘다.
//
// 헤지했다고 안전한 것이 아니다
// ─────────────────────────────
// 순노출이 0이어도 증거금은 여전히 위험하고 펀딩은 계속 나간다.
// 몇 달 들고 있으면 펀딩이 피한 하락폭보다 클 수 있다.
// 그래서 예상 펀딩 비용을 함께 낸다.

import type { MarketType } from '@/lib/markets/marketType';

export type CombinedStrategyId =
  | 'hold-hedge'       // 현물 장기 보유 + 선물 단기 헤지
  | 'overheat-short'   // 현물 매수 + 과열 시 선물 SHORT
  | 'funding-tilt'     // Funding 상태에 따른 현물·선물 비중 조절
  | 'sweep-to-spot'    // 선물 수익을 현물로 적립
  | 'spot-to-fund'     // 현물 수익 일부를 전략자금으로 이동
  | 'defend-not-sell'; // 시장 위험 시 현물을 팔지 않고 선물로 방어

export const COMBINED_LABEL: Record<CombinedStrategyId, string> = {
  'hold-hedge': '현물 보유 + 선물 헤지',
  'overheat-short': '과열 시 선물 숏',
  'funding-tilt': '펀딩 기반 비중 조절',
  'sweep-to-spot': '선물 수익 현물 적립',
  'spot-to-fund': '현물 수익 전략자금 이동',
  'defend-not-sell': '팔지 않고 선물로 방어',
};

export const COMBINED_IDS = Object.keys(COMBINED_LABEL) as CombinedStrategyId[];

// ── 다리 ───────────────────────────────────────────────

export interface Leg {
  market: MarketType;
  side: 'BUY' | 'SELL';
  /** 현물은 코인 수량, 선물은 코인 수량(USDT-M) */
  qty: number;
  /** 선물에만 */
  leverage?: number;
  /**
   * 실행 순서. 1이 먼저다.
   * 같은 번호는 없다 — 동시에 내면 어느 쪽이 먼저 체결될지 모른다.
   */
  order: 1 | 2;
  /**
   * 이 다리가 실패했을 때 남는 상태를 사람 말로.
   * 화면이 그대로 띄운다.
   */
  ifThisFails: string;
  label: string;
}

export interface CombinedPlan {
  ok: boolean;
  strategyId: CombinedStrategyId;
  legs: Leg[];
  /** 계획대로 됐을 때의 순노출 (코인 수량) */
  targetNetExposure: number;
  warnings: string[];
  reason: string;
}

const noPlan = (
  strategyId: CombinedStrategyId, reason: string, warnings: string[] = [],
): CombinedPlan => ({ ok: false, strategyId, legs: [], targetNetExposure: 0, warnings, reason });

// ── 헤지 비율 ──────────────────────────────────────────

export interface HedgeInput {
  /** 현물 보유 수량 */
  spotQty: number;
  /** 현재 선물 순수량 (롱 +, 숏 −) */
  futuresQty: number;
  /** 목표 순노출 비율 (0 = 완전 헤지, 1 = 헤지 없음, 0.5 = 절반만 노출) */
  targetExposureRatio: number;
}

export interface HedgeResult {
  ok: boolean;
  /** 추가로 내야 하는 선물 수량 (부호: + 는 매수, − 는 매도) */
  deltaFutures: number;
  targetFuturesQty: number;
  reason: string;
}

/**
 * 목표 노출에 맞추려면 선물을 얼마나 더 내야 하는가.
 *
 * **현재 선물 포지션을 반드시 반영한다.** 이미 숏이 걸려 있는데 그걸
 * 무시하고 또 숏을 내면 순노출이 음수가 된다 — 헤지가 아니라 반대 베팅이다.
 */
export function hedgeDelta(i: HedgeInput): HedgeResult {
  if (!Number.isFinite(i.spotQty) || i.spotQty < 0) {
    return { ok: false, deltaFutures: 0, targetFuturesQty: 0, reason: '현물 보유 수량이 유효하지 않습니다' };
  }
  if (!Number.isFinite(i.futuresQty)) {
    return { ok: false, deltaFutures: 0, targetFuturesQty: 0, reason: '선물 포지션을 확인하지 못했습니다' };
  }
  const r = i.targetExposureRatio;
  if (!Number.isFinite(r) || r < 0 || r > 1) {
    return { ok: false, deltaFutures: 0, targetFuturesQty: 0, reason: '목표 노출 비율은 0~1 사이여야 합니다' };
  }

  // 목표 순노출 = spot × r  ⇒  목표 선물 = spot×r − spot = −spot×(1−r)
  const targetFuturesQty = -i.spotQty * (1 - r);
  const delta = targetFuturesQty - i.futuresQty;

  return {
    ok: true, deltaFutures: delta, targetFuturesQty,
    reason: Math.abs(delta) < 1e-12
      ? '이미 목표 노출입니다'
      : `선물을 ${delta > 0 ? '매수' : '매도'} ${Math.abs(delta)} 하면 순노출이 ${(i.spotQty * r).toFixed(6)}이 됩니다`,
  };
}

// ── 헤지 건전성 ────────────────────────────────────────

export interface HedgeHealth {
  /** 지금 실제 순노출 */
  netExposure: number;
  /** 의도한 순노출 */
  intended: number;
  /** 어긋난 정도 */
  drift: number;
  status: 'INTACT' | 'DRIFTED' | 'BROKEN' | 'UNKNOWN';
  message: string;
}

/**
 * 헤지가 지금도 살아 있는가.
 *
 * 반쪽 실행·강제 청산·수동 매도로 한쪽이 사라지면 헤지가 깨진다.
 * 그런데 사용자는 걸어둔 것을 기억하지, 깨진 것은 모른다.
 *
 * 한쪽이라도 조회에 실패하면 INTACT라고 하지 않는다 — 확인 불가를
 * 정상으로 처리하는 것이 이 프로젝트에서 가장 자주 나온 사고 유형이다.
 */
export function checkHedgeHealth(
  spotQty: number | null, futuresQty: number | null, intendedNet: number,
): HedgeHealth {
  if (spotQty == null || futuresQty == null) {
    return {
      netExposure: 0, intended: intendedNet, drift: 0, status: 'UNKNOWN',
      message: '현물 또는 선물 포지션을 확인하지 못해 헤지 상태를 알 수 없습니다 — 정상이라는 뜻이 아닙니다',
    };
  }

  const net = spotQty + futuresQty;
  const drift = net - intendedNet;
  const base = Math.max(Math.abs(spotQty), 1e-9);
  const driftRatio = Math.abs(drift) / base;

  if (driftRatio < 0.02) {
    return { netExposure: net, intended: intendedNet, drift, status: 'INTACT', message: '헤지가 유지되고 있습니다' };
  }
  if (driftRatio < 0.25) {
    return {
      netExposure: net, intended: intendedNet, drift, status: 'DRIFTED',
      message: `순노출이 의도(${intendedNet.toFixed(6)})에서 ${drift > 0 ? '+' : ''}${drift.toFixed(6)} 벗어났습니다`,
    };
  }
  return {
    netExposure: net, intended: intendedNet, drift, status: 'BROKEN',
    message: `헤지가 깨졌습니다. 의도 ${intendedNet.toFixed(6)} → 실제 ${net.toFixed(6)}. ` +
             (futuresQty === 0
               ? '선물 다리가 사라졌습니다 — 지금 전액 노출 상태입니다.'
               : '현물과 선물 중 한쪽이 크게 달라졌습니다.'),
  };
}

// ── 펀딩 비용 ──────────────────────────────────────────

export interface FundingCost {
  /** 하루 비용 (명목가 대비 %) */
  dailyPct: number;
  /** 보유 기간 총 비용 (%) */
  totalPct: number;
  /** 총 비용 (USD) */
  totalUsd: number;
  /** 숏이 받는 쪽인가 */
  receiving: boolean;
  note: string;
}

/**
 * 헤지를 유지하는 데 드는 펀딩.
 *
 * 헤지는 공짜가 아니다. 펀딩이 양수일 때 숏은 받지만, 음수면 낸다.
 * 몇 달 유지하면 피하려던 하락폭보다 커질 수 있다.
 * 이 값을 안 보여주면 사용자는 헤지를 무료 보험으로 여긴다.
 */
export function estimateFundingCost(
  fundingRatePct: number | null, notionalUsd: number, days: number,
  side: 'LONG' | 'SHORT',
): FundingCost | null {
  if (fundingRatePct == null || !Number.isFinite(fundingRatePct)) return null;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
  if (!Number.isFinite(days) || days <= 0) return null;

  // 8시간마다 정산 → 하루 3회
  const dailyPct = fundingRatePct * 3;
  // 펀딩이 양수면 롱이 숏에게 낸다
  const signed = side === 'SHORT' ? dailyPct : -dailyPct;
  const totalPct = signed * days;
  const totalUsd = notionalUsd * (totalPct / 100);

  return {
    dailyPct: signed, totalPct, totalUsd,
    receiving: totalUsd > 0,
    note: totalUsd >= 0
      ? `${days}일간 약 $${totalUsd.toFixed(2)} 받습니다 (펀딩 ${fundingRatePct.toFixed(4)}%)`
      : `${days}일간 약 $${Math.abs(totalUsd).toFixed(2)} 냅니다 (펀딩 ${fundingRatePct.toFixed(4)}%). ` +
        '헤지는 공짜가 아닙니다.',
  };
}

// ── 전략 ───────────────────────────────────────────────

export interface CombinedContext {
  symbol: string;
  price: number | null;
  /** 현물 보유 */
  spotQty: number | null;
  /** 선물 순수량 (롱 +, 숏 −) */
  futuresQty: number | null;
  /** 선물 미실현 손익 (USD) */
  futuresPnlUsd: number | null;
  /** 현물 평균 매수가 */
  spotAvgPrice: number | null;
  /** 펀딩비 (%) */
  fundingPct: number | null;
  /** RSI 등 과열 지표 (0~100). 모르면 null */
  overheatScore: number | null;
  /** 선물 지갑 가용 증거금 (USD) */
  futuresMarginUsd: number | null;
}

export interface CombinedConfig {
  /** 목표 노출 비율 (0=완전헤지, 1=노출유지) */
  targetExposureRatio?: number;
  /** 과열 판정 기준 */
  overheatAbove?: number;
  /** 펀딩 기준(%) */
  fundingThresholdPct?: number;
  /** 선물 레버리지 */
  leverage?: number;
  /** 수익 적립 기준 (USD) */
  sweepAboveUsd?: number;
  /** 예상 보유 일수 — 펀딩 비용 계산용 */
  holdDays?: number;
}

const DEF = {
  targetExposureRatio: 0, overheatAbove: 75, fundingThresholdPct: 0.05,
  leverage: 2, sweepAboveUsd: 100, holdDays: 30,
};

function cfg(c: CombinedConfig, k: keyof typeof DEF): number {
  const v = c[k as keyof CombinedConfig];
  return typeof v === 'number' && Number.isFinite(v) ? v : DEF[k];
}

/**
 * 결합 전략 하나를 평가한다.
 *
 * 어느 전략이든 현물·선물 중 하나라도 못 읽으면 계획을 만들지 않는다.
 * 반쪽 정보로 헤지 비율을 내면 그 비율이 그대로 주문이 된다.
 */
export function planCombined(
  id: CombinedStrategyId, ctx: CombinedContext, config: CombinedConfig = {},
): CombinedPlan {
  if (ctx.price == null || ctx.price <= 0) {
    return noPlan(id, '현재가를 확인하지 못해 판단을 보류합니다');
  }
  if (ctx.spotQty == null || ctx.futuresQty == null) {
    return noPlan(id,
      '현물 또는 선물 포지션을 확인하지 못했습니다. 반쪽 정보로 헤지 비율을 내면 그 비율이 그대로 주문이 됩니다.');
  }

  const lev = cfg(config, 'leverage');
  const warnings: string[] = [];

  switch (id) {
    // ── 현물 보유 + 선물 헤지 ──
    case 'hold-hedge':
    case 'defend-not-sell': {
      if (ctx.spotQty <= 0) return noPlan(id, '현물 보유가 없어 헤지할 대상이 없습니다');

      const ratio = cfg(config, 'targetExposureRatio');
      const h = hedgeDelta({ spotQty: ctx.spotQty, futuresQty: ctx.futuresQty, targetExposureRatio: ratio });
      if (!h.ok) return noPlan(id, h.reason);
      if (Math.abs(h.deltaFutures) < 1e-9) return noPlan(id, h.reason);

      // 증거금이 모자라면 헤지가 반만 걸린다 — 그게 가장 나쁜 상태다
      const notional = Math.abs(h.deltaFutures) * ctx.price;
      const needMargin = notional / lev;
      if (ctx.futuresMarginUsd == null) {
        warnings.push('선물 가용 증거금을 확인하지 못했습니다. 부족하면 헤지가 일부만 걸립니다.');
      } else if (needMargin > ctx.futuresMarginUsd) {
        return noPlan(id,
          `헤지에 필요한 증거금 $${needMargin.toFixed(2)}이 선물 가용 증거금 ` +
          `$${ctx.futuresMarginUsd.toFixed(2)}을 넘습니다. 일부만 걸리면 헤지된 줄 알고 ` +
          '더 위험해집니다 — 이체 후 다시 시도하세요.');
      }

      const fc = estimateFundingCost(
        ctx.fundingPct, notional, cfg(config, 'holdDays'),
        h.deltaFutures < 0 ? 'SHORT' : 'LONG');
      if (fc && fc.totalUsd < 0) warnings.push(fc.note);

      return {
        ok: true, strategyId: id,
        targetNetExposure: ctx.spotQty * ratio,
        legs: [{
          market: 'USDT_FUTURES',
          side: h.deltaFutures > 0 ? 'BUY' : 'SELL',
          qty: Math.abs(h.deltaFutures),
          leverage: lev,
          order: 1,
          ifThisFails: '현물은 그대로 남고 헤지가 걸리지 않습니다 — 전액 노출 상태입니다.',
          label: `선물 ${h.deltaFutures > 0 ? 'LONG' : 'SHORT'} ${Math.abs(h.deltaFutures).toFixed(6)}`,
        }],
        warnings,
        reason: id === 'defend-not-sell'
          ? `현물을 팔지 않고 선물로 방어합니다. ${h.reason}`
          : h.reason,
      };
    }

    // ── 과열 시 선물 숏 ──
    case 'overheat-short': {
      if (ctx.overheatScore == null) {
        return noPlan(id, '과열 지표를 계산하지 못해 판단을 보류합니다');
      }
      const th = cfg(config, 'overheatAbove');
      if (ctx.overheatScore < th) {
        return noPlan(id, `과열 지표 ${ctx.overheatScore.toFixed(1)} — 기준 ${th} 미만입니다`);
      }
      if (ctx.spotQty <= 0) return noPlan(id, '현물 보유가 없어 방어할 대상이 없습니다');
      // 이미 숏이 있으면 더 얹지 않는다 — 헤지가 아니라 방향 베팅이 된다
      if (ctx.futuresQty < 0) {
        return noPlan(id, `이미 선물 숏 ${Math.abs(ctx.futuresQty)}이 있습니다. 더 얹으면 헤지가 아니라 반대 베팅입니다.`);
      }

      const ratio = cfg(config, 'targetExposureRatio');
      const h = hedgeDelta({ spotQty: ctx.spotQty, futuresQty: ctx.futuresQty, targetExposureRatio: ratio });
      if (!h.ok || h.deltaFutures >= 0) return noPlan(id, h.reason);

      return {
        ok: true, strategyId: id,
        targetNetExposure: ctx.spotQty * ratio,
        legs: [{
          market: 'USDT_FUTURES', side: 'SELL', qty: Math.abs(h.deltaFutures),
          leverage: lev, order: 1,
          ifThisFails: '현물 보유가 그대로 노출된 채 남습니다.',
          label: `선물 SHORT ${Math.abs(h.deltaFutures).toFixed(6)}`,
        }],
        warnings,
        reason: `과열 지표 ${ctx.overheatScore.toFixed(1)} ≥ ${th} — 현물을 팔지 않고 선물로 덮습니다`,
      };
    }

    // ── 펀딩 기반 비중 조절 ──
    case 'funding-tilt': {
      if (ctx.fundingPct == null) {
        return noPlan(id, '펀딩비를 확인하지 못해 판단을 보류합니다');
      }
      const th = cfg(config, 'fundingThresholdPct');
      // 펀딩이 높으면 숏이 받는다 → 헤지 비용이 음(수익)이므로 헤지를 늘린다
      if (ctx.fundingPct > th) {
        if (ctx.spotQty <= 0) return noPlan(id, '현물 보유가 없어 조절할 대상이 없습니다');
        const h = hedgeDelta({ spotQty: ctx.spotQty, futuresQty: ctx.futuresQty, targetExposureRatio: 0 });
        if (!h.ok || Math.abs(h.deltaFutures) < 1e-9) return noPlan(id, h.reason);
        const notional = Math.abs(h.deltaFutures) * ctx.price;
        const fc = estimateFundingCost(ctx.fundingPct, notional, cfg(config, 'holdDays'), 'SHORT');
        return {
          ok: true, strategyId: id, targetNetExposure: 0,
          legs: [{
            market: 'USDT_FUTURES', side: 'SELL', qty: Math.abs(h.deltaFutures),
            leverage: lev, order: 1,
            ifThisFails: '현물이 그대로 노출됩니다.',
            label: `선물 SHORT ${Math.abs(h.deltaFutures).toFixed(6)}`,
          }],
          warnings,
          reason: `펀딩 ${ctx.fundingPct.toFixed(4)}% > ${th}% — 숏이 받는 구간입니다. ` +
                  (fc ? fc.note : ''),
        };
      }
      if (ctx.fundingPct < -th && ctx.futuresQty < 0) {
        // 펀딩이 음수면 숏이 낸다 → 헤지를 줄인다
        return {
          ok: true, strategyId: id, targetNetExposure: ctx.spotQty,
          legs: [{
            market: 'USDT_FUTURES', side: 'BUY', qty: Math.abs(ctx.futuresQty),
            leverage: lev, order: 1,
            ifThisFails: '헤지가 그대로 남아 펀딩을 계속 냅니다.',
            label: `선물 숏 종료 ${Math.abs(ctx.futuresQty).toFixed(6)}`,
          }],
          warnings,
          reason: `펀딩 ${ctx.fundingPct.toFixed(4)}% < −${th}% — 숏이 내는 구간이라 헤지를 줄입니다`,
        };
      }
      return noPlan(id, `펀딩 ${ctx.fundingPct.toFixed(4)}% — ±${th}% 안이라 조절하지 않습니다`);
    }

    // ── 선물 수익을 현물로 적립 ──
    case 'sweep-to-spot': {
      if (ctx.futuresPnlUsd == null) {
        return noPlan(id, '선물 손익을 확인하지 못해 판단을 보류합니다');
      }
      const th = cfg(config, 'sweepAboveUsd');
      if (ctx.futuresPnlUsd < th) {
        return noPlan(id, `선물 미실현 $${ctx.futuresPnlUsd.toFixed(2)} — 기준 $${th} 미달입니다`);
      }
      const qty = ctx.futuresPnlUsd / ctx.price;
      // 미실현은 아직 내 돈이 아니다. 현물을 먼저 사면 실현 전에 자금이 나간다.
      warnings.push(
        '선물 미실현 손익은 아직 확정되지 않았습니다. 이 계획은 선물 이익을 실현한 뒤에만 ' +
        '의미가 있으며, 실현 없이 현물을 사면 별도 자금이 나갑니다.');
      return {
        ok: true, strategyId: id,
        targetNetExposure: ctx.spotQty + qty,
        legs: [{
          market: 'SPOT', side: 'BUY', qty, order: 1,
          ifThisFails: '선물 수익이 선물 지갑에 그대로 남습니다.',
          label: `현물 매수 ${qty.toFixed(6)} ($${ctx.futuresPnlUsd.toFixed(2)})`,
        }],
        warnings,
        reason: `선물 미실현 $${ctx.futuresPnlUsd.toFixed(2)} ≥ $${th} — 현물로 적립합니다`,
      };
    }

    // ── 현물 수익 일부를 전략자금으로 ──
    case 'spot-to-fund': {
      if (ctx.spotAvgPrice == null || ctx.spotQty <= 0) {
        return noPlan(id, '현물 보유나 평균 매수가가 없어 수익을 계산할 수 없습니다');
      }
      const gainUsd = (ctx.price - ctx.spotAvgPrice) * ctx.spotQty;
      const th = cfg(config, 'sweepAboveUsd');
      if (gainUsd < th) {
        return noPlan(id, `현물 평가익 $${gainUsd.toFixed(2)} — 기준 $${th} 미달입니다`);
      }
      const qty = gainUsd / ctx.price;
      warnings.push(
        '현물을 팔면 그만큼 노출이 줄어듭니다. 헤지를 걸어둔 상태라면 순노출이 ' +
        '음수(숏)가 될 수 있으니 헤지 비율을 함께 조정하세요.');
      return {
        ok: true, strategyId: id,
        targetNetExposure: ctx.spotQty - qty,
        legs: [{
          market: 'SPOT', side: 'SELL', qty, order: 1,
          ifThisFails: '현물이 그대로 남습니다.',
          label: `현물 매도 ${qty.toFixed(6)} (평가익 $${gainUsd.toFixed(2)})`,
        }],
        warnings,
        reason: `현물 평가익 $${gainUsd.toFixed(2)} ≥ $${th} — 수익만큼 전략자금으로 옮깁니다`,
      };
    }
  }
}

/**
 * 여러 다리를 순서대로 실행할 때의 규칙.
 *
 * 두 번째 다리가 실패하면 첫 번째가 이미 나가 있다. 그 상태를 되돌리려
 * 하지 않는다 — 되돌리는 주문이 또 실패하면 더 꼬인다. 대신 지금 상태가
 * 무엇인지 정확히 알려주고 사람이 정하게 한다.
 */
export interface LegOutcome { leg: Leg; ok: boolean; message: string }

export interface ExecutionReport {
  allOk: boolean;
  executed: number;
  /** 반쪽 실행이면 지금 어떤 상태인가 */
  resultingState: string;
  needsAttention: boolean;
}

export function summarizeExecution(outcomes: LegOutcome[]): ExecutionReport {
  const done = outcomes.filter(o => o.ok);
  const failed = outcomes.filter(o => !o.ok);

  if (failed.length === 0) {
    return {
      allOk: true, executed: done.length,
      resultingState: '계획한 모든 다리가 체결됐습니다',
      needsAttention: false,
    };
  }
  if (done.length === 0) {
    return {
      allOk: false, executed: 0,
      resultingState: '아무것도 실행되지 않았습니다 — 포지션은 그대로입니다',
      needsAttention: false,
    };
  }
  // 여기가 위험 구간이다
  return {
    allOk: false, executed: done.length,
    resultingState:
      `${done.length}개는 체결되고 ${failed.length}개는 실패했습니다. ` +
      failed.map(f => f.leg.ifThisFails).join(' ') +
      ' 지금 상태를 확인하고 직접 정리해야 합니다.',
    needsAttention: true,
  };
}
