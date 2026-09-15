// src/lib/engine/paperChallengeApi.ts
//
// **밖에서 온 값을 챌린지 파라미터로 바꾸는 단 하나의 자리 — 순수 함수다.**
//
// 무엇을 받지 않는가
// ──────────────────
//  · **사건 시각을 받지 않는다.** 요청 본문에 `event_effective_at`이 들어올
//    자리가 없다. 그 값은 `paperEventTimeNow()`가 서버에서 만든다
//    (`paperEventTime.ts` 머리말 참고) — 검사기로 막는 것보다 통로를 없애는
//    쪽이 낫다
//  · **계좌 id를 받지 않는다.** 장부는 `challengeId`에서 서버가 찾는다
//  · **시작·종료 시각을 받지 않는다.** 받으면 사용자가 유효기간을 과거로
//    적어 "이미 만료된 챌린지"나 "판정 기간을 벗어난 달성"을 만들 수 있다.
//    받는 것은 **기간의 길이**뿐이고, 시작은 언제나 서버가 정한 지금이다
//
// 왜 여기서 한 번 더 거르나
// ─────────────────────────
// `083`의 CHECK가 마지막 방어선이다. 그런데 DB가 거부할 때는 이미 계좌를
// 만들고 원장을 적으려던 트랜잭션 한복판이고, 사용자에게 돌아가는 것은
// 제약 이름뿐이다. 같은 규칙을 **같은 집합으로** 앞에 두어 사람이 읽을 수
// 있는 사유를 준다. 규칙이 갈리지 않도록 아래 주석에 대응하는 제약 이름을
// 적어 둔다.

/** `083`의 `paper_challenges_equity_chk` · `paper_challenges_period_chk`와 같은 규칙이다. */
export interface ChallengeCreateParams {
  initialEquity: number;
  targetEquity: number;
  failureEquity: number | null;
  durationDays: number;
}

export type ChallengeCreateReject =
  | 'INITIAL_EQUITY'
  | 'TARGET_EQUITY'
  | 'FAILURE_EQUITY'
  | 'DURATION';

export interface ChallengeCreateOk { ok: true; params: ChallengeCreateParams }
export interface ChallengeCreateBad { ok: false; code: ChallengeCreateReject; reason: string }
export type ChallengeCreateParse = ChallengeCreateOk | ChallengeCreateBad;

/**
 * 거부됐는가 — **타입 가드로 쓴다.**
 *
 * 웹 `tsconfig`는 `strict: false`라 `if (!parsed.ok)`만으로는 판별 합집합이
 * 좁혀지지 않는다(`strictNullChecks`가 꺼져 있으면 boolean 리터럴 판별이
 * 동작하지 않는다). `paperScopeFailed`와 같은 이유로 여기 하나를 둔다.
 */
export function challengeCreateRejected(p: ChallengeCreateParse): p is ChallengeCreateBad {
  return !p || p.ok !== true;
}

/** 시작금 상한. 무한대를 넣어 수익률 화면을 깨뜨리지 못하게 한다. */
export const MAX_INITIAL_EQUITY = 10_000_000;
/** 기간 상한·하한 (일). 하루보다 짧으면 만료 유예(L)와 구별되지 않는다. */
export const MIN_DURATION_DAYS = 1;
export const MAX_DURATION_DAYS = 365;

function num(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) return Number(v);
  return NaN;
}

/**
 * 요청 본문 → 챌린지 파라미터.
 *
 * **모르는 값을 기본값으로 채우지 않는다.** 시작금이 없으면 10000으로
 * 가정하지 않고 거부한다 — 가정한 금액 위에 쌓인 성적표는 아무 뜻이 없다.
 */
export function parseChallengeCreate(body: any): ChallengeCreateParse {
  const initial = num(body?.initialEquity);
  if (!Number.isFinite(initial) || initial <= 0) {
    return { ok: false, code: 'INITIAL_EQUITY', reason: '시작금은 0보다 커야 합니다' };
  }
  if (initial > MAX_INITIAL_EQUITY) {
    return {
      ok: false, code: 'INITIAL_EQUITY',
      reason: `시작금이 너무 큽니다 (최대 ${MAX_INITIAL_EQUITY})`,
    };
  }

  const target = num(body?.targetEquity);
  if (!Number.isFinite(target) || target <= initial) {
    return { ok: false, code: 'TARGET_EQUITY', reason: '목표 금액은 시작금보다 커야 합니다' };
  }

  // 실패선은 선택이다. **주지 않은 것과 0은 다르다** — 0은 "전액을 잃을
  // 때까지 계속"이라는 뜻이고, 없음은 실패선을 두지 않는다는 뜻이다.
  let failure: number | null = null;
  if (body?.failureEquity != null && body?.failureEquity !== '') {
    const f = num(body.failureEquity);
    if (!Number.isFinite(f) || f < 0 || f >= initial) {
      return {
        ok: false, code: 'FAILURE_EQUITY',
        reason: '실패선은 0 이상이고 시작금보다 작아야 합니다',
      };
    }
    failure = f;
  }

  const days = num(body?.durationDays);
  if (!Number.isFinite(days) || !Number.isInteger(days)
      || days < MIN_DURATION_DAYS || days > MAX_DURATION_DAYS) {
    return {
      ok: false, code: 'DURATION',
      reason: `기간은 ${MIN_DURATION_DAYS}일 이상 ${MAX_DURATION_DAYS}일 이하의 정수여야 합니다`,
    };
  }

  return {
    ok: true,
    params: { initialEquity: initial, targetEquity: target, failureEquity: failure, durationDays: days },
  };
}

