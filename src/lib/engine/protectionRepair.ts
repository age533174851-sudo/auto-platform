// src/lib/engine/protectionRepair.ts
//
// **어긋난 보호 주문을 어떻게 다시 맞추는가.**
//
// 무엇이 없었나
// ─────────────
// `orderCycle.cycleState`는 `PROTECTION_QTY_MISMATCH`를 판정한다. 그리고
// 거기서 끝난다. 화면에는 "보호 주문이 1.0을 덮는데 포지션은 0.4입니다"가
// 뜨고, **그것을 어떻게 맞추는지는 아무 데도 없다.**
//
// 부분청산을 한 번이라도 하면 이 상태가 된다. 절반을 닫아도 손절은 그대로
// 전량을 덮고 있고, 반대로 물타기로 늘리면 손절은 처음 크기만 덮는다.
// 어느 쪽이든 사용자는 거래소 앱을 열어 손으로 지우고 다시 건다 —
// 막힌 자리에서 푸는 방법이 없으면 그건 안전장치가 아니라 막다른 길이다.
//
// 이 파일이 정하는 것: **순서.**
// ──────────────────────────────
// 수량을 바꾸려면 취소하고 다시 걸어야 한다. 그 사이가 문제다.
//
//   취소 → 걸기 :  그 사이에 **보호가 하나도 없다**
//   걸기 → 취소 :  그 사이에 **보호가 둘이다**
//
// 둘 중에는 뒤가 낫다. 둘 다 reduceOnly면 먼저 발동한 쪽이 포지션을 닫고
// 나머지는 닫을 것이 없어 무시된다 — 최악이 '아무 일도 안 일어남'이다.
// 앞을 고르면 그 몇 초 사이의 급락이 보호 없는 포지션을 친다.
//
// 다만 **기존 보호에 reduceOnly가 안 붙어 있으면 뒤가 더 나쁘다.** 둘 다
// 발동하면 하나는 포지션을 닫고 하나는 반대 포지션을 연다. 그래서 그때만
// 취소를 먼저 하고, 그 틈이 있다는 것을 명시한다. 조용히 고르지 않는다.
//
// 그리고 하지 않는 것
// ───────────────────
// **포지션을 건드리지 않는다.** 이 파일이 만드는 계획에는 포지션을 닫는
// 단계가 없다. 보호 주문이 안 맞는다고 포지션을 정리하면, 사용자가 의도한
// 자리가 수수료만 남기고 사라진다. 어긋난 것은 보호 주문이지 포지션이 아니다.

/** 무엇을 해야 하는가 */
export type RepairKind =
  /** 맞다. 할 일 없음 */
  | 'NONE'
  /** 모른다. **아무것도 하지 않는다** */
  | 'WAIT'
  /** 보호가 없다 — 새로 건다 */
  | 'ATTACH'
  /** 수량이 안 맞는다 — 다시 건다 */
  | 'RESIZE'
  /** 포지션이 없다 — 남은 것을 취소한다 */
  | 'CANCEL'
  /** 자동으로 만들 수 없다 — 사람이 거래소에서 본다 */
  | 'MANUAL';

export interface RepairInput {
  symbol?: string;
  /**
   * 지금 포지션 수량(절대값). **못 읽었으면 null이다** —
   * 0으로 눕히면 '포지션 없음'이 되어 멀쩡한 손절을 취소하는 계획이 나온다.
   */
  positionQty?: number | null;
  /** 포지션 방향. 보호 주문의 방향을 정한다 */
  positionSide?: 'LONG' | 'SHORT' | null;
  /**
   * 보호 주문이 덮는 수량. **못 읽었으면 null.**
   * 전량 종료형이면 이 값 대신 closesAll을 쓴다.
   */
  protectionQty?: number | null;
  /** 보호 주문이 '남은 전부'를 닫는 형태인가 (closePosition / auto_size) */
  protectionClosesAll?: boolean;
  /** 취소할 대상. 없으면 취소 단계를 만들 수 없다 */
  protectionOrderId?: string | null;
  /**
   * 기존 보호 주문에 reduceOnly가 붙어 있는가. **모르면 null이다** —
   * 이 값이 순서를 정한다. 모르면 안전한 쪽(취소 먼저)으로 간다.
   */
  protectionReduceOnly?: boolean | null;
  /**
   * 보호 주문의 발동 가격. **모르면 다시 걸 수 없다** —
   * 지어낸 가격으로 손절을 거는 것은 손절이 없는 것보다 나쁘다.
   */
  stopPrice?: number | null;
}

