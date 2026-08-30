// src/lib/runtime/schedulerReport.ts
//
// **"Fly 로그를 열어서 예약 폴러가 도는지 봐 주세요"를 없앤다.**
//
// 무엇이 있었나
// ─────────────
// 예약 평가의 주 실행자는 이미 Fly Worker다(`worker/src/index.ts`의
// `pollSchedules`). GitHub `autotrade-tick`은 예비다. 그런데 2026-08-29에
// **그게 실제로 돌고 있는지 아무도 값으로 답할 수 없었다.**
//
//   · `[schedules] …` 로그는 `fly logs`에만 있다 — 사람이 열어야 한다
//   · `autotrade_schedules.last_decision.source`는 DB에만 있다
//   · `/api/system/runtime-health`는 로그인이 필요해 CI가 못 읽는다
//
// 그래서 판정이 "확인 불가"로 끝났다. **확인하지 못한 것은 통과가 아니다** —
// 그런데 확인할 방법 자체가 없으면, 그건 매번 사람에게 넘어가는 숙제다.
//
// 무엇을 하나
// ───────────
// 사실을 아는 쪽이 적는다. 워커는 자기가 APP_URL·ADMIN_SECRET을 가졌는지,
// main 락을 쥐었는지, 예약을 마지막으로 언제 들여다봤는지 **전부 알고 있다.**
// 그걸 heartbeat에 같이 적고(073), 인증이 필요 없는
// `/api/system/deployment`가 그대로 보여 준다. `deployment-check`는 배포마다
// 이미 그 경로를 부르므로, **새로 눌러야 할 버튼이 하나도 없다.**
//
// 값은 나가지 않는다
// ──────────────────
// APP_URL도 ADMIN_SECRET도 **있다/없다만** 적는다. 주소도 시크릿도, 그
// 지문조차 이 파일을 지나가지 않는다.
//
// 판정은 여기 한 곳에 있다
// ────────────────────────
// 워커·API·CI 스크립트가 각자 판단하면 언젠가 갈린다. 네 가지 코드는
// 이 파일에서만 정의하고, 나머지는 `schedulerVerdict()`를 부른다.

import type { DispatchSource } from '../autotrade/schedulePoll';

/**
 * 예약 주 경로가 실제로 도는가.
 *
 * **"모른다"에 이름을 준다.** 안 도는 것과 못 본 것은 다른 사실이고,
 * 둘을 같은 칸에 적으면 진짜 고장이 그 안에 묻힌다.
 */
/**
 * 예약 폴러가 낼 수 있는 오류의 **전부**.
 *
 * 여기 없는 것은 `UNKNOWN`이 된다 — 새 문자열이 공개 경로로 새지 않는다.
 */
export const SCHEDULER_ERROR_CODES = [
  /** 예약 표를 읽지 못했다 */
  'SCHEDULE_READ_FAILED',
  /** 읽기는 했는데 한 건의 평가가 실패했다 */
  'EVALUATION_FAILED',
  /** 워커가 아는 코드가 아니다. 상세는 Fly 로그에만 있다 */
  'UNKNOWN',
] as const;
export type SchedulerErrorCode = (typeof SCHEDULER_ERROR_CODES)[number];

/** 사람이 읽는 한 줄. **코드에서만 만든다 — 예외 문구를 쓰지 않는다** */
export const SCHEDULER_ERROR_TEXT: Record<SchedulerErrorCode, string> = {
  SCHEDULE_READ_FAILED: '예약 표를 읽지 못했습니다 (상세는 워커 로그)',
  EVALUATION_FAILED: '예약 평가가 실패했습니다 (상세는 워커 로그)',
  UNKNOWN: '워커가 분류하지 못한 오류입니다 (상세는 워커 로그)',
};

export type SchedulerCode =
  /** 설정이 갖춰졌고, main 락을 쥐었고, 최근에 실제로 들여다봤다 */
  | 'WORKER_PRIMARY_ACTIVE'
  /** 워커는 살아 있는데 APP_URL·ADMIN_SECRET이 없어 예약을 건너뛴다 */
  | 'WORKER_PRESENT_BUT_CONFIG_BLOCKED'
  /** 설정은 갖췄는데 폴링이 멈췄거나 오류로 끝났다 */
  | 'WORKER_PRESENT_BUT_RUNTIME_BROKEN'
  /** 워커가 아직 이 보고를 적은 적이 없다 — 판정하지 않는다 */
  | 'INSUFFICIENT_EVIDENCE';

