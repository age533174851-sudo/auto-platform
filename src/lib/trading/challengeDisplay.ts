// src/lib/trading/challengeDisplay.ts
//
// **끝난 이유를 화면이 다시 판단하지 않는다.**
//
// 무엇을 막는가
// ─────────────
// 챌린지는 목표에 **처음 닿는 순간** 사유가 `TARGET_REACHED`로 얼어붙는다
// (`083`의 트리거와 `paperChallenge.freezeCloseIntent`). 그 뒤에 남은
// 포지션을 강제청산하면서 손실이 나면 최종 잔고가 목표 아래로 내려갈 수
// 있다 — 그래도 **달성은 달성이다.**
//
// 화면이 여기서 실수하기 쉽다. "잔고 < 목표니까 실패"라고 색을 칠하는 순간,
// DB가 애써 얼려 둔 사실을 UI가 뒤집는다. 사용자는 달성한 챌린지를 실패로
// 본다.
//
// 그래서 이 파일은 **잔고를 보지 않는다.** 판정의 입력은 `terminalStatus`와
// `closeIntent`뿐이고, 잔고는 인자로 들어올 자리조차 없다 — 검사기로 막는
// 것보다 통로를 없애는 쪽이 낫다.

export type ChallengeTone = 'RUNNING' | 'WIN' | 'LOSS' | 'NEUTRAL' | 'UNKNOWN';

export interface ChallengeStatusView {
  /** 상태 한 낱말 */
  label: string;
  /** 왜 끝났는가. 아직 안 끝났으면 null */
  intentLabel: string | null;
  /** 색을 정할 때 쓰는 값. **잔고가 아니라 사유에서 나온다** */
  tone: ChallengeTone;
  /** 지금 주문을 받는가 */
  ordersAllowed: boolean;
  /** 사용자에게 보여 줄 한 줄 */
  detail: string;
}

const STATUS_LABEL: Record<string, string> = {
  READY: '시작 전',
  RUNNING: '진행 중',
  CLOSING: '정리 중',
  CLOSED: '종료',
};

const INTENT_LABEL: Record<string, string> = {
  TARGET_REACHED: '목표 달성',
  EXPIRED: '기간 만료',
  FAILED: '실패선 도달',
  CANCELLED: '사용자 취소',
};

/**
 * 사유의 성격. **달성은 잔고와 무관하게 성공이다.**
 *
 * 취소와 만료는 성공도 실패도 아니다 — 중립으로 둔다. 만료를 실패로 칠하면
 * "기간을 다 채운 것"이 나쁜 일로 보이고, 성공으로 칠하면 달성과 구별되지
 * 않는다.
 */
export function intentTone(intent: string | null | undefined): ChallengeTone {
  if (intent === 'TARGET_REACHED') return 'WIN';
  if (intent === 'FAILED') return 'LOSS';
  if (intent === 'EXPIRED' || intent === 'CANCELLED') return 'NEUTRAL';
  if (intent == null || intent === '') return 'NEUTRAL';
  // 모르는 사유를 성공으로도 실패로도 적지 않는다
  return 'UNKNOWN';
}

/**
 * 챌린지 한 건의 표시.
 *
 * **잔고를 받지 않는다.** 받으면 언젠가 "잔고가 목표보다 낮으니 실패"라는
 * 줄이 여기 붙고, 그 순간 동결된 사유가 화면에서 뒤집힌다.
 */
export function challengeStatusView(i: {
  status: string | null | undefined;
  closeIntent?: string | null;
  terminalStatus?: string | null;
}): ChallengeStatusView {
  const status = String(i?.status ?? '');
  // **최종 사유가 있으면 그것이 정본이다.** `terminal_status`는 finalizer가
  // 동결된 `close_intent`를 그대로 옮긴 값이다(`086`).
  const intent = (i?.terminalStatus ?? i?.closeIntent) || null;

  const label = STATUS_LABEL[status] ?? `알 수 없음 (${status || '없음'})`;
  const intentLabel = intent ? (INTENT_LABEL[intent] ?? `알 수 없는 사유 (${intent})`) : null;
  const ordersAllowed = status === 'RUNNING';

  if (status === 'RUNNING') {
    return { label, intentLabel, tone: 'RUNNING', ordersAllowed,
      detail: '이 챌린지 계좌로 주문할 수 있습니다' };
  }
  if (status === 'READY') {
    return { label, intentLabel, tone: 'NEUTRAL', ordersAllowed,
      detail: '아직 시작하지 않았습니다 — 시작 후에 주문할 수 있습니다' };
  }
  if (status === 'CLOSING') {
    return {
      label, intentLabel, tone: intentTone(intent), ordersAllowed,
      detail: intentLabel
        ? `${intentLabel}으로 마감 중입니다 — 남은 포지션을 정리하면 끝납니다`
        : '정리 중입니다',
    };
  }
  if (status === 'CLOSED') {
    return {
      label, intentLabel, tone: intentTone(intent), ordersAllowed,
      detail: intentLabel ? `${intentLabel}으로 끝났습니다` : '끝났습니다',
    };
  }
  // 모르는 상태에서 주문을 열지 않는다
  return { label, intentLabel, tone: 'UNKNOWN', ordersAllowed: false,
    detail: '상태를 확인하지 못했습니다' };
}

/**
 * 목표까지 얼마나 왔는가 — **진행 표시 전용이다.**
 *
 * 이 값으로 달성 여부를 판단하지 않는다. 달성은 서버가 실현 잔고로
 * 판정해 사유를 얼리고, 화면은 그 사유만 읽는다.
 *
 * 읽을 수 없는 값이 하나라도 있으면 **null이다 — 0%로 적지 않는다.**
 */
export function challengeProgressPct(i: {
  balance: number | null | undefined;
  initialEquity: number | null | undefined;
  targetEquity: number | null | undefined;
}): number | null {
  // **`Number(null)`은 0이다.** 그냥 `Number()`로 접으면 "못 읽었다"가
  // 0%로 새어 나가고, 화면은 "목표까지 하나도 못 왔다"로 읽는다 —
  // 확인하지 못한 것을 통과로 세는 그 고장이다. 시험이 이걸 잡았다.
  const num = (v: any): number => (v == null || v === '' ? NaN : Number(v));
  const bal = num(i?.balance);
  const init = num(i?.initialEquity);
  const tgt = num(i?.targetEquity);
  if (!Number.isFinite(bal) || !Number.isFinite(init) || !Number.isFinite(tgt)) return null;
  const span = tgt - init;
  if (!(span > 0)) return null;
  const pct = ((bal - init) / span) * 100;
  // 목표를 넘겨도 100을 넘겨 적지 않고, 아래로 빠져도 0 아래로 적지 않는다.
  // 막대를 그리는 값이지 성적이 아니다.
  return Math.max(0, Math.min(100, pct));
}

/** 남은 기간. 못 읽으면 null — "0일"로 적지 않는다. */
export function challengeDaysLeft(endsAt: string | null | undefined, nowMs?: number): number | null {
  if (!endsAt) return null;
  const t = Date.parse(String(endsAt));
  if (!Number.isFinite(t)) return null;
  const now = Number.isFinite(nowMs as number) ? (nowMs as number) : Date.now();
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}