export interface RepairStep {
  op: 'PLACE' | 'CANCEL';
  /** CANCEL 대상 */
  orderId?: string | null;
  /** PLACE 수량. closesAll이면 null */
  qty?: number | null;
  closesAll?: boolean;
  stopPrice?: number | null;
  side?: 'BUY' | 'SELL' | null;
  reduceOnly?: boolean;
  /** 사람이 읽는 한 줄 */
  label: string;
}

export interface RepairPlan {
  kind: RepairKind;
  /** 왜 이 계획인가 */
  reason: string;
  /** **순서대로** 실행한다. 순서가 안전을 정한다 */
  steps: RepairStep[];
  /**
   * 지금 보호되지 않은 수량. 0보다 크면 그만큼이 맨몸이다.
   * 못 읽었으면 null.
   */
  uncoveredQty: number | null;
  /** 지금 손을 써야 하는가 */
  urgent: boolean;
  /**
   * 이 계획을 실행하는 동안 **보호가 비는 순간이 있는가.**
   * 있으면 화면이 그렇게 말해야 한다 — 조용히 비우지 않는다.
   */
  momentaryGap: boolean;
  /**
   * 확인 없이 실행해도 되는가.
   *
   * 이 계획은 보호 주문만 만지고 포지션을 건드리지 않으므로 대체로 true다.
   * 모르는 값 위에서 만든 계획(WAIT/MANUAL)은 애초에 실행할 단계가 없다.
   */
  safeToAutomate: boolean;
}

const numOrNull = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 수량 비교는 상대 오차로. 거래소마다 자릿수가 다르다 (orderCycle과 같은 기준) */
function qtyClose(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale < 1e-6;
}

/** 포지션을 닫는 방향 */
export function closeSideOf(side: 'LONG' | 'SHORT' | null | undefined): 'BUY' | 'SELL' | null {
  if (side === 'LONG') return 'SELL';
  if (side === 'SHORT') return 'BUY';
  return null;
}

const fmt = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Number(n.toFixed(8)));

const plan = (p: Partial<RepairPlan> & { kind: RepairKind; reason: string }): RepairPlan => ({
  steps: [], uncoveredQty: null, urgent: false,
  momentaryGap: false, safeToAutomate: false, ...p,
});

/**
 * 보호 주문을 포지션에 맞추는 계획.
 *
 * **관측한 사실만 받는다.** 거래소를 안 부르고 저장소도 안 읽는다 —
 * 그래야 실제 왕복 없이 순서에 테스트를 붙일 수 있다.
 */