/**
 * 워커가 heartbeat에 적는 값.
 *
 * **모르는 칸은 null이다.** 0이나 false로 적지 않는다 — "0건 봤다"와
 * "몇 건인지 모른다"는 다른 말이다.
 */
export interface SchedulerReport {
  /** 값이 아니라 있다/없다. 주소는 여기를 지나가지 않는다 */
  hasAppUrl: boolean | null;
  /** 값이 아니라 있다/없다. 시크릿은 여기를 지나가지 않는다 */
  hasAdminSecret: boolean | null;
  /** 이 워커가 main 락을 쥐고 있는가. 예약은 쥔 쪽만 본다 */
  isMain: boolean | null;
  /** 폴링 주기(ms). 신선도 판정의 기준이 된다 */
  pollIntervalMs: number | null;
  /** 마지막으로 예약 표를 실제로 읽은 시각 */
  lastPollIso: string | null;
  /** 그때 평가 대상이던 줄 수 */
  lastDueCount: number | null;
  /** 그때 건너뛴 줄 수 */
  lastSkippedCount: number | null;
  /**
   * 마지막으로 평가를 실제로 돌린 시각.
   *
   * **어느 종목을 무슨 결과로 평가했는지는 담지 않는다.** 이 값은 로그인
   * 없이 열리는 `/api/system/deployment`로 나간다 — 예약 주 경로가 도는지
   * 판정하는 데 종목이 필요하지 않고, 필요하지 않은 것을 공개 경로에
   * 얹지 않는다. 판정에 쓰는 것은 시각과 횟수뿐이다.
   */
  lastEvalIso: string | null;
  /**
   * 마지막 오류. **조용히 지우지 않되, 문구를 내보내지도 않는다.**
   *
   * 예외 메시지를 그대로 담으면 **임의의 내부 문자열이 로그인 없이 열리는
   * 경로로 나간다** — DB 오류 본문, 연결 이름, 주소가 어떤 모양으로 섞여
   * 들어올지 미리 알 수 없다. 가리개(정규식)로 막는 것은 방어선이 아니라
   * 추측이다. 그래서 **미리 정해 둔 코드만** 담는다.
   *
   * 상세 예외는 워커의 Fly 로그에만 남는다.
   */
  lastErrorIso: string | null;
  lastErrorCode: SchedulerErrorCode | null;
  /** 폴링을 시도한 횟수 · 평가를 돌린 횟수 */
  pollCount: number | null;
  evalCount: number | null;
  /** 누가 깨우는 경로인가. 워커가 적으면 언제나 FLY_WORKER다 */
  source: DispatchSource;
}

export interface SchedulerVerdict {
  code: SchedulerCode;
  /** 사람이 읽는 한 문장. 그대로 CI 로그에 찍힌다 */
  reason: string;
  /** 판정의 근거가 된 값들. 판정과 근거를 같이 남긴다 */
  evidence: string[];
  /** 이 보고를 적은 워커가 예비(standby)인가 */
  standbyOnly: boolean;
}

/** 폴링이 이 배수만큼 밀리면 멈춘 것으로 본다 */
export const STALE_POLL_FACTOR = 5;
/** 주기를 모를 때 쓰는 최소 여유 */
export const STALE_POLL_FLOOR_MS = 5 * 60_000;

/**
 * 코드가 아닌 것은 공개 보고에 담지 않는다.
 *
 * 예전 줄에 예외 문구만 있으면 **"오류가 있었다"는 사실은 살리고 문구는
 * 버린다** — 조용히 통과시키지 않되, 임의 문자열도 내보내지 않는다.
 */
function errorCode(code: any, legacyText: any, legacyIso: any): SchedulerErrorCode | null {
  const c = String(code ?? '').trim();
  if ((SCHEDULER_ERROR_CODES as readonly string[]).includes(c)) return c as SchedulerErrorCode;
  if (c) return 'UNKNOWN';
  // 073 이전 형식: 문구만 있고 코드가 없다.
  if (legacyText || legacyIso) return 'UNKNOWN';
  return null;
}

