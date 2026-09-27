// src/lib/trading/paperCloseReview.ts
//
// **열린 포지션을 닫기 전에 읽어 주는 층.**
//
// 무엇이 문제였나
// ───────────────
// `[전량청산]`이 **한 번의 클릭으로** `/api/paper/close`에 POST했다.
// 되돌릴 수 없는 동작이고, 좁은 화면에서 옆 칸을 누르려다 닿는 자리에
// 있었다. 진입은 Phase 2C에서 확인 창을 거치게 했는데 **청산은 그대로**
// 였다 — 더 위험한 쪽이 더 쉬웠다.
//
// ★ 주문 확인 창과 **합치지 않는다**
// ──────────────────────────────────
// `paperOrderReview`와 모양이 닮았지만 업무가 다르다. 진입은 "무엇을 얼마나
// 살 것인가"를 읽고, 청산은 "이미 가진 것 하나를 닫는다"를 읽는다. 정체성도
// 다르다 — 진입은 `{market, symbol, side}`이고 청산은 **`positionId` 하나**다.
// 하나의 reducer로 합치면 둘 중 하나의 안전조건이 다른 쪽 이름에 가려진다.
// 표현·포커스·inert만 공유하고 판정과 부수효과는 각자 둔다.
//
// ★ 손익을 여기서 만들지 않는다
// ─────────────────────────────
// 이 저장소에는 **열린 포지션의 미실현 손익 정본이 없다.**
// `/api/paper/positions`는 청산된 포지션의 실현 손익만 낸다. 화면에서
// 현재가로 대충 계산하면 수수료 포함 여부·격리/교차·배율 해석이 제각각인
// **세 번째 손익 권위**가 생긴다. 그래서 여기서는 장부가 실제로 준 값만
// 적고, 예상 체결가·예상 실현손익·ROE는 만들지 않는다.
//
// 청산 가격 권위도 그대로 서버다. `/api/paper/close`가 포지션의 시장을 읽고
// `readPaperMarkPrice()`로 다시 조회한다 — 화면은 가격을 **보내지 않는다.**

// ══════════════ 상태 ══════════════

export type CloseReviewPhase = 'NONE' | 'REVIEW' | 'SUBMITTING';

/**
 * 확인 창이 붙잡은 포지션. **정본은 `positionId` 하나다.**
 *
 * 종목으로 잡으면 같은 종목의 다른 포지션과 구별되지 않는다.
 */
export interface CloseTicket {
  positionId: string;
}

export function sameClose(a: CloseTicket | null, b: CloseTicket | null): boolean {
  return a != null && b != null && !!a.positionId && a.positionId === b.positionId;
}

// ══════════════ 표시값 ══════════════

export type CloseRowKey =
  | 'SYMBOL' | 'SIDE' | 'ENTRY_PRICE' | 'QUANTITY'
  | 'LEVERAGE' | 'MARGIN'
  | 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION_PRICE'
  | 'OPENED_AT';

/**
 * 한 칸의 값.
 *
 * `UNKNOWN`이 **0과 다른 것**이 이 타입의 이유다. 손절가가 없는 포지션에
 * `0`을 적으면 "0원에 손절"로 읽힌다.
 */
export type CloseValue =
  | { kind: 'TEXT'; text: string }
  | { kind: 'PRICE'; amount: number }
  | { kind: 'QTY'; amount: number }
  | { kind: 'MONEY'; amount: number }
  | { kind: 'TIME'; iso: string }
  | { kind: 'UNKNOWN'; reason: string };

export interface CloseRow {
  key: CloseRowKey;
  label: string;
  value: CloseValue;
}

/** 장부가 준 포지션 한 줄. `PaperLedgerPosition`의 부분집합이다 */
export interface ClosePositionView {
  id: string;
  symbol: string;
  side: string;
  fillPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  stopLoss: number | null;
  takeProfit: number | null;
  liquidationPrice: number | null;
  openedAt: string | null;
}

const unknown = (reason: string): CloseValue => ({ kind: 'UNKNOWN', reason });

const numberOr = (v: unknown, kind: 'PRICE' | 'QTY' | 'MONEY', reason: string): CloseValue => {
  if (v == null || v === '' || typeof v === 'boolean') return unknown(reason);
  const n = Number(v);
  return Number.isFinite(n) ? { kind, amount: n } : unknown(reason);
};

/**
 * 확인 창에 적을 줄들. **순서가 곧 화면 순서다.**
 *
 * 여기 없는 것은 화면에도 없다 — 특히 예상 실현손익·ROE·예상 체결가는
 * 만들지 않는다(위 주석).
 */
