// src/lib/strategies/exitPolicy.ts
//
// **청산 정책은 진입 전략과 따로 관리한다.**
//
// 왜 나누는가
// ───────────
// 사용자의 원본 전략에서 **진입은 규칙이 있었고 청산은 재량이었다.**
// 화면을 보면서 적당히 먹고 나오는 방식은 그대로 자동화할 수 없다.
//
// 그렇다고 "원래 손절 0.4%, 익절 0.8%였다"고 적으면 **없던 규칙을
// 원본으로 만드는 것**이다. 나중에 "내 원본 전략의 성적"을 물었을 때
// 그 숫자가 원본인 줄 알게 된다.
//
// 그래서:
//
//   진입  my-original-v1 v1     — 사용자의 원본. 바뀌지 않는다
//   청산  testnet-exit-v1 v1    — 검증용으로 **새로 정한** 정책. 교체된다
//
// 두 버전이 각각 기록되므로, 나중에 청산 정책만 바꿔 가며 비교할 수 있다.
// 그때 진입 성적과 청산 성적이 섞이지 않는다.
//
// 100배에서 손절 1%는 왜 안 되는가
// ────────────────────────────────
// 청산 거리 = 100 ÷ 배율 − 유지증거금률. 100배·MMR 0.4%면 **0.6%**다.
// 손절을 1%에 두면 그 가격에 닿기 전에 청산당한다 — 손절이 있으나 마나고,
// 증거금 전액이 사라진다. 그래서 이 정책은 0.4%에서 자른다(0.6% 안쪽).
//
// 여유가 0.2%뿐이라는 것도 사실이다. 수수료·펀딩이 그 여유를 갉아먹으므로
// **진입 직전에 실제 배율로 다시 확인하고, 손절이 청산보다 멀면 막는다.**

import { liquidationDistancePct, maxLeverageBeforeLiquidation, DEFAULT_MMR_PCT } from '../engine/leverageMath';

export interface ExitPolicySpec {
  id: string;
  version: string;
  name: string;
  /** 진입가 대비 손절 거리(%). 양수 */
  stopPct: number;
  /** 진입가 대비 익절 거리(%). 양수. null이면 익절을 걸지 않는다 */
  takeProfitPct: number | null;
  /** 분할 익절을 쓰는가. v1은 전량이다 */
  partial: boolean;
  note: string;
}

/**
 * 지금 쓸 수 있는 청산 정책.
 *
 * **이 목록의 값은 사용자의 원본 규칙이 아니다.** 검증용으로 정한 값이고,
 * 교체될 것을 전제로 버전이 붙어 있다.
 */
export const EXIT_POLICIES: ExitPolicySpec[] = [
  {
    id: 'testnet-exit-v1',
    version: '1',
    name: '테스트넷 검증용 1:2',
    stopPct: 0.4,
    takeProfitPct: 0.8,
    partial: false,
    note: '원본 진입 전략과 무관하게 정한 검증용 값입니다 — 실제 체결 흐름을 보기 위한 것이고, '
      + '원본의 청산 규칙으로 기록되지 않습니다',
  },
];

export const DEFAULT_EXIT_POLICY_ID = 'testnet-exit-v1';

const BY_ID = new Map(EXIT_POLICIES.map(p => [p.id, p]));

export function resolveExitPolicy(id?: any): {
  ok: boolean; spec: ExitPolicySpec | null; message: string;
} {
  const key = String(id ?? '').trim() || DEFAULT_EXIT_POLICY_ID;
  const spec = BY_ID.get(key) ?? null;
  return spec
    ? { ok: true, spec, message: '' }
    : { ok: false, spec: null, message: `모르는 청산 정책입니다: ${key}` };
}

// ── 가격 ─────────────────────────────────────────────

export interface ExitPrices {
  ok: boolean;
  stop: number | null;
  takeProfit: number | null;
  reason: string;
}

/** 유한한 양수만 가격으로 쓴다. **0과 NaN을 진입가로 삼지 않는다** */
const price = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 진입가에서 손절·익절 가격을 만든다.
 *
 * 방향을 뒤집으면 손절이 익절이 된다. 그래서 부호를 한 곳에서만 정한다 —
 * 부르는 쪽마다 계산하면 언젠가 한 곳이 반대가 되고, 그때 손절이
 * **이익 쪽에** 걸린다.
 */