function iso(v: any): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

function ms(v: any): number | null {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
}

/**
 * 워커가 적은 것을 읽는다.
 *
 * **없는 칸을 지어내지 않는다.** 073이 아직 적용되지 않은 배포에서는
 * 이 칸이 통째로 없고, 그때는 `null`이 나온다 — 판정기가 그걸
 * INSUFFICIENT_EVIDENCE로 읽는다.
 */
export function parseSchedulerReport(raw: any): SchedulerReport | null {
  if (raw == null) return null;
  let o: any = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch { return null; }
  }
  if (typeof o !== 'object' || Array.isArray(o)) return null;
  const bool = (v: any) => (typeof v === 'boolean' ? v : null);
  const num = (v: any) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  return {
    hasAppUrl: bool(o.hasAppUrl),
    hasAdminSecret: bool(o.hasAdminSecret),
    isMain: bool(o.isMain),
    pollIntervalMs: num(o.pollIntervalMs),
    lastPollIso: iso(o.lastPollIso),
    lastDueCount: num(o.lastDueCount),
    lastSkippedCount: num(o.lastSkippedCount),
    lastEvalIso: iso(o.lastEvalIso),
    lastErrorIso: iso(o.lastErrorIso),
    // **아는 코드가 아니면 UNKNOWN이다.** 예전 배포가 적어 둔 줄에 예외
    // 문구(`lastError`)가 들어 있어도 여기서 떨어진다 — 형식이 바뀌었다고
    // 과거 줄을 고치러 가지 않고, 읽는 쪽이 버린다.
    lastErrorCode: errorCode(o.lastErrorCode, o.lastError, o.lastErrorIso),
    pollCount: num(o.pollCount),
    evalCount: num(o.evalCount),
    source: (o.source === 'GITHUB_FALLBACK' || o.source === 'MANUAL') ? o.source : 'FLY_WORKER',
  };
}

/** 아직 아무것도 모르는 상태. 워커가 이 값에서 출발한다 */
export const EMPTY_SCHEDULER_REPORT: SchedulerReport = {
  hasAppUrl: null, hasAdminSecret: null, isMain: null, pollIntervalMs: null,
  lastPollIso: null, lastDueCount: null, lastSkippedCount: null,
  lastEvalIso: null, lastErrorIso: null, lastErrorCode: null,
  pollCount: null, evalCount: null, source: 'FLY_WORKER',
};

/**
 * 아는 만큼만 덮어쓴다 — 그리고 **절대 던지지 않는다.**
 *
 * 관측 장치는 본업보다 약해야 한다. 이 병합이 실패해서 예약 평가·주문
 * 실행·heartbeat가 같이 멈추면, 고장을 보려고 만든 것이 고장을 만든다.
 * 무엇이 들어와도 이전 상태를 그대로 돌려주는 것이 최악의 결과다.
 *
 * 부분 갱신이다. 락 상태를 적는 자리와 폴링 결과를 적는 자리가 다르고,
 * **한쪽이 다른 쪽을 null로 지워 버리면 안 된다** — 지운 값과 아직 모르는
 * 값이 같은 칸에 들어가면 판정이 갈린다.
 */
export function mergeSchedulerReport(
  prev: SchedulerReport | null | undefined, patch: Partial<SchedulerReport> | null | undefined,
): SchedulerReport {
  const base = prev ?? EMPTY_SCHEDULER_REPORT;
  try {
    if (patch == null || typeof patch !== 'object') return base;
    const next: any = { ...base };
    for (const k of Object.keys(EMPTY_SCHEDULER_REPORT) as Array<keyof SchedulerReport>) {
      if (!(k in patch)) continue;
      const v = (patch as any)[k];
      if (v === undefined) continue;
      // **코드가 아닌 오류는 UNKNOWN으로 접는다.** 워커가 실수로 예외
      // 문구를 넣어도 공개 보고에는 코드만 남는다.
      next[k] = k === 'lastErrorCode' ? errorCode(v, null, true) : v;
    }
    next.source = 'FLY_WORKER';
    return next as SchedulerReport;
  } catch {
    // 관측이 실패해도 본업은 돈다. 이전 상태를 그대로 둔다.
    return base;
  }
}

