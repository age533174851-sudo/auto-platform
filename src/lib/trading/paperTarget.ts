// src/lib/trading/paperTarget.ts
//
// **"지금 어느 모의 장부로 거래하는가" — 화면 전체가 이 값 하나를 쓴다.**
//
// 왜 값 하나인가
// ──────────────
// 잔고는 챌린지 계좌를 보는데 주문은 기본 계좌로 나가는 것이 이 구조에서
// 제일 쉽게 나는 고장이다. 화면마다 자기 상태를 들고 있으면 언젠가 한
// 곳만 바뀐다 — 이 저장소가 반복해서 겪은 "경로가 둘인데 한쪽만 고침"이다.
//
// 그래서 **선택은 한 값**이고, 잔고·포지션·미리보기·체결·청산·이력이 전부
// 그 값에서 요청을 만든다.
//
// 계좌 id를 만들지 않는다
// ───────────────────────
// 이 모듈이 내놓는 것은 `challengeId`뿐이다. `paperAccountId`를 만들거나
// 들고 다니지 않는다 — 들고 다니는 순간 그 값이 화면에 노출되고, 다음
// 요청이 그걸 되보내게 되고, 그러면 남의 계좌 id를 넣어 보는 문이 열린다.
// 계좌는 **서버가 challengeId에서 찾는다**(`resolveChallengeScope`).
//
// 시장과 무관하다
// ───────────────
// 현물이든 선물이든 "어느 장부인가"는 같은 질문이다. 그래서 이 모듈에는
// 시장 개념이 없다 — 선물 모의 주문 화면이 붙는 다음 PR에서도 이 파일과
// 챌린지 선택은 **그대로 쓴다.** 다시 쓰지 않도록 경계를 여기 그었다.

/** 기본 계좌인가, 챌린지 전용 계좌인가. **셋째는 없다.** */
export type PaperTargetKind = 'DEFAULT' | 'CHALLENGE';

export interface PaperTarget {
  kind: PaperTargetKind;
  /** CHALLENGE일 때만 값이 있다. DEFAULT면 반드시 null이다 */
  challengeId: string | null;
}

export const DEFAULT_TARGET: PaperTarget = { kind: 'DEFAULT', challengeId: null };

/** UUID 모양만 받는다 — `paperChallengeScope.readChallengeId`와 같은 규칙이다. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isChallengeId(raw: any): boolean {
  return typeof raw === 'string' && UUID.test(raw.trim());
}

export function selectDefault(): PaperTarget {
  return { kind: 'DEFAULT', challengeId: null };
}

/**
 * 챌린지를 고른다. **모양이 아니면 null이다 — 기본 계좌로 대신 고르지 않는다.**
 *
 * 여기서 조용히 `DEFAULT`를 돌려주면, 사용자가 챌린지를 골랐다고 믿는
 * 화면에서 기본 장부로 주문이 나간다. 그건 이 PR이 없애려는 고장 그 자체다.
 */
export function selectChallenge(raw: any): PaperTarget | null {
  if (!isChallengeId(raw)) return null;
  return { kind: 'CHALLENGE', challengeId: String(raw).trim().toLowerCase() };
}

/** 값이 계약대로인가 — 저장소에서 읽은 값처럼 **믿을 수 없는 입력**에 쓴다. */
export function isValidTarget(t: any): t is PaperTarget {
  if (!t) return false;
  if (t.kind === 'DEFAULT') return t.challengeId == null;
  if (t.kind === 'CHALLENGE') return isChallengeId(t.challengeId);
  return false;
}

/**
 * 저장해 둔 선택을 되읽는다.
 *
 * **읽지 못하면 기본 계좌다.** 이건 폴백이 아니라 "아무것도 고르지 않은
 * 상태"의 정의다 — 챌린지를 고른 적이 없으면 기본 계좌가 맞다. 위험한
 * 폴백은 *골랐는데 못 찾았을 때* 기본으로 내려가는 것이고, 그건 서버가
 * 거부하고 화면이 그대로 보여 준다(여기서 일어나지 않는다).
 */
export function restoreTarget(raw: any): PaperTarget {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (isValidTarget(v)) {
      return v.kind === 'CHALLENGE'
        ? { kind: 'CHALLENGE', challengeId: String(v.challengeId).toLowerCase() }
        : selectDefault();
    }
  } catch { /* 못 읽었다 */ }
  return selectDefault();
}

/**
 * 이 선택으로 요청을 만들 때 실을 값.
 *
 * **계좌 id가 들어갈 자리가 없다.** 기본 계좌면 아무것도 싣지 않는다 —
 * 빈 `challengeId`를 실으면 서버가 "값은 왔는데 모양이 아니다"로 읽어
 * 거부한다(그건 기본 계좌 주문이 실패한다는 뜻이다).
 */
export function targetRequestFields(t: PaperTarget): { challengeId?: string } {
  return t?.kind === 'CHALLENGE' && t.challengeId ? { challengeId: t.challengeId } : {};
}

/** 조회용 쿼리스트링 조각. 기본 계좌면 빈 문자열이다. */
export function targetQuery(t: PaperTarget): string {
  return t?.kind === 'CHALLENGE' && t.challengeId
    ? `?challengeId=${encodeURIComponent(t.challengeId)}`
    : '';
}

/** 두 선택이 같은 장부를 가리키는가 — 화면이 다시 읽을지 정할 때 쓴다. */
export function sameTarget(a: PaperTarget, b: PaperTarget): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  return (a.challengeId ?? null) === (b.challengeId ?? null);
}

/** 화면에 적을 이름. */
export function targetLabel(t: PaperTarget): string {
  return t?.kind === 'CHALLENGE' ? '챌린지' : '모의투자';
}

// ══════════════ 이 장부가 지금 주문을 받는가 ══════════════

export interface TargetOrderGate {
  allowed: boolean;
  reason: string;
}

/**
 * 선택한 장부가 지금 주문을 받는가.
 *
 * 기본 계좌는 언제나 받는다. 챌린지는 **RUNNING일 때만**이고, 상태를
 * 모르면 받지 않는다 — 확인하지 못한 것은 통과가 아니다.
 *
 * 이 판정은 **안내**다. 최종 권위는 계좌를 잠근 뒤 상태를 다시 보는
 * `086`의 `paper_open_position`에 있고, 값이 갈리면 DB 쪽이 맞다.
 */
export function targetOrderGate(
  t: PaperTarget, challengeStatus?: string | null,
): TargetOrderGate {
  if (!t || t.kind === 'DEFAULT') {
    return { allowed: true, reason: '기본 모의 계좌로 주문합니다' };
  }
  if (!t.challengeId) {
    return { allowed: false, reason: '챌린지를 알 수 없어 주문하지 않았습니다' };
  }
  if (challengeStatus === 'RUNNING') {
    return { allowed: true, reason: '진행 중인 챌린지 계좌로 주문합니다' };
  }
  if (challengeStatus === 'READY') {
    return { allowed: false, reason: '아직 시작하지 않은 챌린지입니다' };
  }
  if (challengeStatus === 'CLOSING') {
    return { allowed: false, reason: '정리 중인 챌린지입니다 — 새 주문을 받지 않습니다' };
  }
  if (challengeStatus === 'CLOSED') {
    return { allowed: false, reason: '이미 끝난 챌린지입니다' };
  }
  return {
    allowed: false,
    reason: `챌린지 상태를 확인하지 못해 주문하지 않았습니다 (${challengeStatus || '모름'})`,
  };
}
