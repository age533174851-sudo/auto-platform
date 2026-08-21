// src/lib/engine/exitMonitorLease.ts
//
// **한 번 옮긴 손절을 또 옮기지 않는다.**
//
// 청산 감시는 이제 워커가 5분마다 깨운다. 그런데 워커가 재시작하거나
// 두 대가 동시에 뜨면 같은 순간에 두 번 깨울 수 있다. 그러면 같은
// 포지션에 손절 이동이 두 번 나가고, **그건 되돌릴 수 없다.**
//
// 임차(lease)로 막는다
// ────────────────────
// 한 줄짜리 표에 "지금은 내가 주인이고 언제까지"를 적는다. 남이 주인이면
// 그냥 안 한다 — **기다리지 않는다.** 그쪽이 하면 되는 일이다.
//
// 울타리(fence)가 왜 더 필요한가
// ──────────────────────────────
// 임차만으로는 한 가지를 못 막는다. A가 임차를 쥐고 거래소를 부르는데
// 응답이 90초 걸린다고 하자. 그 사이 임차가 만료돼 B가 가져간다. A가
// 뒤늦게 깨어나 **자기가 아직 주인인 줄 알고** 주문을 낸다 — 그러면 둘 다
// 낸 것이다.
//
// 그래서 임차를 가져갈 때마다 번호를 하나씩 올린다. 주문을 내기 직전에
// "내 번호가 아직 최신인가"를 다시 묻고, 아니면 **아무것도 하지 않는다.**
// 늦게 깨어난 A는 자기 번호가 낡았다는 것을 알 수 있다.

export type LeaseCode =
  | 'ACQUIRED'
  /** 남이 쥐고 있다. 기다리지 않는다 */
  | 'HELD_BY_OTHER'
  /** 만료된 것을 가져왔다 */
  | 'TAKEN_OVER'
  /** 상태를 읽지 못했다. **비어 있는 것이 아니다** */
  | 'UNKNOWN';

export interface LeaseRow {
  holder: string;
  fence: number;
  expiresAtMs: number;
}

export interface LeaseDecision {
  code: LeaseCode;
  granted: boolean;
  /** 가져간다면 새 울타리 번호 */
  nextFence: number | null;
  reason: string;
}

/** 한 회차가 이 시간 안에 끝난다고 본다. 넘기면 죽은 것으로 보고 가져간다 */
export const LEASE_TTL_MS = 4 * 60_000;

/**
 * 지금 내가 청산 감시를 돌려도 되는가.
 *
 * **못 읽었으면 가져가지 않는다.** 빈 표와 못 읽은 표는 다르고,
 * 못 읽은 것을 빈 것으로 보면 남이 도는 중에 같이 돈다.
 */
export function leaseDecision(i: {
  /** 지금 표의 줄. 없으면 null, **못 읽었으면 undefined** */
  current: LeaseRow | null | undefined;
  me: string;
  nowMs: number;
  ttlMs?: number;
}): LeaseDecision {
  if (i?.current === undefined) {
    return { code: 'UNKNOWN', granted: false, nextFence: null,
      reason: '임차 상태를 읽지 못했습니다 — 남이 도는 중일 수 있어 실행하지 않습니다' };
  }
  const cur = i.current;
  if (cur == null) {
    return { code: 'ACQUIRED', granted: true, nextFence: 1, reason: '임차가 비어 있어 가져왔습니다' };
  }
  // 내가 이미 주인이면 갱신이다. 번호는 올린다 — 뒤늦게 깨어난 내 옛
  // 실행이 아직 최신인 줄 알면 안 된다.
  if (cur.holder === i.me) {
    return { code: 'ACQUIRED', granted: true, nextFence: (Number(cur.fence) || 0) + 1,
      reason: '내가 쥐고 있던 임차를 갱신했습니다' };
  }
  const expired = !Number.isFinite(cur.expiresAtMs) || cur.expiresAtMs <= i.nowMs;
  if (!expired) {
    return { code: 'HELD_BY_OTHER', granted: false, nextFence: null,
      reason: `${cur.holder}가 돌고 있습니다 — 기다리지 않고 이번은 건너뜁니다` };
  }
  return { code: 'TAKEN_OVER', granted: true, nextFence: (Number(cur.fence) || 0) + 1,
    reason: `${cur.holder}의 임차가 만료돼 가져왔습니다` };
}

