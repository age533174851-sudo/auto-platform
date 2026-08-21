// src/lib/strategies/tradeIdentity.ts
//
// **"100배"라는 이름과 실제 숫자가 맞는가.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// 화면에 `100배`라고 적혀 있어도, 증거금 → 명목가치 → 가격변화 →
// 수수료 → 손익이 **서로 맞지 않으면** 그건 이름만 100배다.
//
// 실제로 갈릴 수 있는 곳이 여럿이다:
//
//   · 거래소가 100배를 안 받아 75배만 걸렸다
//   · 수량 규격(step/최소 명목) 때문에 실제 명목이 요청과 다르다
//   · 명목 상한이 따로 걸려 실질 노출이 5배 수준이다
//   · 레버리지는 100인데 손절 폭이 좁아 1회 위험은 계좌의 2%다
//
// 넷 다 "틀린 것"은 아니다. **숨기는 것이 틀린 것**이다.
//
// 그리고 가장 중요한 것
// ─────────────────────
// **레버리지는 기대값을 만들지 않는다.** 손익을 확대할 뿐이다.
// 전략의 1회 기대값이 음수면 100배는 파산을 앞당길 뿐이므로, 이 파일은
// "100배라서 번다"는 말을 만들지 않는다 — 숫자가 맞는지만 본다.

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 두 값이 실질적으로 같은가 (상대오차) */
function close(a: number, b: number, tolPct = 0.5): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale * 100 <= tolPct;
}

export interface TradeInputs {
  /** 이 거래에 넣은 증거금(USD) */
  marginUsd?: number | null;
  /** 전략이 요청한 배율 */
  requestedLeverage?: number | null;
  /** **거래소가 실제로 건 배율.** 모르면 null — 요청값으로 대신하지 않는다 */
  actualLeverage?: number | null;
  /** 실제 체결 수량 */
  quantity?: number | null;
  /** 실제 체결가 */
  entryPrice?: number | null;
  /** 왕복 수수료율(%) */
  roundTripFeePct?: number | null;
  /** 손절 트리거가 */
  stopPrice?: number | null;
  side?: 'LONG' | 'SHORT' | null;
}

export type IdentityCode =
  | 'OK'
  /** 숫자가 모자라 검증하지 못했다. **통과가 아니다** */
  | 'INCOMPLETE'
  /** 증거금 × 배율 ≠ 명목가치 */
  | 'NOTIONAL_MISMATCH'
  /** 요청 배율과 실제 배율이 다르다 */
  | 'LEVERAGE_MISMATCH'
  /** 손절이 방향과 안 맞는다 */
  | 'STOP_SIDE_WRONG';

export interface TradeIdentity {
  code: IdentityCode;
  ok: boolean;
  /** 실제 명목가치 = 수량 × 체결가 */
  notionalUsd: number | null;
  /** 증거금 × 실제 배율 (같아야 한다) */
  impliedNotionalUsd: number | null;
  /** 명목 ÷ 증거금 — **실질 배율**. 이름이 아니라 이것이 사실이다 */
  effectiveLeverage: number | null;
  /** 손절까지의 가격 변화(%) */
  stopMovePct: number | null;
  /** 손절이 맞았을 때 계좌에서 빠지는 금액(수수료 포함) */
  lossAtStopUsd: number | null;
  /** 그 손실이 증거금의 몇 %인가 */
  lossOfMarginPct: number | null;
  /** 왕복 수수료(USD) */
  feeUsd: number | null;
  /** 사람이 읽는 한 줄 */
  reason: string;
  /** 화면이 숨기면 안 되는 사실들 */
  notes: string[];
}

/**
 * 거래 한 건의 숫자가 서로 맞는지 본다.
 *
 * **모르는 값을 채워 넣지 않는다.** 실제 배율을 모르면 요청 배율로
 * 대신하지 않는다 — 그 대입이 바로 "이름만 100배"를 만드는 짓이다.
 */
