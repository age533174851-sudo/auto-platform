// src/lib/autotrade/scheduleCancel.ts
//
// **"예약 삭제"는 사용자의 말이고, 서버가 하는 일은 취소다.**
//
// 지금 무엇이 문제인가
// ────────────────────
// `DELETE /api/autotrade/schedule`은 `enabled = false`만 한다. 그래서
// 화면에서 삭제를 눌러도 **잠깐 끈 것과 구분되지 않는다.** 나중에
// "이 예약이 왜 안 도나"를 물었을 때 답할 근거가 없다.
//
// 행을 지우는 것도 답이 아니다. 지우면 '켠 적 없다'와 '취소했다'가
// 같아지고, 이미 실행된 예약의 이력까지 사라진다.
//
// 그래서 끄고 **취소한 사실을 적는다**(069: `cancelled_at`·`cancelled_by`).
// 활성 목록에서는 즉시 사라지고, 기록에는 남는다.
//
// 경합이 진짜 문제다
// ──────────────────
// 워커는 `enabled = true`인 줄을 **읽고 나서** 선점한다. 그 사이에
// 사용자가 취소하면, 예전에는 선점 UPDATE가 그대로 성공해서
// **취소된 예약이 주문을 냈다.**
//
// 그 경합은 판정으로 못 막는다 — DB 한 문장 안에서 끝나야 한다.
// `claimSchedule`의 WHERE에 `enabled = true AND cancelled_at IS NULL`을
// 붙여서, 취소가 먼저 커밋되면 선점이 0줄을 고치고 지게 만든다.
//
// 이 파일은 그 옆의 **판정**만 갖는다: 지금 이 줄이 어떤 상태인가.

export type ScheduleState =
  /** 살아 있다 — 워커가 돈다 */
  | 'ACTIVE'
  /** 사용자가 껐다. 다시 켤 수 있다 */
  | 'PAUSED'
  /** 취소됐다. 활성 목록에서 빠진다 */
  | 'CANCELLED';

export interface ScheduleRowLike {
  enabled?: boolean | null;
  cancelled_at?: string | null;
  last_run_at?: string | null;
}

/**
 * 이 예약은 지금 어떤 상태인가.
 *
 * **취소가 끄기보다 세다.** 취소된 줄은 `enabled`가 무엇이든 취소다 —
 * 그러지 않으면 되살리기(upsert)가 `enabled = true`만 바꿔 놓았을 때
 * 취소된 예약이 슬그머니 다시 돈다.
 */
export function scheduleStateOf(row: ScheduleRowLike | null | undefined): ScheduleState {
  if (!row) return 'CANCELLED';
  if (row.cancelled_at) return 'CANCELLED';
  return row.enabled === true ? 'ACTIVE' : 'PAUSED';
}

/** 워커가 이 줄을 돌려도 되는가 */
export function isSchedulable(row: ScheduleRowLike | null | undefined): boolean {
  return scheduleStateOf(row) === 'ACTIVE';
}

export type CancelCode =
  /** 이번 요청이 취소했다 */
  | 'CANCELLED'
  /** 이미 취소돼 있었다. 오류가 아니다 */
  | 'ALREADY_CANCELLED'
  /** 그런 예약이 없다(또는 남의 것이다) */
  | 'NOT_FOUND'
  /** DB가 실패했다. **취소됐다고 적지 않는다** */
  | 'FAILED';

export interface CancelVerdict {
  code: CancelCode;
  /** 화면에서 목록을 지워도 되는가 */
  ok: boolean;
  reason: string;
}

/**
 * 취소 UPDATE의 결과를 읽는다.
 *
 * @param updated 고쳐진 줄 수. **못 읽었으면 null이다 — 0이 아니다**
 * @param existed 그 예약이 있기는 한가 (취소 상태로라도)
 */
export function cancelVerdict(i: {
  updated: number | null;
  existed: boolean;
  alreadyCancelled?: boolean;
  error?: string | null;
}): CancelVerdict {
  if (i.error) {
    // **실패를 성공으로 적지 않는다.** 화면에서 사라졌는데 워커가 계속
    // 도는 것이 이 기능에서 가장 나쁜 결과다.
    return { code: 'FAILED', ok: false,
      reason: `예약을 취소하지 못했습니다 — ${String(i.error).slice(0, 160)}` };
  }
  if (i.updated == null) {
    return { code: 'FAILED', ok: false,
      reason: '취소 결과를 읽지 못했습니다 — 취소됐다고 단정하지 않습니다' };
  }
  if (i.updated > 0) {
    return { code: 'CANCELLED', ok: true, reason: '예약을 취소했습니다' };
  }
  // 0줄이다. 이미 취소됐거나, 없거나.
  if (i.alreadyCancelled) {
    return { code: 'ALREADY_CANCELLED', ok: true,
      reason: '이미 취소된 예약입니다' };
  }
  if (!i.existed) {
    return { code: 'NOT_FOUND', ok: false,
      reason: '그 예약을 찾지 못했습니다' };
  }
  return { code: 'FAILED', ok: false,
    reason: '예약이 있는데 취소되지 않았습니다 — 취소됐다고 적지 않습니다' };
}

/**
 * 되살릴 때 지워야 하는 칸.
 *
 * 같은 종목으로 예약을 다시 만들면 `upsert`가 같은 줄을 되살린다
 * (`UNIQUE (user_id, symbol)`). 이때 취소 표식을 안 지우면 **새로 만든
 * 예약이 취소된 상태로 남아** 영영 안 돈다.
 */
export const REVIVE_PATCH = { cancelled_at: null, cancelled_by: null };
