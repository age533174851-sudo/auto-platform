// src/lib/engine/paperRunnerStatus.ts
//
// **"모의 자동매매가 지금 돌고 있냐"에 값으로 답한다.**
//
// 왜 이 파일이 필요했나
// ─────────────────────
// 2026-11-16에 그 질문을 받았고 답하지 못했다. 화면도, 라우트도,
// "켜져 있다"까지만 말하고 **누가 그것을 깨우고 있는지는 말하지 않았다.**
//
// 깨우는 것은 하나뿐이다:
//
//   Fly 워커 → `/api/paper/exit-monitor` → `runDuePaperAutomation()`
//
// `vercel.json`의 cron 5개에도, GitHub Actions cron 어디에도 이 경로를
// 부르는 것이 없다(실측). **워커가 꺼져 있으면 봇을 켜 두어도 한 건도
// 돌지 않는다.** 그런데 화면에는 "반복 실행 중"이라고만 떠 있었다.
//
// 무엇을 새로 만들지 않았나
// ─────────────────────────
// 판단을 두 곳에 두지 않는다.
//
//   · 워커가 살아 있는가  → `runtime/workerPlan.ts`의 `workerAlive`
//   · 마지막 회차가 신선한가 → `engine/dataQuality.ts`의 `assess`
//
// 이 파일은 **그 둘을 합쳐 한 문장으로 만드는 일만** 한다. 임계값을
// 새로 정하지 않는다.
//
// 모르는 것은 "정상"이 아니다
// ───────────────────────────
// `workerAlive`는 못 읽으면 `null`을 준다 — 죽었다고도 살았다고도 하지
// 않는다. 그 `null`이 여기서 `RUNNER_UNKNOWN`이 되고, `running`은
// **false**다. 확인하지 못한 것을 "돌고 있다"로 적지 않는다.
import { workerAlive } from '../runtime/workerPlan';
import { assess, formatAge, type DataSource, type Freshness } from './dataQuality';

/**
 * 봇 주기를 못 읽었을 때 쓰는 간격.
 *
 * `assess`의 POLLED 기본값은 10초다 — 호가처럼 자주 오는 값을 위한
 * 값이라서, 수십 초~분 단위인 봇 주기에 그대로 쓰면 **멀쩡한 회차를
 * '멈춤'으로 적는다.** 모를 때 성급히 빨간불을 켜지 않기 위한 보수적
 * 하한이고, 이 값으로 "정상"을 주장하지는 않는다.
 */
export const UNKNOWN_INTERVAL_MS = 10 * 60_000;

export type PaperRunnerCode =
  /** 켜진 봇이 없다 — 고장이 아니다 */
  | 'OFF'
  /** 주 실행기(Fly 워커)가 오지 않는다. **켜 두어도 아무도 돌리지 않는다** */
  | 'RUNNER_DOWN'
  /** 실행기가 살아 있는지 확인하지 못했다 */
  | 'RUNNER_UNKNOWN'
  /** 켜져 있고 실행기도 오는데 **회차 기록이 하나도 없다** */
  | 'NEVER_RAN'
  /** 마지막 회차가 너무 오래됐다 */
  | 'OVERDUE'
  /** 돌고 있다 */
  | 'RUNNING';

export interface PaperRunnerStatus {
  code: PaperRunnerCode;
  /** **지금 모의 자동매매가 돌고 있다고 말해도 되는가** */
  running: boolean;
  enabledBots: number;
  /** 마지막 회차의 신선도 (`dataQuality.assess`가 판정) */
  freshness: Freshness;
  /** 마지막 회차가 얼마나 됐나. **모르면 null** */
  ageMs: number | null;
  headline: string;
  reason: string;
}

