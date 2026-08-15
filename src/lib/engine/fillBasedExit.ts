// src/lib/engine/fillBasedExit.ts
//
// **손절은 실제로 산 가격에서 재야 한다.**
//
// 지금까지 어떻게 계산했나
// ────────────────────────
// 원본 v1은 09:10~09:30 합성 봉의 종가(`windowClose`)를 진입가로 놓고
// 거기서 −0.4% / +0.8%를 계산해 실행기에 넘겼다. 그런데 그 값은
// **주문을 내기 전의 참고가**다. 시장가 주문은 그 가격에 체결되지 않는다:
//
//   · 판단 종가와 주문 전송 사이에 시간이 흐른다
//   · 100배 명목가는 호가를 여러 단계 먹는다(슬리피지)
//   · 유동성이 얇으면 부분 체결로 평균가가 더 밀린다
//
// 그래서 실제 체결가가 참고가보다 0.2% 밀리면, 의도한 −0.4% 손절이
// 실제로는 −0.2%가 되거나 −0.6%가 된다. **100배에서 0.2%는 증거금의
// 20%다.** 그리고 청산 거리가 0.6%이므로, 밀리는 방향이 나쁘면
// 손절이 청산 바깥으로 나간다 — 손절이 걸려 있는데 청산이 먼저 온다.
//
// 그래서 이 파일이 정하는 것
// ──────────────────────────
// **체결이 확정되기 전에는 보호주문 가격을 고정하지 않는다.**
// 실제 평균 체결가(avgPrice)와 실제 체결 수량(filledQty)을 먼저 확정하고,
// 그 가격에서 전략의 %를 다시 계산하고, 호가 단위에 맞춘 뒤에 건다.
//
// 체결가를 못 읽으면 계산하지 않는다 — 참고가로 대신하지 않는다.
// 그게 지금 고치는 고장 자체다.

export interface FillBasis {
  /** 이 값들로 보호주문 가격을 계산해도 되는가 */
  ok: boolean;
  code: 'OK' | 'NO_FILL_PRICE' | 'NO_FILL_QTY' | 'NOT_SETTLED';
  /** 실제 평균 체결가 */
  avgPrice: number | null;
  /** 실제 체결 수량 */
  filledQty: number | null;
  reason: string;
}

