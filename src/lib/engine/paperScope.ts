// src/lib/engine/paperScope.ts
//
// **어느 모의 계좌의 포지션을 보고 있는가 — 한 곳에서 정한다.**
//
// 무엇이 문제였나
// ───────────────
// `081`이 `paper_accounts`를 사용자당 여러 개가 될 수 있게 바꿨고, 읽기
// **다섯 곳**을 `is_default`로 좁혔다. 그런데 좁힌 것은 **계좌 표**뿐이고
// `paper_positions`를 읽는 자리는 **한 곳도 안 좁혔다.** 전부 `user_id`만
// 본다.
//
// 계좌가 하나인 동안은 증상이 없다. 전용 계좌(챌린지 등)가 처음 생기는
// 순간 이렇게 된다:
//
//   가용 증거금   전용 계좌가 물고 있는 증거금이 기본 계좌 예산을 깎는다
//   총자산        지갑에 전용 계좌 포지션이 섞여 보인다
//   위험 판정     일일손실·연속손실에 남의 장부 손익이 들어온다
//   REVERSE       기본 계좌 신호가 **전용 계좌 포지션을 닫는다**
//
// 그리고 더 나쁜 것: `082`의 `paper_open_position` **안**에 있는 용량 검사는
// `user_id AND paper_account_id`로 **정확히 좁혀져 있다.** 즉 미리보기(TS)와
// 최종 판정(SQL)이 서로 다른 예산을 본다 — "경로가 둘인데 한쪽만 고침"이다.
//
// 여기서 하는 일
// ──────────────
// "이 요청이 보는 계좌"를 **한 번** 정하고, 포지션을 읽는 모든 자리가 그
// 값으로 좁힌다. 정하지 못하면 **멈춘다** — 기본 계좌로 슬쩍 넘어가지 않는다.
//
// **폴백이 없다**
// ───────────────
// 계좌를 명시했는데 그 계좌가 이 사용자의 것이 아니면, 기본 계좌로 대신
// 처리하지 않고 거기서 끝낸다. 대신 처리하면 **사용자가 고른 적 없는
// 장부로 주문이 나간다.**
//
// 여기서 좁히지 않는 자리
// ───────────────────────
// **청산 감시(exit-monitor)는 전 계좌를 본다.** 손절·청산가 감시를 기본
// 계좌로 좁히면 전용 계좌 포지션의 손절이 **아무도 안 보게** 된다. 이 감시는
// 포지션 id로 닫고(`paper_settle_close`가 그 포지션의 계좌를 따라간다)
// 계좌를 섞어 합산하지 않으므로 오염 위험이 없다. 안전망은 넓어야 한다.
//
// 포지션 id로 한 줄을 집는 자리도 좁히지 않는다 — 그 줄이 자기 계좌를
// 들고 있으므로 모호하지 않다. 소유자 확인은 그 자리에서 따로 한다.

export interface PaperScopeOk {
  ok: true;
  accountId: string;
  /** 명시적으로 받은 계좌인가, 기본 계좌를 찾은 것인가 */
  source: 'EXPLICIT' | 'DEFAULT';
}

export interface PaperScopeFail {
  ok: false;
  code: PaperScopeFailure;
  reason: string;
}

/** 이 요청이 보는 계좌. **정하지 못하면 ok:false다 — 기본값으로 넘어가지 않는다** */
export type PaperScope = PaperScopeOk | PaperScopeFail;

/**
 * 못 정했는가 — **타입 가드로 쓴다.**
 *
 * 웹 쪽 `tsconfig`는 `strict: false`라 `if (!scope.ok)`만으로는 판별 합집합이
 * 좁혀지지 않는다(`strictNullChecks`가 꺼져 있으면 boolean 리터럴 판별이
 * 동작하지 않는다). 부르는 쪽마다 캐스팅을 흩뿌리는 대신 여기 하나를 둔다.
 */
export function paperScopeFailed(s: PaperScope): s is PaperScopeFail {
  return !s || s.ok !== true;
}

export type PaperScopeFailure =
  /** 사용자를 모른다 */
  | 'NO_USER'
  /** 기본 계좌가 없다 (아직 모의투자를 시작하지 않았다) */
  | 'NO_ACCOUNT'
  /** 지정한 계좌가 이 사용자의 것이 아니다 — **기본 계좌로 대신 처리하지 않는다** */
  | 'NOT_OWNED'
  /** 조회 자체가 실패했다. '없다'와 다르다 */
  | 'UNREADABLE';