/**
 * 여러 워커 중 **예약을 보는 쪽**을 고른다.
 *
 * 머신이 둘이고 예약은 main 락을 쥔 쪽만 본다. 최신 heartbeat 한 줄만
 * 읽으면 예비 워커를 보고 "안 돈다"고 적을 수 있다 — 그건 틀린 빨강이다.
 */
export function pickSchedulerRow<T extends { scheduler?: any }>(rows: T[] | null | undefined):
{ row: T | null; standbyOnly: boolean } {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { row: null, standbyOnly: false };
  const parsed = list.map(r => ({ r, s: parseSchedulerReport(r?.scheduler) }));
  const main = parsed.find(p => p.s?.isMain === true);
  if (main) return { row: main.r, standbyOnly: false };
  // 아무도 main이라고 적지 않았다. 첫 줄(가장 최근)을 쓰되 **예비라고 적는다.**
  const anyReport = parsed.find(p => p.s != null);
  return { row: (anyReport?.r ?? list[0]) ?? null, standbyOnly: parsed.some(p => p.s?.isMain === false) };
}

/**
 * 예약 주 경로가 도는가 — 한 곳의 판정.
 *
 * `report`가 `undefined`면 **칸을 못 읽었다**, `null`이면 **워커가 적은 적이
 * 없다**. 둘 다 "안 돈다"가 아니라 "모른다"다.
 */