export function tradeIdentity(i: TradeInputs): TradeIdentity {
  const margin = num(i?.marginUsd);
  const req = num(i?.requestedLeverage);
  const act = num(i?.actualLeverage);
  const qty = num(i?.quantity);
  const px = num(i?.entryPrice);
  const feePct = num(i?.roundTripFeePct) ?? 0;
  const stop = num(i?.stopPrice);
  const side = i?.side === 'SHORT' ? 'SHORT' : i?.side === 'LONG' ? 'LONG' : null;

  const notes: string[] = [];
  const empty = {
    notionalUsd: null, impliedNotionalUsd: null, effectiveLeverage: null,
    stopMovePct: null, lossAtStopUsd: null, lossOfMarginPct: null, feeUsd: null,
  };

  if (margin == null || margin <= 0 || qty == null || px == null || px <= 0) {
    return {
      ...empty, code: 'INCOMPLETE', ok: false, notes,
      reason: '증거금 · 수량 · 체결가 중 모르는 값이 있어 검증하지 못했습니다 — 통과가 아닙니다',
    };
  }

  const notionalUsd = Number((qty * px).toFixed(8));
  const effectiveLeverage = Number((notionalUsd / margin).toFixed(4));
  const feeUsd = Number((notionalUsd * (feePct / 100)).toFixed(8));

  // 요청 배율과 실제 배율이 다르면 **그 사실을 먼저 말한다.**
  if (req != null && act != null && !close(req, act, 0.5)) {
    notes.push(`요청 ${req}배 · 실제 ${act}배 — 화면에 요청값만 적으면 안 됩니다`);
  }
  // 이름과 실질이 다른 경우(명목 상한·수량 규격 때문에 노출이 작아진 경우)
  if (req != null && !close(req, effectiveLeverage, 5)) {
    notes.push(`이름은 ${req}배지만 실질 배율은 ${effectiveLeverage}배입니다 (명목 ${notionalUsd} ÷ 증거금 ${margin})`);
  }

  let stopMovePct: number | null = null;
  let lossAtStopUsd: number | null = null;
  let lossOfMarginPct: number | null = null;
  let sideWrong = false;
  if (stop != null && stop > 0) {
    const movePct = ((px - stop) / px) * 100;
    if (side === 'LONG' && movePct <= 0) sideWrong = true;
    if (side === 'SHORT' && movePct >= 0) sideWrong = true;
    stopMovePct = Number(Math.abs(movePct).toFixed(6));
    // 손절이 맞았을 때 잃는 금액 = 명목 × 가격변화% + 왕복 수수료
    lossAtStopUsd = Number((notionalUsd * (stopMovePct / 100) + feeUsd).toFixed(8));
    lossOfMarginPct = Number((lossAtStopUsd / margin * 100).toFixed(4));
    if (lossOfMarginPct >= 100) {
      notes.push(`손절 한 번에 증거금의 ${lossOfMarginPct.toFixed(0)}%가 사라집니다 — 손절보다 청산이 먼저 옵니다`);
    }
  }

  const base = {
    notionalUsd, impliedNotionalUsd: act != null ? Number((margin * act).toFixed(8)) : null,
    effectiveLeverage, stopMovePct, lossAtStopUsd, lossOfMarginPct, feeUsd,
  };

  if (sideWrong) {
    return { ...base, code: 'STOP_SIDE_WRONG', ok: false, notes,
      reason: `손절가가 ${side} 방향과 맞지 않습니다 — 진입 즉시 맞거나 영원히 안 맞습니다` };
  }
  if (act != null && !close(margin * act, notionalUsd, 2)) {
    return {
      ...base, code: 'NOTIONAL_MISMATCH', ok: false, notes,
      reason: `증거금 × 배율(${(margin * act).toFixed(2)})과 실제 명목가치(${notionalUsd.toFixed(2)})가 다릅니다 — `
        + '둘 중 하나는 화면에 잘못 적힌 값입니다',
    };
  }
  if (req != null && act != null && !close(req, act, 0.5)) {
    return {
      ...base, code: 'LEVERAGE_MISMATCH', ok: false, notes,
      reason: `요청 ${req}배 · 실제 ${act}배 — 거래소가 요청대로 걸지 않았습니다`,
    };
  }

  return {
    ...base, code: 'OK', ok: true, notes,
    reason: `증거금 ${margin} × ${act ?? effectiveLeverage}배 = 명목 ${notionalUsd.toFixed(2)}`
      + (lossOfMarginPct != null ? ` · 손절 시 증거금의 ${lossOfMarginPct.toFixed(1)}%` : ''),
  };
}

// ── 우위는 가정인가 측정인가 ──────────────────────────

export type EdgeSource =
  /** 사람이 "이만큼 맞힌다고 치자"고 넣은 값 */
  | 'ASSUMED'
  /** 백테스트에서 나온 값 */
  | 'BACKTEST'
  /** 실거래 기록에서 나온 값 */
  | 'REALIZED';