export function exitPricesFor(i: {
  side: 'LONG' | 'SHORT';
  entryPrice: any;
  spec: ExitPolicySpec;
}): ExitPrices {
  const entry = price(i.entryPrice);
  if (entry == null) {
    return { ok: false, stop: null, takeProfit: null,
      reason: '진입가를 읽지 못해 손절·익절 가격을 만들 수 없습니다' };
  }
  const s = Number(i.spec.stopPct);
  if (!Number.isFinite(s) || s <= 0) {
    return { ok: false, stop: null, takeProfit: null,
      reason: `손절 거리가 유효하지 않습니다 (${i.spec.stopPct})` };
  }
  const long = i.side === 'LONG';
  const stop = long ? entry * (1 - s / 100) : entry * (1 + s / 100);

  const t = i.spec.takeProfitPct;
  const tp = t == null ? null
    : (() => {
      const n = Number(t);
      if (!Number.isFinite(n) || n <= 0) return null;
      return long ? entry * (1 + n / 100) : entry * (1 - n / 100);
    })();

  return {
    ok: true,
    stop: round(stop), takeProfit: tp == null ? null : round(tp),
    reason: `진입 ${entry} · 손절 ${round(stop)} (-${s}%)`
      + (tp == null ? ' · 익절 없음' : ` · 익절 ${round(tp)} (+${t}%)`),
  };
}

/** 가격 자릿수는 거래소 규격이 최종적으로 다듬는다. 여기서는 부동소수점 꼬리만 자른다 */
const round = (v: number) => Number(v.toFixed(8));

// ── 손절이 청산보다 먼저 오는가 ──────────────────────

export type LiquidationGuardCode =
  | 'OK'
  /** 손절이 청산 거리 밖이다 — 손절이 작동하기 전에 청산된다 */
  | 'STOP_BEYOND_LIQUIDATION'
  /** 이 배율은 진입 즉시 청산 구간이다 */
  | 'IMMEDIATE_LIQUIDATION'
  /** 계산에 필요한 값을 못 읽었다. **안전하다고 답하지 않는다** */
  | 'UNKNOWN';

export interface LiquidationGuard {
  ok: boolean;
  code: LiquidationGuardCode;
  /** 이 배율의 청산 거리(%). 못 구하면 null */
  liquidationDistancePct: number | null;
  /** 이 손절에서 안전한 최대 배율. 못 구하면 null */
  maxSafeLeverage: number | null;
  reason: string;
}

/**
 * 이 배율·이 손절로 들어가면 손절이 청산보다 먼저 오는가.
 *
 * **모르면 막는다.** false를 "안전하다"로 읽으면, 확인하지 못한 조합으로
 * 100배 주문이 나간다.
 */
export function liquidationGuard(i: {
  leverage: any;
  stopPct: any;
  /** 거래소 유지증거금률(%). 못 읽으면 기본값을 쓴다 */
  mmrPct?: any;
}): LiquidationGuard {
  const lev = Number(i.leverage);
  const stop = Number(i.stopPct);
  const mmr = Number.isFinite(Number(i.mmrPct)) ? Number(i.mmrPct) : DEFAULT_MMR_PCT;

  if (!Number.isFinite(lev) || lev <= 0 || !Number.isFinite(stop) || stop <= 0) {
    return {
      ok: false, code: 'UNKNOWN', liquidationDistancePct: null, maxSafeLeverage: null,
      reason: `배율(${i.leverage})이나 손절 거리(${i.stopPct})를 읽지 못해 청산 위치를 확인할 수 없습니다 — `
        + '확인하지 못한 것은 안전이 아닙니다',
    };
  }

  const liq = liquidationDistancePct(lev, mmr);
  if (liq == null) {
    return {
      ok: false, code: 'IMMEDIATE_LIQUIDATION', liquidationDistancePct: null,
      maxSafeLeverage: maxLeverageBeforeLiquidation(stop, mmr),
      reason: `${lev}배는 유지증거금 ${mmr}%에서 진입 즉시 청산 구간입니다`,
    };
  }
  const safe = maxLeverageBeforeLiquidation(stop, mmr);
  if (stop >= liq) {
    return {
      ok: false, code: 'STOP_BEYOND_LIQUIDATION',
      liquidationDistancePct: Number(liq.toFixed(4)), maxSafeLeverage: safe,
      reason: `손절 ${stop}%가 청산 거리 ${liq.toFixed(2)}%보다 멀거나 같습니다 — `
        + '손절이 작동하기 전에 청산됩니다(증거금 전액 소멸). '
        + (safe != null ? `이 손절에서는 ${Math.floor(safe)}배까지가 안전합니다` : ''),
    };
  }
  return {
    ok: true, code: 'OK',
    liquidationDistancePct: Number(liq.toFixed(4)), maxSafeLeverage: safe,
    reason: `손절 ${stop}%가 청산 거리 ${liq.toFixed(2)}% 안쪽입니다`,
  };
}
