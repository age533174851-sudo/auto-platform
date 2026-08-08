// src/lib/runtime/persistentRuntime.ts
//
// **화면을 떠나면 자동매매가 멈춘다.**
//
// MOCK 자동매매가 브라우저 타이머로 돈다:
//
//   자동매매 시작 → React state = true → setInterval(10초)
//   → 다른 화면 이동 → component unmount → **타이머 소멸**
//
// 다른 메뉴로 가거나, 탭이 백그라운드가 되거나, 안드로이드가 절전에
// 넣거나, 앱을 닫으면 느려지거나 멈춘다. 그런데 자동매매는 사용자가
// 화면을 보고 있느냐와 상관없이 돌아야 한다.
//
// 원칙은 하나다
// ─────────────
//   브라우저   보여주고 조작만 한다
//   서버/Worker 실제로 실행한다
//   DB         현재 상태의 진실
//
// 이 파일이 하는 일
// ─────────────────
// 실행기를 옮기는 것은 인프라 작업이다. 이 파일은 그 전에 필요한
// **판정**을 담는다 — 무엇을 '실행 중'이라고 부를 수 있는가.
//
// 가장 중요한 규칙: **enabled는 running이 아니다.**
//
// DB에 enabled=true가 적혀 있다고 실제로 돌고 있는 것이 아니다. Worker가
// 죽어 있으면 그건 '설정이 켜져 있다'일 뿐이고, 화면이 그것을 '실행 중'
// 이라고 적으면 거짓말이 된다. 사용자는 자동매매가 자기 돈을 지키고
// 있다고 믿는다.
//
// 그리고 false와 unknown도 다르다
// ───────────────────────────────
// 화면에 들어올 때 `useState(false)`로 시작하면 서버 응답이 오기 전까지
// '정지'가 보인다. 실제로는 돌고 있는데도. 그 짧은 순간에 사용자가
// [시작]을 누르면 **두 번 시작하는 셈**이 된다.

export type RuntimeType =
  | 'MOCK_AUTO' | 'PAPER' | 'SHADOW' | 'TESTNET_AUTO' | 'LIVE_AUTO'
  | 'DCA' | 'TRAILING' | 'TWAP' | 'SCALED' | 'RECONCILIATION' | 'ALERTS';

export type RuntimeStatus =
  /** 아직 못 읽었다 — **false가 아니다** */
  | 'UNKNOWN'
  | 'STOPPED'
  | 'STARTING'
  /** 켜져 있고 Worker가 살아 있고 최근에 돌았다 */
  | 'RUNNING'
  | 'PAUSED'
  /** 안전장치가 막았다 */
  | 'BLOCKED'
  /** 켜져 있는데 Worker 응답이 늦다 — **실행 보장 안 됨** */
  | 'DEGRADED'
  /** 켜져 있는데 한참 안 돌았다 */
  | 'STALE'
  | 'ERROR'
  | 'STOPPING';

export const STATUS_LABEL: Record<RuntimeStatus, string> = {
  UNKNOWN: '상태 확인 중…',
  STOPPED: '정지',
  STARTING: '시작하는 중…',
  RUNNING: '실행 중',
  PAUSED: '일시정지',
  BLOCKED: '차단됨',
  DEGRADED: '실행 설정 ON · Worker 응답 없음',
  STALE: '실행 설정 ON · 한참 안 돌았음',
  ERROR: '오류',
  STOPPING: '멈추는 중…',
};

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

export const STATUS_TONE: Record<RuntimeStatus, Tone> = {
  UNKNOWN: 'muted', STOPPED: 'muted', STARTING: 'warn', RUNNING: 'good',
  PAUSED: 'warn', BLOCKED: 'bad', DEGRADED: 'bad', STALE: 'bad',
  ERROR: 'bad', STOPPING: 'warn',
};

/**
 * Worker 심장박동이 이보다 오래되면 살아 있다고 못 한다.
 *
 * 10초 간격으로 도는 실행기라면 30초는 세 번을 걸렀다는 뜻이다.
 */
export const HEARTBEAT_STALE_MS = 30_000;

/** 예정된 실행 시각을 이만큼 넘기면 '안 돌고 있다' */
export const TICK_LATE_FACTOR = 3;

export interface RuntimeRow {
  runtimeId?: any;
  runtimeType?: any;
  /** 사용자가 켰는가 — **이것만으로 '실행 중'이라고 하지 않는다** */
  enabled?: any;
  /** DB에 적힌 상태 */
  status?: any;
  intervalSec?: any;
  lastTickAt?: any;
  workerHeartbeatAt?: any;
  blockedReason?: any;
  lastError?: any;
  /** 이 실행을 잡고 있는 Worker */
  ownerWorkerId?: any;
  leaseExpiresAt?: any;
}

