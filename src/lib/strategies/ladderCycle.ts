// src/lib/strategies/ladderCycle.ts
//
// **10배 문턱을 넘을 때만 주문 크기가 바뀐다.**
//
// 무엇이 다른가 — 그리고 왜 이게 중요한가
// ────────────────────────────────────────
// 저장소의 기존 크기 계산(`riskManager` · `leverageMath` · `dynamicSizing`)은
// 전부 **연속 복리**다. 잔고가 $1,120이면 주문이 $112가 되고 $1,350이면
// $135가 된다.
//
// 이 전략은 그게 아니다. **자릿수 구간이 크기를 정한다:**
//
//     $100 ~ $999      →  주문 증거금 $10
//     $1,000 ~ $9,999  →  주문 증거금 $100
//     $10,000 ~ $99,999→  주문 증거금 $1,000
//     $100,000         →  그 회차 완료
//
// $500이든 $900이든 같은 $10이고, $3,000이든 $9,900이든 같은 $100이다.
// 문턱을 넘는 순간에만 10배로 뛴다.
//
// 왜 비율이 아니라 자릿수인가
// ───────────────────────────
// 비율 방식은 잔고가 늘면 주문도 매 거래 늘어난다. 100배에서는 그 증가가
// 손실 충격도 같이 키워서, 연속 손실 구간에서 회복이 안 되는 자리가 생긴다.
// 자릿수 방식은 한 구간 안에서 **주문 크기가 고정**이라, 그 구간을 몇 번
// 이길 수 있는지가 명확하다.
//
// 계좌 잔고를 쓰지 않는다
// ───────────────────────
// **테스트넷 계좌에는 시작금과 무관한 가상 자금이 들어 있다.** 그걸
// 기준으로 크기를 정하면 $1,000 → $10,000 → $100,000 규칙을 시험하는
// 것이 아니라 거래소가 넣어 준 잔고를 시험하게 된다.
//
// 그래서 전략마다 **가상 원장(cycleEquity)**을 따로 둔다. 여기에는 실제
// 체결 손익·수수료·펀딩만 더하고 뺀다.
//
// 여기서 안 하는 것
// ─────────────────
// **$100 미만과 $100,000 초과의 규칙은 정의되지 않았다.** 사용자가 말한
// 것은 세 구간뿐이고, 없는 규칙을 이어서 만들면 그건 다른 전략이다.
// 그 바깥은 주문을 만들지 않고 그 사실을 말한다.

/** 이 금액에 닿으면 회차 완료 */
export const CYCLE_TARGET_USD = 100_000;

/** 규칙이 정의된 최저 금액. 이 아래는 주문을 만들지 않는다 */
export const CYCLE_FLOOR_USD = 100;

/** 자릿수 구간표. **연속 함수가 아니라 표다** — 값으로 확인할 수 있어야 한다 */
export const LADDER_BANDS: Array<{ floor: number; marginUsd: number; label: string }> = [
  { floor: 10_000, marginUsd: 1_000, label: '$10,000~$99,999' },
  { floor: 1_000, marginUsd: 100, label: '$1,000~$9,999' },
  { floor: 100, marginUsd: 10, label: '$100~$999' },
];

export type OrderSizeCode =
  | 'OK'
  /** 회차 목표에 닿았다 — 더 넣지 않는다 */
  | 'TARGET_REACHED'
  /** $100 미만 — 규칙이 정의되지 않았다 */
  | 'BELOW_FLOOR'
  /** 숫자가 아니다. **0으로 읽지 않는다** */
  | 'UNKNOWN';

export interface OrderSizeVerdict {
  ok: boolean;
  code: OrderSizeCode;
  /** 이번 주문에 쓸 증거금(USD). 못 정하면 null */
  marginUsd: number | null;
  /** 어느 구간인가 */
  bandFloor: number | null;
  bandLabel: string;
  reason: string;
}

/** null·빈 문자열·boolean은 숫자가 아니다. **`Number(null) === 0`을 막는다** */
function num(v: any): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 이번 주문에 쓸 증거금.
 *
 * **구간표를 위에서부터 훑는다.** 계산식(`10 ** (floor(log10(e)) - 1)`)으로
 * 쓰면 $1,000 같은 정확한 경계에서 부동소수점 때문에 한 칸 아래로 떨어질
 * 수 있고, 그러면 주문이 10분의 1이 된다. 그 고장은 조용하다 —
 * 주문은 나가고 크기만 틀리다.
 */
