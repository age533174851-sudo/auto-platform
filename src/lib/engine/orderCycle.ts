// src/lib/engine/orderCycle.ts
//
// **한 사이클이 어디까지 갔고, 어디가 끊겼는가.**
//
// 왜 필요한가
// ───────────
// 주문 한 번은 아홉 단계다.
//
//   진입 요청 → 거래소 접수 확인 → 실제 포지션 확인 → 보호 주문 부착
//   → 거래소에서 보호 주문 되읽기 → 부분청산 → 전량청산
//   → 남은 보호 주문 제거 → 앱과 거래소 상태 일치
//
// 지금 코드에는 각 단계가 **따로따로** 들어 있다. executeOrder가 앞의
// 넷을, stopVerify가 다섯째를, closePosition이 여섯·일곱을, 대조가
// 아홉째를 본다. 각각은 맞는데, **"지금 이 심볼이 어느 단계에 있고 그
// 단계가 성립하는가"를 묻는 곳이 없다.**
//
// 그래서 이런 상태가 아무에게도 안 걸린다:
//
//   · 포지션은 있는데 보호 주문이 없다 — 크기를 정당화한 근거가 사라졌다
//   · 포지션은 없는데 보호 주문이 살아 있다 — **다음 진입을 그 손절이 친다**
//   · 절반을 닫았는데 손절은 아직 전량을 덮고 있다(또는 그 반대)
//
// 세 번째가 특히 조용하다. 부분청산 뒤에 수량이 안 맞아도 화면 어디에도
// 안 뜨고, 손절이 발동하는 순간에야 "왜 이만큼만 닫혔지"가 된다.
//
// 이 파일이 하는 일
// ─────────────────
// **관측한 사실만 받아서 판정한다.** 거래소를 안 부르고 저장소도 안 읽는다.
// 그래야 실제 왕복 없이도 끊기는 지점에 테스트를 붙일 수 있다.
//
// 규칙 하나: **못 읽은 것은 '없음'이 아니다.** 조회 실패를 '보호 없음'으로
// 읽으면 조회가 한 번 흔들릴 때마다 멀쩡한 포지션을 닫는다. 반대로
// '있음'으로 읽으면 보호 없는 포지션을 보호된 것으로 센다. 둘 다 사고라서
// 세 번째 답이 필요하다 — 모름.

import type { StopCheck } from './stopVerify';

export type CycleStage =
  /** 아직 아무것도 없다 */
  | 'IDLE'
  /** 주문을 보냈고 결과를 모른다 */
  | 'SENT'
  /** 거래소가 접수했다 */
  | 'ACKED'
  /** 거래소에서 포지션을 실제로 확인했다 */
  | 'POSITION_OPEN'
  /** 보호 주문이 거래소에 살아 있는 것을 확인했다 */
  | 'PROTECTED'
  /** 일부만 닫혔다 */
  | 'PARTIALLY_CLOSED'
  /** 포지션이 없다 */
  | 'CLOSED';

export type CycleBreak =
  /** 포지션이 있는데 보호 주문이 없다 */
  | 'POSITION_UNPROTECTED'
  /** 포지션이 없는데 보호 주문이 살아 있다 — 다음 진입을 친다 */
  | 'ORPHAN_PROTECTION'
  /** 보호 주문 수량이 포지션과 안 맞는다 */
  | 'PROTECTION_QTY_MISMATCH'
  /** 보호 주문을 걸긴 했는데 되읽어 확인하지 못했다 */
  | 'PROTECTION_UNVERIFIED'
  /** 포지션을 못 읽었다 */
  | 'POSITION_UNKNOWN'
  /** 주문을 보냈는데 결과를 모른다 */
  | 'ORDER_UNKNOWN';

export interface CycleFacts {
  /** live_orders의 상태 */
  orderStatus?: string | null;
  /**
   * 거래소가 보고한 포지션 수량(절대값). **못 읽었으면 null이다.**
   * 0과 null은 완전히 다른 사실이다 — 0은 '없다', null은 '모른다'.
   */
  positionQty?: number | null;
  /** 진입할 때 의도한 수량 */
  intendedQty?: number | null;
  /** 보호 주문 판정 (stopVerify.findAnyStop / verifyStopAttached) */
  stop?: StopCheck | null;
  /**
   * 보호 주문이 덮는 수량. **전량 종료형(closePosition / auto_size)이면
   * null을 준다** — 그건 '모름'이 아니라 '언제나 남은 전부'라는 뜻이므로
   * closesAll을 따로 둔다.
   */
  protectionQty?: number | null;
  /** 보호 주문이 '남은 전부'를 닫는 형태인가 */
  protectionClosesAll?: boolean;
  /** 우리 장부에 적힌 보호 주문 id (걸었다고 기록된 것) */
  recordedStopId?: string | null;
}

