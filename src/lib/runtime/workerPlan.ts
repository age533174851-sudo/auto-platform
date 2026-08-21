// src/lib/runtime/workerPlan.ts
//
// **켜져 있다(desired)와 돌고 있다(observed)는 다른 사실이다.**
//
// 왜 필요한가
// ───────────
// 2026-08-13에 원본 전략이 판단 창을 133분 놓쳤다. 그때 화면은
// 아무것도 이상하다고 말하지 않았다 — 예약은 `enabled: true`였고,
// 그것만 보면 "켜져 있으니 돌고 있다"였다.
//
// 실제로는 워커에 폴링 코드가 배포되지 않아 아무도 그 예약을 보지
// 않았다. 코드가 main에 있어도 Fly에 안 올라가면 없는 코드와 같다.
//
// 그 뒤로 부품은 하나씩 생겼다:
//   `dueCheck`         이 예약이 지금 평가할 차례인가
//   `runtimeStateOf`   그 줄 하나의 상태(WATCHING·STALE·BLOCKED…)
//   `worker_heartbeat` 워커가 마지막으로 살아 있던 시각
//   `dispatch source`  누가 그 평가를 깨웠는가
//
// **그런데 이걸 하나로 합쳐 "지금 전체가 정상인가"를 답하는 곳이 없다.**
// 화면은 줄마다 배지를 그리고, 사람은 그 배지들을 눈으로 합산한다.
// 이 파일이 그 합산을 값으로 만든다.
//
// 무엇을 하지 않는가
// ──────────────────
// **판정을 새로 만들지 않는다.** 줄 하나의 상태는 `runtimeStateOf`가
// 이미 정했다 — 여기서 다시 계산하면 두 벌이 되고, 그때 화면의 배지와
// 관제판의 요약이 서로 다른 말을 한다.

import { WORKER_STALE_MS, type RuntimeState } from '../autotrade/evaluationLoop';

/** 이 예약이 **어떤 상태이기를 바라는가** (DB가 말하는 것) */
export interface DesiredSchedule {
  id: string;
  symbol: string;
  strategyId: string;
  enabled: boolean;
  /** 연결이 없으면 켜져 있어도 주문을 못 낸다 */
  connectionId: string | null;
  mode: string;
}

/** 이 예약이 **실제로 어떤 상태인가** (`runtimeStateOf`가 판정한 것) */
export interface ObservedSchedule {
  id: string;
  state: RuntimeState;
  /** 마지막으로 실행기가 이 줄을 본 시각(ms). **못 읽으면 null** */
  lastRunAtMs: number | null;
  /** 누가 깨웠는가 */
  source: string | null;
}

export type PlanCode =
  /** 켜진 예약이 없다 — 고장이 아니다 */
  | 'IDLE'
  /** 켜져 있고 전부 정상이다 */
  | 'HEALTHY'
  /** 주 실행기가 안 온다. **켜져 있어도 아무도 안 본다** */
  | 'WORKER_DOWN'
  /** 워커가 살아 있는지 확인하지 못했다 */
  | 'WORKER_UNKNOWN'
  /** 예약 자체가 막혀 있다(연결 없음 등) */
  | 'BLOCKED'
  /** 실행기는 오는데 어떤 줄이 밀렸다 */
  | 'STALE';