/**
 * 무엇을 물어봐야 하는가 — **순수 함수.**
 *
 * DB를 부르기 전에 정해지는 부분만 여기서 정한다. 명시 계좌가 있으면 그것을
 * 확인하고, 없으면 기본 계좌를 찾는다. 두 경로의 분기가 여러 파일에 흩어지면
 * 언젠가 한쪽만 고쳐진다.
 */
export function paperScopePlan(i: {
  userId?: string | null;
  paperAccountId?: string | null;
}): { kind: 'EXPLICIT'; userId: string; accountId: string }
 | { kind: 'DEFAULT'; userId: string }
 | { kind: 'STOP'; code: PaperScopeFailure; reason: string } {
  const userId = typeof i?.userId === 'string' ? i.userId.trim() : '';
  if (!userId) {
    return { kind: 'STOP', code: 'NO_USER', reason: '사용자를 알 수 없어 모의 계좌를 정하지 못했습니다' };
  }
  const explicit = typeof i?.paperAccountId === 'string' ? i.paperAccountId.trim() : '';
  if (explicit) return { kind: 'EXPLICIT', userId, accountId: explicit };
  return { kind: 'DEFAULT', userId };
}

/**
 * 이 요청이 보는 계좌를 정한다.
 *
 * **명시 계좌는 소유자까지 확인한다.** 남의 계좌 id를 넣어도 여기서 멈춘다.
 * 못 찾았을 때 기본 계좌로 넘어가지 않는다 — 그건 사용자가 고른 적 없는
 * 장부다.
 */
export async function resolvePaperScope(
  sb: any,
  userId: string | null | undefined,
  paperAccountId?: string | null,
): Promise<PaperScope> {
  const plan = paperScopePlan({ userId, paperAccountId });
  if (plan.kind === 'STOP') return { ok: false, code: plan.code, reason: plan.reason };
  if (!sb) return { ok: false, code: 'UNREADABLE', reason: '모의 계좌를 조회할 수 없습니다' };

  if (plan.kind === 'EXPLICIT') {
    try {
      // **소유자까지 함께 본다.** id만 보면 남의 계좌가 통과한다.
      const { data, error } = await sb.from('paper_accounts')
        .select('id').eq('id', plan.accountId).eq('user_id', plan.userId).maybeSingle();
      if (error) {
        return { ok: false, code: 'UNREADABLE', reason: '모의 계좌 조회에 실패했습니다' };
      }
      if (!data?.id) {
        return {
          ok: false, code: 'NOT_OWNED',
          reason: '지정한 모의 계좌를 찾지 못했습니다 — 기본 계좌로 대신 처리하지 않습니다',
        };
      }
      return { ok: true, accountId: String(data.id), source: 'EXPLICIT' };
    } catch {
      return { ok: false, code: 'UNREADABLE', reason: '모의 계좌 조회에 실패했습니다' };
    }
  }

  try {
    const { data, error } = await sb.from('paper_accounts')
      .select('id').eq('user_id', plan.userId).eq('is_default', true).maybeSingle();
    if (error) {
      return { ok: false, code: 'UNREADABLE', reason: '모의 계좌 조회에 실패했습니다' };
    }
    if (!data?.id) {
      return {
        ok: false, code: 'NO_ACCOUNT',
        reason: '모의 계좌가 없습니다 — 먼저 모의투자를 시작하세요',
      };
    }
    return { ok: true, accountId: String(data.id), source: 'DEFAULT' };
  } catch {
    return { ok: false, code: 'UNREADABLE', reason: '모의 계좌 조회에 실패했습니다' };
  }
}

/**
 * 기본 계좌 id — 못 찾으면 **null.**
 *
 * 위험 판정처럼 "못 읽으면 모름으로 두는" 자리가 쓴다. `null`을 그대로
 * 질의에 넣으면 안 된다 — 부르는 쪽이 **null이면 질의를 하지 않고** 그 지표를
 * 모름으로 남겨야 한다. 0건으로 읽으면 "오늘 손실이 없다"가 되어 막아야 할
 * 것을 통과시킨다.
 */
export async function defaultPaperAccountId(
  sb: any, userId: string | null | undefined,
): Promise<string | null> {
  const scope = await resolvePaperScope(sb, userId);
  return paperScopeFailed(scope) ? null : scope.accountId;
}
