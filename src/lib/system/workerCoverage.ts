// src/lib/system/workerCoverage.ts
//
// **Fly Worker를 끄면 무엇이 멈추는지를 값으로 답한다.**
//
// 왜 이 파일이 있나
// ─────────────────
// 2026-11-06에 운영 방향이 "Fly.io 퇴출, Vercel + Supabase"로 정해졌다.
// 그런데 Fly Worker는 지금 **시계** 역할을 한다 — 60초마다 깨어나서
// 예약 평가·손절 감시·예약 청산·job 큐를 깨운다.
//
// **주문을 내는 것은 Fly가 아니다.** Binance가 Fly 서버의 IP 지역을
// 막아서(`jobs` 표에 "Service unavailable from a restricted location")
// 주문은 여전히 Vercel이 낸다. 그래서 이관에 필요한 것은 "거래 엔진을
// 옮기는 것"이 아니라 **분 단위 시계와 job 처리자를 대체하는 것**이다.
//
// 그 차이를 사람의 기억에 맡기면 안 된다. 끄는 날 "손절 감시도 Vercel
// cron에 있지?"를 누가 기억해야 하는 구조는 언젠가 틀린다. 그래서
// **판정을 여기 한 곳에 둔다.**
//
// 이 모듈이 지키는 규칙
// ─────────────────────
// **모르는 주기를 0으로 적지 않는다.** cron 식을 주기로 환산할 수 없으면
// `null`(UNKNOWN)이고, 그러면 악화 배수도 `null`이다. `0`은 "즉시"로
// 읽히고 `null`은 "모른다"로 읽힌다 — 둘을 섞으면 "대체됐다"는 거짓이
// 조용히 생긴다.

/** Vercel/Supabase 쪽 대체 상태 */
export type Substitute =
  /** 같은 일을 비슷한 주기로 한다 */
  | 'EQUIVALENT'
  /** 하기는 하는데 **주기가 나쁘다** — 손절에서는 이게 없는 것과 비슷하다 */
  | 'DEGRADED'
  /** 대체가 아예 없다 */
  | 'NONE'
  /** 대체 주기를 읽을 수 없었다 — 통과로 적지 않는다 */
  | 'UNKNOWN';

export interface WorkerTask {
  /** `worker/src/index.ts`의 함수 이름 */
  fn: string;
  /** Fly에서 이 작업이 도는 주기(ms). `null`은 "매 tick" */
  everyMs: number | null;
  /** 이 작업이 깨우는 앱 경로. `null`이면 DB를 직접 본다 */
  endpoint: string | null;
  /** 사람이 읽는 역할 */
  role: string;
  /**
   * **안전상 필수인가.** 포지션을 닫거나 손실을 막는 일, 또는 그것을
   * 가능하게 하는 일(job 큐·킬스위치 보장)이면 true.
   */
  safetyCritical: boolean;
}

export interface VercelCron {
  schedule: string;
  path: string;
}

export interface CoverageRow {
  fn: string;
  role: string;
  endpoint: string | null;
  flyEveryMs: number | null;
  /** Vercel cron에서 환산한 주기. 읽을 수 없으면 `null` */
  vercelEveryMs: number | null;
  substitute: Substitute;
  /** 몇 배 나빠지는가. 둘 중 하나라도 모르면 `null` */
  factor: number | null;
  reason: string;
  safetyCritical: boolean;
}

/**
 * 5칸 cron 식을 **발사 간격(ms)** 으로 환산한다.
 *
 * 환산할 수 있는 모양만 답하고, 나머지는 `null`(UNKNOWN)이다.
 * 추측해서 숫자를 적으면 "대체됐다"는 거짓이 생긴다.
 */
