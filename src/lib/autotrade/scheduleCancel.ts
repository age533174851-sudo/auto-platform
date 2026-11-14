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

// ── 취소된 줄에 길을 준다 ──────────────────────────────
//
// 2026-11-14 사용자가 쓴 말 그대로:
//
//   "저거 취소됨 할거면 다시 킬수 있게 만들어 놓든가 그냥 저거 방치하고
//    계속 쌓이는게 마음에 안들어 / 내역 삭제할건 하고 내비두면 다시
//    킬수 있게 만들어놔"
//
// 맞는 말이다. 취소된 줄에는 **버튼이 하나도 없었다.** 화면은 "같은
// 종목으로 예약을 다시 만들면 이 줄이 되살아납니다"라고 적는데, 그건
// `UNIQUE (user_id, symbol)`이 실제로 걸려 있을 때만 참이다. 그 제약이
// 없는 DB에서는 새로 만들 때마다 **새 줄**이 생기고, 취소된 줄은
// 되살아나지도 지워지지도 않고 영영 쌓인다.
//
// 그래서 두 가지를 준다. 둘 다 **판정은 여기 한 곳**에 둔다.

export type RestoreCode =
  /** 되살렸다 — 다만 꺼진 상태다 */
  | 'RESTORED'
  /** 취소된 줄이 아니다. 되살릴 것이 없다 */
  | 'NOT_CANCELLED'
  /** 그런 예약이 없다(또는 남의 것이다) */
  | 'NOT_FOUND'
  /** DB가 실패했거나 결과를 못 읽었다 */
  | 'FAILED';

export interface RestoreVerdict {
  code: RestoreCode;
  ok: boolean;
  /** 되살린 뒤의 상태. **항상 꺼짐이다** */
  enabledAfter: false;
  reason: string;
}

/**
 * 취소 표식을 지워 **꺼진 예약**으로 되돌린다.
 *
 * **켜진 채로 돌려주지 않는다.** 취소했다는 것은 돌리고 싶지 않았다는
 * 뜻이고, 되살리기 한 번에 주문이 다시 나가기 시작하면 그건 사용자가
 * 누른 적 없는 거래다. 목록에 다시 보이게만 하고, 켜는 것은 기존
 * 스위치가 한다 — 그 스위치에는 이미 실행 프로필 검사가 붙어 있다.
 */
export function restoreVerdict(i: {
  updated: number | null;
  existed: boolean;
  wasCancelled: boolean;
  error?: string | null;
}): RestoreVerdict {
  const no = (code: RestoreCode, reason: string): RestoreVerdict =>
    ({ code, ok: false, enabledAfter: false, reason });

  if (i.error) {
    return no('FAILED', `예약을 되살리지 못했습니다 — ${String(i.error).slice(0, 160)}`);
  }
  if (i.updated == null) {
    return no('FAILED', '되살리기 결과를 읽지 못했습니다 — 되살렸다고 단정하지 않습니다');
  }
  if (!i.existed) return no('NOT_FOUND', '그 예약을 찾지 못했습니다');
  if (!i.wasCancelled) {
    return no('NOT_CANCELLED',
      '취소된 예약이 아닙니다 — 되살릴 것이 없습니다. 꺼져 있을 뿐이라면 스위치로 켜세요');
  }
  if (i.updated <= 0) {
    return no('FAILED', '취소된 예약인데 되살아나지 않았습니다 — 되살렸다고 적지 않습니다');
  }
  return {
    code: 'RESTORED', ok: true, enabledAfter: false,
    reason: '예약을 되살렸습니다 — **꺼진 상태**입니다. 목록에서 스위치로 켜세요',
  };
}

export type PurgeCode =
  /** 줄을 지웠다. 되돌릴 수 없다 */
  | 'PURGED'
  /** 취소된 줄이 아니다. **지우지 않았다** */
  | 'NOT_CANCELLED'
  | 'NOT_FOUND'
  | 'FAILED';

export interface PurgeVerdict {
  code: PurgeCode;
  ok: boolean;
  reason: string;
}