export interface CycleVerdict {
  stage: CycleStage;
  /** 이 사이클이 지금 성립하는가 */
  ok: boolean;
  broken: CycleBreak | null;
  /** 사람이 읽는 문장 */
  reason: string;
  /** 지금 해야 하는 일 */
  action: string;
  /** 즉시 손을 써야 하는가 — 보호 없는 포지션은 기다릴 수 없다 */
  urgent: boolean;
}

const numOrNull = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 수량 비교는 상대 오차로. 거래소마다 자릿수가 다르다 */
function qtyClose(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale < 1e-6;
}

/**
 * 지금 이 심볼의 사이클 상태.
 *
 * 판정 순서가 중요하다. **모름을 먼저 걸러낸다** — 모르는 것 위에서
 * '보호 없음'이나 '정상'을 말하면, 그 말이 다음 행동을 정한다.
 */
export function cycleState(facts: CycleFacts | null | undefined): CycleVerdict {
  const f = facts ?? {};
  const status = String(f.orderStatus ?? '').toUpperCase();
  const qty = numOrNull(f.positionQty);
  const stop = f.stop ?? null;
  const stopStatus = stop?.status ?? null;

  // ── 주문 결과를 모른다 ──
  //
  // 여기서 '포지션 없음'으로 넘어가면, 실제로는 체결된 주문 위에 또
  // 들어간다. 확정 전에는 다음 단계를 논하지 않는다.
  if (status === 'UNKNOWN' || status === 'SENT') {
    return {
      stage: 'SENT', ok: false, broken: 'ORDER_UNKNOWN', urgent: true,
      reason: '주문을 보냈지만 거래소 응답을 받지 못했습니다 — 체결됐을 수 있습니다',
      action: '거래소와 대조해 확정하기 전에는 같은 심볼에 다시 진입하지 않습니다',
    };
  }

  // ── 포지션을 못 읽었다 ──
  //
  // 0으로 읽으면 '없다'가 되고, 그러면 남은 보호 주문을 고아로 판정해
  // 지운다 — 실제로는 포지션이 있는데 보호만 사라진다.
  if (qty == null) {
    return {
      stage: 'IDLE', ok: false, broken: 'POSITION_UNKNOWN', urgent: false,
      reason: '거래소 포지션을 읽지 못했습니다 — 없는 것이 아니라 모르는 것입니다',
      action: '조회가 회복될 때까지 이 심볼의 판정을 보류합니다',
    };
  }

  const hasPosition = Math.abs(qty) > 0;

  // ── 포지션이 없다 ──
  if (!hasPosition) {
    // 보호 주문이 살아 있으면 **다음 진입을 그 손절이 친다.**
    // 반대 방향으로 들어가면 즉시 발동하고, 같은 방향이면 엉뚱한
    // 가격에 걸린 채로 남는다.
    if (stopStatus === 'attached') {
      return {
        stage: 'CLOSED', ok: false, broken: 'ORPHAN_PROTECTION', urgent: true,
        reason: '포지션은 없는데 보호 주문이 아직 살아 있습니다',
        action: '남은 보호 주문을 취소합니다 — 두면 다음 진입이 이 손절에 걸립니다',
      };
    }
    if (stopStatus === 'unknown') {
      return {
        stage: 'CLOSED', ok: false, broken: 'PROTECTION_UNVERIFIED', urgent: false,
        reason: '포지션은 정리됐는데 남은 보호 주문이 있는지 확인하지 못했습니다',
        action: '미체결 목록을 다시 읽어 확인합니다',
      };
    }
    return {
      stage: 'CLOSED', ok: true, broken: null, urgent: false,
      reason: '포지션 없음 · 남은 보호 주문 없음 — 사이클이 닫혔습니다',
      action: '',
    };
  }

  // ── 포지션이 있다 ──
  //
  // 여기서부터는 보호가 있는지가 전부다. 포지션 크기 자체가 손절 거리로
  // 역산된 값이라(허용손실 ÷ 손절거리), 손절이 없으면 그 크기를 정당화할
  // 근거가 사라진다.
  if (stopStatus === 'missing') {
    return {
      stage: 'POSITION_OPEN', ok: false, broken: 'POSITION_UNPROTECTED', urgent: true,
      reason: f.recordedStopId
        ? '손절을 걸었다고 기록돼 있지만 거래소 주문장에 없습니다'
        : '포지션이 열려 있는데 보호 주문이 없습니다',
      action: '지금 손절을 걸거나 포지션을 닫습니다 — 이 크기는 손절이 있다는 전제로 계산됐습니다',
    };
  }

  if (stopStatus == null || stopStatus === 'unknown') {
    return {
      stage: 'POSITION_OPEN', ok: false, broken: 'PROTECTION_UNVERIFIED', urgent: false,
      // **'없음'이라고 하지 않는다.** 조회 실패로 멀쩡한 포지션을 닫으면
      // 그것대로 사고다.
      reason: stop?.reason || '보호 주문이 걸려 있는지 확인하지 못했습니다',
      action: '미체결 목록을 다시 읽습니다 — 확인 전에는 보호된 것으로도 안 된 것으로도 세지 않습니다',
    };
  }

  // ── 보호가 있다. 수량이 맞는가 ──
  //
  // 부분청산 뒤에 이게 어긋난다. 절반을 닫았는데 손절이 아직 전량을
  // 덮고 있으면, 발동 시 없는 수량을 닫으려다 거부되거나 반대 포지션이
  // 열린다. 반대로 손절이 더 적으면 나머지가 보호되지 않는다.
  const pq = numOrNull(f.protectionQty);
  const closesAll = f.protectionClosesAll === true;
  if (!closesAll && pq != null && !qtyClose(pq, Math.abs(qty))) {
    return {
      stage: 'PARTIALLY_CLOSED', ok: false, broken: 'PROTECTION_QTY_MISMATCH', urgent: true,
      reason: `보호 주문이 ${pq}를 덮는데 포지션은 ${Math.abs(qty)}입니다`,
      action: pq < Math.abs(qty)
        ? '보호되지 않은 수량이 남아 있습니다 — 보호 주문을 포지션 크기에 맞춥니다'
        : '보호 주문이 포지션보다 큽니다 — 발동 시 거부되거나 반대 포지션이 열립니다',
    };
  }

  const intended = numOrNull(f.intendedQty);
  const partial = intended != null && Math.abs(qty) > 0 && !qtyClose(Math.abs(qty), intended);

  return {
    stage: partial ? 'PARTIALLY_CLOSED' : 'PROTECTED',
    ok: true, broken: null, urgent: false,
    reason: partial
      ? `일부 정리됨 — 남은 ${Math.abs(qty)} / 진입 ${intended} · 보호 주문 정상`
      : '포지션과 보호 주문이 모두 확인되었습니다',
    action: '',
  };
}