export function repairPlan(input: RepairInput | null | undefined): RepairPlan {
  const i = input ?? ({} as RepairInput);
  const pos = numOrNull(i.positionQty);
  const closesAll = i.protectionClosesAll === true;
  const pq = numOrNull(i.protectionQty);
  const stopPrice = numOrNull(i.stopPrice);
  const orderId = i.protectionOrderId || null;
  const hasProtection = closesAll || orderId != null || (pq != null && pq > 0);

  // ── 1. 포지션을 모른다 ──
  //
  // 여기서 0으로 눕히면 계획이 '남은 보호 취소'가 되고, 조회가 한 번
  // 흔들릴 때마다 멀쩡한 포지션의 유일한 손절을 지운다.
  if (pos == null) {
    return plan({
      kind: 'WAIT',
      reason: '포지션 수량을 읽지 못했습니다 — 모르는 위에서 보호 주문을 고치지 않습니다',
    });
  }

  const size = Math.abs(pos);

  // ── 2. 포지션이 없다 ──
  if (size <= 0) {
    if (!hasProtection) {
      return plan({ kind: 'NONE', reason: '포지션 없음 · 남은 보호 주문 없음', uncoveredQty: 0 });
    }
    if (!orderId) {
      return plan({
        kind: 'MANUAL', uncoveredQty: 0, urgent: true,
        reason: '포지션이 없는데 보호 주문이 남아 있습니다 — 그런데 취소할 주문 번호를 모릅니다',
      });
    }
    return plan({
      kind: 'CANCEL', uncoveredQty: 0, urgent: true, safeToAutomate: true,
      reason: '포지션이 없는데 보호 주문이 살아 있습니다 — 두면 다음 진입이 이 손절에 걸립니다',
      steps: [{
        op: 'CANCEL', orderId,
        label: `남은 보호 주문 ${orderId}을(를) 취소합니다`,
      }],
    });
  }

  // ── 3. 전량 종료형이면 언제나 맞다 ──
  //
  // closePosition/auto_size는 발동 시점의 '남은 전부'를 닫는다. 부분청산을
  // 몇 번 하든 다시 걸 일이 없다 — 이 형태로 걸어 두는 것이 근본 해결이다.
  if (closesAll) {
    return plan({
      kind: 'NONE', uncoveredQty: 0,
      reason: '보호 주문이 전량 종료형입니다 — 부분청산을 해도 남은 전부를 덮습니다',
    });
  }

  // ── 4. 보호 수량을 모른다 ──
  if (pq == null) {
    if (!hasProtection) {
      // 보호가 아예 없는 것으로 관측됐다. 이건 '모름'이 아니다.
      return attachPlan(size, stopPrice, i.positionSide);
    }
    return plan({
      kind: 'WAIT', uncoveredQty: null, urgent: false,
      reason: '보호 주문이 얼마를 덮는지 확인하지 못했습니다 — 확인 전에는 고치지 않습니다',
    });
  }

  if (pq <= 0) return attachPlan(size, stopPrice, i.positionSide);

  // ── 5. 맞는가 ──
  if (qtyClose(pq, size)) {
    return plan({ kind: 'NONE', uncoveredQty: 0, reason: '보호 주문 수량이 포지션과 일치합니다' });
  }

  // ── 6. 안 맞는다 ──
  const uncovered = Math.max(0, size - pq);
  const over = pq > size;

  // reduceOnly가 붙어 있으면 초과분은 거래소가 무시한다. 안 붙어 있거나
  // 모르면, 발동 시 초과분이 **반대 포지션을 연다.**
  const oldSafe = i.protectionReduceOnly === true;

  if (stopPrice == null) {
    return plan({
      kind: 'MANUAL', uncoveredQty: uncovered, urgent: uncovered > 0 || !oldSafe,
      reason: `보호 주문이 ${fmt(pq)}를 덮는데 포지션은 ${fmt(size)}입니다 — `
        + '발동 가격을 읽지 못해 다시 걸 수 없습니다. 거래소에서 직접 수정하세요',
    });
  }

  const side = closeSideOf(i.positionSide);
  const place: RepairStep = {
    op: 'PLACE', qty: size, stopPrice, side, reduceOnly: true, closesAll: false,
    label: `보호 주문을 ${fmt(size)}로 새로 겁니다 (발동가 ${fmt(stopPrice)}${side ? ` · ${side}` : ''})`,
  };
  const cancel: RepairStep | null = orderId
    ? { op: 'CANCEL', orderId, label: `기존 보호 주문 ${orderId}을(를) 취소합니다` }
    : null;

  if (!cancel) {
    // 취소할 주문을 지목하지 못하면, 새로 걸었다가 둘이 남는다.
    return plan({
      kind: 'MANUAL', uncoveredQty: uncovered, urgent: uncovered > 0 || !oldSafe,
      reason: `보호 주문이 ${fmt(pq)}를 덮는데 포지션은 ${fmt(size)}입니다 — `
        + '기존 주문 번호를 몰라 자동으로 바꿀 수 없습니다',
    });
  }

  // **순서가 여기서 갈린다.**
  const steps = oldSafe ? [place, cancel] : [cancel, place];

  return plan({
    kind: 'RESIZE',
    uncoveredQty: uncovered,
    // 덜 덮는 쪽은 지금 맨몸이다. 더 덮는 쪽은 reduceOnly가 붙어 있으면
    // 급하지 않다 — 초과분은 거래소가 무시한다.
    urgent: uncovered > 0 || !oldSafe,
    momentaryGap: !oldSafe,
    safeToAutomate: true,
    reason: over
      ? `보호 주문이 포지션보다 ${fmt(pq - size)} 큽니다`
        + (oldSafe
          ? ' — reduceOnly라 초과분은 무시되지만, 수량을 맞춰 둡니다'
          : ' — reduceOnly가 확인되지 않아 발동 시 반대 포지션이 열릴 수 있습니다')
      : `${fmt(uncovered)}가 보호되지 않은 채 남아 있습니다`,
    steps,
  });
}

