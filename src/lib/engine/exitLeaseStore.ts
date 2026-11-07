// src/lib/engine/exitLeaseStore.ts
//
// **임차 표를 실제로 읽고 쓰는 자리 — 하나뿐이다.**
//
// 왜 뗐는가
// ─────────
// 이 Supabase 코드는 `exit-monitor` 라우트 안에 인라인으로 있었다. 긴급
// 종료(킬스위치)도 **같은 표의 같은 줄**을 잡아야 둘이 동시에 같은
// 포지션을 닫지 않는다. 그런데 그 코드를 킬 라우트에 복사하면 같은 판단이
// 두 벌이 되고, 언젠가 한쪽만 고쳐진다 — 이 저장소가 반복한 고장이다.
//
// 특히 조용히 갈릴 수 있는 세 가지:
//   · `row: undefined`(못 읽었다)와 `row: null`(비어 있다)의 구분
//   · 표가 없는 배포를 `missingTable`로 알리는 것
//   · **본 값을 조건으로 걸어** 쓰는 것(compare-and-set)
//
// 셋 중 하나만 달라도 두 실행이 같은 울타리 번호로 둘 다 주인이 된다.

import { fenceStillMine, type LeaseStore } from './exitMonitorLease';

/** 임차 표는 **한 줄짜리**다 (058: `id INTEGER PRIMARY KEY CHECK (id = 1)`) */
export const EXIT_LEASE_ROW_ID = 1;
export const EXIT_LEASE_TABLE = 'exit_monitor_lease';

/**
 * Supabase 클라이언트를 `LeaseStore`로 싼다.
 *
 * `read`의 세 결과를 구분해서 돌려준다:
 *   `{ row }` 읽었다 · `{ row: null }` 비어 있다 ·
 *   `{}` **못 읽었다** · `{ missingTable: true }` 표가 없다
 */
export function exitLeaseStore(sb: any): LeaseStore {
  return {
    read: async () => {
      try {
        const { data, error } = await (sb as any)
          .from(EXIT_LEASE_TABLE).select('holder, fence, expires_at')
          .eq('id', EXIT_LEASE_ROW_ID).maybeSingle();
        if (error) {
          if (/does not exist|schema cache|relation/i.test(String(error.message))) {
            return { missingTable: true };
          }
          // row: undefined → **못 읽었다.** 비어 있는 것이 아니다
          return {};
        }
        return { row: data == null ? null : {
          holder: String((data as any).holder),
          fence: Number((data as any).fence) || 0,
          expiresAtMs: Date.parse(String((data as any).expires_at)),
        } };
      } catch { return {}; }
    },
    insert: async (row) => {
      const { error } = await (sb as any).from(EXIT_LEASE_TABLE).insert({
        id: EXIT_LEASE_ROW_ID, holder: row.holder, fence: row.fence,
        acquired_at: new Date(row.acquiredAtMs).toISOString(),
        expires_at: new Date(row.expiresAtMs).toISOString(),
      });
      return { ok: !error, error: error ? String(error.message) : null };
    },
    // ★ **본 값을 조건으로 걸어** 쓴다(compare-and-set).
    //   조건 없는 upsert는 두 실행이 같은 fence로 둘 다 주인이 되게 한다.
    compareAndSet: async (row, prevFence) => {
      const { data, error } = await (sb as any).from(EXIT_LEASE_TABLE)
        .update({
          holder: row.holder, fence: row.fence,
          acquired_at: new Date(row.acquiredAtMs).toISOString(),
          expires_at: new Date(row.expiresAtMs).toISOString(),
        })
        .eq('id', EXIT_LEASE_ROW_ID).eq('fence', prevFence).select('fence');
      return { updated: Array.isArray(data) ? data.length : 0,
        error: error ? String(error.message) : null };
    },
  };
}

/**
 * 쓰기 직전에 다시 묻는 함수를 만든다: **내 울타리가 아직 최신인가.**
 *
 * `tracked`가 거짓이면(표가 없는 배포) 참을 돌려준다 — 그 배포에서
 * 상호 배제는 **보장되지 않는다.** 보장된 것처럼 적지 않기 위해
 * 호출부가 그 사실을 함께 기록한다.
 *
 * 못 읽으면 **거짓**이다. 확인하지 못한 것을 통과로 보지 않는다.
 */
export function exitFenceChecker(
  sb: any, myFence: number | null, tracked: boolean,
): () => Promise<boolean> {
  return async () => {
    if (!tracked) return true;
    let cur: number | null | undefined = undefined;
    try {
      const { data, error } = await (sb as any)
        .from(EXIT_LEASE_TABLE).select('fence').eq('id', EXIT_LEASE_ROW_ID).maybeSingle();
      if (!error) cur = data == null ? null : Number((data as any).fence);
    } catch { /* undefined → 못 읽었다 */ }
    return fenceStillMine({ myFence, currentFence: cur }).ok;
  };
}
