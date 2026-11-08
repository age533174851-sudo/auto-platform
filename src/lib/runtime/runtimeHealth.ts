// src/lib/runtime/runtimeHealth.ts
//
// **`fly logs`를 사람이 스크롤하는 일을 없앤다.**
//
// 2026-08-19에 사흘을 잃었다. 화면은 워커가 `alive: false`라고 했고,
// 배포는 네 번 전부 success였고, Fly는 머신이 `started`라고 했고,
// 로그에는 tick이 찍히고 있었다. **넷이 동시에 참일 수 있는가?** 있다 —
// 워커가 살아서 다른 데이터베이스에 쓰고 있으면 전부 참이다.
//
// 그걸 알아내는 데 사흘이 걸린 이유는 간단하다. 각 사실이 서로 다른
// 화면(Fly 대시보드 · Grafana · TRAIGO 화면 · GitHub Actions)에 흩어져
// 있었고, **한자리에 모아 놓고 모순을 짚어 주는 것이 없었다.**
//
// 이 파일이 그 자리다. 값이 아니라 **판정**을 만든다.

export type RuntimeCode =
  /** 다 맞다 */
  | 'HEALTHY'
  /** 워커 기록이 아예 없다 */
  | 'NO_WORKER'
  /** 살아 있다는 신호가 오래됐다 */
  | 'STALE_HEARTBEAT'
  /** 워커가 웹과 **다른 데이터베이스**를 보고 있다 */
  | 'DIFFERENT_DATABASE'
  /** 워커가 거래소 키를 못 푼다 */
  | 'DIFFERENT_ENCRYPTION_KEY'
  /** 배포된 커밋이 서로 다르다 */
  | 'SHA_MISMATCH'
  /** 워커가 어느 커밋인지 모른다 */
  | 'VERSION_UNKNOWN'
  /** 기동 점검이 실패한 채로 돌고 있다 */
  | 'STARTUP_FAILED'
  /** 읽지 못했다. **정상이 아니다** */
  | 'UNKNOWN';

export type RuntimeSeverity = 'ok' | 'warn' | 'bad' | 'unknown';

export interface RuntimeFinding {
  code: RuntimeCode;
  severity: RuntimeSeverity;
  detail: string;
  /** 시스템이 스스로 고쳐 볼 수 있는가 */
  autoFix: 'RESTART_WORKER' | 'REDEPLOY_WORKER' | 'APPLY_MIGRATIONS' | null;
  /** 자동으로 못 고치는 이유. 고칠 수 있으면 null */
  needsHuman: string | null;
}

export interface RuntimeHealth {
  code: RuntimeCode;
  severity: RuntimeSeverity;
  summary: string;
  findings: RuntimeFinding[];
  /** 워커가 지금 일을 받을 수 있는가 */
  canRun: boolean;
  ageSec: number | null;
}

export interface WorkerRow {
  worker_id?: string | null;
  last_seen?: string | null;
  status?: string | null;
  version?: string | null;
  provider?: string | null;
  region?: string | null;
  machine_id?: string | null;
  started_at?: string | null;
  tick_count?: number | null;
  supabase_fingerprint?: string | null;
  encryption_fingerprint?: string | null;
  startup_ok?: boolean | null;
  startup_detail?: string | null;
}

/**
 * **워커가 살아 있는지를 정하는 단 하나의 숫자.**
 *
 * 이 질문에 답하는 상수가 세 곳에 따로 있었고 이미 갈라져 있었다:
 * `evaluationLoop.WORKER_STALE_MS`(180초) · 이 파일(180초) ·
 * `persistentRuntime.HEARTBEAT_STALE_MS`(**30초**). 그래서 같은 워커가
 * 보는 화면에 따라 "실행 중"이거나 "응답 없음"이 됐다.
 *
 * 숫자의 근거 — 실측값에서 나온다:
 *
 *   worker/src/index.ts:86
 *     const POLL_SEC = Math.max(1, Math.min(15, parseInt(process.env.WORKER_POLL_SEC || '3', 10)))
 *
 * 즉 heartbeat는 기본 **3초**마다, 최악의 설정에서도 **15초**마다 쓰인다
 * (`index.ts:1200`이 매 tick 안에서 쓴다). 180초는 그 상한의 12배다.
 *
 * 왜 넉넉한가 — **재배포 때문이다.** 짧게 잡으면 배포마다 모든 화면이
 * 빨강이 되고, 사람은 빨강을 무시하기 시작한다. 그 하한은 이 저장소가
 * 이미 시험으로 적어 두었다:
 *
 *   src/lib/autotrade/schedulePoll.test.ts:470
 *     assert(WORKER_STALE_MS >= 120_000, '유예가 너무 짧으면 재배포마다 빨강이 된다')
 *     assert(WORKER_STALE_MS <= 600_000, '유예가 너무 길면 죽은 워커를 못 본다')
 *
 * `HEARTBEAT_STALE_MS = 30_000`은 그 하한을 깨고 있었다. **그런데 시험이
 * 그것을 볼 수 없었다** — 다른 상수였기 때문이다. 한쪽에 붙인 시험은
 * 다른 쪽을 지켜 주지 않는다.
 *
 * 새 사본이 생기는 것은 `scripts/check-runtime.mjs`가 막는다.
 */
