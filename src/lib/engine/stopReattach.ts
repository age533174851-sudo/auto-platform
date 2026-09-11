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