export function schedulerVerdict(i: {
  report: SchedulerReport | null | undefined;
  /** heartbeat가 살아 있는가. `workerAlive()`의 결과를 그대로 준다 */
  workerAlive: boolean | null;
  heartbeatAgeSec?: number | null;
  standbyOnly?: boolean;
  /** 워커가 뜬 시각(`worker_heartbeat.started_at`). 첫 폴링 전 유예에 쓴다 */
  workerStartedIso?: string | null;
  nowMs: number;
}): SchedulerVerdict {
  const { report, workerAlive, nowMs } = i;
  const standbyOnly = i.standbyOnly === true;
  const evidence: string[] = [];
  if (typeof i.heartbeatAgeSec === 'number') evidence.push(`heartbeat ${i.heartbeatAgeSec}초 전`);

  if (report === undefined) {
    return { code: 'INSUFFICIENT_EVIDENCE', standbyOnly, evidence,
      reason: '예약 폴러 상태 칸을 읽지 못했습니다 — 마이그레이션 073을 적용하는 중이거나 heartbeat를 못 읽었습니다' };
  }
  if (report === null) {
    return { code: 'INSUFFICIENT_EVIDENCE', standbyOnly, evidence,
      reason: '워커가 예약 폴러 상태를 적은 적이 없습니다 — 073 적용 전 이미지가 떠 있습니다' };
  }

  evidence.push(`APP_URL ${report.hasAppUrl === true ? '있음' : report.hasAppUrl === false ? '없음' : '모름'}`);
  evidence.push(`ADMIN_SECRET ${report.hasAdminSecret === true ? '있음' : report.hasAdminSecret === false ? '없음' : '모름'}`);
  evidence.push(`main 락 ${report.isMain === true ? '쥠' : report.isMain === false ? '예비' : '모름'}`);
  evidence.push(`마지막 폴링 ${report.lastPollIso ?? '없음'}`);
  evidence.push(`due ${report.lastDueCount ?? '모름'}건 · 건너뜀 ${report.lastSkippedCount ?? '모름'}건`);
  evidence.push(report.lastEvalIso ? `마지막 평가 ${report.lastEvalIso}` : '마지막 평가 없음');
  // 근거 줄도 **코드에서만 만든다.** 예외 문구는 여기까지 오지 않는다.
  if (report.lastErrorCode) {
    evidence.push(`마지막 오류 ${report.lastErrorIso ?? '시각 모름'} — `
      + `${report.lastErrorCode} (${SCHEDULER_ERROR_TEXT[report.lastErrorCode]})`);
  }
  evidence.push(`깨운 주체 ${report.source}`);

  // 워커가 끊겼으면 예약도 안 돈다. **이건 "모른다"가 아니라 고장이다.**
  if (workerAlive === false) {
    return { code: 'WORKER_PRESENT_BUT_RUNTIME_BROKEN', standbyOnly, evidence,
      reason: 'heartbeat가 끊겼습니다 — 이 보고는 과거 상태이고 지금 예약을 보는 워커가 없습니다' };
  }
  if (workerAlive == null) {
    return { code: 'INSUFFICIENT_EVIDENCE', standbyOnly, evidence,
      reason: 'heartbeat 시각을 읽지 못해 워커가 살아 있는지 모릅니다' };
  }

  // **설정이 없으면 워커는 예약을 건너뛴다.** 그건 고장이 아니라 미배선이다.
  if (report.hasAppUrl === false || report.hasAdminSecret === false) {
    const missing = [report.hasAppUrl === false ? 'APP_URL' : '',
      report.hasAdminSecret === false ? 'ADMIN_SECRET' : ''].filter(Boolean).join(', ');
    return { code: 'WORKER_PRESENT_BUT_CONFIG_BLOCKED', standbyOnly, evidence,
      reason: `워커에 ${missing}이(가) 없어 예약 평가를 건너뛰고 있습니다 — GitHub autotrade-tick만 남습니다` };
  }
  if (report.hasAppUrl == null || report.hasAdminSecret == null) {
    return { code: 'INSUFFICIENT_EVIDENCE', standbyOnly, evidence,
      reason: '워커가 환경변수 유무를 적지 않았습니다 — 있다고도 없다고도 읽지 않습니다' };
  }

  if (report.isMain !== true) {
    return { code: 'INSUFFICIENT_EVIDENCE', standbyOnly: true, evidence,
      reason: 'main 락을 쥔 워커의 보고가 없습니다 — 예비 워커만 보고했거나 락을 아무도 못 쥐었습니다' };
  }

  const pollMs = ms(report.lastPollIso);
  if (pollMs == null) {
    // **방금 뜬 워커를 고장이라고 적지 않는다.** 배포 직후 deployment-check가
    // 도는 시점에는 아직 첫 폴링 전일 수 있고, 그 빨강은 진짜 고장의
    // 빨강과 구별되지 않는다. 유예는 주기의 두 배까지다.
    const startedMs = ms(i.workerStartedIso);
    const grace = (report.pollIntervalMs && report.pollIntervalMs > 0 ? report.pollIntervalMs : 60_000) * 2;
    if (startedMs != null && nowMs - startedMs < grace) {
      return { code: 'INSUFFICIENT_EVIDENCE', standbyOnly, evidence,
        reason: `워커가 ${Math.round((nowMs - startedMs) / 1000)}초 전에 떴습니다 — 아직 첫 예약 폴링 전입니다` };
    }
    return { code: 'WORKER_PRESENT_BUT_RUNTIME_BROKEN', standbyOnly, evidence,
      reason: '설정은 갖췄는데 예약 표를 한 번도 들여다보지 않았습니다' };
  }

  // 오류로 끝났고 그 뒤로 성공한 폴링이 없다 → 멈춘 것이다.
  const errMs = ms(report.lastErrorIso);
  if (report.lastErrorCode && errMs != null && errMs >= pollMs) {
    return { code: 'WORKER_PRESENT_BUT_RUNTIME_BROKEN', standbyOnly, evidence,
      reason: `마지막 폴링이 오류로 끝났습니다: ${report.lastErrorCode} `
        + `— ${SCHEDULER_ERROR_TEXT[report.lastErrorCode]}` };
  }

  const interval = Number.isFinite(report.pollIntervalMs as number) && (report.pollIntervalMs as number) > 0
    ? (report.pollIntervalMs as number) : null;
  const limit = Math.max(STALE_POLL_FLOOR_MS, (interval ?? 0) * STALE_POLL_FACTOR);
  const ageMs = nowMs - pollMs;
  if (ageMs > limit) {
    return { code: 'WORKER_PRESENT_BUT_RUNTIME_BROKEN', standbyOnly, evidence,
      reason: `예약 폴링이 ${Math.round(ageMs / 1000)}초째 멈춰 있습니다 (허용 ${Math.round(limit / 1000)}초)` };
  }

  return { code: 'WORKER_PRIMARY_ACTIVE', standbyOnly, evidence,
    reason: `main 락을 쥔 워커가 ${Math.round(ageMs / 1000)}초 전에 예약을 확인했습니다 — 주 경로가 돌고 있습니다` };
}