const ms = (v: any): number | null => {
  if (v == null || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * 모의 자동매매 가동 상태.
 *
 * 순서가 곧 규칙이다 — `workerPlan`이 쓰는 것과 같은 순서다:
 *   1. 켠 것이 없으면 고장이 아니다
 *   2. 주 실행기가 안 오면 나머지는 볼 필요가 없다
 *   3. 실행기 상태를 **못 읽었으면 정상이라고 말하지 않는다**
 *   4. 한 번도 안 돌았으면 돌고 있다고 말하지 않는다
 *   5. 마지막 회차가 멈춘 수준이면 경고
 */
export function paperRunnerStatus(i: {
  nowMs: number;
  /** `enabled === true`인 봇 수. 문자열 'false'는 truthy이므로 호출자가 엄격히 센다 */
  enabledBots: number;
  /** `worker_heartbeat`의 마지막 시각. 행이 없으면 null */
  workerLastSeen: number | string | null;
  /**
   * 심장박동 **조회 자체가 실패했는가.**
   *
   * "읽었는데 워커가 하나도 없다"와 "못 읽었다"는 다른 사실이다. 앞은
   * 실행기가 없는 것이고(= 아무도 안 돌린다), 뒤는 모르는 것이다.
   * 둘을 같은 문장으로 적으면 둘 중 하나는 거짓말이 된다.
   */
  heartbeatReadFailed?: boolean;
  /** 마지막 회차 시각. 기록이 없거나 못 읽었으면 null */
  lastRunAt: number | string | null;
  /** 켜진 봇 중 **가장 짧은** 주기(초). 모르면 null — 그때는 기본 간격을 쓴다 */
  shortestIntervalSec: number | null;
}): PaperRunnerStatus {
  const enabledBots = Number.isFinite(i.enabledBots) && i.enabledBots > 0 ? Math.floor(i.enabledBots) : 0;
  const lastRunMs = ms(i.lastRunAt);
  const intervalSec = Number.isFinite(i.shortestIntervalSec as number) && (i.shortestIntervalSec as number) > 0
    ? (i.shortestIntervalSec as number) : null;

  const src: DataSource = {
    kind: 'POLLED', origin: '모의 자동매매 회차', label: '마지막 회차',
    asOf: lastRunMs,
    expectedIntervalMs: intervalSec ? intervalSec * 1000 : UNKNOWN_INTERVAL_MS,
  };
  const a = assess(src, i.nowMs);
  const base = { enabledBots, freshness: a.freshness, ageMs: a.ageMs };

  if (enabledBots === 0) {
    return {
      ...base, code: 'OFF', running: false,
      headline: '켜진 모의 봇 없음',
      reason: '봇이 하나도 켜져 있지 않습니다 — 고장이 아닙니다',
    };
  }

  if (i.heartbeatReadFailed === true) {
    return {
      ...base, code: 'RUNNER_UNKNOWN', running: false,
      headline: `켜진 봇 ${enabledBots}개 · 실행기 상태 모름`,
      reason: '실행기(Fly 워커)의 심장박동을 조회하지 못했습니다 — '
        + '확인하지 못한 것을 "돌고 있다"로 적지 않습니다',
    };
  }

  const lastSeenMs = ms(i.workerLastSeen);
  if (lastSeenMs == null) {
    // 조회는 됐는데 행이 없다 = 등록된 워커가 **없다.** 모르는 것이 아니다.
    return {
      ...base, code: 'RUNNER_DOWN', running: false,
      headline: `켜진 봇 ${enabledBots}개 · 등록된 실행기 없음`,
      reason: '모의 자동매매를 깨우는 Fly 워커가 등록되어 있지 않습니다 — '
        + '봇을 켜 두어도 아무도 돌리지 않습니다',
    };
  }

  const alive = workerAlive(i.nowMs, lastSeenMs);

  if (alive === false) {
    return {
      ...base, code: 'RUNNER_DOWN', running: false,
      headline: `켜진 봇 ${enabledBots}개 · 실행기 없음`,
      reason: '모의 자동매매를 깨우는 것은 Fly 워커 하나뿐입니다. '
        + '그 워커가 오지 않습니다 — 봇을 켜 두어도 아무도 돌리지 않습니다',
    };
  }
  if (alive === null) {
    // `lastSeenMs`가 숫자인데도 null이 나오는 경우 — 판정이 바뀌어도
    // 여기서 "정상"으로 흘러가지 않게 남겨 둔다.
    return {
      ...base, code: 'RUNNER_UNKNOWN', running: false,
      headline: `켜진 봇 ${enabledBots}개 · 실행기 상태 모름`,
      reason: '실행기(Fly 워커)가 살아 있는지 판정하지 못했습니다 — '
        + '확인하지 못한 것을 "돌고 있다"로 적지 않습니다',
    };
  }

  if (lastRunMs == null) {
    return {
      ...base, code: 'NEVER_RAN', running: false,
      headline: `켜진 봇 ${enabledBots}개 · 회차 기록 없음`,
      reason: '실행기는 살아 있는데 이 계정의 회차 기록이 하나도 없습니다 — '
        + '아직 한 번도 돌지 않았거나 기록을 읽지 못했습니다',
    };
  }

  if (a.freshness === 'STALE' || a.freshness === 'NONE') {
    return {
      ...base, code: 'OVERDUE', running: false,
      headline: `켜진 봇 ${enabledBots}개 · 회차가 밀렸습니다`,
      reason: `실행기는 살아 있는데 마지막 회차가 ${formatAge(a.ageMs)} 지났습니다`,
    };
  }

  return {
    ...base, code: 'RUNNING', running: true,
    headline: `켜진 봇 ${enabledBots}개 · 돌고 있습니다`,
    reason: `마지막 회차 ${formatAge(a.ageMs)} 전`
      + (a.freshness === 'LAGGING' ? ' — 평소보다 늦습니다' : ''),
  };
}