function attachPlan(
  size: number, stopPrice: number | null, positionSide: 'LONG' | 'SHORT' | null | undefined,
): RepairPlan {
  if (stopPrice == null) {
    return plan({
      kind: 'MANUAL', uncoveredQty: size, urgent: true,
      reason: '포지션이 보호되지 않았습니다 — 손절 가격이 정해지지 않아 자동으로 걸 수 없습니다',
    });
  }
  const side = closeSideOf(positionSide);
  return plan({
    kind: 'ATTACH', uncoveredQty: size, urgent: true, safeToAutomate: true,
    reason: '포지션이 보호되지 않았습니다 — 이 크기는 손절이 있다는 전제로 계산됐습니다',
    steps: [{
      op: 'PLACE', qty: size, stopPrice, side, reduceOnly: true, closesAll: false,
      label: `보호 주문 ${fmt(size)}를 겁니다 (발동가 ${fmt(stopPrice)}${side ? ` · ${side}` : ''})`,
    }],
  });
}

/**
 * 거래소 미체결 주문 하나를 **복구 입력으로 번역한다.**
 *
 * 화면 안에서 이 번역을 하면 테스트가 안 붙고, 안 붙으면 "거래소가
 * reduceOnly를 안 실어 보낼 때 어떻게 되는가"를 아무도 확인할 수 없다.
 *
 * 규칙 하나: **없는 필드는 false가 아니라 모름이다.** Gate의
 * price_orders는 reduceOnly를 안 준다 — 그것을 '아니오'로 읽으면
 * 멀쩡한 보호 주문이 전부 '반대 포지션을 열 수 있음'으로 분류되고,
 * 복구 순서가 매번 위험한 쪽(취소 먼저)으로 기운다.
 */
export function protectionFactsOf(o: any): Pick<RepairInput,
  'protectionQty' | 'protectionClosesAll' | 'protectionOrderId'
  | 'protectionReduceOnly' | 'stopPrice'> {
  const closesAll = o?.closePosition === true || o?.auto_size != null || o?.autoSize != null;
  const qty = numOrNull(o?.origQty ?? o?.quantity ?? o?.size);
  return {
    protectionOrderId: o?.orderId != null && o.orderId !== '' ? String(o.orderId) : null,
    protectionClosesAll: closesAll,
    // 전량 종료형은 '모름'이 아니라 '언제나 남은 전부'다 — 수량 칸을 비운다.
    protectionQty: closesAll ? null : (qty != null ? Math.abs(qty) : null),
    // **closePosition은 그 자체로 reduceOnly보다 강하다.** 포지션이 없으면
    // 아무것도 안 연다.
    protectionReduceOnly:
      closesAll ? true
      : o?.reduceOnly === true ? true
      : o?.reduceOnly === false ? false
      : null,
    stopPrice: numOrNull(o?.stopPrice ?? o?.triggerPrice),
  };
}

/**
 * 화면에 적을 한 줄.
 *
 * 계획이 없을 때 빈 문자열을 준다 — "할 일 없음"을 굳이 띄우면 진짜
 * 경고가 그 사이에 묻힌다.
 */
export function repairSummary(p: RepairPlan): string {
  if (p.kind === 'NONE') return '';
  const mark = p.urgent ? '🛑 ' : '⚠ ';
  return `${mark}${p.reason}`;
}
