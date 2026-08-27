// src/lib/ops/migrationWait.ts
//
// **같은 push에서 migrate와 fly-deploy가 동시에 출발한다.**
//
// 실제로 이렇게 막혔다
// ────────────────────
// #182를 합친 순간(2026-08-27 01:35:32Z) 두 워크플로가 같이 시작했다.
//
//   01:36:03  fly-deploy  "적용됨 63 / 남음 1 → PENDING" → 배포 중단
//   01:36:03  migrate     067을 적용하기 시작
//   01:36:15  migrate     적용 완료
//
// 게이트는 옳게 동작했다 — DB가 뒤처진 채로 워커를 바꾸지 않는 것은
// 맞다. 문제는 **12초를 못 기다려서** 마이그레이션이 포함된 merge마다
// 배포가 반드시 한 번 실패하고, 사람이 재실행 버튼을 눌러야 끝난다는
// 것이다. 이 저장소에서 반복적으로 없애 온 모양이다: 기계가 할 수 있는
// 일에 사람 손이 상시로 끼는 구조.
//
// 그래서 **판정을 바꾸지 않고 시간만 준다.** 여전히 fail-closed다 —
// 끝내 안 끝나면 배포하지 않는다.
//
// 기다려도 소용없는 것은 기다리지 않는다
// ──────────────────────────────────────
// `NEEDS_APPROVAL`은 migrate가 **자동으로 적용하지 않는** 것들이다.
// 5분을 기다린 뒤 실패하면 원인만 흐려진다 — 즉시 멈추고 이유를 적는다.

export type MigrationWaitCode =
  /** DB가 코드를 따라와 있다. 배포해도 된다 */
  | 'READY'
  /** 아직 남았다. migrate가 돌고 있을 수 있다 — 더 본다 */
  | 'WAITING'
  /** 끝내 안 끝났다. **이 상태로 워커를 바꾸지 않는다** */
  | 'TIMEOUT'
  /** 사람이 승인해야 하는 변경이다. 기다려도 안 풀린다 */
  | 'NEEDS_APPROVAL'
  /** 접속 정보가 없어 확인 자체를 못 했다. **따라와 있다는 뜻이 아니다** */
  | 'SKIPPED'
  /** 상태를 못 읽었다. **따라와 있다는 뜻이 아니다** */
  | 'UNREADABLE';

export interface MigrationWaitVerdict {
  code: MigrationWaitCode;
  /** 더 기다릴 필요 없이 결론이 났는가 */
  done: boolean;
  /** 배포를 진행해도 되는가 */
  proceed: boolean;
  reason: string;
}

/**
 * 지금 배포해도 되는가 · 더 기다려야 하는가.
 *
 * **못 읽은 것을 "따라와 있다"로 읽지 않는다.** 시간이 남아 있으면
 * 못 읽은 것도 아직 결론이 아니다 — 마이그레이션 도중에는 조회가
 * 흔들릴 수 있다.
 */
export function migrationWaitVerdict(i: {
  /** `migration-report.json`의 code. **못 읽었으면 null** */
  code: string | null | undefined;
  /** 기다리기 시작한 뒤 흐른 시간 */
  elapsedMs: number;
  /** 이만큼 지나면 결론을 낸다 */
  budgetMs: number;
  /** 아직 안 끝난 마이그레이션 이름 (로그용) */
  pending?: string[] | null;
}): MigrationWaitVerdict {
  const code = String(i?.code || '').toUpperCase() || null;
  const outOfTime = Number(i?.elapsedMs) >= Number(i?.budgetMs);
  const names = Array.isArray(i?.pending) && i.pending.length
    ? ` (${i.pending.slice(0, 5).join(' · ')})` : '';

  if (code === 'UP_TO_DATE') {
    return { code: 'READY', done: true, proceed: true, reason: 'DB가 코드를 따라와 있습니다' };
  }

  // **기다려도 안 풀린다.** 자동 적용 대상이 아니다.
  if (code === 'NEEDS_APPROVAL') {
    return { code: 'NEEDS_APPROVAL', done: true, proceed: false,
      reason: `사람이 승인해야 하는 마이그레이션이 남아 있습니다${names} — `
        + '기다려도 자동으로 적용되지 않습니다. migration-report를 보세요' };
  }

  // 예전부터의 동작을 그대로 둔다: 주소를 모르면 확인하지 못한 채 배포한다.
  // 다만 **확인했다고 적지 않는다.**
  if (code === 'NO_CREDENTIAL') {
    return { code: 'SKIPPED', done: true, proceed: true,
      reason: '접속 정보가 없어 마이그레이션 상태를 확인하지 못했습니다 — '
        + 'DB가 따라와 있다는 뜻이 아닙니다' };
  }

  if (code === 'PENDING') {
    if (!outOfTime) {
      return { code: 'WAITING', done: false, proceed: false,
        reason: `아직 적용되지 않은 마이그레이션이 있습니다${names} — migrate를 기다립니다` };
    }
    return { code: 'TIMEOUT', done: true, proceed: false,
      reason: `마이그레이션이 끝나지 않았습니다${names} — 이 상태로 워커를 바꾸지 않습니다. `
        + 'migrate 워크플로가 먼저 끝나야 합니다' };
  }

  // UNKNOWN · 읽기 실패 · 처음 보는 code — 전부 "모른다"다.
  if (!outOfTime) {
    return { code: 'WAITING', done: false, proceed: false,
      reason: `마이그레이션 상태를 아직 읽지 못했습니다${code ? ` (${code})` : ''}` };
  }
  return { code: 'UNREADABLE', done: true, proceed: false,
    reason: `마이그레이션 상태를 끝내 읽지 못했습니다${code ? ` (${code})` : ''} — `
      + 'DB가 따라와 있다는 뜻이 아니라서 배포하지 않습니다' };
}

/** 얼마나 · 얼마 간격으로 기다릴 것인가. 두 곳으로 갈리지 않게 여기 하나만 둔다 */
export const MIGRATION_WAIT_BUDGET_MS = 300_000;
export const MIGRATION_WAIT_INTERVAL_MS = 10_000;
