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
  /**
   * 이 cron을 거는 쪽. 생략하면 `vercel.json`이다.
   *
   * **Vercel Hobby는 일 단위 cron만 허용한다** — 이 저장소가 여러 곳에
   * 적어 둔 제약이다(`exit-monitor/route.ts:9`, `calendar-sync/route.ts:54`,
   * `PROGRESS.md:493`). 그래서 분 단위로 깨우는 일은 이미 **GitHub
   * Actions의 `schedule`** 이 하고 있다. 대체 범위를 `vercel.json`만
   * 보고 판정하면 **이미 있는 대체를 없다고 적는다** — 실제로 그렇게
   * 틀렸고, 손절 감시를 288배 악화로 보고했다(선언 기준으로는 12배다).
   *
   * ⚠ **그 "12배"도 관측값이 아니다.** 여기서 쓰는 주기는 워크플로에
   * **선언된** cron이고, GitHub Actions가 그만큼 돌려준다는 보장이 없다.
   * 2026-11-07 실측: 워크플로 8개의 `event=schedule` 실행률이 선언
   * 24~288회/일과 무관하게 **4.3~5.0회/일**이었다 (5분 간격 cron으로
   * 288회를 선언한 `scheduled-exit`이 400회/69일 = 5.8회/일). 실제 대체 주기는
   * 약 5시간이고, 손절 감시의 실측 악화는 ~64배다.
   *
   * 이 모듈은 파일만 읽으므로 그 차이를 스스로 알 수 없다. 그래서
   * `factor`는 **선언 기준 값**이고, 부르는 쪽이 그것을 관측으로 적지
   * 않아야 한다 (`check-worker-coverage.mjs`가 경고를 찍는다).
   * 방향은 바뀌지 않는다 — 실측이 더 나쁘므로 Fly는 더더욱 끌 수 없다.
   */
  source?: string;
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
        + 'cron으로 대체할 대상 자체가 없습니다',
    };
  }

  // 같은 경로를 여러 곳이 깨울 수 있다(Vercel cron + GitHub Actions).
  // 실제 대체는 **가장 자주 도는 것**이다. 첫 번째를 집으면 느린 쪽을
  // 답으로 적어 악화 배수가 부풀려진다.
  const matches = (crons ?? []).filter((c) => String(c.path ?? '').trim() === task.endpoint);
  const ranked = matches
    .map((c) => ({ c, ms: cronEveryMs(c.schedule) }))
    .sort((x, y) => {
      if (x.ms == null && y.ms == null) return 0;
      if (x.ms == null) return 1;   // 환산 불가는 뒤로
      if (y.ms == null) return -1;
      return x.ms - y.ms;           // 더 자주 도는 것이 앞
    });
  const hit = ranked.length ? ranked[0].c : undefined;
  if (!hit) {
    return {
      ...base, vercelEveryMs: null, substitute: 'NONE', factor: null,
      reason: `${task.endpoint}을 부르는 cron이 어디에도 없습니다 `
        + '(vercel.json · GitHub Actions schedule 모두) — '
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
      reason: `${hit.source ?? 'vercel.json'} \`${hit.schedule}\` → 같은 급의 주기입니다`,
    };
  }
  return {
    ...base, vercelEveryMs, substitute: 'DEGRADED', factor,
    reason: `${hit.source ?? 'vercel.json'} \`${hit.schedule}\` → `
      + `주기가 ${Math.round(factor)}배 나빠집니다`,
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

// ── 정정: "Fly가 없으면 모든 킬스위치 실행이 멈춘다"는 과장이었다 ─────
//
// 이 감사가 `processPendingJobs`를 안전상 필수로 적고 "끄면 멈춘다"고
// 보고했을 때, 읽는 사람에게 남은 문장은 **"Fly를 끄면 킬스위치가 아예
// 실행되지 않는다"** 였다. 그것은 사실이 아니다.
//
// 현재 코드에서 측정한 모양(2026-11-08, main 220f8001 기준):
//
//   · 발동 라우트가 **그 자리에서 직접 실행한다**
//     (`risk/kill-switch/trigger/route.ts`, `.../status/route.ts`)
//   · `jobs` 큐는 **Worker 안의 닫힌 고리**다 — 제품 코드에서 행을
//     넣는 곳은 Worker의 자가복구 한 곳뿐이고, 꺼내는 곳도 Worker다
//   · `enqueueJob`을 부르는 제품 코드는 **0건**이다
//
// 그래서 Fly를 끄면 없어지는 것은 **주 경로가 실패했을 때의 자가복구
// 그물**이다. 실행 경로 자체가 아니다. 그물이 없어지는 것도 손실이므로
// `safetyCritical`은 그대로 true다 — **약하게 고치지 않는다.** 바꾸는
// 것은 보고 문장이지 판정 등급이 아니다.
//
// 그리고 이 판정을 산문으로 적어 두지 않는다. 산문은 코드가 바뀌어도
// 그대로 남는다. 누가 큐에 외부 생산자를 붙이는 순간 위 문장은 거짓이
// 되고, 그때 **이 함수가 답을 바꿔야 한다.**
//
// ⚠ 이 판정은 **소스의 모양**에 대한 판정이다. 실제 발동이 거래소에서
// 성공한다는 증거가 아니다. 그 증거는 거래소 응답으로만 생긴다.

export type KillSwitchPath =
  /** 발동 라우트가 직접 실행한다 — 큐는 자가복구 전용 */
  | 'INLINE'
  /** 큐를 통해서만 실행된다 — 큐 처리자가 없으면 실행이 멈춘다 */
  | 'QUEUE'
  /** 둘 다 실행 경로다 */
  | 'BOTH'
  /** **확인하지 못했다.** 멈추지 않는다는 뜻이 아니다 */
  | 'UNKNOWN';

export interface KillSwitchPathFacts {
  /** 제품 코드에서 `enqueueJob`을 부르는 곳의 수. null = 세지 못했다 */
  enqueueCallers: number | null;
  /** `jobs`에 행을 넣는 제품 코드 중 **Worker 밖**인 곳의 수. null = 모른다 */
  externalQueueProducers: number | null;
  /** 발동 라우트가 그 자리에서 직접 실행하는가. null = 확인 못 했다 */
  routesExecuteInline: boolean | null;
}

export interface KillSwitchPathVerdict {
  path: KillSwitchPath;
  /** 큐가 자가복구 전용인가 (외부 생산자가 없다) */
  queueIsSelfHealOnly: boolean;
  /**
   * Fly를 끄면 킬스위치 **실행 자체**가 멈추는가.
   * `null`은 "모른다" — **false가 아니다.**
   */
  stopsAllExecution: boolean | null;
  reason: string;
}

/**
 * 킬스위치는 어느 경로로 실행되는가.
 *
 * 입력은 전부 **코드에서 센 값**이다(검사기가 센다). 하나라도 못 셌으면
 * `UNKNOWN`이고, 그때 "멈추지 않는다"고 적지 않는다.
 */
export function killSwitchExecutionPath(f: KillSwitchPathFacts | null | undefined): KillSwitchPathVerdict {
  const enq = typeof f?.enqueueCallers === 'number' && Number.isFinite(f.enqueueCallers) ? f.enqueueCallers : null;
  const ext = typeof f?.externalQueueProducers === 'number' && Number.isFinite(f.externalQueueProducers) ? f.externalQueueProducers : null;
  const inline = typeof f?.routesExecuteInline === 'boolean' ? f.routesExecuteInline : null;

  if (enq == null || ext == null || inline == null) {
    return {
      path: 'UNKNOWN', queueIsSelfHealOnly: false, stopsAllExecution: null,
      reason: '킬스위치 실행 경로를 코드에서 확인하지 못했습니다 — 멈추지 않는다는 뜻이 아닙니다',
    };
  }

  const producers = ext + enq;

  if (inline && producers === 0) {
    return {
      path: 'INLINE', queueIsSelfHealOnly: true, stopsAllExecution: false,
      reason: '발동 라우트가 직접 실행합니다. jobs 큐는 생산자도 소비자도 Worker인 닫힌 고리이므로 '
        + '자가복구 그물입니다 — Fly를 끄면 그 그물이 사라지지만 실행 경로가 멈추지는 않습니다',
    };
  }
  if (inline && producers > 0) {
    return {
      path: 'BOTH', queueIsSelfHealOnly: false, stopsAllExecution: false,
      reason: `발동 라우트가 직접 실행하고, 큐에도 외부 생산자가 ${producers}곳 있습니다 — `
        + 'Fly를 끄면 큐 경로로 적재된 실행이 처리되지 않고 남습니다',
    };
  }
  if (!inline && producers > 0) {
    return {
      path: 'QUEUE', queueIsSelfHealOnly: false, stopsAllExecution: true,
      reason: `발동 라우트가 직접 실행하지 않고 큐 생산자가 ${producers}곳입니다 — `
        + 'Fly를 끄면 킬스위치 실행이 멈춥니다',
    };
  }
  return {
    path: 'UNKNOWN', queueIsSelfHealOnly: false, stopsAllExecution: null,
    reason: '직접 실행도, 큐 생산자도 찾지 못했습니다 — 킬스위치를 실행하는 곳이 보이지 않습니다',
  };
}