/**
 * 주문을 내기 직전에 다시 묻는다: **내 울타리가 아직 최신인가.**
 *
 * 아니면 내가 자는 사이 남이 가져간 것이다. 그때는 아무것도 하지 않는다 —
 * 이미 그쪽이 같은 일을 하고 있다.
 */
export function fenceStillMine(i: {
  myFence: number | null | undefined;
  /** 지금 표의 번호. **못 읽었으면 undefined** */
  currentFence: number | null | undefined;
}): { ok: boolean; reason: string } {
  if (i?.myFence == null) return { ok: false, reason: '내 울타리 번호가 없습니다' };
  if (i?.currentFence === undefined) {
    return { ok: false, reason: '울타리 번호를 다시 읽지 못했습니다 — 확인하지 못한 것을 통과로 보지 않습니다' };
  }
  if (i.currentFence == null) return { ok: false, reason: '임차가 사라졌습니다' };
  if (Number(i.currentFence) !== Number(i.myFence)) {
    return { ok: false, reason: `내 울타리(${i.myFence})가 낡았습니다 — 지금은 ${i.currentFence}입니다` };
  }
  return { ok: true, reason: '' };
}

// ── 밀렸는가 ──

export interface OverdueVerdict {
  code: 'OK' | 'OVERDUE' | 'NEVER_RAN' | 'UNKNOWN';
  overdue: boolean;
  sinceSec: number | null;
  /** 새 진입을 막아야 하는가 */
  blockEntry: boolean;
  reason: string;
}

/**
 * 진입을 막기까지의 여유.
 *
 * 간격 한두 번 밀린 것으로 매매를 멈추면, 배포 한 번에 하루가 멈춘다.
 * 반대로 영영 안 막으면 **트레일링·시간청산이 죽은 채로 새 포지션이 계속
 * 열린다** — 못 여는 것은 불편이고 못 닫는 것은 사고다.
 */
export const OVERDUE_BLOCK_MS = 30 * 60_000;

/**
 * 청산 감시가 제때 돌고 있는가.
 *
 * **한 번도 안 돈 것과 못 읽은 것을 구분한다.** 앞은 확인된 문제이고
 * 뒤는 확인 불가다.
 */
export function exitMonitorOverdue(i: {
  /** 마지막으로 **성공한** 회차 시각. 없으면 null, 못 읽었으면 undefined */
  lastSuccessMs: number | null | undefined;
  nowMs: number;
  intervalMs: number;
  blockAfterMs?: number;
}): OverdueVerdict {
  const blockAfter = Number.isFinite(i?.blockAfterMs as number) && (i.blockAfterMs as number) > 0
    ? (i.blockAfterMs as number) : OVERDUE_BLOCK_MS;

  if (i?.lastSuccessMs === undefined) {
    return { code: 'UNKNOWN', overdue: false, sinceSec: null, blockEntry: false,
      reason: '청산 감시 기록을 읽지 못했습니다 — 안 돌았다는 뜻이 아닙니다' };
  }
  if (i.lastSuccessMs == null) {
    // 058이 막 적용된 직후가 이 상태다. **기록이 없다고 매매를 멈추지
    // 않는다** — 그건 이 기능을 배포한 순간 자동매매를 끄는 것과 같다.
    return { code: 'NEVER_RAN', overdue: true, sinceSec: null, blockEntry: false,
      reason: '청산 감시가 아직 한 번도 기록되지 않았습니다 — 첫 회차를 기다립니다' };
  }
  const since = i.nowMs - i.lastSuccessMs;
  const sinceSec = Math.max(0, Math.round(since / 1000));
  // 간격의 두 배를 넘기면 밀린 것으로 본다. 한 번 거른 것은 흔한 일이다.
  const late = since > Math.max(2 * i.intervalMs, 60_000);
  if (!late) {
    return { code: 'OK', overdue: false, sinceSec, blockEntry: false,
      reason: `${sinceSec}초 전에 돌았습니다` };
  }
  const block = since > blockAfter;
  return {
    code: 'OVERDUE', overdue: true, sinceSec, blockEntry: block,
    reason: block
      ? `청산 감시가 ${Math.round(since / 60_000)}분째 돌지 않았습니다 — 트레일링·시간청산이 죽은 채로 `
        + '새 포지션을 열지 않습니다'
      : `청산 감시가 ${Math.round(since / 60_000)}분째 밀렸습니다 (${Math.round(blockAfter / 60_000)}분을 넘기면 진입을 막습니다)`,
  };
}
