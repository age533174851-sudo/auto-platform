// src/lib/engine/stopMove.ts
//
// **손절을 옮기는 순서. 여기서 틀리면 손절 없는 포지션이 남는다.**
//
// 지켜야 하는 순서
// ────────────────
//   ① 새 손절을 건다
//   ② 새 주문 번호를 장부에 적는다
//   ③ **적히고 나서** 기존 손절을 취소한다
//
// ②를 건너뛰고 ③을 하면 어떻게 되는가
// ────────────────────────────────────
// 새 손절은 거래소에 걸려 있는데 그 번호가 장부에 없다. 그러면:
//
//   · 고아 정리(orphanSweep)가 "내 번호가 아니다"라며 그것을 남긴다
//     — 그건 그나마 낫다
//   · 다음 주기의 소유권 판정이 그 손절을 남의 것으로 본다
//   · 그리고 **기존 손절은 이미 취소됐다.** 앱이 아는 손절이 하나도
//     없는 상태로 포지션이 남는다
//
// 그래서 **장부 기록이 실패하면 기존 손절을 건드리지 않는다.**
// 잠깐 손절이 둘이 되는 쪽을 고른다 — 둘 다 전량 종료라 먼저 닿는
// 쪽이 닫고 나머지는 무효가 된다. **겹치는 편이 비는 것보다 안전하다.**

export type StopMoveCode =
  /** 새 손절을 걸고 · 적고 · 옛 것을 치웠다 */
  | 'MOVED'
  /** 새 손절을 못 걸었다. 기존 손절은 그대로 살아 있다 */
  | 'PLACE_FAILED'
  /** 걸었는데 장부에 못 적었다. **기존 손절을 남긴다** */
  | 'RECORD_FAILED'
  /** 걸고 적었는데 옛 것을 못 치웠다. 손절이 둘이다 — 비는 것보다 낫다 */
  | 'OLD_STOP_REMAINS';

export interface StopMoveResult {
  code: StopMoveCode;
  ok: boolean;
  newOrderId: string | null;
  cancelledOld: number;
  /** 기존 손절이 아직 살아 있는가 */
  oldStopKept: boolean;
  reason: string;
}

/**
 * 손절 이동을 순서대로 실행한다.
 *
 * 거래소도 DB도 여기서 직접 부르지 않는다 — 전부 인자로 받는다.
 * 그래야 "기록이 실패하면 취소를 부르지 않는다"를 **호출 횟수로**
 * 확인할 수 있다.
 */
export async function moveStopSafely(i: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  newStop: number;
  /** 새 손절을 건다 */
  place: (stopPrice: number) => Promise<{ ok: boolean; orderId: string | null; message?: string }>;
  /** 새 주문 번호를 장부에 적는다. **실패하면 취소하지 않는다** */
  record: (orderId: string | null) => Promise<{ ok: boolean; message?: string }>;
  /** 방금 건 것 외의 손절을 취소한다 */
  cancelOthers: (keepOrderId: string | null) => Promise<{ cancelled: number; note?: string }>;
}): Promise<StopMoveResult> {
  // ── ① 새 손절 ──
  let placed: { ok: boolean; orderId: string | null; message?: string };
  try {
    placed = await i.place(i.newStop);
  } catch (e: any) {
    return { code: 'PLACE_FAILED', ok: false, newOrderId: null, cancelledOld: 0, oldStopKept: true,
      reason: `새 손절을 걸지 못했습니다 (${String(e?.message || e).slice(0, 120)}) — 기존 손절은 그대로입니다` };
  }
  if (!placed?.ok) {
    return { code: 'PLACE_FAILED', ok: false, newOrderId: null, cancelledOld: 0, oldStopKept: true,
      reason: `새 손절을 걸지 못했습니다 (${placed?.message || '사유 없음'}) — 기존 손절은 그대로입니다` };
  }

  // ── ② 장부 기록 ──
  let rec: { ok: boolean; message?: string };
  try {
    rec = await i.record(placed.orderId ?? null);
  } catch (e: any) {
    rec = { ok: false, message: String(e?.message || e).slice(0, 120) };
  }
  if (!rec?.ok) {
    // **여기서 멈춘다.** 취소를 부르지 않는다.
    return { code: 'RECORD_FAILED', ok: false, newOrderId: placed.orderId ?? null,
      cancelledOld: 0, oldStopKept: true,
      reason: `새 손절은 걸었지만 장부에 적지 못했습니다 (${rec?.message || '사유 없음'}) — `
        + '기존 손절을 남깁니다. 손절이 둘인 편이 하나도 없는 것보다 안전합니다' };
  }

  // ── ③ 옛 손절 정리 ──
  try {
    const c = await i.cancelOthers(placed.orderId ?? null);
    const n = Number(c?.cancelled ?? 0);
    return { code: 'MOVED', ok: true, newOrderId: placed.orderId ?? null,
      cancelledOld: Number.isFinite(n) ? n : 0, oldStopKept: false,
      reason: `손절을 옮겼습니다${c?.note ? ` (${c.note})` : ''}` };
  } catch (e: any) {
    // 새 손절은 걸려 있고 적혀 있다. 옛 것이 남은 것은 위험이 아니라 잡음이다.
    return { code: 'OLD_STOP_REMAINS', ok: true, newOrderId: placed.orderId ?? null,
      cancelledOld: 0, oldStopKept: true,
      reason: `새 손절은 걸고 적었지만 옛 손절을 치우지 못했습니다 `
        + `(${String(e?.message || e).slice(0, 120)}) — 다음 주기에 다시 시도합니다` };
  }
}