export interface RuntimeHealth {
  status: RuntimeStatus;
  tone: Tone;
  label: string;
  /** 실제로 돌고 있다고 말해도 되는가 */
  actuallyRunning: boolean;
  /** Worker가 마지막으로 살아 있다고 알린 지 (ms). 모르면 null */
  heartbeatAgeMs: number | null;
  /** 마지막 실행 이후 (ms) */
  tickAgeMs: number | null;
  /** 다음 실행 예정 (ms). 모르면 null */
  nextTickInMs: number | null;
  reason: string;
}

const ms = (v: any): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 지금 이 실행기가 진짜로 돌고 있는가.
 *
 * **enabled=true만 보고 '실행 중'이라고 적지 않는다.** RUNNING이라고
 * 말하려면 셋이 다 필요하다:
 *
 *   1. 사용자가 켰다
 *   2. Worker 심장박동이 최근이다
 *   3. 마지막 실행이 너무 늦지 않았다
 *
 * 하나라도 아니면 그 사실을 화면에 적는다. "실행 중"이라고 적어 놓고
 * 실제로 안 도는 것이 가장 나쁘다 — 사용자는 자동매매가 자기 돈을
 * 지키고 있다고 믿는다.
 */
export function runtimeHealth(
  row: RuntimeRow | null | undefined, nowMs?: any,
): RuntimeHealth {
  const now = num(nowMs);
  const make = (status: RuntimeStatus, reason: string, extra: Partial<RuntimeHealth> = {}): RuntimeHealth => ({
    status, tone: STATUS_TONE[status], label: STATUS_LABEL[status],
    actuallyRunning: status === 'RUNNING',
    heartbeatAgeMs: null, tickAgeMs: null, nextTickInMs: null,
    reason, ...extra,
  });

  // **못 읽은 것을 '정지'로 읽지 않는다.**
  //
  // 화면 진입 시 false로 시작하면 서버 응답 전까지 '정지'가 보이고,
  // 그 순간 사용자가 [시작]을 누르면 두 번 시작하는 셈이 된다.
  if (row == null) return make('UNKNOWN', '실행 상태를 아직 읽지 못했습니다');
  if (now == null) return make('UNKNOWN', '현재 시각을 알 수 없어 상태를 판정하지 못했습니다');

  const declared = String(row.status ?? '').trim().toUpperCase();
  const enabled = row.enabled === true;

  const hb = ms(row.workerHeartbeatAt);
  const tick = ms(row.lastTickAt);
  const heartbeatAgeMs = hb == null ? null : Math.max(0, now - hb);
  const tickAgeMs = tick == null ? null : Math.max(0, now - tick);
  const intervalSec = num(row.intervalSec);
  const nextTickInMs = tick != null && intervalSec != null && intervalSec > 0
    ? (tick + intervalSec * 1000) - now : null;
  const ages = { heartbeatAgeMs, tickAgeMs, nextTickInMs };

  // 전환 중 상태는 그대로 존중한다.
  if (declared === 'STARTING') return make('STARTING', '실행기를 잡는 중입니다', ages);
  if (declared === 'STOPPING') return make('STOPPING', '멈추는 중입니다', ages);

  if (row.blockedReason) {
    return make('BLOCKED', String(row.blockedReason), ages);
  }
  if (row.lastError && !enabled) {
    return make('ERROR', String(row.lastError), ages);
  }
  if (declared === 'PAUSED') return make('PAUSED', '사용자가 일시정지했습니다', ages);
  if (!enabled) return make('STOPPED', '', ages);

  // 여기부터는 enabled=true다. **그래도 아직 '실행 중'이 아니다.**
  if (heartbeatAgeMs == null) {
    return make('DEGRADED',
      'Worker 심장박동을 확인하지 못했습니다 — 실행 설정은 켜져 있지만 실제로 도는지 알 수 없습니다', ages);
  }
  if (heartbeatAgeMs > HEARTBEAT_STALE_MS) {
    return make('DEGRADED',
      `Worker 응답 없음 · ${Math.round(heartbeatAgeMs / 1000)}초 — 자동매매 실행이 보장되지 않습니다`, ages);
  }
  if (tickAgeMs == null) {
    return make('DEGRADED', '아직 한 번도 실행되지 않았습니다', ages);
  }
  if (intervalSec != null && intervalSec > 0 && tickAgeMs > intervalSec * 1000 * TICK_LATE_FACTOR) {
    return make('STALE',
      `마지막 실행이 ${Math.round(tickAgeMs / 1000)}초 전입니다 (주기 ${intervalSec}초)`, ages);
  }
  if (row.lastError) {
    return make('DEGRADED', `마지막 실행에서 오류: ${row.lastError}`, ages);
  }

  return make('RUNNING', '', ages);
}