export function closeRows(p: ClosePositionView): CloseRow[] {
  return [
    { key: 'SYMBOL', label: '종목', value: { kind: 'TEXT', text: p.symbol || '—' } },
    { key: 'SIDE', label: '방향', value: { kind: 'TEXT', text: p.side || '—' } },
    {
      key: 'ENTRY_PRICE', label: '진입가',
      value: numberOr(p.fillPrice, 'PRICE', '진입가를 읽지 못했습니다'),
    },
    {
      key: 'QUANTITY', label: '수량',
      value: numberOr(p.quantity, 'QTY', '수량을 읽지 못했습니다'),
    },
    {
      key: 'LEVERAGE', label: '레버리지',
      value: p.leverage == null || !Number.isFinite(Number(p.leverage))
        ? unknown('배율을 읽지 못했습니다')
        : { kind: 'TEXT', text: `${Number(p.leverage)}배` },
    },
    {
      key: 'MARGIN', label: '증거금',
      value: numberOr(p.margin, 'MONEY', '증거금을 읽지 못했습니다'),
    },
    {
      key: 'STOP_LOSS', label: '손절가',
      value: numberOr(p.stopLoss, 'PRICE', '이 포지션에 손절가가 없습니다'),
    },
    {
      key: 'TAKE_PROFIT', label: '익절가',
      value: numberOr(p.takeProfit, 'PRICE', '이 포지션에 익절가가 없습니다'),
    },
    {
      key: 'LIQUIDATION_PRICE', label: '청산가',
      value: numberOr(p.liquidationPrice, 'PRICE', '청산가를 읽지 못했습니다'),
    },
    {
      key: 'OPENED_AT', label: '진입 시각',
      value: p.openedAt
        ? { kind: 'TIME', iso: String(p.openedAt) }
        : unknown('진입 시각을 읽지 못했습니다'),
    },
  ];
}

/**
 * 화면 값을 약속으로 읽지 않게 하는 문장.
 *
 * 서버가 확인 시점에 포지션의 시장을 읽고 `readPaperMarkPrice()`로 가격을
 * 다시 조회한다. 여기 적힌 숫자 어디에도 **청산 체결가는 없다.**
 */
export const CLOSE_SERVER_REPRICE_NOTE =
  '최종 청산 가격은 확인 시 서버가 다시 조회합니다.';

// ══════════════ 요청 본문 — **이 모양 하나뿐이다** ══════════════

/**
 * ★ 청산 요청 본문.
 *
 * `positionId` **하나만** 보낸다. 가격(`exitPrice`·`markPrice`)을 보내면
 * 화면이 유리한 값으로 장부를 만들 수 있고, 계좌(`accountId`·
 * `paperAccountId`)를 보내면 소유권 판단이 화면으로 내려온다. 둘 다 서버가
 * 포지션에서 스스로 찾는다.
 *
 * 함수로 두는 이유: 시험이 **나가는 본문의 열쇠 목록**을 그대로 셀 수 있다.
 */
export function closeRequestBody(positionId: string): { positionId: string } {
  return { positionId: String(positionId) };
}

// ══════════════ 확인 버튼 판정 ══════════════

export type CloseConfirmAction = 'NONE' | 'CLOSE';

export interface CloseConfirmInput {
  phase: CloseReviewPhase;
  /** 창이 붙잡은 포지션 */
  opened: CloseTicket | null;
  /** 지금 장부에 **열려 있는** 포지션 id들 */
  openIds: readonly string[];
  hasAuth: boolean;
  busy: boolean;
}

export interface CloseConfirmVerdict {
  /** 꺼져 있는가. **색 · DOM · 클릭이 이 값 하나를 본다** */
  off: boolean;
  action: CloseConfirmAction;
  reason: string | null;
}

/**
 * 순서가 뜻을 갖는다 — 먼저 걸린 사유가 사용자에게 보여야 하는 사유다.
 *
 * "포지션이 더 이상 열려 있지 않다"가 "로그인이 필요하다"보다 앞이다.
 * 이미 닫힌 것을 다시 닫으라고 로그인을 시킬 수는 없다.
 */