export const WORKER_STALE_MS = 3 * 60_000;

/**
 * 예전 이름. 이 파일 안과 `runtimeHealth.test.ts`가 쓴다.
 * **값을 따로 적지 않는다** — 같은 숫자다.
 */
export const STALE_MS = WORKER_STALE_MS;

function ms(v: any): number | null {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
}

function short(sha: any): string | null {
  const s = String(sha ?? '').trim();
  return s ? s.slice(0, 7) : null;
}

/**
 * 지금 런타임이 성한가.
 *
 * **읽지 못한 것을 정상으로 적지 않는다.** 그리고 모순을 발견하면
 * 가장 조용한 것을 먼저 말한다 — 다른 DB를 보고 있는 워커는 모든 화면에서
 * 멀쩡해 보인다.
 */
export function runtimeHealthOf(i: {
  /** worker_heartbeat 마지막 줄. **못 읽었으면 undefined, 없으면 null** */
  worker: WorkerRow | null | undefined;
  /** 웹(Vercel)이 보고 있는 Supabase 지문 */
  webSupabaseFp?: string | null;
  /** 웹이 가진 암호화 키 지문 */
  webEncryptionFp?: string | null;
  /** 배포돼 있어야 하는 커밋 (main) */
  mainSha?: string | null;
  /** 웹이 실제로 돌고 있는 커밋 */
  webSha?: string | null;
  nowMs: number;
}): RuntimeHealth {
  const findings: RuntimeFinding[] = [];
  const w = i?.worker;

  if (w === undefined) {
    return {
      code: 'UNKNOWN', severity: 'unknown',
      summary: '워커 상태를 읽지 못했습니다 — 죽었다는 뜻도, 살아 있다는 뜻도 아닙니다',
      findings: [{
        code: 'UNKNOWN', severity: 'unknown',
        detail: 'worker_heartbeat를 읽지 못했습니다',
        autoFix: null,
        needsHuman: null,
      }],
      canRun: false, ageSec: null,
    };
  }

  if (w === null) {
    return {
      code: 'NO_WORKER', severity: 'bad',
      summary: '워커 기록이 하나도 없습니다 — 한 번도 뜬 적이 없거나, 뜨자마자 죽었습니다',
      findings: [{
        code: 'NO_WORKER', severity: 'bad',
        detail: 'worker_heartbeat에 줄이 없습니다',
        autoFix: 'REDEPLOY_WORKER',
        needsHuman: null,
      }],
      canRun: false, ageSec: null,
    };
  }

  const seen = ms(w.last_seen);
  const ageSec = seen == null ? null : Math.max(0, Math.round((i.nowMs - seen) / 1000));
  const stale = seen == null || (i.nowMs - seen) > STALE_MS;

  // ── 1. 살아 있는가 ──
  if (stale) {
    findings.push({
      code: 'STALE_HEARTBEAT', severity: 'bad',
      detail: seen == null
        ? '마지막 신호 시각을 읽지 못했습니다'
        : `마지막 신호가 ${ageSec}초 전입니다 (${Math.round(STALE_MS / 1000)}초를 넘기면 멈춘 것으로 봅니다)`,
      // 재시작은 시스템이 해 볼 수 있다. 다만 주문이 떠 있으면 먼저 대조한다.
      autoFix: 'RESTART_WORKER',
      needsHuman: null,
    });
  }

  // ── 2. 같은 데이터베이스를 보고 있는가 ──
  //
  // **이게 가장 조용한 고장이다.** 워커는 살아서 tick을 찍고, Fly는
  // started라고 하고, 배포는 success인데, 화면은 아무것도 못 본다.
  if (i.webSupabaseFp && w.supabase_fingerprint) {
    if (String(i.webSupabaseFp) !== String(w.supabase_fingerprint)) {
      findings.push({
        code: 'DIFFERENT_DATABASE', severity: 'bad',
        detail: `워커가 웹과 다른 데이터베이스를 보고 있습니다 (워커 ${w.supabase_fingerprint} · 웹 ${i.webSupabaseFp})`,
        autoFix: null,
        // 값을 바꾸는 일이라 자동으로 하지 않는다. **다만 어느 값인지는 말한다.**
        needsHuman: '워커의 SUPABASE_URL이 웹과 다릅니다 — 값은 보여 주지 않고 지문만 비교했습니다',
      });
    }
  }

  if (i.webEncryptionFp && w.encryption_fingerprint) {
    if (String(i.webEncryptionFp) !== String(w.encryption_fingerprint)) {
      findings.push({
        code: 'DIFFERENT_ENCRYPTION_KEY', severity: 'bad',
        detail: `워커가 거래소 키를 풀지 못합니다 (워커 ${w.encryption_fingerprint} · 웹 ${i.webEncryptionFp})`,
        autoFix: null,
        needsHuman: 'EXCHANGE_ENCRYPTION_KEY가 웹과 다릅니다 — 워커는 주문을 낼 수 없습니다',
      });
    }
  }

  // ── 3. 어느 커밋인가 ──
  const wSha = short(w.version);
  const mSha = short(i.mainSha);
  if (mSha && wSha && mSha !== wSha) {
    findings.push({
      code: 'SHA_MISMATCH', severity: 'warn',
      detail: `워커가 ${wSha}를 돌리고 있습니다 (지금 코드는 ${mSha}) — 배포가 아직 안 끝났거나 실패했습니다`,
      autoFix: 'REDEPLOY_WORKER',
      needsHuman: null,
    });
  } else if (mSha && !wSha) {
    // **"모름"은 "같음"이 아니다.**
    findings.push({
      code: 'VERSION_UNKNOWN', severity: 'warn',
      detail: '워커가 어느 커밋인지 적지 않았습니다 — 같다는 뜻이 아닙니다',
      autoFix: 'APPLY_MIGRATIONS',
      needsHuman: null,
    });
  }

  // ── 4. 기동 점검 ──
  if (w.startup_ok === false) {
    findings.push({
      code: 'STARTUP_FAILED', severity: 'bad',
      detail: `기동 점검이 실패한 채로 돌고 있습니다: ${String(w.startup_detail || '이유 없음').slice(0, 200)}`,
      autoFix: 'RESTART_WORKER',
      needsHuman: null,
    });
  }

  if (findings.length === 0) {
    const who = w.provider ? String(w.provider) : '실행기';
    return {
      code: 'HEALTHY', severity: 'ok',
      summary: `${who}에서 워커가 돌고 있습니다`
        + (wSha ? ` (${wSha})` : '')
        + (ageSec != null ? ` · ${ageSec}초 전 신호` : ''),
      findings: [], canRun: true, ageSec,
    };
  }

  // 가장 나쁜 것을 대표로 삼는다. 같은 등급이면 앞엣것(더 조용한 고장)이 먼저다.
  const rank = { bad: 3, warn: 2, unknown: 1, ok: 0 } as const;
  const worst = findings.slice().sort((a, b) => rank[b.severity] - rank[a.severity])[0];
  return {
    code: worst.code, severity: worst.severity,
    summary: worst.detail,
    findings,
    // warn만 있으면 일은 받을 수 있다. bad가 하나라도 있으면 못 받는다.
    canRun: !findings.some(f => f.severity === 'bad'),
    ageSec,
  };
}