/** 화면에 한 줄로 적을 문구 */
export function cycleSummary(v: CycleVerdict): string {
  if (v.ok) return v.reason;
  return `${v.urgent ? '🛑 ' : '⚠ '}${v.reason}`;
}

/**
 * 이 상태에서 **새 진입을 허용해도 되는가.**
 *
 * 보수적이다. 모르는 상태에서는 열지 않는다 —
 * 못 여는 것은 불편이고 못 닫는 것은 사고다.
 */
export function canOpenNew(v: CycleVerdict): { allowed: boolean; reason: string } {
  if (v.broken === 'ORDER_UNKNOWN') {
    return { allowed: false, reason: '결과를 모르는 주문이 있습니다 — 확정 전에는 열지 않습니다' };
  }
  if (v.broken === 'POSITION_UNKNOWN') {
    return { allowed: false, reason: '거래소 포지션을 읽지 못했습니다 — 모르는 위에 열지 않습니다' };
  }
  if (v.broken === 'ORPHAN_PROTECTION') {
    return { allowed: false, reason: '남은 보호 주문이 새 포지션을 칩니다 — 먼저 취소하세요' };
  }
  if (v.broken === 'POSITION_UNPROTECTED') {
    return { allowed: false, reason: '보호되지 않은 포지션이 있습니다 — 그 위에 더 얹지 않습니다' };
  }
  if (v.broken === 'PROTECTION_QTY_MISMATCH') {
    return { allowed: false, reason: '보호 주문 수량이 포지션과 다릅니다 — 먼저 맞추세요' };
  }
  return { allowed: true, reason: '' };
}
