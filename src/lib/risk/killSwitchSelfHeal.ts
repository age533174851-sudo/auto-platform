// src/lib/risk/killSwitchSelfHeal.ts
//
// **워커의 킬스위치 자가복구 판정 — 못 읽은 것을 '아니다'로 적지 않는다.**
//
// 무엇이 있었나 (#514 감사의 원칙, 현재 코드에서 실측)
// ────────────────────────────────────────────────────
// `worker/src/index.ts`의 `monitorConnections()`가 세 곳에서 `error`를
// 버리고 있었다:
//
//   const { data: conns } = await sb().from('exchange_connections')...;
//   if (!conns) return;                                  // ① 조용히 끝낸다
//
//   const { data: ks } = await sb().from('kill_switch_state')...;
//   if (ks && ks.active) {                               // ② 못 읽으면 '꺼졌다'
//     const { data: existing } = await sb().from('jobs')...limit(1);
//     if (!existing || existing.length === 0) { insert }  // ③ 못 읽으면 '없음'
//
// ②가 가장 비싸다. 킬스위치가 DB에서 켜져 있는데 조회가 한 번 실패하면
// 워커는 **꺼진 것으로 읽고 아무 job도 보장하지 않는다.** 그 함수 바로
// 위 주석이 적어 둔 그대로다 — "자가복구가 있다고 믿는 쪽이 없는 것보다
// 나쁘다."
//
// ③은 반대 방향으로 샌다. 기존 잡 조회가 실패하면 '없음'으로 읽고 또
// 넣는다 — 같은 연결에 KILL_SWITCH_EXECUTE가 둘이 된다.
//
// 이 원칙은 이미 `killRetry.ts`에 적혀 있다:
//
//   `ok: true` + `job: null`("조회했고 행이 없다")과 `ok: false`
//   ("조회 자체를 못 했다")를 한 모양으로 합치지 않는다.
//
// 같은 판단이 두 곳에 있으면 언젠가 갈린다. 그래서 자가복구의 판정도
// **이 파일 한 곳**에 두고 워커가 부른다.
//
// 왜 '모르면 넣는다'가 아닌가
// ───────────────────────────
// 킬스위치 실행은 포지션을 닫는다. 켜졌는지 **모르는 상태**에서 넣으면
// 사용자가 켜지 않은 청산이 나간다. 그래서 모를 때의 안전한 쪽은
// "넣지 않고, 사람이 보게 남긴다"이다 — 조용히 넘어가는 것과 다르다.
//
// 오류 문구를 담지 않는 이유
// ──────────────────────────
// `error`는 **있었는지 여부만** 받는다. 원문을 판정에 담아 두면 그것이
// 알림·로그로 흘러가고, DB 오류 문구에는 접속 문자열이 섞일 수 있다.
// 키·시크릿은 로그에 남기지 않는다.

/**
 * 한 번의 조회 결과.
 *
 * **`ok: true` + `rows: []`("조회했고 행이 없다")과 `ok: false`("조회
 * 자체를 못 했다")를 한 모양으로 합치지 않는다.**
 */
export type SelfHealLookup<T> =
  | { ok: true; rows: T[] }
  | { ok: false };

export type SelfHealCode =
  /** 켜져 있고 기존 잡이 없다 — 지금 하나 넣는다 */
  | 'ENSURE_JOB'
  /** 켜져 있고 기존 잡이 이미 있다 — 건드리지 않는다 */
  | 'ALREADY_ENSURED'
  /** 조회로 확인한 '꺼짐' 또는 '한 번도 발동 안 함' */
  | 'NOT_ACTIVE'
  /** 확인하지 못했다 — 통과가 아니다 */
  | 'UNVERIFIED';

export interface SelfHealVerdict {
  code: SelfHealCode;
  /** KILL_SWITCH_EXECUTE job을 넣는가 */
  insert: boolean;
  /** 사람이 봐야 하는가 (조용히 넘어가지 않는다) */
  attention: boolean;
  /** `insert`일 때 payload에 적을 action_mode. 없으면 null */
  actionMode: string | null;
  reason: string;
}

export interface KillSwitchStateRow {
  active?: unknown;
  action_mode?: unknown;
}