/**
 * 자동으로 고쳐 볼 것들.
 *
 * **주문이 떠 있으면 무작정 재시작하지 않는다.** 재시작 자체는 안전하지만,
 * 재시작 뒤에 포지션·주문을 다시 맞추지 않으면 그 사이의 체결을 놓친다.
 */
export function autoFixPlan(h: RuntimeHealth, i: { openOrders: number | null }): {
  actions: Array<'RECONCILE_FIRST' | 'RESTART_WORKER' | 'REDEPLOY_WORKER' | 'APPLY_MIGRATIONS'>;
  blocked: string[];
} {
  const actions: Array<'RECONCILE_FIRST' | 'RESTART_WORKER' | 'REDEPLOY_WORKER' | 'APPLY_MIGRATIONS'> = [];
  const blocked: string[] = [];

  for (const f of h?.findings ?? []) {
    if (f.autoFix) {
      if (!actions.includes(f.autoFix)) actions.push(f.autoFix);
    } else if (f.needsHuman) {
      blocked.push(`${f.code}: ${f.needsHuman}`);
    }
  }

  if (actions.includes('RESTART_WORKER') || actions.includes('REDEPLOY_WORKER')) {
    if (i?.openOrders == null) {
      // **모르면 재시작하지 않는다.** 열린 주문을 못 읽은 채로 워커를
      // 갈아 끼우면, 그 사이 체결을 아무도 안 본다.
      return { actions: [], blocked: [...blocked, '열린 주문 수를 확인하지 못해 재시작하지 않았습니다'] };
    }
    if (i.openOrders > 0) actions.unshift('RECONCILE_FIRST');
  }
  return { actions, blocked };
}
