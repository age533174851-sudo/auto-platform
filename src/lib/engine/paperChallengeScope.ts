// src/lib/engine/paperChallengeScope.ts
//
// **챌린지 id 하나로 "어느 장부에 적을 것인가"를 정한다.**
//
// 왜 계좌 id를 받지 않는가
// ────────────────────────
// 화면이 `paperAccountId`를 직접 보내면, 그 값이 무엇을 뜻하는지 아는 곳이
// 화면이 된다. 챌린지 계좌인지 기본 계좌인지, 아직 시작 전인지, 이미 끝났는지
// — 판단이 클라이언트로 새어 나간다. 그래서 **밖에서 들어오는 것은
// `challengeId` 하나**이고, 계좌는 서버가 그 챌린지에서 찾아낸다.
//
// 이 파일이 지키는 것 넷
// ──────────────────────
//  ① **소유자까지 함께 본다.** 남의 challengeId는 여기서 멈춘다
//  ② **기본 계좌로 대신 처리하지 않는다.** 폴백은 사용자가 고른 적 없는
//     장부로 주문을 내보내는 일이다 — `paperScope`가 계좌에 대해 세운 것과
//     같은 규칙이다
//  ③ **못 읽은 것을 "없다"로 적지 않는다.** 조회 실패는 `UNREADABLE`이고,
//     부르는 쪽은 거기서 멈춘다
//  ④ **RUNNING이 아니면 주문을 받지 않는다.** 상태가 하나 늘어도 기본이
//     거부다(fail-closed)
//
// DB가 최종 권위다
// ────────────────
// `086`의 `paper_open_position`은 계좌를 잠근 뒤 챌린지 상태를 **다시** 보고
// RUNNING이 아니면 `CHALLENGE_NOT_RUNNING`을 돌려준다. 여기 있는 관문은 그
// 판정을 대신하지 않는다 — 잠그기 전의 안내이고, 값이 갈리면 **DB 쪽이
// 맞다.** 두 곳이 같은 판단을 하되 권위는 하나다.
import { type ChallengeStatus } from './paperChallenge';
import { resolvePaperScope, paperScopeFailed } from './paperScope';

export type ChallengeScopeFailure =
  /** 사용자를 모른다 */
  | 'NO_USER'
  /** challengeId가 비었거나 모양이 아니다 */
  | 'NO_CHALLENGE_ID'
  /** 없거나, 이 사용자의 것이 아니다 — **두 경우에 같은 답을 준다** */
  | 'NOT_FOUND'
  /** 조회 자체가 실패했다. '없다'와 다르다 */
  | 'UNREADABLE';

export interface ChallengeScopeOk {
  ok: true;
  challengeId: string;
  accountId: string;
  status: ChallengeStatus;
}

export interface ChallengeScopeFail {
  ok: false;
  code: ChallengeScopeFailure;
  reason: string;
}

export type ChallengeScope = ChallengeScopeOk | ChallengeScopeFail;

/**
 * 못 정했는가 — **타입 가드로 쓴다.**
 *
 * 웹 `tsconfig`는 `strict: false`라 `if (!scope.ok)`만으로는 판별 합집합이
 * 좁혀지지 않는다. `paperScopeFailed`와 같은 이유로 여기 하나를 둔다.
 */
export function challengeScopeFailed(s: ChallengeScope): s is ChallengeScopeFail {
  return !s || s.ok !== true;
}

/** 밖에서 온 값을 challengeId로 읽는다. **못 읽으면 null** — 빈 문자열로 넘기지 않는다. */
export function readChallengeId(raw: any): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  // UUID 모양만 받는다. 아무 문자열이나 통과시키면 그 값이 그대로 질의에 들어가고,
  // 실패 사유가 "없음"인지 "잘못된 값"인지 구별되지 않는다.
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {
    return null;
  }
  return v.toLowerCase();
}

export interface ChallengeOrderGate {
  allowed: boolean;
  reason: string;
}

/**
 * 이 상태에서 주문을 받는가 — **RUNNING만이다.**
 *
 * 금지 목록(`CLOSING`·`CLOSED`만 막기)으로 쓰지 않는다. `READY`는 아직 시작
 * 시각 전이고, 그때 열린 포지션은 아무도 고르지 않은 기간에 생긴 것이다.
 * 목록으로 적으면 상태가 하나 늘 때 **조용히 열린다.**
 */
export function challengeOrderGate(status: string | null | undefined): ChallengeOrderGate {
  if (status === 'RUNNING') return { allowed: true, reason: '진행 중인 챌린지입니다' };
  if (status === 'READY') {
    return { allowed: false, reason: '아직 시작하지 않은 챌린지입니다 — 시작 후에 주문할 수 있습니다' };
  }
  if (status === 'CLOSING') {
    return { allowed: false, reason: '정리 중인 챌린지입니다 — 새 주문을 받지 않습니다' };
  }
  if (status === 'CLOSED') {
    return { allowed: false, reason: '이미 끝난 챌린지입니다' };
  }
  return {
    allowed: false,
    reason: `챌린지 상태를 알 수 없어 주문하지 않았습니다 (${status || '없음'})`,
  };
}