function verdict(
  code: SelfHealCode,
  reason: string,
  extra: { insert?: boolean; attention?: boolean; actionMode?: string | null } = {},
): SelfHealVerdict {
  return {
    code,
    insert: extra.insert === true,
    attention: extra.attention === true,
    actionMode: extra.actionMode ?? null,
    reason,
  };
}

/** `action_mode`를 문자열로. 읽을 수 없으면 null — 지어내지 않는다. */
function modeOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/**
 * 연결 목록 조회를 믿을 수 있는가.
 *
 * 배열이 아니면(오류든 null이든) **"연결이 없다"가 아니라 "못 읽었다"**다.
 * 그 회차의 자가복구 전체가 비는 것이므로 조용히 끝내지 않는다.
 */
export function connectionScanVerdict(i: {
  rows: unknown;
  /** 조회 오류가 있었는가. 문구는 받지 않는다 */
  failed?: boolean | null;
}): { ok: boolean; attention: boolean; count: number; reason: string } {
  if (i?.failed === true) {
    return { ok: false, attention: true, count: 0,
      reason: '연결 목록을 읽지 못했습니다 — 연결이 없다는 뜻이 아닙니다' };
  }
  if (!Array.isArray(i?.rows)) {
    return { ok: false, attention: true, count: 0,
      reason: '연결 목록이 행 배열이 아닙니다 — 읽은 것으로 치지 않습니다' };
  }
  return { ok: true, attention: false, count: i.rows.length, reason: `연결 ${i.rows.length}개` };
}

/**
 * 한 연결의 킬스위치 자가복구 판정.
 *
 * `jobs`는 **켜진 것이 확인된 뒤에만** 필요하다. 그 전에는 null로 둔다 —
 * 꺼진 연결에 잡 조회를 보내지 않기 위해서다.
 */
export function killSwitchSelfHealVerdict(i: {
  state: SelfHealLookup<KillSwitchStateRow> | null | undefined;
  jobs?: SelfHealLookup<unknown> | null | undefined;
}): SelfHealVerdict {
  const state = i?.state;
  if (!state) {
    return verdict('UNVERIFIED', '킬스위치 상태를 조회하지 않았습니다', { attention: true });
  }
  if (state.ok !== true) {
    return verdict('UNVERIFIED',
      '킬스위치 상태를 읽지 못했습니다 — 꺼졌다는 뜻이 아닙니다', { attention: true });
  }
  const rows = Array.isArray(state.rows) ? state.rows : null;
  if (rows == null) {
    return verdict('UNVERIFIED', '킬스위치 상태가 행 배열이 아닙니다', { attention: true });
  }
  if (rows.length === 0) {
    // 행이 없다 = 이 연결은 한 번도 발동하지 않았다. 조회로 확인한 사실이다.
    return verdict('NOT_ACTIVE', '킬스위치 기록이 없습니다 (조회로 확인)');
  }
  const active = rows[0]?.active;
  if (active === false) {
    return verdict('NOT_ACTIVE', '킬스위치가 꺼져 있습니다 (조회로 확인)');
  }
  if (active !== true) {
    // null·undefined·문자열·숫자 — 무엇이든 **읽지 못한 것**이다.
    return verdict('UNVERIFIED',
      '킬스위치 active 값을 해석할 수 없습니다 — 꺼졌다고 읽지 않습니다', { attention: true });
  }

  const jobs = i?.jobs;
  if (!jobs) {
    return verdict('UNVERIFIED', '기존 잡을 조회하지 않았습니다', { attention: true });
  }
  if (jobs.ok !== true) {
    return verdict('UNVERIFIED',
      '기존 잡을 읽지 못했습니다 — 없다는 뜻이 아닙니다 (중복 전송 금지)', { attention: true });
  }
  if (!Array.isArray(jobs.rows)) {
    return verdict('UNVERIFIED', '기존 잡이 행 배열이 아닙니다', { attention: true });
  }
  if (jobs.rows.length > 0) {
    return verdict('ALREADY_ENSURED', '기존 KILL_SWITCH_EXECUTE가 있습니다 — 건드리지 않습니다');
  }
  return verdict('ENSURE_JOB',
    '킬스위치가 켜져 있고 기존 잡이 없습니다 — 하나 보장합니다',
    { insert: true, actionMode: modeOf(rows[0]?.action_mode) });
}
