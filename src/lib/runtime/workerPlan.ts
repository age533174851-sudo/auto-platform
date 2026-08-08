// src/lib/runtime/workerPlan.ts
//
// **Worker가 매 순간 무엇을 할지 정하는 판정.**
//
// 이 파일은 Fly를 모른다. Railway도, Cloud Run도, VPS도 모른다.
// `fetch`도 `process`도 쓰지 않는다 — 순수 함수만 있다.
//
// 왜 이렇게 나누는가
// ──────────────────
// 호스트는 바뀐다. 지금은 Fly가 맞지만 전략이 늘어 초 단위가 필요해지거나
// 서울 리전이 필요해지면 옮긴다. 그때 **판정까지 같이 옮겨 쓰면 옮기는
// 김에 규칙이 조금씩 달라진다.** 그러면 "재시작 후 중복 주문 안 나감"을
// 새 호스트에서 다시 증명해야 한다.
//
// 그래서 껍데기(프로세스 · 시그널 · 배포)만 호스트별로 두고, 규칙은
// 여기 하나에 둔다. 테스트도 여기에만 붙는다.
//
// **실행엔진은 이미 있다 — `worker/src/index.ts`.**
// jobs 큐 폴링, 락 획득, 거래소 실행, Ghost Sync, 킬스위치, heartbeat,
// stale 잡 회수가 전부 거기 있다. 이 판정을 붙일 때 그것을 대체하지 않고
// **그 안에서 부르도록** 붙인다 — 실행엔진이 둘이면 한쪽만 고치는 일이
// 반드시 생기고, 그때 "화면은 안 돈다는데 Worker는 돌고 있다"가 된다.
//
// (처음에 내가 worker/main.mjs로 두 번째 엔진을 만들었다. 저장소를 먼저
//  안 봤기 때문이다. 지웠다.)
//
// 이 파일이 막으려는 것
// ─────────────────────
//  1. **두 Worker가 같은 job을 동시에 도는 것.** Fly가 Machine을 옮기면
//     잠깐 둘이 살아 있을 수 있다. 그때 같은 주문이 두 번 나간다
//  2. 늦게 깨어난 Worker가 옛 임대로 주문을 내는 것 — 임대 만료만으로는
//     못 막는다. 번호표(fencing token)가 필요하다
//  3. 죽어 있던 동안의 틱을 몰아서 처리하는 것
//  4. 종료 신호를 받고도 주문을 새로 내는 것 — 그 주문의 결과를 아무도
//     확인하지 못한 채 프로세스가 사라진다
//  5. Worker의 메모리를 장부로 쓰는 것 — 재시작하면 사라진다

import { leaseCheck, fenceCheck, tickKey, gapCheck } from './persistentRuntime';