export function orderMarginFor(cycleEquity: any): OrderSizeVerdict {
  const e = num(cycleEquity);
  if (e == null) {
    return {
      ok: false, code: 'UNKNOWN', marginUsd: null, bandFloor: null, bandLabel: '',
      reason: '가상 원장 잔고를 읽지 못했습니다 — 0으로 보지 않고 주문을 만들지 않습니다',
    };
  }
  if (e >= CYCLE_TARGET_USD) {
    return {
      ok: false, code: 'TARGET_REACHED', marginUsd: null, bandFloor: null, bandLabel: '',
      reason: `회차 목표 $${CYCLE_TARGET_USD.toLocaleString()}에 도달했습니다 — 이 회차는 더 진입하지 않습니다`,
    };
  }
  for (const b of LADDER_BANDS) {
    if (e >= b.floor) {
      return {
        ok: true, code: 'OK', marginUsd: b.marginUsd,
        bandFloor: b.floor, bandLabel: b.label,
        reason: `${b.label} 구간 — 주문 증거금 $${b.marginUsd.toLocaleString()} 고정`,
      };
    }
  }
  return {
    ok: false, code: 'BELOW_FLOOR', marginUsd: null, bandFloor: null, bandLabel: '',
    reason: `가상 원장이 $${CYCLE_FLOOR_USD} 미만($${e})입니다 — 이 구간의 주문 규칙은 정해진 것이 없어 진입하지 않습니다`,
  };
}

// ── 회차 ─────────────────────────────────────────────

export type CycleState =
  /** 돌고 있다 */
  | 'RUNNING'
  /** 목표 도달 — 성과를 확정하고 다음 회차를 새 시드로 시작한다 */
  | 'COMPLETE'
  /** $100 아래로 내려갔다 — 규칙이 없는 구간이다 */
  | 'BELOW_FLOOR'
  /** 읽지 못했다. **비어 있음이 아니다** */
  | 'UNKNOWN';

export interface CycleStatus {
  state: CycleState;
  /** 이 회차를 시작한 금액 */
  seedUsd: number | null;
  /** 지금 가상 원장 잔고 */
  equityUsd: number | null;
  /** 시드 대비 손익 */
  pnlUsd: number | null;
  /** 목표까지 몇 배 남았는가. 모르면 null */
  toTargetX: number | null;
  size: OrderSizeVerdict;
  reason: string;
}

export function cycleStatusOf(i: { seedUsd: any; equityUsd: any }): CycleStatus {
  const seed = num(i.seedUsd);
  const eq = num(i.equityUsd);
  const size = orderMarginFor(eq);

  if (eq == null) {
    return {
      state: 'UNKNOWN', seedUsd: seed, equityUsd: null, pnlUsd: null, toTargetX: null,
      size, reason: '가상 원장을 읽지 못했습니다',
    };
  }
  const pnl = seed == null ? null : Number((eq - seed).toFixed(2));
  const toTargetX = eq > 0 ? Number((CYCLE_TARGET_USD / eq).toFixed(2)) : null;

  if (size.code === 'TARGET_REACHED') {
    return {
      state: 'COMPLETE', seedUsd: seed, equityUsd: eq, pnlUsd: pnl, toTargetX: 1,
      size, reason: size.reason,
    };
  }
  if (size.code === 'BELOW_FLOOR') {
    return {
      state: 'BELOW_FLOOR', seedUsd: seed, equityUsd: eq, pnlUsd: pnl, toTargetX,
      size, reason: size.reason,
    };
  }
  return {
    state: 'RUNNING', seedUsd: seed, equityUsd: eq, pnlUsd: pnl, toTargetX,
    size, reason: size.reason,
  };
}

/**
 * 체결 손익을 가상 원장에 반영한다.
 *
 * **실제로 확정된 것만 더한다.** 미실현 손익을 반영하면 포지션이 열려
 * 있는 동안 구간이 오르내리고, 같은 회차 안에서 주문 크기가 흔들린다.
 *
 * 수수료·펀딩은 이미 부호가 붙어 들어온다(비용이면 음수).
 */
export function applyRealized(equityUsd: any, realizedPnlUsd: any): number | null {
  const e = num(equityUsd);
  const p = num(realizedPnlUsd);
  if (e == null || p == null) return null;
  // 센트 단위로 끊는다. 부동소수점 누적으로 $999.9999999가 되면 구간이
  // 한 칸 떨어지고, 그때 주문이 10분의 1이 된다.
  return Number((e + p).toFixed(2));
}

/**
 * 다음 회차의 시드.
 *
 * **목표에 닿았다고 거래소 잔고를 건드리지 않는다.** 회차를 COMPLETE로
 * 적고 가상 원장만 처음 시드로 되돌린다 — 성과 기록은 그 회차에 남는다.
 */
export function nextCycleSeed(firstSeedUsd: any): number | null {
  return num(firstSeedUsd);
}