/**
 * 기간의 끝 — **시작 시각에서 계산한다.**
 *
 * 시작 시각은 이 요청의 사건 시각이고, 그것은 서버가 만든다. 여기서 다시
 * `Date.now()`를 읽지 않는다 — 읽으면 원장에 적히는 시각과 기간의 기준이
 * 미세하게 어긋나고, 그 차이가 경계에서 만료 판정을 가른다.
 */
export function challengeEndsAt(startsAtIso: string, durationDays: number): string {
  const t = Date.parse(startsAtIso);
  if (!Number.isFinite(t)) {
    throw new Error('challengeEndsAt: 시작 시각을 읽지 못했습니다');
  }
  return new Date(t + durationDays * 24 * 60 * 60 * 1000).toISOString();
}

// ══════════════ 취소 결과 ══════════════

/** `087`의 `paper_challenge_cancel`이 돌려주는 코드와 같은 집합이어야 한다. */
export type ChallengeCancelCode =
  | 'CLOSING' | 'ALREADY_CLOSING' | 'INTENT_FROZEN' | 'ALREADY_CLOSED' | 'NOT_FOUND';

export const CHALLENGE_CANCEL_CODES: ChallengeCancelCode[] =
  ['CLOSING', 'ALREADY_CLOSING', 'INTENT_FROZEN', 'ALREADY_CLOSED', 'NOT_FOUND'];

export interface ChallengeCancelView {
  /** HTTP status */
  http: number;
  /** 성공으로 적을 것인가. **얼어 있는 다른 사유를 성공으로 적지 않는다** */
  ok: boolean;
  message: string;
}

/**
 * 취소 결과를 화면이 읽을 수 있는 모양으로.
 *
 * **다시 누른 것은 실패가 아니다.** 이미 CANCELLED로 얼어 있으면 같은 답을
 * 준다(멱등). 반대로 목표 달성이나 만료가 먼저 정해졌으면 **취소했다고
 * 적지 않는다** — 사용자가 "달성했는데 취소로 기록된" 화면을 보게 두지
 * 않는다.
 */
export function challengeCancelView(
  code: string | null | undefined,
  intent?: string | null,
): ChallengeCancelView {
  switch (code) {
    case 'CLOSING':
      return { http: 200, ok: true, message: '챌린지를 취소했습니다 — 남은 포지션을 정리한 뒤 마감됩니다' };
    case 'ALREADY_CLOSING':
      return { http: 200, ok: true, message: '이미 취소된 챌린지입니다 — 정리 중입니다' };
    case 'INTENT_FROZEN':
      return {
        http: 409, ok: false,
        message: intent === 'TARGET_REACHED'
          ? '이미 목표를 달성해 마감 중입니다 — 취소로 바꾸지 않았습니다'
          : intent === 'EXPIRED'
            ? '이미 기간이 끝나 마감 중입니다 — 취소로 바꾸지 않았습니다'
            : intent === 'FAILED'
              ? '이미 실패선에 닿아 마감 중입니다 — 취소로 바꾸지 않았습니다'
              : `이미 다른 사유로 마감 중입니다 (${intent || '알 수 없음'}) — 취소로 바꾸지 않았습니다`,
      };
    case 'ALREADY_CLOSED':
      return { http: 409, ok: false, message: '이미 끝난 챌린지입니다' };
    case 'NOT_FOUND':
      return { http: 404, ok: false, message: '챌린지를 찾지 못했습니다' };
    default:
      // **모르는 코드를 성공으로 적지 않는다.**
      return {
        http: 500, ok: false,
        message: `취소 결과를 읽지 못했습니다 (${code || '없음'}) — 취소됐다는 뜻이 아닙니다`,
      };
  }
}

// ══════════════ 화면이 읽는 모양 ══════════════

export interface ChallengeView {
  id: string;
  status: string;
  closeIntent: string | null;
  terminalStatus: string | null;
  initialEquity: number;
  targetEquity: number;
  failureEquity: number | null;
  startsAt: string | null;
  endsAt: string | null;
  closedAt: string | null;
  /** **못 읽으면 null이다 — 0으로 적지 않는다.** 0은 "전액을 잃었다"로 읽힌다 */
  balance: number | null;
  /** 잔고를 모르면 null */
  returnPct: number | null;
  /** 지금 주문을 받는가 (RUNNING만) */
  ordersAllowed: boolean;
}

function maybeNum(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 챌린지 한 줄 → 화면이 읽는 값.
 *
 * **계좌 id를 내보내지 않는다.** 밖으로 나가면 다음 요청이 그 값을 다시
 * 보내게 되고, 그 순간 `challengeId` 하나만 받는다는 계약이 깨진다.
 */
export function challengeView(row: any, balance: number | null): ChallengeView {
  const initial = Number(row?.initial_equity);
  const bal = maybeNum(balance);
  return {
    id: String(row?.id ?? ''),
    status: String(row?.status ?? ''),
    closeIntent: row?.close_intent != null ? String(row.close_intent) : null,
    terminalStatus: row?.terminal_status != null ? String(row.terminal_status) : null,
    initialEquity: initial,
    targetEquity: Number(row?.target_equity),
    failureEquity: maybeNum(row?.failure_equity),
    startsAt: row?.starts_at != null ? String(row.starts_at) : null,
    endsAt: row?.ends_at != null ? String(row.ends_at) : null,
    closedAt: row?.closed_at != null ? String(row.closed_at) : null,
    balance: bal,
    returnPct: bal != null && Number.isFinite(initial) && initial > 0
      ? ((bal - initial) / initial) * 100
      : null,
    ordersAllowed: String(row?.status ?? '') === 'RUNNING',
  };
}