/**
 * challengeId → 전용 계좌.
 *
 * **폴백이 없다.** 못 찾으면 기본 계좌로 넘어가지 않고 여기서 끝난다.
 */
export async function resolveChallengeScope(
  sb: any,
  userId: string | null | undefined,
  challengeId: string | null | undefined,
): Promise<ChallengeScope> {
  const uid = typeof userId === 'string' ? userId.trim() : '';
  if (!uid) {
    return { ok: false, code: 'NO_USER', reason: '사용자를 알 수 없어 챌린지를 정하지 못했습니다' };
  }
  const cid = readChallengeId(challengeId);
  if (!cid) {
    return { ok: false, code: 'NO_CHALLENGE_ID', reason: '챌린지를 알 수 없습니다' };
  }
  if (!sb) return { ok: false, code: 'UNREADABLE', reason: '챌린지를 조회할 수 없습니다' };

  try {
    // **소유자까지 함께 본다.** id만 보면 남의 챌린지가 통과한다.
    const { data, error } = await sb.from('paper_challenges')
      .select('id, paper_account_id, status')
      .eq('id', cid).eq('user_id', uid).maybeSingle();
    if (error) {
      return { ok: false, code: 'UNREADABLE', reason: '챌린지 조회에 실패했습니다' };
    }
    if (!data?.id || !data?.paper_account_id) {
      // 없는 것과 남의 것에 **같은 답**을 준다 — 존재 여부를 알려 주지 않는다.
      return {
        ok: false, code: 'NOT_FOUND',
        reason: '챌린지를 찾지 못했습니다 — 기본 계좌로 대신 처리하지 않습니다',
      };
    }
    return {
      ok: true,
      challengeId: String(data.id),
      accountId: String(data.paper_account_id),
      status: String(data.status) as ChallengeStatus,
    };
  } catch {
    return { ok: false, code: 'UNREADABLE', reason: '챌린지 조회에 실패했습니다' };
  }
}

// ══════════════ 이 요청이 보는 장부 ══════════════

export interface PaperTargetOk {
  ok: true;
  accountId: string;
  /** 챌린지 장부인가, 기본 장부인가 */
  kind: 'CHALLENGE' | 'DEFAULT';
  /** 챌린지일 때만 있다 */
  challengeId: string | null;
  /** 챌린지일 때만 있다 */
  challengeStatus: ChallengeStatus | null;
}

export interface PaperTargetFail {
  ok: false;
  code: ChallengeScopeFailure | 'NO_ACCOUNT' | 'NOT_OWNED';
  reason: string;
  kind: 'CHALLENGE' | 'DEFAULT';
}

export type PaperTarget = PaperTargetOk | PaperTargetFail;

export function paperTargetFailed(t: PaperTarget): t is PaperTargetFail {
  return !t || t.ok !== true;
}

/**
 * **이 요청이 적을 장부를 한 번 정한다.**
 *
 * `challengeId`가 있으면 그 챌린지의 전용 계좌, 없으면 지금까지처럼 기본
 * 계좌다. 챌린지를 지정했는데 못 찾으면 **기본 계좌로 내려가지 않는다** —
 * 그 순간 사용자가 고른 적 없는 장부로 주문이 나간다.
 *
 * 미리보기(가용 증거금)·조회·최종 체결이 **전부 이 한 값**을 쓴다. 한 곳만
 * 다른 계좌를 보면 "미리보기와 최종 판정이 다른 예산을 본다"가 그대로
 * 돌아온다.
 */
export async function resolvePaperTarget(
  sb: any,
  userId: string | null | undefined,
  challengeId?: string | null,
): Promise<PaperTarget> {
  const raw = typeof challengeId === 'string' ? challengeId.trim() : '';
  if (raw) {
    const cs = await resolveChallengeScope(sb, userId, raw);
    if (challengeScopeFailed(cs)) {
      return { ok: false, code: cs.code, reason: cs.reason, kind: 'CHALLENGE' };
    }
    return {
      ok: true, accountId: cs.accountId, kind: 'CHALLENGE',
      challengeId: cs.challengeId, challengeStatus: cs.status,
    };
  }
  const ps = await resolvePaperScope(sb, userId);
  if (paperScopeFailed(ps)) {
    return { ok: false, code: ps.code, reason: ps.reason, kind: 'DEFAULT' };
  }
  return {
    ok: true, accountId: ps.accountId, kind: 'DEFAULT',
    challengeId: null, challengeStatus: null,
  };
}