export function cronEveryMs(schedule: string): number | null {
  const s = String(schedule ?? '').trim();
  if (!s) return null;
  const f = s.split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;

  const everyN = (field: string): number | null => {
    const m = /^\*\/(\d+)$/.exec(field);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const isFixed = (field: string) => /^\d+$/.test(field);
  const isAny = (field: string) => field === '*';

  // 날짜·월·요일이 고정되면 하루보다 긴 주기다 — 여기서는 환산하지 않는다.
  if (!isAny(dom) || !isAny(mon) || !isAny(dow)) return null;

  // `*/N * * * *` — N분마다
  const perMin = everyN(min);
  if (perMin != null && isAny(hour)) return perMin * 60_000;

  // `M * * * *` — 매시 M분 = 1시간
  if (isFixed(min) && isAny(hour)) return 60 * 60_000;

  // `M H * * *` — 하루 1회
  if (isFixed(min) && isFixed(hour)) return 24 * 60 * 60_000;

  // `M */N * * *` — N시간마다
  const perHour = everyN(hour);
  if (isFixed(min) && perHour != null) return perHour * 60 * 60_000;

  return null;
}

/**
 * 같은 일로 볼 만큼 주기가 가까운가.
 *
 * 2배까지는 같은 급으로 본다. 그 이상은 손절·청산에서 의미가 달라진다 —
 * 5분 감시와 24시간 감시는 "둘 다 감시한다"고 적을 수 있는 것이 아니다.
 */
const SAME_ORDER_FACTOR = 2;

export function coverageRow(task: WorkerTask, crons: VercelCron[]): CoverageRow {
  const base = {
    fn: task.fn,
    role: task.role,
    endpoint: task.endpoint,
    flyEveryMs: task.everyMs,
    safetyCritical: task.safetyCritical,
  };

  if (!task.endpoint) {
    return {
      ...base, vercelEveryMs: null, substitute: 'NONE', factor: null,
      reason: 'DB를 직접 보는 작업이라 깨울 수 있는 HTTP 경로가 없습니다 — '
        + 'Vercel cron으로 대체할 대상 자체가 없습니다',
    };
  }

  const hit = crons.find((c) => String(c.path ?? '').trim() === task.endpoint);
  if (!hit) {
    return {
      ...base, vercelEveryMs: null, substitute: 'NONE', factor: null,
      reason: `${task.endpoint}을 부르는 Vercel cron이 없습니다 — `
        + 'Fly를 끄면 이 작업은 아무도 깨우지 않습니다',
    };
  }

  const vercelEveryMs = cronEveryMs(hit.schedule);
  if (vercelEveryMs == null) {
    return {
      ...base, vercelEveryMs: null, substitute: 'UNKNOWN', factor: null,
      reason: `cron \`${hit.schedule}\`을 주기로 환산하지 못했습니다 — `
        + '모르는 것을 대체됨으로 적지 않습니다',
    };
  }

  // 매 tick 작업은 Worker 폴링 주기를 모르면 비교할 수 없다.
  if (task.everyMs == null) {
    return {
      ...base, vercelEveryMs, substitute: 'UNKNOWN', factor: null,
      reason: '매 tick 도는 작업이라 Fly 쪽 주기가 폴링 설정에 달려 있습니다 — '
        + '비교 기준이 없어 대체됨으로 적지 않습니다',
    };
  }

  const factor = vercelEveryMs / task.everyMs;
  if (factor <= SAME_ORDER_FACTOR) {
    return {
      ...base, vercelEveryMs, substitute: 'EQUIVALENT', factor,
      reason: `${hit.schedule} → 같은 급의 주기입니다`,
    };
  }
  return {
    ...base, vercelEveryMs, substitute: 'DEGRADED', factor,
    reason: `${hit.schedule} → 주기가 ${Math.round(factor)}배 나빠집니다`,
  };
}

export function coverage(tasks: WorkerTask[], crons: VercelCron[]): CoverageRow[] {
  return (tasks ?? []).map((t) => coverageRow(t, crons ?? []));
}

/**
 * **Fly를 지금 끌 수 있는가**에 대한 답.
 *
 * 안전상 필수 작업 중 `EQUIVALENT`가 아닌 것이 하나라도 있으면 끌 수 없다.
 * `UNKNOWN`도 막는다 — 확인하지 못한 것은 통과가 아니다.
 */
export function flyRetirementBlockers(rows: CoverageRow[]): CoverageRow[] {
  return (rows ?? []).filter((r) => r.safetyCritical && r.substitute !== 'EQUIVALENT');
}

export function flyRetirable(rows: CoverageRow[]): boolean {
  return flyRetirementBlockers(rows).length === 0;
}