export interface WorkerPlan {
  code: PlanCode;
  /** **지금 자동매매가 실제로 돌고 있다고 말해도 되는가** */
  healthy: boolean;
  desiredOn: number;
  /** 실제로 감시 중인 줄 수 */
  observedRunning: number;
  /** 사람이 손봐야 하는 줄 */
  needsAttention: Array<{ id: string; symbol: string; state: RuntimeState; why: string }>;
  headline: string;
  reason: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 워커가 지금 살아 있는가. **못 읽으면 null이다 — 죽었다고도 살았다고도 하지 않는다** */
export function workerAlive(nowMs: number, lastSeenMs: any): boolean | null {
  const t = num(lastSeenMs);
  if (t == null) return null;
  return nowMs - t <= WORKER_STALE_MS;
}

/**
 * 원하는 상태와 관측된 상태를 맞춰 본다.
 *
 * 순서가 곧 규칙이다:
 *   1. **켠 것이 없으면 고장이 아니다** — 회색이지 빨강이 아니다
 *   2. 주 실행기가 안 오면 나머지는 볼 필요가 없다. 켜져 있어도 아무도 안 본다
 *   3. 워커 상태를 못 읽었으면 **정상이라고 말하지 않는다**
 *   4. 막힌 줄이 있으면 사람이 손봐야 한다
 *   5. 밀린 줄이 있으면 경고
 */
export function workerPlan(i: {
  nowMs: number;
  desired: DesiredSchedule[];
  observed: ObservedSchedule[];
  /** `worker_heartbeat`의 마지막 시각. **못 읽었으면 null** */
  workerLastSeenMs: number | null;
}): WorkerPlan {
  const desired = Array.isArray(i.desired) ? i.desired : [];
  const byId = new Map(i.observed?.map(o => [String(o.id), o]) ?? []);
  // **`enabled === true`만 켜진 것이다.** 문자열 'false'는 truthy다.
  const on = desired.filter(d => d.enabled === true);

  const none = { desiredOn: on.length, observedRunning: 0, needsAttention: [] as WorkerPlan['needsAttention'] };

  if (on.length === 0) {
    return {
      ...none, code: 'IDLE', healthy: true,
      headline: '켜진 자동매매 없음',
      reason: '예약이 하나도 켜져 있지 않습니다 — 고장이 아닙니다',
    };
  }

  const alive = workerAlive(i.nowMs, i.workerLastSeenMs);

  if (alive === false) {
    return {
      ...none, code: 'WORKER_DOWN', healthy: false,
      needsAttention: on.map(d => ({
        id: d.id, symbol: d.symbol, state: 'STALE' as RuntimeState,
        why: '주 실행기(Fly Worker)가 오지 않습니다',
      })),
      headline: `켜진 ${on.length}개 · 주 실행기 없음`,
      reason: '예약은 켜져 있지만 주 실행기가 오지 않습니다 — '
        + '이 상태에서는 켜 두어도 아무도 평가하지 않습니다. Fly 배포와 워커 상태를 확인하세요',
    };
  }

  const attention: WorkerPlan['needsAttention'] = [];
  let running = 0;

  for (const d of on) {
    const o = byId.get(String(d.id));
    if (!o) {
      // **관측이 없는 것을 정상으로 읽지 않는다.**
      attention.push({ id: d.id, symbol: d.symbol, state: 'UNKNOWN' as RuntimeState,
        why: '이 예약의 실행 상태를 읽지 못했습니다' });
      continue;
    }
    if (o.state === 'WATCHING' || o.state === 'ENTERED') { running++; continue; }
    if (o.state === 'OFF') { continue; }
    attention.push({ id: d.id, symbol: d.symbol, state: o.state, why: whyOf(o.state) });
  }

  if (alive == null) {
    return {
      desiredOn: on.length, observedRunning: running, needsAttention: attention,
      code: 'WORKER_UNKNOWN', healthy: false,
      headline: `켜진 ${on.length}개 · 실행기 확인 못 함`,
      reason: '주 실행기가 살아 있는지 확인하지 못했습니다 — 확인하지 못한 것은 정상이 아닙니다',
    };
  }

  const blocked = attention.filter(a => a.state === 'BLOCKED');
  if (blocked.length > 0) {
    return {
      desiredOn: on.length, observedRunning: running, needsAttention: attention,
      code: 'BLOCKED', healthy: false,
      headline: `켜진 ${on.length}개 · 막힘 ${blocked.length}개`,
      reason: `${blocked.map(b => b.symbol).join(' · ')}이(가) 막혀 있습니다 — 사람이 손봐야 합니다`,
    };
  }
  if (attention.length > 0) {
    return {
      desiredOn: on.length, observedRunning: running, needsAttention: attention,
      code: 'STALE', healthy: false,
      headline: `켜진 ${on.length}개 · 감시 중 ${running}개 · 확인 필요 ${attention.length}개`,
      reason: attention.map(a => `${a.symbol}: ${a.why}`).join(' / '),
    };
  }

  return {
    desiredOn: on.length, observedRunning: running, needsAttention: [],
    code: 'HEALTHY', healthy: true,
    headline: `켜진 ${on.length}개 모두 감시 중`,
    reason: '주 실행기가 살아 있고 켜진 예약이 전부 감시 중입니다',
  };
}

function whyOf(state: RuntimeState): string {
  switch (state) {
    case 'STALE': return '실행기가 제때 오지 않았습니다';
    case 'BLOCKED': return '막혀 있습니다 — 사람이 손봐야 합니다';
    case 'NEVER_RAN': return '켜져 있는데 아직 한 번도 평가되지 않았습니다';
    case 'FAILED': return '마지막 평가가 실패했습니다';
    case 'UNKNOWN': return '상태를 확인하지 못했습니다';
    default: return String(state);
  }
}

// ── 배포가 실제로 반영됐는가 ────────────────────────

export type DeploymentCode = 'MATCHED' | 'MISMATCH' | 'UNKNOWN';

export interface DeploymentVerdict {
  code: DeploymentCode;
  /** **지금 도는 코드가 main과 같다고 말해도 되는가** */
  matched: boolean;
  reason: string;
}

/**
 * main · Vercel · Fly가 같은 코드를 돌리고 있는가.
 *
 * **#124에서 실제로 드러난 것**: 코드가 main에 있어도 Fly에 안 올라가면
 * 없는 코드와 같다. fly-deploy가 8/9 이후 한 번도 안 돌아서, 워커는
 * 8/9 코드로 도는데 화면은 아무것도 이상하다고 말하지 않았다.
 * 그 사이 8/13 판단 창을 통째로 놓쳤다.
 *
 * **모르면 MATCHED가 아니다.** 못 읽은 것을 "같다"로 읽으면 이 검사가
 * 있으나 마나다.
 */
/**
 * main을 모를 때도 답할 수 있는 것: **웹과 워커가 같은 코드인가.**
 *
 * `deploymentVerdict`는 셋을 다 요구한다. 그런데 서버는 main의 SHA를
 * 모른다 — GitHub에 물어야 하고, 그 호출이 실패하면 판정 전체가
 * UNKNOWN이 되어 아무것도 못 본다.
 *
 * 웹(Vercel)과 워커(Fly)는 **둘 다 자기 커밋을 안다.** 둘이 다르면 그
 * 자체로 사고다 — 실제로 8/15에 Vercel은 #135, Fly는 #127이었다.
 * 그 한 줄만 있었어도 원인을 바로 찾았다.
 *
 * **하나라도 못 읽으면 MATCHED가 아니다.**
 */
export function runtimeSkew(i: {
  vercelSha?: string | null;
  flySha?: string | null;
}): DeploymentVerdict {
  const norm = (v: any) => String(v ?? '').trim().slice(0, 40).toLowerCase();
  const vercel = norm(i?.vercelSha);
  const fly = norm(i?.flySha);

  const missing: string[] = [];
  if (!vercel) missing.push('Vercel');
  if (!fly) missing.push('Fly');
  if (missing.length > 0) {
    return { code: 'UNKNOWN', matched: false,
      reason: `${missing.join(' · ')} 버전을 읽지 못했습니다 — `
        + '같은 코드가 도는지 확인되지 않았습니다 (모르는 것을 "같다"로 읽지 않습니다)' };
  }
  const same = vercel.startsWith(fly) || fly.startsWith(vercel);
  return same
    ? { code: 'MATCHED', matched: true, reason: '웹(Vercel)과 워커(Fly)가 같은 코드를 돌리고 있습니다' }
    : { code: 'MISMATCH', matched: false,
      reason: `웹은 ${vercel.slice(0, 7)}, 워커는 ${fly.slice(0, 7)} — 다른 코드를 돌리고 있습니다. `
        + '머지됐다고 배포된 것이 아닙니다' };
}

export function deploymentVerdict(i: {
  mainSha?: string | null;
  vercelSha?: string | null;
  /** 워커 자체가 보고한 SHA */
  flySha?: string | null;
  /**
   * 이 코드가 요구하는 마이그레이션이 DB에 다 들어갔는가.
   *
   * **SHA가 셋 다 같아도 이게 아니면 배포가 끝난 것이 아니다.** 코드만
   * 앞서 나가면 새 칸에 대한 쓰기가 조용히 실패하고 매매는 계속된다 —
   * 054에서 실제로 일어난 일이다. 그래서 배포 검증에 스키마를 포함한다.
   *
   * `undefined`는 **확인하지 않았다**는 뜻이고, 그때는 이 조건을 보지 않는다
   * (예전 호출부를 갑자기 UNKNOWN으로 만들지 않기 위해서다).
   * `false`는 확인했고 안 됐다는 뜻이다.
   */
  migrationsApplied?: boolean | null;
  /** 남은 마이그레이션 이름 (사유에 적기 위해서만 쓴다) */
  pendingMigrations?: string[] | null;
}): DeploymentVerdict {
  const norm = (v: any) => String(v ?? '').trim().slice(0, 40).toLowerCase();
  const main = norm(i.mainSha);
  const vercel = norm(i.vercelSha);
  const fly = norm(i.flySha);

  const missing: string[] = [];
  if (!main) missing.push('main');
  if (!vercel) missing.push('Vercel');
  if (!fly) missing.push('Fly');
  if (missing.length > 0) {
    return { code: 'UNKNOWN', matched: false,
      reason: `${missing.join(' · ')} 버전을 읽지 못했습니다 — 같은 코드가 도는지 확인되지 않았습니다` };
  }

  // 짧은 SHA와 긴 SHA를 섞어 비교해도 맞게 한다.
  const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  const behind: string[] = [];
  if (!same(main, vercel)) behind.push('Vercel');
  if (!same(main, fly)) behind.push('Fly');

  if (behind.length > 0) {
    return { code: 'MISMATCH', matched: false,
      reason: `${behind.join(' · ')}가 main과 다른 코드를 돌리고 있습니다 — `
        + '머지됐다고 배포된 것이 아닙니다. 배포를 확인하세요' };
  }
  // ── 코드가 같아도 DB가 따라오지 않았으면 '배포 완료'가 아니다 ──
  if (i.migrationsApplied === false) {
    const pend = Array.isArray(i.pendingMigrations) ? i.pendingMigrations : [];
    return {
      code: 'MISMATCH', matched: false,
      reason: 'main · Vercel · Fly가 같은 코드를 돌리고 있지만 **DB 스키마가 따라오지 않았습니다**'
        + (pend.length ? ` (남은 마이그레이션 ${pend.length}개: ${pend.slice(0, 3).join(', ')})` : '')
        + ' — 이 상태는 배포 완료가 아닙니다',
    };
  }
  if (i.migrationsApplied == null && i.migrationsApplied !== undefined) {
    // null = 확인하려 했는데 못 읽었다. **모르는 것을 '됐다'로 읽지 않는다.**
    return { code: 'UNKNOWN', matched: false,
      reason: 'main · Vercel · Fly는 같지만 마이그레이션 적용 여부를 확인하지 못했습니다 — 배포 완료로 보지 않습니다' };
  }
  return {
    code: 'MATCHED', matched: true,
    reason: i.migrationsApplied === true
      ? 'main · Vercel · Fly가 같은 코드를 돌리고 있고 DB 스키마도 따라와 있습니다'
      : 'main · Vercel · Fly가 같은 코드를 돌리고 있습니다',
  };
}
