// src/lib/engine/paperHoldingScope.ts
//
// **보유/매도가 어느 장부를 보는지 한 곳에서 정한다.**
//
// 판단 자체는 새로 만들지 않는다 — `resolveChallengeScope`와
// `resolvePaperScope`가 이미 정본이고, 여기서는 둘을 **같은 순서로** 부르고
// 실패를 같은 모양으로 돌려줄 뿐이다. 두 라우트(보유 읽기 · 매도)가 계좌를
// 각자 정하면 언젠가 한쪽만 고쳐진다.
//
// **`challengeId`가 있는데 못 풀리면 기본 계좌로 내려가지 않는다.** 내려가면
// 사용자가 고른 적 없는 장부의 보유가 보이고, 그 장부의 자산이 팔린다.

export type HoldingScope =
  | { ok: true; accountId: string; challengeId: string | null }
  | { ok: false; code: 'AUTH' | 'NOT_FOUND' | 'UNREADABLE'; reason: string; status: number };

export async function resolveHoldingScope(
  sb: any, userId: string, rawChallengeId: string | null | undefined,
): Promise<HoldingScope> {
  const cid = typeof rawChallengeId === 'string' ? rawChallengeId.trim() : '';

  if (cid) {
    const { resolveChallengeScope, challengeScopeFailed } =
      await import('./paperChallengeScope');
    const cs = await resolveChallengeScope(sb, userId, cid);
    if (challengeScopeFailed(cs)) {
      const unreadable = cs.code === 'UNREADABLE';
      return {
        ok: false,
        code: unreadable ? 'UNREADABLE' : 'NOT_FOUND',
        reason: cs.reason,
        status: unreadable ? 503 : 404,
      };
    }
    return { ok: true, accountId: cs.accountId, challengeId: cid };
  }

  const { resolvePaperScope, paperScopeFailed } = await import('./paperScope');
  const scope = await resolvePaperScope(sb, userId);
  if (paperScopeFailed(scope)) {
    // **못 읽은 것을 "계좌 없음"으로 적지 않는다.** 둘은 다른 사실이다.
    return { ok: false, code: 'UNREADABLE', reason: scope.reason, status: 503 };
  }
  return { ok: true, accountId: scope.accountId, challengeId: null };
}

export function holdingScopeFailed(
  s: HoldingScope,
): s is Extract<HoldingScope, { ok: false }> {
  return s.ok === false;
}
