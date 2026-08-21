// src/lib/ops/opsQueue.ts
//
// **화면은 요청을 적고, 자격을 가진 쪽이 집어 간다.**
//
// "배포해"를 눌렀을 때 그 화면(Vercel)은 GitHub 워크플로를 부를 자격도,
// Fly 머신을 재시작할 자격도 없다. 그 자격은 GitHub Actions가 이미
// 가지고 있다. 새 토큰을 하나 더 만드는 대신 **이미 자격을 가진 쪽이
// 요청을 집어 가게** 한다.
//
// 이 파일은 그 큐의 규칙만 다룬다. 실행은 `scripts/ops-runner.mjs`에 있고,
// 그쪽은 이 파일을 컴파일해서 쓴다 — **판단을 복제하지 않는다.**

export type QueueStatus = 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED' | 'EXPIRED';

export interface QueueRow {
  id: string;
  command: string;
  status: QueueStatus;
  approved: boolean;
  requestedAtMs: number;
  claimedAtMs: number | null;
  claimedBy: string | null;
}

/** 이 시간을 넘겨 CLAIMED로 남아 있으면 집어 간 쪽이 죽은 것으로 본다 */
export const CLAIM_TTL_MS = 15 * 60_000;

/** 이 시간이 지난 PENDING은 실행하지 않는다 — 한참 전의 "배포해"가 지금 도는 것은 놀랍다 */
export const REQUEST_TTL_MS = 60 * 60_000;

export type ClaimCode =
  | 'CLAIM'
  /** 남이 쥐고 있다 */
  | 'HELD'
  /** 너무 오래돼 실행하지 않는다 */
  | 'EXPIRED'
  /** 승인이 필요한데 승인이 없다 */
  | 'NEEDS_APPROVAL'
  /** 모르는 명령 */
  | 'UNKNOWN_COMMAND'
  /** 실행할 것이 없다 */
  | 'NOTHING';

export interface ClaimDecision {
  code: ClaimCode;
  row: QueueRow | null;
  reason: string;
}

/** 승인이 필요한 명령 (실제 자금·파괴적 변경) */
const NEEDS_APPROVAL = new Set(['APPROVE_LIVE_SMALL']);

/** 실행기가 다룰 수 있는 명령. **모르는 명령은 실행하지 않는다** */
const RUNNABLE = new Set(['DEPLOY', 'RECOVER', 'APPROVE_LIVE_SMALL']);

/**
 * 무엇을 집어 갈 것인가.
 *
 * **오래된 요청은 실행하지 않는다.** 한 시간 전에 누른 "배포해"가 지금
 * 도는 것은 사람이 예상하지 못하는 일이고, 그 사이 코드가 여러 번 바뀐다.
 */
export function claimDecision(i: {
  /** requested_at 오름차순. **못 읽었으면 undefined** */
  rows: QueueRow[] | null | undefined;
  me: string;
  nowMs: number;
}): ClaimDecision {
  if (i?.rows === undefined) {
    return { code: 'NOTHING', row: null,
      reason: '요청 목록을 읽지 못했습니다 — 아무것도 실행하지 않습니다' };
  }
  const rows = (i.rows ?? []).slice()
    .sort((a, b) => (a.requestedAtMs || 0) - (b.requestedAtMs || 0));

  for (const r of rows) {
    if (r.status === 'CLAIMED') {
      const held = r.claimedAtMs != null && (i.nowMs - r.claimedAtMs) < CLAIM_TTL_MS;
      if (held && r.claimedBy !== i.me) {
        return { code: 'HELD', row: r,
          reason: `${r.claimedBy || '다른 실행기'}가 ${r.command}를 처리하는 중입니다` };
      }
      // 만료된 것은 다시 집어 간다. 죽은 실행기의 요청이 영영 남지 않게.
    } else if (r.status !== 'PENDING') {
      continue;
    }

    if ((i.nowMs - (r.requestedAtMs || 0)) > REQUEST_TTL_MS) {
      return { code: 'EXPIRED', row: r,
        reason: `${Math.round((i.nowMs - r.requestedAtMs) / 60_000)}분 전 요청이라 실행하지 않습니다` };
    }
    if (!RUNNABLE.has(r.command)) {
      return { code: 'UNKNOWN_COMMAND', row: r,
        reason: `${r.command}는 실행기가 처리하는 명령이 아닙니다` };
    }
    if (NEEDS_APPROVAL.has(r.command) && !r.approved) {
      // **실제 자금이 걸린 것은 승인 없이 절대 실행하지 않는다.**
      return { code: 'NEEDS_APPROVAL', row: r,
        reason: `${r.command}는 명시적 승인이 있어야 실행합니다` };
    }
    return { code: 'CLAIM', row: r, reason: `${r.command}를 집어 갑니다` };
  }
  return { code: 'NOTHING', row: null, reason: '실행할 요청이 없습니다' };
}

// ── 실행 결과 ──

export interface StepOutcome {
  step: string;
  ok: boolean;
  detail: string;
}

export interface RunOutcome {
  status: 'DONE' | 'FAILED';
  steps: StepOutcome[];
  error: string | null;
  summary: string;
}

/**
 * 단계 결과 → 요청 결과.
 *
 * **하나라도 실패하면 DONE이 아니다.** "배포했습니다"라고 적어 놓고
 * 실제로는 절반만 된 상태가 이 저장소에서 가장 자주 난 고장이다.
 */
export function runOutcomeOf(steps: StepOutcome[]): RunOutcome {
  const list = Array.isArray(steps) ? steps : [];
  const bad = list.filter(s => !s.ok);
  if (list.length === 0) {
    return { status: 'FAILED', steps: [], error: '실행한 단계가 없습니다',
      summary: '아무것도 하지 않았습니다' };
  }
  if (bad.length > 0) {
    return {
      status: 'FAILED', steps: list,
      error: bad.map(b => `${b.step}: ${b.detail}`).join(' · ').slice(0, 1000),
      summary: `${list.length}단계 중 ${bad.length}단계가 실패했습니다 — ${bad[0].step}`,
    };
  }
  return {
    status: 'DONE', steps: list, error: null,
    summary: `${list.length}단계를 모두 마쳤습니다: ${list.map(s => s.step).join(' → ')}`,
  };
}
