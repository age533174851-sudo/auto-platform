// src/lib/autotrade/scheduleReadSummary.ts
//
// **예약을 못 읽은 것을 "예약 0건"으로 적지 않는다.**
//
// 무엇이 있었나
// ─────────────
// 2026-10-20부터 Supabase가 egress 할당량 초과로 서비스 제한에 들어갔다.
// 그때부터 자동매매 실행기의 응답은 매번 이랬다:
//
//   {"ok":false,"error":"Service for this project is restricted …",
//    "scheduled":0,"results":[], …}
//
// `ok:false`와 `error`는 정직하다. 그런데 바로 옆의 **`scheduled: 0`은
// 거짓이다** — 예약은 BTCUSDT·ETHUSDT 두 건이 그대로 켜져 있었고,
// 읽지 못했을 뿐이다. 그 칸만 보는 쪽에서는 "사용자가 자동매매를 꺼
// 두었다"와 "DB를 못 읽는다"가 **같은 0**으로 보인다.
//
// 이 저장소의 절대 규칙 그대로다 — **UNKNOWN을 0으로 적지 않는다.**
// 확인하지 못한 것은 통과가 아니고, 0건도 아니다.
//
// 왜 `rows.length`가 그 자리에 있었나
// ───────────────────────────────────
// 읽기에 실패하면 `rows`가 `[]`로 남고, 그 길이가 그대로 나갔다. 빈
// 배열이 "없다"와 "못 읽었다" 두 가지를 뜻하게 되는, 이 저장소가 반복해서
// 당한 모양이다. 길이를 세기 전에 **읽기가 성공했는지 먼저 묻는다.**

export interface ScheduleReadSummary {
  ok: boolean;
  /** 켜져 있는 예약 수. **읽지 못했으면 `null`이다 — 0이 아니다** */
  scheduled: number | null;
  /** 이 값이 왜 null인지가 여기 적힌다. 화면·로그가 그대로 쓴다 */
  note: string;
  /** 읽기 자체가 실패했는가. 소비자가 0과 구분해야 할 때 쓴다 */
  unknown: boolean;
}

export function scheduleReadSummary(i: {
  rows: any[] | null | undefined;
  readError: string | null | undefined;
}): ScheduleReadSummary {
  const err = i.readError ? String(i.readError) : null;
  if (err) {
    return { ok: false, scheduled: null, unknown: true, note: err };
  }
  // 오류는 없는데 배열도 아니면 그것도 '읽었다'가 아니다.
  if (!Array.isArray(i.rows)) {
    return {
      ok: false, scheduled: null, unknown: true,
      note: '예약 목록을 읽지 못했습니다 — 응답이 배열이 아닙니다',
    };
  }
  const n = i.rows.length;
  return {
    ok: true, scheduled: n, unknown: false,
    note: n === 0
      ? '켜져 있는 자동매매 설정이 없습니다 — autotrade_schedules에 enabled=true 줄이 필요합니다'
      : `${n}건 실행했습니다`,
  };
}