export interface EdgeClaim {
  /** 이 숫자를 "전략의 우위"라고 말해도 되는가 */
  proven: boolean;
  source: EdgeSource;
  /** 화면이 그대로 적을 말 */
  label: string;
  reason: string;
}

/**
 * **가정한 우위를 측정한 우위처럼 말하지 않는다.**
 *
 * 화면의 `우위 +10%p` 버튼은 **입력한 가정**이다. 그런데 그 버튼을
 * 켜면 수익이 나고 끄면 청산이 쏟아지는 것을 보고 "이 전략은 우위가
 * 10%면 된다"로 읽기 쉽다. 그건 전략의 성질이 아니라 **산수의 성질**이다 —
 * 승률을 올려 넣었으니 결과가 좋아지는 것이 당연하다.
 *
 * 그래서 값에 출처를 붙인다. 증거 없는 우위는 언제나 `ASSUMED`이고,
 * 그 위에서 나온 결과는 "이 가정이 맞다면"이라는 조건문이다.
 */
export function edgeClaimOf(i: { edgePp?: number | null; source?: EdgeSource | null }): EdgeClaim {
  const pp = num(i?.edgePp) ?? 0;
  const src: EdgeSource = i?.source === 'BACKTEST' || i?.source === 'REALIZED' ? i.source : 'ASSUMED';

  if (pp === 0) {
    return { proven: true, source: src, label: '무우위 기준',
      reason: '방향을 못 맞힌다고 보고 계산한 값입니다 — 가장 보수적인 기준선입니다' };
  }
  if (src === 'ASSUMED') {
    return {
      proven: false, source: 'ASSUMED', label: `가정: 우위 +${pp}%p`,
      reason: '입력한 가정이지 측정한 값이 아닙니다 — 이 가정이 맞다는 증거는 아직 없습니다. '
        + '아래 숫자는 전부 "이 가정이 사실이라면"입니다',
    };
  }
  return {
    proven: true, source: src, label: `${src === 'BACKTEST' ? '백테스트' : '실거래'} 우위 +${pp}%p`,
    reason: src === 'BACKTEST'
      ? '백테스트에서 나온 값입니다 — 표본·기간·비용 가정을 같이 보세요'
      : '실거래 기록에서 나온 값입니다',
  };
}

export interface FragilityVerdict {
  code: 'ROBUST_ZONE' | 'SINGLE_POINT' | 'SCATTERED' | 'NONE';
  ok: boolean;
  reason: string;
}

/**
 * **한 점에서만 좋은 것은 우위가 아니다.**
 *
 * 우위를 0%p부터 한 칸씩 올리면 결과는 **매끄럽게** 좋아져야 한다.
 * +10%p에서만 갑자기 좋고 +9와 +11에서 나쁘다면, 그건 전략의 성질이
 * 아니라 난수나 임계값이 만든 무늬다.
 */
export function edgeFragility(
  points: Array<{ edgePp: number; tradable?: boolean; grade?: string }> | null | undefined,
): FragilityVerdict {
  const list = (Array.isArray(points) ? points : [])
    .slice().sort((a, b) => (num(a?.edgePp) ?? 0) - (num(b?.edgePp) ?? 0));
  const good = list.filter(p => p?.tradable === true || String(p?.grade).toUpperCase() === 'ROBUST');

  if (good.length === 0) {
    return { code: 'NONE', ok: false,
      reason: '어느 우위 가정에서도 견고하지 않았습니다' };
  }
  if (good.length === 1) {
    return {
      code: 'SINGLE_POINT', ok: false,
      reason: `+${good[0].edgePp}%p 한 점에서만 좋습니다 — 전략의 성질이 아니라 `
        + '난수나 임계값이 만든 무늬일 수 있습니다',
    };
  }
  // 이어지는 구간이 있는가
  let best = 1; let run = 1;
  for (let k = 1; k < good.length; k++) {
    const idxPrev = list.indexOf(good[k - 1]);
    const idxCur = list.indexOf(good[k]);
    if (idxCur === idxPrev + 1) { run++; best = Math.max(best, run); }
    else run = 1;
  }
  if (best < 2) {
    return {
      code: 'SCATTERED', ok: false,
      reason: '좋은 지점이 흩어져 있고 이어지는 구간이 없습니다 — 구간이 아니라 점입니다',
    };
  }
  return {
    code: 'ROBUST_ZONE', ok: true,
    reason: `이어지는 견고 구간이 ${best}칸입니다 — 우위가 조금 달라져도 결과가 유지됩니다`,
  };
}
