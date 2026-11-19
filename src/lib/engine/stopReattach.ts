// src/lib/engine/stopReattach.ts
//
// **복구가 손절을 다시 걸어도 되는가** — 그 판단 하나.
//
// 왜 함수로 빼는가
// ────────────────
// 이 판단은 `orderExecutor.attachStopIfMissing` 안에 `if` 몇 줄로 있었다.
// 그 함수는 거래소를 부르고 DB를 쓰기 때문에 시험에서 그대로 돌릴 수 없고,
// 그래서 **가장 중요한 규칙이 시험되지 않는 자리에 있었다.**
//
// 규칙만 여기로 옮긴다. 부작용은 호출부에 남는다. 그러면 규칙은 순수
// 함수라 시험할 수 있고, 규칙을 망가뜨리는 변경이 빨간불이 된다.
//
// 무엇을 막는가
// ─────────────
// 응답을 못 받아 UNKNOWN이 된 주문은 손절 부착 단계에 도달한 적이 없다.
// 포지션은 열렸는데 보호가 없는 상태로 남으므로, 대조가 확정한 뒤 한 번
// 더 건다 — 그게 이 경로의 존재 이유다.
//
// 그런데 **고정 손절을 쓰지 않기로 한 프로필**에는 그 복구가 사고다.
// 사용자가 고른 적 없는 자리에 STOP_MARKET이 걸리고, 100배에서 그 자리는
// 청산선 근처다. 그래서 값(`stop_loss`)이 아니라 **정책**을 먼저 본다.

export type StopReattachCode =
  /** 걸어도 된다 */
  | 'ATTACH'
  /** 청산 주문이다 — 나가는 주문에 보호를 붙이지 않는다 */
  | 'REDUCE_ONLY'
  /** 이미 걸려 있다 */
  | 'ALREADY_ATTACHED'
  /** 고정 손절을 쓰지 않는 프로필의 주문이다 */
  | 'NO_FIXED_SL'
  /** 계획에 손절가가 없다 — 없는 값을 지어내지 않는다 */
  | 'NO_PLANNED_STOP';

export interface StopReattachVerdict {
  attach: boolean;
  code: StopReattachCode;
  /**
   * 기록에 남길 말. **빈 문자열이면 적을 것이 없다는 뜻이다.**
   *
   * `REDUCE_ONLY`·`ALREADY_ATTACHED`·`NO_PLANNED_STOP`은 원래 조용히
   * 넘어가던 경우라 그대로 둔다. `NO_FIXED_SL`만 이유를 남긴다 —
   * "복구가 아무것도 안 했다"와 "복구가 일부러 안 했다"는 다른 사실이고,
   * 100배 포지션에서는 그 차이를 사람이 볼 수 있어야 한다.
   */
  note: string;
  /** 걸어야 할 손절가. `attach`가 true일 때만 값이 있다 */
  stopPrice: number | null;
}

/**
 * 이 주문에 손절을 다시 걸어도 되는가.
 *
 * 순서가 규칙의 일부다. **정책이 값보다 앞에 온다** — 뒤에 두면 `stop_loss`가
 * 어떤 이유로든 채워진 순간 정책이 무시된다.
 */
export function stopReattachVerdict(o: {
  reduce_only?: any;
  sl_order_id?: any;
  stop_policy?: any;
  stop_loss?: any;
} | null | undefined): StopReattachVerdict {
  const no = (code: StopReattachCode, note = ''): StopReattachVerdict =>
    ({ attach: false, code, note, stopPrice: null });

  if (o?.reduce_only) return no('REDUCE_ONLY');
  if (o?.sl_order_id) return no('ALREADY_ATTACHED');

  if (String(o?.stop_policy || '') === 'NO_FIXED_SL') {
    return no('NO_FIXED_SL', '손절 복구 안 함 — 고정 손절을 쓰지 않는 프로필의 주문입니다');
  }

  const stop = Number(o?.stop_loss);
  if (!Number.isFinite(stop) || stop <= 0) return no('NO_PLANNED_STOP');

  return { attach: true, code: 'ATTACH', note: '', stopPrice: stop };
}

// ──────────────────────────────────────────────────────────────────
// 복구 직전의 포지션 증거 — **못 읽은 것은 '없음'이 아니다** (#479)
// ──────────────────────────────────────────────────────────────────
//
// 복구는 포지션이 실제로 있을 때만 손절을 건다. 그 확인이 예전에는
// `Number(x ?? 0)` 다음 `if (!x) return null`이었다. 그러면
//
//   · 조회 실패(Gate HTTP 오류 → null, 바이낸스 `risk: null`)
//   · 깨진 수량('bad' → NaN → `!NaN`은 true)
//
// 이 전부 "포지션 없음 → 걸 것 없음"이 되고 **아무 말도 남지 않는다.**
// 대조는 그 줄을 종료로 적으므로 다시 볼 기회도 없다 — 손절 없는 포지션이
// 조용히 남는다. `positionRiskRead`는 이미 깨진 수량을 `risk: null`로
// 돌려주는데, 받는 쪽이 그것을 다시 0으로 바꾸고 있었다.
//
// 그래서 셋으로 나눈다. 확인된 0만 FLAT이다. UNKNOWN이어도 **주문은
// 보내지 않는다** — 모르는 노출에 손절을 지어내 걸지 않는다. 대신 그 사실을
// 남긴다.

export type ReattachPositionEvidence =
  | { kind: 'OPEN'; qty: number }
  | { kind: 'FLAT' }
  | { kind: 'UNKNOWN'; note: string };

/**
 * @param rawQty   거래소가 준 부호 있는 수량. 포지션 응답 자체를 못 받았으면
 *                 `undefined`/`null`을 넘긴다.
 * @param readError 조회 쪽이 알려 준 실패 이유(있으면 기록에 붙인다).
 */
export function reattachPositionEvidence(
  rawQty: unknown,
  readError?: string | null,
): ReattachPositionEvidence {
  const unknown = (why: string): ReattachPositionEvidence => ({
    kind: 'UNKNOWN',
    note: `손절 복구 확인 불가 — ${why}${readError ? ` (${readError})` : ''}`
      + ' · 포지션이 열려 있다면 손절 없이 남아 있을 수 있습니다',
  });

  if (rawQty === null || rawQty === undefined) {
    return unknown('거래소 포지션을 읽지 못했습니다');
  }
  let n: number;
  if (typeof rawQty === 'number') n = rawQty;
  else if (typeof rawQty === 'string' && rawQty.trim() !== '') n = Number(rawQty.trim());
  else n = NaN;
  if (!Number.isFinite(n)) {
    return unknown(`거래소 포지션 수량을 해석할 수 없습니다 (${String(rawQty).slice(0, 32)})`);
  }
  if (n === 0) return { kind: 'FLAT' };
  return { kind: 'OPEN', qty: n };
}
