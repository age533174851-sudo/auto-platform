// src/lib/engine/staleJobRecovery.ts
//
// **heartbeat를 못 읽은 것은 워커가 죽었다는 증거가 아니다.**
//
// 무엇이 있었나
// ─────────────
// stale 회수는 "만료 + 유예 120초"와 "보유 워커의 heartbeat가 끊김"을
// 모두 요구한다. 두 번째 조건이 있는 이유는 분명하다 — 거래소 호출이
// 느려서 60초를 넘겼을 뿐인 **살아 있는 워커의 잡**을 되돌리면 다른
// 워커가 같은 주문을 또 낸다.
//
// 그런데 그 조건을 읽는 코드가 오류를 버렸다:
//
//   const { data: beats } = await sb().from('worker_heartbeat')…
//   const alive = new Set((Array.isArray(beats) ? beats : [])…);
//
// 조회가 실패하면 `beats = null`이고 `alive`는 **빈 집합**이 된다. 그러면
// `alive.has(locked_by)`가 전부 false다 — 즉 **모든 워커가 죽은 것으로
// 읽힌다.** 살아 있는 워커가 처리 중인 잡이 통째로 PENDING으로 돌아가고,
// 다른 워커가 다시 집으면 주문·청산이 중복된다.
//
// 이게 가설이 아닌 이유: 지금 이 프로젝트는 Supabase 한도 초과(402)를
// 겪고 있다. heartbeat 조회가 실패하는 조건이 **이미 성립해 있다.**
//
// `stale` 목록 쪽도 같은 모양이다. 그쪽은 못 읽으면 회수를 안 해서
// 방향은 안전하지만, **조용하다** — 회수가 멈춘 사실이 아무 데도 안 남는다.
//
// 성공한 빈 배열만 "살아 있는 워커 없음"이다.

export type StaleRecoveryCode =
  /** 읽었고, 회수할 잡이 있다 */
  | 'RECOVER'
  /** 읽었고, 회수할 잡이 없다 */
  | 'NONE'
  /** **heartbeat를 못 읽었다** → 이번 회차를 통째로 멈춘다 */
  | 'HEARTBEAT_UNREADABLE'
  /** **stale 목록을 못 읽었다** → 0건으로 적지 않는다 */
  | 'STALE_UNREADABLE';

export type StaleRecoveryPlan = {
  code: StaleRecoveryCode;
  /** 되돌릴 잡. `RECOVER`에서만 비어 있지 않다 */
  recover: any[];
  /** 살아 있어서 건드리지 않은 잡 (로그용) */
  skipped: any[];
  reason: string;
};

const halt = (code: StaleRecoveryCode, reason: string): StaleRecoveryPlan =>
  ({ code, recover: [], skipped: [], reason });

/**
 * 이번 회차에 무엇을 되돌릴 것인가.
 *
 * **못 읽은 쪽은 아무것도 되돌리지 않는다.** 되돌리는 것은 "이 잡은
 * 임자가 없다"는 주장이고, 그 주장의 근거가 heartbeat다. 근거를 못 읽고
 * 주장하면 살아 있는 워커의 주문을 두 번 내게 된다.
 */
export function staleRecoveryPlan(i: {
  /** `jobs` stale 조회 결과 그대로 (`{ data, error }`) */
  stale: { data?: any; error?: any } | null | undefined;
  /** `worker_heartbeat` 조회 결과 그대로 */
  beats: { data?: any; error?: any } | null | undefined;
}): StaleRecoveryPlan {
  if (!i.stale) return halt('STALE_UNREADABLE', 'stale 잡 조회가 아무 응답도 돌려주지 않았습니다');
  if (i.stale.error) {
    return halt('STALE_UNREADABLE',
      `stale 잡 목록을 읽지 못했습니다 — ${String(i.stale.error?.message ?? i.stale.error)}`);
  }
  if (!Array.isArray(i.stale.data)) {
    return halt('STALE_UNREADABLE', 'stale 잡 목록이 배열이 아닙니다 — 0건으로 읽지 않습니다');
  }
  const stale = i.stale.data as any[];
  if (stale.length === 0) return { code: 'NONE', recover: [], skipped: [], reason: '회수할 잡이 없습니다' };

  // 여기부터는 **되돌릴 후보가 있다.** 근거(heartbeat)를 못 읽으면 멈춘다.
  if (!i.beats) return halt('HEARTBEAT_UNREADABLE', 'heartbeat 조회가 아무 응답도 돌려주지 않았습니다');
  if (i.beats.error) {
    return halt('HEARTBEAT_UNREADABLE',
      `heartbeat를 읽지 못해 회수를 멈춥니다 — 못 읽은 것은 워커 사망의 증거가 아닙니다 `
      + `(${String(i.beats.error?.message ?? i.beats.error)})`);
  }
  if (!Array.isArray(i.beats.data)) {
    return halt('HEARTBEAT_UNREADABLE',
      'heartbeat 응답이 배열이 아닙니다 — "살아 있는 워커 0명"으로 읽지 않습니다');
  }

  const alive = new Set(
    (i.beats.data as any[])
      .filter((b) => b && b.status !== 'stopped')
      .map((b) => String(b.worker_id)),
  );

  const recover: any[] = [];
  const skipped: any[] = [];
  for (const j of stale) {
    if (j?.locked_by && alive.has(String(j.locked_by))) skipped.push(j);
    else recover.push(j);
  }
  return recover.length === 0
    ? { code: 'NONE', recover, skipped, reason: `만료된 잡 ${stale.length}건 모두 보유 워커가 살아 있습니다` }
    : { code: 'RECOVER', recover, skipped, reason: `만료 ${stale.length}건 중 ${recover.length}건을 회수합니다` };
}