function num(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── 심장박동 ──────────────────────────────────────────────

/**
 * 심장박동 주기.
 *
 * 임대 만료(30초)보다 넉넉히 짧아야 한다. 같으면 네트워크가 한 번
 * 느려질 때마다 임대를 잃고, 그러면 멀쩡한 Worker가 계속 쫓겨난다.
 */
export const HEARTBEAT_EVERY_MS = 10_000;
/** 이보다 오래 못 들으면 죽은 것으로 본다 */
export const LEASE_TTL_MS = 30_000;

export type WorkerAction =
  /** 임대를 잡는다 */
  | 'ACQUIRE_LEASE'
  /** 심장박동만 갱신한다 */
  | 'HEARTBEAT'
  /** 이번 틱을 실행한다 */
  | 'RUN_TICK'
  /** 아무것도 안 한다 (아직 시각이 아니다) */
  | 'IDLE'
  /** 이 job을 놓는다 */
  | 'RELEASE'
  /** 종료 중이다 — 새 일을 시작하지 않는다 */
  | 'DRAIN';

export interface WorkerStep {
  action: WorkerAction;
  /** 이번에 돌릴 틱의 열쇠. RUN_TICK이 아니면 null */
  tickKey: string | null;
  /** 놓친 구간을 GAP으로 남겨야 하는가 */
  recordGap: boolean;
  missedTicks: number | null;
  reason: string;
}

export interface StepInput {
  jobId?: any;
  desiredState?: any;
  /** 지금 이 job의 임대 주인 */
  leaseOwner?: any;
  leaseExpiresAtMs?: any;
  /** 이 Worker의 id */
  myWorkerId?: any;
  /** 내가 들고 있는 번호표 */
  myFencingToken?: any;
  /** DB에 적힌 지금 번호표 */
  currentFencingToken?: any;
  lastTickAtMs?: any;
  intervalSec?: any;
  nowMs?: any;
  /** 종료 신호를 받았는가 */
  shuttingDown?: boolean;
}

/**
 * 지금 이 job에 대해 무엇을 할 것인가.
 *
 * **순서가 중요하다.** 종료 → 원하는 상태 → 임대 → 번호표 → 시각.
 * 앞의 것을 건너뛰고 뒤를 보면, 종료 중에 주문을 내거나 남의 임대로
 * 틱을 돌리게 된다.
 */
export function nextStep(input: StepInput | null | undefined): WorkerStep {
  const i = input ?? {};
  const now = num(i.nowMs);
  const none = (action: WorkerAction, reason: string): WorkerStep =>
    ({ action, tickKey: null, recordGap: false, missedTicks: null, reason });

  // ── 1) 종료 중이면 새 일을 시작하지 않는다 ──
  //
  // SIGTERM을 받은 뒤에 주문을 내면, 그 주문의 결과를 아무도 확인하지
  // 못한 채 프로세스가 사라진다. 그 주문은 UNKNOWN으로 남고, 다음
  // Worker는 그것이 체결됐는지 모른 채 시작한다.
  if (i.shuttingDown === true) {
    return none('DRAIN', '종료 중입니다 — 새 틱을 시작하지 않고 진행 중인 것만 마칩니다');
  }

  // ── 2) 사용자가 원하는 상태 ──
  const desired = String(i.desiredState ?? '').trim().toUpperCase();
  if (desired !== 'RUNNING') {
    return none('RELEASE',
      desired ? `원하는 상태가 ${desired}입니다 — 임대를 놓습니다`
        : '원하는 상태를 읽지 못해 임대를 놓습니다');
  }

  const myId = String(i.myWorkerId ?? '').trim();
  if (!myId) return none('IDLE', '내 Worker id가 없습니다');
  if (now === null) return none('IDLE', '지금 시각을 읽지 못했습니다');

  // ── 3) 임대 ──
  //
  // `leaseCheck`는 이미 있는 판정이다. 여기서 다시 구현하지 않는다 —
  // 임대 규칙이 두 곳에 있으면 한쪽만 고치는 일이 반드시 생긴다.
  const lc = leaseCheck(
    { ownerWorkerId: i.leaseOwner, leaseExpiresAt: i.leaseExpiresAtMs },
    myId, now,
  );
  if (lc.verdict === 'ACQUIRE') return none('ACQUIRE_LEASE', lc.reason);
  if (lc.verdict !== 'RENEW') {
    // BLOCKED(남이 잡고 있다)나 UNKNOWN(확인 못 했다) — 둘 다 안 돈다.
    // **확인하지 못한 것을 내 것으로 치지 않는다.** 겹쳐 돌면 같은
    // 주문이 두 번 나간다.
    return none('IDLE', lc.reason);
  }

  // ── 4) 번호표 ──
  //
  // 임대가 내 것이어도 번호표를 확인한다. Fly가 Machine을 옮기는 동안
  // 잠깐 둘이 살아 있으면, 늦게 깨어난 쪽이 옛 번호표로 주문을 낸다.
  // 임대 만료만으로는 그걸 못 막는다.
  const fc = fenceCheck(i.myFencingToken, i.currentFencingToken);
  if (!fc.ok) {
    return none('RELEASE', `번호표 확인 실패 (${fc.code}) — ${fc.reason}`);
  }

  // ── 5) 지금 돌 시각인가 ──
  const iv = num(i.intervalSec);
  const last = num(i.lastTickAtMs);
  if (iv === null || iv <= 0) {
    return none('HEARTBEAT', '주기를 읽지 못해 틱을 돌리지 않고 심장박동만 갱신합니다');
  }

  const g = gapCheck({ lastTickAtMs: last, nowMs: now, intervalSec: iv });

  // 아직 한 번도 안 돌았으면 지금 돈다.
  if (last === null) {
    const k = tickKey(String(i.jobId ?? ''), now, iv);
    return { action: k ? 'RUN_TICK' : 'HEARTBEAT', tickKey: k,
      recordGap: false, missedTicks: null,
      reason: k ? '첫 틱입니다' : '틱 열쇠를 만들지 못했습니다' };
  }

  const dueAt = last + iv * 1000;
  if (now < dueAt) {
    return none('HEARTBEAT', `다음 틱까지 ${Math.ceil((dueAt - now) / 1000)}초 남았습니다`);
  }

  const k = tickKey(String(i.jobId ?? ''), now, iv);
  if (!k) return none('HEARTBEAT', '틱 열쇠를 만들지 못했습니다');

  return {
    action: 'RUN_TICK', tickKey: k,
    // **놓친 구간을 몰아서 돌지 않는다.** 세되 채우지 않는다 —
    // 3분 죽어 있었다고 10초짜리 틱 18개를 지어내면 일어나지 않은
    // 거래 18건을 만드는 것이다.
    recordGap: g.hasGap,
    missedTicks: g.missedTicks,
    reason: g.hasGap ? g.reason : '',
  };
}

// ── 재시작 복구 ───────────────────────────────────────────

export interface RecoveryPlan {
  /** 되찾을 job id들 */
  reclaim: string[];
  /** 남의 것이라 건드리지 않는 것 */
  skip: string[];
  /** **언제나 false.** 로컬 상태로 복구하지 않는다 */
  useLocalState: false;
  note: string;
}

/**
 * Worker가 새로 떴다. 무엇을 이어받는가.
 *
 * **DB가 진실이다.** Worker의 메모리나 디스크에 남은 것으로 복구하면,
 * 그 Worker가 죽기 전에 무엇을 했는지에 따라 결과가 달라진다 — 같은
 * 상황에서 두 번 다른 결과가 나오는 시스템은 검증할 수 없다.
 *
 * Fly는 Machine을 다른 호스트로 옮긴다. 그때 디스크도 같이 안 갈 수
 * 있고, 갔더라도 그 사이 다른 Worker가 일을 진행했을 수 있다.
 *
 * `useLocalState`를 리터럴 `false` 타입으로 둔 것은 실수 방지다 —
 * "빠른 복구"를 위해 로컬 캐시를 쓰려 하면 타입에서 먼저 막힌다.
 */
export function recoveryPlan(
  jobs: Array<{ id?: any; desiredState?: any; leaseOwner?: any; leaseExpiresAtMs?: any }> | null | undefined,
  myWorkerId: any,
  nowMs: any,
): RecoveryPlan {
  const list = Array.isArray(jobs) ? jobs : [];
  const myId = String(myWorkerId ?? '').trim();
  const now = num(nowMs);

  if (!myId || now === null) {
    return { reclaim: [], skip: [], useLocalState: false,
      note: '내 id나 지금 시각을 몰라 아무것도 이어받지 않습니다' };
  }

  const reclaim: string[] = [];
  const skip: string[] = [];

  for (const j of list) {
    const id = String(j?.id ?? '').trim();
    if (!id) continue;
    if (String(j?.desiredState ?? '').trim().toUpperCase() !== 'RUNNING') { skip.push(id); continue; }
    const lc = leaseCheck(
      { ownerWorkerId: j?.leaseOwner, leaseExpiresAt: j?.leaseExpiresAtMs },
      myId, now,
    );
    // RENEW(원래 내 것) 또는 ACQUIRE(만료돼 비었다)만 이어받는다.
    // BLOCKED는 남이 살아 있는 것이고, UNKNOWN은 확인 못 한 것이다 —
    // **확인 못 한 것을 이어받으면 둘이 동시에 돈다.**
    if (lc.verdict === 'RENEW' || lc.verdict === 'ACQUIRE') reclaim.push(id);
    else skip.push(id);
  }

  return {
    reclaim, skip, useLocalState: false,
    note: reclaim.length > 0
      ? `${reclaim.length}개를 DB에서 다시 찾아 이어받습니다 (로컬 상태는 쓰지 않습니다)`
      : '이어받을 job이 없습니다',
  };
}

// ── 종료 ──────────────────────────────────────────────────

export interface ShutdownPlan {
  /** 새 틱을 시작해도 되는가 */
  acceptNewWork: false;
  /** 진행 중인 것을 기다린다 */
  waitForInflight: boolean;
  /** 임대를 놓는다 — 다음 Worker가 바로 이어받게 */
  releaseLeases: boolean;
  /** 이 시간 안에 안 끝나면 포기하고 종료 */
  graceMs: number;
  note: string;
}

/**
 * 종료 신호를 받았다.
 *
 * **새 일을 받지 않고, 진행 중인 것을 마치고, 임대를 놓는다.**
 *
 * 임대를 놓는 것이 중요하다. 안 놓으면 다음 Worker가 만료(30초)를
 * 기다려야 하고, 그 30초 동안 아무것도 안 돈다 — 배포할 때마다
 * 30초씩 멈추는 셈이다.
 *
 * 진행 중인 주문을 버리고 나가면 그 주문은 UNKNOWN이 되고, 다음
 * Worker는 그것이 체결됐는지 모른 채 시작한다.
 */
export function shutdownPlan(inflightCount: any): ShutdownPlan {
  const n = num(inflightCount) ?? 0;
  return {
    acceptNewWork: false,
    waitForInflight: n > 0,
    releaseLeases: true,
    graceMs: 25_000,
    note: n > 0
      ? `진행 중인 작업 ${n}개를 마친 뒤 임대를 놓습니다 — 버리고 나가면`
        + ' 그 주문이 UNKNOWN으로 남고 다음 Worker가 체결 여부를 모릅니다'
      : '진행 중인 작업이 없어 임대를 놓고 바로 종료합니다',
  };
}

// ── 이 Worker를 어떻게 부르는가 ───────────────────────────

/**
 * Worker id.
 *
 * **호스트가 준 값을 그대로 쓴다.** Fly는 Machine id를 주고, Railway는
 * 다른 것을 준다. 여기서 만들어 내면 재시작할 때마다 달라져서, 같은
 * Machine이 이어받는 것인지 새 Machine인지 구분할 수 없다.
 *
 * 못 받으면 `null`이다 — 지어내지 않는다. id가 없으면 임대를 못 잡고,
 * 그건 아무것도 안 도는 것이라 안전한 쪽이다.
 */
export function workerIdFrom(env: Record<string, any> | null | undefined): string | null {
  const e = env ?? {};
  const candidates = [
    e.FLY_MACHINE_ID,            // Fly
    e.RAILWAY_REPLICA_ID,        // Railway
    e.CLOUD_RUN_EXECUTION,       // Cloud Run
    e.HOSTNAME,                  // 컨테이너 일반
    e.WORKER_ID,                 // 직접 지정
  ];
  for (const c of candidates) {
    const s = String(c ?? '').trim();
    if (s) return s;
  }
  return null;
}

export const HOST_INDEPENDENT_NOTE =
  '이 판정은 호스트를 모른다. Fly·Railway·Cloud Run·VPS 어디로 옮겨도'
  + ' 규칙은 바뀌지 않는다 — 옮기는 김에 규칙이 달라지면 "재시작 후 중복'
  + ' 주문 없음"을 새 호스트에서 처음부터 다시 증명해야 한다';
