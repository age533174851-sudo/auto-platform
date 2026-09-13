// src/lib/engine/paperChallengeSweep.ts
//
// **챌린지 생명주기를 끝까지 미는 스윕의 판정 — 다만 권위는 DB에 있다.**
//
// 무엇을 여기서 하지 않는가
// ─────────────────────────
// "누가 만료 대상인가"를 여기서 다시 계산하지 않는다. 그 판정은 `086`의
// `paper_challenge_sweep_due()` 안에 있고, 거기서만 `clock_timestamp()`와
// 계좌·챌린지 잠금이 같은 트랜잭션 안에 있다. 여기서 같은 판단을 또 적으면
// **두 곳이 언젠가 갈리고**, 갈리는 순간 그 차이가 곧 만료 race다.
//
// 그래서 이 모듈이 하는 일은 셋뿐이다.
//
//   ① DB가 보고한 전이가 **계약 안의 전이인가** 확인한다
//      (`paperChallenge.transitionAllowed` — 상태 머신의 정본)
//   ② 최종 상태가 **동결된 사유의 복사인가** 확인한다
//      (`paperChallenge.terminalStatusFor`)
//   ③ 한 회차의 결과를 **값으로** 요약한다 — 못 한 것을 0으로 적지 않는다
//
// ①②는 두 번째 권위가 아니라 **대조**다. DB가 정하고, 여기서 어긋나면
// 성공으로 적지 않는다. 이 저장소가 반복해서 겪은 고장이 "실행은 성공했는데
// 생기지 않았다"이므로, 보고하는 쪽이 스스로를 한 번 더 본다.
import {
  transitionAllowed, terminalStatusFor,
  type ChallengeStatus, type CloseIntent,
} from './paperChallenge';

/** `paper_challenge_sweep_due()`가 돌려주는 행. */
export interface SweepRow {
  challenge: string;
  account: string;
  owner: string;
  action: string;          // STARTED | EXPIRED
}

/** 스윕 동작이 뜻하는 전이. 계약 밖이면 null. */
export function sweepTransition(action: string):
  { from: ChallengeStatus; to: ChallengeStatus } | null {
  if (action === 'STARTED') return { from: 'READY', to: 'RUNNING' };
  // 만료는 READY에서도 RUNNING에서도 올 수 있다. 둘 다 CLOSING으로 간다.
  if (action === 'EXPIRED') return { from: 'RUNNING', to: 'CLOSING' };
  return null;
}

export interface SweepCheck {
  accepted: SweepRow[];
  /** 계약 밖이라 성공으로 적지 않은 것. **버리지 않고 이유와 함께 남긴다** */
  rejected: Array<{ row: SweepRow; reason: string }>;
}

/**
 * DB가 보고한 전이를 상태 머신에 대조한다.
 *
 * 모르는 동작을 조용히 넘기지 않는다 — 넘기면 새 전이가 검토 없이 들어온다.
 */
export function checkSweepRows(rows: SweepRow[] | null | undefined): SweepCheck {
  const accepted: SweepRow[] = [];
  const rejected: Array<{ row: SweepRow; reason: string }> = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const t = sweepTransition(String(row?.action ?? ''));
    if (!t) {
      rejected.push({ row, reason: `모르는 스윕 동작입니다 (${String(row?.action ?? '없음')})` });
      continue;
    }
    if (!transitionAllowed(t.from, t.to)) {
      rejected.push({ row, reason: `계약에 없는 전이입니다 (${t.from} → ${t.to})` });
      continue;
    }
    if (!row?.challenge || !row?.account) {
      rejected.push({ row, reason: '챌린지나 계좌를 알 수 없습니다' });
      continue;
    }
    accepted.push(row);
  }
  return { accepted, rejected };
}

/**
 * 최종 상태가 **동결된 사유의 복사**인가.
 *
 * finalizer는 마지막 잔고를 보고 사유를 다시 판단하지 않는다. DB의 CHECK가
 * 이미 막지만, 보고하는 쪽도 같은 것을 본다 — 한쪽이 조용히 빠져도 다른
 * 쪽이 말한다.
 */
export function terminalMatchesFrozenIntent(
  intent: string | null | undefined, terminal: string | null | undefined): boolean {
  const want = terminalStatusFor((intent ?? null) as CloseIntent | null);
  return (terminal ?? null) === want;
}

/** 한 챌린지의 마감 시도 결과. */
export interface FinalizeOutcome {
  challenge: string;
  /** CLOSED | NOT_CLOSING | POSITIONS_OPEN | RECONCILE_MISMATCH | LOST_RACE | NO_CHALLENGE */
  code: string;
  /** 아직 남은 열린 포지션 수. **모르면 null이다 — 0으로 적지 않는다** */
  openCount: number | null;
}

export interface SweepSummary {
  started: number;
  expired: number;
  closed: number;
  /** 포지션이 남아 아직 못 닫은 것 */
  waiting: number;
  /** 원장과 잔고가 어긋나 닫지 않은 것. **사고다 — 따로 센다** */
  mismatched: number;
  /** 시세를 못 구해 이번 회차에 건드리지 않은 포지션 */
  unknownMarks: number;
  /** 계약 밖이라 받아들이지 않은 보고 */
  rejected: number;
  reason: string;
}

/**
 * 한 회차를 값으로 요약한다.
 *
 * **못 한 것을 0으로 적지 않는다.** "닫힌 것 0건"과 "볼 것이 없었다"는 다르고,
 * 운영 화면이 "왜 안 닫혔나"에 답할 수 있어야 한다.
 */
export function summarizeSweep(i: {
  sweep: SweepCheck;
  finalizes: FinalizeOutcome[];
  unknownMarks: number;
}): SweepSummary {
  const acc = i?.sweep?.accepted ?? [];
  const started = acc.filter(r => r.action === 'STARTED').length;
  const expired = acc.filter(r => r.action === 'EXPIRED').length;
  const fin = Array.isArray(i?.finalizes) ? i.finalizes : [];
  const closed = fin.filter(f => f.code === 'CLOSED').length;
  const waiting = fin.filter(f => f.code === 'POSITIONS_OPEN').length;
  const mismatched = fin.filter(f => f.code === 'RECONCILE_MISMATCH').length;
  const rejected = i?.sweep?.rejected?.length ?? 0;
  const unknownMarks = Number.isFinite(i?.unknownMarks) ? Number(i.unknownMarks) : 0;

  const parts: string[] = [];
  if (started) parts.push(`시작 ${started}건`);
  if (expired) parts.push(`만료 ${expired}건`);
  if (closed) parts.push(`마감 ${closed}건`);
  if (waiting) parts.push(`정리 중 ${waiting}건`);
  if (mismatched) parts.push(`원장 불일치 ${mismatched}건`);
  if (unknownMarks) parts.push(`시세 미확인 ${unknownMarks}건`);
  if (rejected) parts.push(`계약 밖 보고 ${rejected}건`);

  return {
    started, expired, closed, waiting, mismatched, unknownMarks, rejected,
    reason: parts.length ? parts.join(' · ') : '밀 것이 없었습니다',
  };
}