export function closeConfirmVerdict(i: CloseConfirmInput): CloseConfirmVerdict {
  const id = i.opened?.positionId || '';
  const offReason =
    i.phase === 'SUBMITTING' || i.busy ? '청산 요청을 보내는 중입니다'
    : i.phase !== 'REVIEW' || !id ? '청산 확인 중이 아닙니다'
    : !i.openIds.includes(id) ? '포지션이 더 이상 열려 있지 않습니다'
    : !i.hasAuth ? '로그인해야 청산할 수 있습니다'
    : null;

  if (offReason) return { off: true, action: 'NONE', reason: offReason };
  return { off: false, action: 'CLOSE', reason: null };
}

// ══════════════ 흐름 — **순수 상태 기계** ══════════════
//
// "첫 클릭에는 안 나간다" · "취소하면 안 나간다" · "연타해도 한 번" ·
// "사라진 포지션은 못 닫는다"는 전부 순서에 관한 사실이고, `useState` 안에
// 두면 시험이 닿지 못한다.
//
// **청산 요청이 만들어지는 자리는 이 파일의 `closeReviewReduce` 한 곳뿐이다.**

export interface CloseReviewState {
  opened: CloseTicket | null;
  /** 확인을 눌러 요청이 나갔는가 (응답 대기) */
  sent: boolean;
}

export const CLOSE_REVIEW_CLOSED: CloseReviewState = { opened: null, sent: false };

export interface CloseReviewEnv {
  openIds: readonly string[];
  hasAuth: boolean;
  busy: boolean;
}

export type CloseReviewEvent =
  | { type: 'OPEN'; positionId: string }
  | { type: 'CANCEL' }
  | { type: 'CONFIRM' }
  | { type: 'RESULT'; ok: boolean }
  /** 장부가 바뀌었다 */
  | { type: 'LEDGER' };

/**
 * 이 전이가 **실제로 일으키는 일.**
 *
 * `'CLOSE'` 하나뿐이다. 여는 것으로 서버에 아무 흔적도 남지 않아야 한다.
 */
export type CloseReviewEffect = 'CLOSE';

export interface CloseReviewStep {
  state: CloseReviewState;
  effects: CloseReviewEffect[];
}

export function closeReviewPhaseOf(s: CloseReviewState, busy: boolean): CloseReviewPhase {
  if (s.opened == null) return 'NONE';
  return (s.sent || busy) ? 'SUBMITTING' : 'REVIEW';
}

const stay = (state: CloseReviewState): CloseReviewStep => ({ state, effects: [] });

export function closeReviewReduce(
  s: CloseReviewState, env: CloseReviewEnv, e: CloseReviewEvent,
): CloseReviewStep {
  const phase = closeReviewPhaseOf(s, env.busy);

  switch (e.type) {
    case 'OPEN': {
      // ★ 여는 것에는 부수효과가 없다. 조회도 예약도 하지 않는다.
      if (phase !== 'NONE') return stay(s);
      const id = String(e.positionId || '');
      // 장부에 없는 포지션의 확인 창을 열지 않는다 — 열면 "닫을 수 있다"로
      // 읽히고, 그 상태로 확인을 누르면 404가 사용자 잘못처럼 보인다.
      if (!id || !env.openIds.includes(id)) return stay(s);
      return stay({ opened: { positionId: id }, sent: false });
    }

    case 'CANCEL':
      // 보내는 중에는 못 닫는다 — 결과 메시지가 갈 곳이 없어진다.
      if (phase === 'SUBMITTING') return stay(s);
      return stay(CLOSE_REVIEW_CLOSED);

    case 'CONFIRM': {
      // 판정을 여기서 다시 쓰지 않는다. `closeConfirmVerdict` 하나가 정한다.
      const v = closeConfirmVerdict({
        phase, opened: s.opened, openIds: env.openIds,
        hasAuth: env.hasAuth, busy: env.busy,
      });
      if (v.action !== 'CLOSE') return stay(s);
      // `sent`를 **먼저** 세운다. 연타의 두 번째는 위 판정에서 막힌다.
      return { state: { opened: s.opened, sent: true }, effects: ['CLOSE'] };
    }

    case 'RESULT':
      // 실패면 **열어 둔다.** 닫으면 왜 실패했는지가 사라지고 재시도도 못 한다.
      return stay({ opened: e.ok ? null : s.opened, sent: false });

    case 'LEDGER':
      if (phase === 'SUBMITTING') return stay(s);
      if (s.opened == null) return stay(s);
      // 그 포지션이 사라졌다 — 다른 포지션으로 **재사용하지 않는다.**
      if (env.openIds.includes(s.opened.positionId)) return stay(s);
      return stay(CLOSE_REVIEW_CLOSED);

    default:
      return stay(s);
  }
}