// ── 중복 실행을 막는다 ────────────────────────────────────

export type LeaseVerdict = 'ACQUIRE' | 'RENEW' | 'BLOCKED' | 'UNKNOWN';

export interface LeaseCheck {
  verdict: LeaseVerdict;
  reason: string;
}

/**
 * 이 Worker가 이 실행기를 잡아도 되는가.
 *
 * **두 Worker가 같은 실행기를 돌리면 같은 주문이 두 번 나간다.** 그래서
 * 임대(lease)를 쓴다 — 잡은 Worker만 돌고, 만료되면 다른 Worker가 이어받는다.
 *
 * 만료 시각을 못 읽으면 **잡지 않는다.** 모르는 채로 잡으면 앞의 Worker와
 * 겹칠 수 있고, 겹치는 쪽의 대가가 훨씬 크다.
 */
export function leaseCheck(
  row: RuntimeRow | null | undefined, workerId: any, nowMs: any,
): LeaseCheck {
  const now = num(nowMs);
  const me = String(workerId ?? '').trim();
  if (!me) return { verdict: 'UNKNOWN', reason: 'Worker id가 없습니다' };
  if (now == null) return { verdict: 'UNKNOWN', reason: '현재 시각을 알 수 없습니다' };
  if (row == null) return { verdict: 'UNKNOWN', reason: '실행기 행을 읽지 못했습니다' };

  const owner = String(row.ownerWorkerId ?? '').trim();
  if (!owner) return { verdict: 'ACQUIRE', reason: '주인이 없습니다' };
  if (owner === me) return { verdict: 'RENEW', reason: '이미 내가 잡고 있습니다' };

  const exp = ms(row.leaseExpiresAt);
  if (exp == null) {
    // **모르면 안 잡는다.** 겹치는 쪽의 대가가 훨씬 크다.
    return { verdict: 'BLOCKED',
      reason: `다른 Worker(${owner})가 잡고 있는데 임대 만료 시각을 읽지 못했습니다 — 겹쳐 돌면 같은 주문이 두 번 나갑니다` };
  }
  if (now >= exp) {
    return { verdict: 'ACQUIRE', reason: `이전 주인(${owner})의 임대가 만료됐습니다` };
  }
  return { verdict: 'BLOCKED',
    reason: `다른 Worker(${owner})가 ${Math.ceil((exp - now) / 1000)}초 더 잡고 있습니다` };
}

// ── 같은 tick을 두 번 실행하지 않는다 ─────────────────────

/**
 * 실행 하나를 가리키는 열쇠.
 *
 * **벽시계로 만들지 않는다.** `Date.now()`를 쓰면 재시도가 새 열쇠를
 * 만들어 중복을 못 막는다. 예정 시각을 주기로 잘라 쓰면, 같은 주기의
 * 재시도는 같은 열쇠가 된다.
 */
export function tickKey(
  runtimeId: any, scheduledAtMs: any, intervalSec: any,
): string | null {
  const id = String(runtimeId ?? '').trim();
  const at = num(scheduledAtMs);
  const iv = num(intervalSec);
  if (!id || at == null || iv == null || iv <= 0) return null;
  // 예정 시각을 주기 격자에 맞춰 내림한다.
  const slot = Math.floor(at / (iv * 1000));
  return `${id}:${slot}`;
}

// ── 화면이 안 떠 있어도 도는가 ────────────────────────────

export type Durability =
  /** 서버가 돌린다 — 화면을 닫아도 계속된다 */
  | 'SERVER'
  /** 브라우저 타이머다 — 화면을 떠나면 멈춘다 */
  | 'BROWSER'
  /** 확인하지 못했다 */
  | 'UNKNOWN';

export const DURABILITY_NOTE: Record<Durability, string> = {
  SERVER: '화면을 닫아도 서버가 계속 실행합니다',
  BROWSER:
    '이 화면이 열려 있는 동안만 돕니다 — 다른 메뉴로 가거나 탭이 뒤로 가면 '
    + '느려지거나 멈춥니다. **상시 실행이 아닙니다.**',
  UNKNOWN: '어디서 실행되는지 확인하지 못했습니다',
};

/**
 * '상시 실행'이라고 불러도 되는가.
 *
 * **브라우저가 살아 있어야만 동작하는 기능을 '상시 실행'이라고 부르지
 * 않는다.** 그 말은 사용자가 앱을 닫아도 된다는 뜻으로 읽힌다.
 */
export function canCallAlwaysOn(d: Durability): boolean {
  return d === 'SERVER';
}