const num = (v: any): number | null => {
  // `Number(null) === 0`이다. 이 저장소에서 반복해서 물린 함정이라
  // 빈 값·불리언은 여기서 전부 막는다.
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 실제 체결을 보호주문의 기준으로 삼아도 되는가.
 *
 * **`settled`가 false면 아직 모른다는 뜻이지 실패가 아니다.** 그래도
 * 여기서는 통과시키지 않는다 — 모르는 체결가로 손절을 걸면 그 손절은
 * 아무 근거가 없다.
 */
export function fillBasis(i: {
  avgPrice?: any; filledQty?: any; settled?: boolean | null;
}): FillBasis {
  const price = num(i?.avgPrice);
  const qty = num(i?.filledQty);

  if (price == null || price <= 0) {
    return { ok: false, code: 'NO_FILL_PRICE', avgPrice: null, filledQty: qty,
      reason: '실제 평균 체결가를 읽지 못했습니다 — 판단 참고가로 대신 계산하지 않습니다' };
  }
  if (qty == null || qty <= 0) {
    return { ok: false, code: 'NO_FILL_QTY', avgPrice: price, filledQty: null,
      reason: '실제 체결 수량이 0이거나 읽히지 않습니다 — 보호할 포지션이 확정되지 않았습니다' };
  }
  if (i?.settled === false) {
    return { ok: false, code: 'NOT_SETTLED', avgPrice: price, filledQty: qty,
      reason: '체결이 아직 확정되지 않았습니다 — 확정 뒤에 그 가격으로 보호주문을 겁니다' };
  }
  return { ok: true, code: 'OK', avgPrice: price, filledQty: qty,
    reason: `실제 체결 ${qty} @ ${price}` };
}

export interface RoundedTrigger {
  price: number | null;
  /** 값이 바뀌었으면 그 사실. **조용히 바꾸지 않는다** */
  note: string;
}

/**
 * 트리거 가격을 호가 단위에 맞춘다.
 *
 * 방향이 중요하다. `gatePlan`이 이미 쓰고 있는 원칙과 **같게** 맞춘다:
 *   · 손절은 진입에서 **멀어지는** 쪽 — 한 틱 일찍 터지지 않게
 *   · 익절은 진입에서 **멀어지는** 쪽 — 한 틱 일찍 체결되지 않게
 *
 * 두 경우 모두 "불리한 쪽"이다. 한 틱 손해가 안 걸리는 손절이나
 * 즉시 체결되는 익절보다 낫다.
 */
export function roundTrigger(
  price: number, side: 'LONG' | 'SHORT', kind: 'STOP' | 'TAKE_PROFIT',
  tickSize?: number | null,
): RoundedTrigger {
  const p0 = num(price);
  if (p0 == null || p0 <= 0) return { price: null, note: '' };
  const tick = num(tickSize);
  if (tick == null || tick <= 0) return { price: p0, note: '' };

  // LONG 손절은 아래(내림) · LONG 익절은 위(올림)
  // SHORT 손절은 위(올림) · SHORT 익절은 아래(내림)
  const up = (side === 'LONG') === (kind === 'TAKE_PROFIT');
  const eps = 1e-9;
  const n = p0 / tick;
  const k = up ? Math.ceil(n - eps) : Math.floor(n + eps);
  const dec = Math.max(0, Math.min(12, Math.round(-Math.log10(tick))));
  const p = Number((k * tick).toFixed(dec));
  if (!(p > 0)) return { price: null, note: `${p0}을 호가 단위 ${tick}에 맞추면 0이 됩니다` };
  return { price: p, note: p === p0 ? '' : `${p0} → ${p} (호가 단위 ${tick})` };
}

export interface FillBasedExit {
  ok: boolean;
  code: 'OK' | 'NO_BASIS' | 'BAD_PCT' | 'BAD_PRICE';
  stop: number | null;
  takeProfit: number | null;
  /** 실제로 쓴 기준가 */
  basisPrice: number | null;
  /** 참고가와 얼마나 벌어졌는가(%). 기록용이고 판정에는 안 쓴다 */
  slippagePct: number | null;
  note: string;
  reason: string;
}

/**
 * 실제 체결가에서 손절·익절 가격을 만든다.
 *
 * **부호는 여기 한 곳에서만 정한다.** 두 곳에 두면 한쪽만 고쳐지고,
 * 그때 손절이 진입 위에 걸린다 — 걸자마자 발동한다.
 */
export function exitFromFill(i: {
  side: 'LONG' | 'SHORT';
  basis: FillBasis;
  stopPct: number;
  takeProfitPct?: number | null;
  tickSize?: number | null;
  /** 판단에 쓴 참고가. 미끄러진 정도를 기록하는 데만 쓴다 */
  referencePrice?: number | null;
}): FillBasedExit {
  const none = { stop: null, takeProfit: null, basisPrice: null, slippagePct: null, note: '' };

  if (!i?.basis?.ok || i.basis.avgPrice == null) {
    return { ...none, ok: false, code: 'NO_BASIS',
      reason: i?.basis?.reason || '실제 체결을 확인하지 못했습니다' };
  }
  const entry = i.basis.avgPrice;
  const sp = num(i.stopPct);
  if (sp == null || sp <= 0 || sp >= 100) {
    return { ...none, ok: false, code: 'BAD_PCT', basisPrice: entry,
      reason: `손절 비율이 유효하지 않습니다 (${i.stopPct})` };
  }
  const tp = num(i.takeProfitPct);

  const dir = i.side === 'LONG' ? 1 : -1;
  const stopRaw = entry * (1 - dir * sp / 100);
  const tpRaw = tp != null && tp > 0 ? entry * (1 + dir * tp / 100) : null;

  const rs = roundTrigger(stopRaw, i.side, 'STOP', i.tickSize);
  const rt = tpRaw == null ? { price: null, note: '' } : roundTrigger(tpRaw, i.side, 'TAKE_PROFIT', i.tickSize);

  if (rs.price == null) {
    return { ...none, ok: false, code: 'BAD_PRICE', basisPrice: entry,
      reason: `손절가를 만들지 못했습니다 — ${rs.note || '호가 단위 보정 실패'}` };
  }
  // 방향 확인. 여기서 걸리면 계산이 틀린 것이므로 **주문을 내지 않는다.**
  const badStop = i.side === 'LONG' ? rs.price >= entry : rs.price <= entry;
  if (badStop) {
    return { ...none, ok: false, code: 'BAD_PRICE', basisPrice: entry,
      reason: `${i.side} 체결가 ${entry} / 손절 ${rs.price} — 손절이 진입 반대편에 있어 즉시 발동합니다` };
  }
  if (rt.price != null) {
    const badTp = i.side === 'LONG' ? rt.price <= entry : rt.price >= entry;
    if (badTp) {
      return { ...none, ok: false, code: 'BAD_PRICE', basisPrice: entry,
        reason: `${i.side} 체결가 ${entry} / 익절 ${rt.price} — 익절이 진입 반대편에 있어 즉시 체결됩니다` };
    }
  }

  const ref = num(i.referencePrice);
  const slip = ref != null && ref > 0 ? Number((((entry - ref) / ref) * 100).toFixed(4)) : null;

  return {
    ok: true, code: 'OK',
    stop: rs.price, takeProfit: rt.price,
    basisPrice: entry, slippagePct: slip,
    note: [rs.note, rt.note].filter(Boolean).join(' · '),
    reason: `실제 체결가 ${entry} 기준 · 손절 ${rs.price}`
      + (rt.price != null ? ` · 익절 ${rt.price}` : '')
      + (slip != null ? ` · 참고가 대비 ${slip > 0 ? '+' : ''}${slip}%` : ''),
  };
}