/**
 * 취소된 줄을 **영구 삭제**한다.
 *
 * 왜 취소된 줄만인가
 * ──────────────────
 * 살아 있거나 잠깐 꺼 둔 예약을 지우면, 사용자가 "껐다"고 생각한 것과
 * "없앴다"가 같아진다. 그리고 실수로 지운 것을 되살릴 방법이 없다.
 * **취소는 되돌릴 수 있고(위 `restoreVerdict`), 삭제는 되돌릴 수 없다.**
 * 그래서 반드시 취소를 거친 줄만 지운다 — 삭제 앞에 되돌릴 수 있는
 * 단계를 하나 세워 둔다.
 *
 * 체결·장부 기록은 다른 표에 있고 이 줄을 참조하지 않는다(외래키 없음).
 * 그래서 이 삭제로 거래 이력이 사라지지는 않는다.
 */
export function purgeVerdict(i: {
  deleted: number | null;
  existed: boolean;
  wasCancelled: boolean;
  error?: string | null;
}): PurgeVerdict {
  if (i.error) {
    return { code: 'FAILED', ok: false,
      reason: `기록을 지우지 못했습니다 — ${String(i.error).slice(0, 160)}` };
  }
  // **취소 여부를 먼저 본다.** 못 읽은 결과보다 이 검사가 앞선다 —
  // 살아 있는 예약을 지우는 것이 여기서 가장 나쁜 결과다.
  if (!i.existed) return { code: 'NOT_FOUND', ok: false, reason: '그 예약을 찾지 못했습니다' };
  if (!i.wasCancelled) {
    return { code: 'NOT_CANCELLED', ok: false,
      reason: '취소된 예약만 지웁니다 — 먼저 취소하세요. 켜져 있거나 잠깐 꺼 둔 예약은 지우지 않습니다' };
  }
  if (i.deleted == null) {
    return { code: 'FAILED', ok: false,
      reason: '삭제 결과를 읽지 못했습니다 — 지웠다고 단정하지 않습니다' };
  }
  if (i.deleted <= 0) {
    return { code: 'FAILED', ok: false,
      reason: '취소된 예약인데 지워지지 않았습니다 — 지웠다고 적지 않습니다' };
  }
  return { code: 'PURGED', ok: true,
    reason: '취소된 예약 기록을 지웠습니다 — 되돌릴 수 없습니다' };
}

// ── 예약청산(scheduled_exits)의 선점 ────────────────────
//
// **예전에는 선점이 아예 없었다.** 실행기는 줄을 읽고 → 주문을 내고 →
// 그제서야 `fired_at`을 썼다. 그 사이가 통째로 열려 있었다:
//
//   · 사용자가 취소해도 주문이 그대로 나갔다
//   · 실행기가 둘이면(크론 5분 + 수동) 같은 줄을 둘 다 집어
//     **같은 예약이 두 번 발사됐다**
//
// 고치는 방법은 자동매매 예약과 같다: `fired_at`을 **먼저** 못 박고,
// 조건이 그대로일 때만 성공하게 한다.

export type ExitClaimCode =
  /** 이번 실행기가 잡았다. 주문해도 된다 */
  | 'CLAIMED'
  /** 취소됐거나 다른 실행기가 이미 집었다. **주문하지 않는다** */
  | 'SKIPPED'
  /** 선점 조회 자체가 실패했다. **잡았다고 보지 않는다** */
  | 'CLAIM_FAILED';

export interface ExitClaimVerdict {
  code: ExitClaimCode;
  /** 주문을 내도 되는가 */
  mayFire: boolean;
  reason: string;
}

/**
 * 선점 UPDATE의 결과를 읽는다.
 *
 * @param updated 고쳐진 줄 수. **못 읽었으면 null이다 — 0이 아니다**
 */
export function exitClaimVerdict(i: {
  updated: number | null;
  error?: string | null;
}): ExitClaimVerdict {
  if (i.error) {
    return { code: 'CLAIM_FAILED', mayFire: false,
      reason: `선점하지 못했습니다 — ${String(i.error).slice(0, 140)}` };
  }
  if (i.updated == null) {
    return { code: 'CLAIM_FAILED', mayFire: false,
      reason: '선점 결과를 읽지 못했습니다 — 잡았다고 보지 않습니다' };
  }
  if (i.updated > 0) {
    return { code: 'CLAIMED', mayFire: true, reason: '이번 실행기가 선점했습니다' };
  }
  return { code: 'SKIPPED', mayFire: false,
    reason: '취소됐거나 다른 실행기가 이미 처리했습니다 — 주문하지 않습니다' };
}
