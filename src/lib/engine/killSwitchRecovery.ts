// src/lib/engine/killSwitchRecovery.ts
//
// **킬스위치 자가복구를 만들지 말지 정하는 자리.**
//
// 무엇이 있었나
// ─────────────
// 워커의 `monitorConnections()`는 Ghost Sync(거래소 포지션 조회) 뒤에
// 킬스위치 잡 보장을 붙여 놓았다. 그래서 세 가지가 한꺼번에 틀렸다:
//
//   ① 거래소 조회가 실패하면 `continue` — **킬스위치가 active여도**
//      Vercel이 못 만든 잡을 워커도 안 만든다. 거래소가 흔들릴 때는
//      정확히 킬스위치가 필요한 때다
//
//   ② `const { data: ks } = …` — 오류를 버린다. 상태를 **못 읽은 것**이
//      `ks = null`이 되어 "꺼져 있다"로 읽힌다
//
//   ③ `const { data: existing } = …` — 역시 오류를 버린다. 기존 잡을
//      **못 읽은 것**이 "없다"가 되어 **중복 잡을 만든다.** 이쪽이 더
//      위험하다 — 전량청산 잡이 둘이 된다
//
// ②와 ③은 방향이 반대인데 원인은 하나다: `{ data, error }`에서 `data`만
// 꺼내면 "못 읽음"과 "없음"이 같은 값이 된다. 이 저장소가 반복해서 당한
// 모양이다.
//
// 세 번째 것
// ──────────
// 판정을 여기 두는 이유는 **중복 잡이 실주문을 만든다**는 것이다.
// YAML이나 함수 본문 안쪽에 조건을 적으면 값으로 확인할 방법이 없다.

export type KillSwitchRecoveryCode =
  /** active이고, 기존 잡이 **없다고 확인**했다 → 만든다 */
  | 'CREATE'
  /** 기존 잡이 있다 → 만들지 않는다 */
  | 'ALREADY'
  /** 읽었고, 꺼져 있다 */
  | 'NOT_ACTIVE'
  /** 킬스위치 상태를 **못 읽었다** → 만들지 않는다 */
  | 'STATE_UNREADABLE'
  /** 기존 잡 목록을 **못 읽었다** → 만들지 않는다 (중복 금지) */
  | 'JOBS_UNREADABLE';

export type KillSwitchRecovery = {
  code: KillSwitchRecoveryCode;
  /** 이 값만 보고 잡을 만든다. `CREATE`에서만 true다 */
  create: boolean;
  /** 사람이 읽을 사유. **못 읽은 것을 "없다"로 적지 않는다** */
  reason: string;
  /** `CREATE`일 때 잡에 실을 모드. 못 읽었으면 null */
  actionMode: string | null;
};

const no = (code: KillSwitchRecoveryCode, reason: string): KillSwitchRecovery =>
  ({ code, create: false, reason, actionMode: null });

/**
 * 자가복구 잡을 만들 것인가.
 *
 * **못 읽은 쪽은 전부 만들지 않는다.** 방향이 두 가지로 보이지만 하나다:
 *
 *   · 상태를 모르는데 만들면 — 사용자가 켜지 않은 전량청산이 나간다
 *   · 기존 잡을 모르는데 만들면 — 같은 청산이 두 번 나간다
 *
 * 둘 다 되돌릴 수 없다. 모르면 만들지 않고, **모른다는 사실을 적는다** —
 * 조용히 건너뛰면 자가복구가 멈춘 것을 아무도 모른다.
 */
export function killSwitchRecoveryVerdict(i: {
  /** `kill_switch_state` 조회 결과 그대로 (`{ data, error }`) */
  state: { data?: any; error?: any } | null | undefined;
  /** 살아 있는 `KILL_SWITCH_EXECUTE` 잡 조회 결과 그대로 */
  existing: { data?: any; error?: any } | null | undefined;
}): KillSwitchRecovery {
  if (!i.state) return no('STATE_UNREADABLE', '킬스위치 상태 조회가 아무 응답도 돌려주지 않았습니다');
  if (i.state.error) {
    const m = String(i.state.error?.message ?? i.state.error);
    return no('STATE_UNREADABLE', `킬스위치 상태를 읽지 못했습니다 — ${m}`);
  }

  const row: any = i.state.data ?? null;
  if (!row || row.active !== true) {
    return no('NOT_ACTIVE', '킬스위치가 켜져 있지 않습니다');
  }

  // 여기부터는 **켜져 있는 것이 확인된** 상태다. 기존 잡을 못 읽으면
  // 중복이 되므로 만들지 않는다 — 켜져 있다는 사실과 무관하게.
  if (!i.existing) return no('JOBS_UNREADABLE', '기존 킬스위치 잡 조회가 아무 응답도 돌려주지 않았습니다');
  if (i.existing.error) {
    const m = String(i.existing.error?.message ?? i.existing.error);
    return no('JOBS_UNREADABLE', `기존 킬스위치 잡을 읽지 못해 중복을 만들지 않았습니다 — ${m}`);
  }
  const rows = i.existing.data;
  if (!Array.isArray(rows)) {
    // 배열이 아니면 "0건"이 아니라 **모르는 것**이다.
    return no('JOBS_UNREADABLE', '기존 킬스위치 잡 목록이 배열이 아닙니다 — 0건으로 읽지 않습니다');
  }
  if (rows.length > 0) {
    return { code: 'ALREADY', create: false, reason: `이미 살아 있는 킬스위치 잡이 ${rows.length}건 있습니다`, actionMode: null };
  }

  return {
    code: 'CREATE', create: true,
    reason: '킬스위치가 켜져 있고 살아 있는 잡이 없습니다 — 자가복구 잡을 만듭니다',
    actionMode: String(row.action_mode || 'BC'),
  };
}
