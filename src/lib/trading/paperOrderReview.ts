// src/lib/trading/paperOrderReview.ts
//
// **모의 진입 주문을 보내기 전에 읽어 주는 층 — 새 판정이 아니다.**
//
// 무엇을 하는가
// ─────────────
// `useTradeForm` → `planSizing` → `buildPaperPlan`이 **이미 계산해 둔 것**을
// 제출 직전에 한 번 보여 준다. 숫자를 여기서 만들지 않는다. 만들기 시작하면
// 미리보기와 실제 주문이 갈리고, 그 차이는 체결된 뒤에 보인다.
//
// ★ `/api/orders/preflight`가 아니다
// ──────────────────────────────────
// 저장소에 이미 `preTradeChecklist` · `PreTradeChecklist` ·
// `/api/orders/preflight`가 있다. 그것은 **운영 경로**의 검사다 — 운영 모드 ·
// 거래소 상태 · position mode · 재대조 · 일/주간 손실 제한. 모의 주문 확인에
// 그것을 붙이면 두 가지가 동시에 망가진다:
//
//   ⑴ 모의 화면이 운영 판정을 받아 "안전하다"는 착각을 준다
//   ⑵ 운영 검사가 모의 경로의 요구로 끌려다닌다
//
// 그래서 이름부터 분리한다. 이 파일은 `preflight`를 import하지 않고,
// 검사기가 그것을 강제한다.
//
// ★ 없는 값을 0으로 적지 않는다
// ─────────────────────────────
// `buildPaperPlan`은 실패하면 `notional` · `requiredMargin` · `entryFee`를
// **0으로 채운 결과**를 돌려준다(`no()` 헬퍼). 그 0은 "0원이다"가 아니라
// "계산하지 못했다"이다. 그대로 화면에 적으면 수수료 0원짜리 주문으로
// 보인다. 청산가도 같다 — `plan.plan.liquidationPrice`는 못 구했을 때 0이고,
// `plan.liquidationPrice`만 null을 유지한다.
//
// 그래서 값은 **아는 것과 모르는 것으로 갈라서** 내보낸다. 화면은 모르는
// 것에 `—`와 사유를 적는다.
import type { MarginMode } from '../engine/paperPlan';

// ══════════════ 상태 ══════════════
//
// bool 하나로 "확인 중인가"를 표현하면 **보내는 중**과 구별되지 않는다.
// 둘은 다른 상태다: 확인 중에는 닫을 수 있고, 보내는 중에는 닫을 수 없다.
export type ReviewPhase = 'NONE' | 'REVIEW' | 'SUBMITTING';

/**
 * 확인 시트가 **붙잡은** 주문의 정체.
 *
 * 시트를 열어 둔 채로 종목이나 방향이 바뀌면, 사용자가 읽은 주문과 실제로
 * 나가는 주문이 달라진다. 그래서 열 때의 정체를 들고 있다가 확인 순간에
 * 다시 맞춰 본다.
 */
export interface ReviewTicket {
  market: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
}

export function ticketKey(t: ReviewTicket | null): string {
  return t ? `${t.market}:${t.symbol}:${t.side}` : 'NONE';
}

export function sameTicket(a: ReviewTicket | null, b: ReviewTicket | null): boolean {
  return a != null && b != null && ticketKey(a) === ticketKey(b);
}

// ══════════════ 표시값 ══════════════

export type ReviewRowKey =
  | 'MARKET' | 'SYMBOL' | 'SIDE' | 'ORDER_TYPE'
  | 'REFERENCE_PRICE'
  | 'QUANTITY' | 'NOTIONAL'
  | 'MARGIN_MODE' | 'LEVERAGE'
  | 'REQUIRED_MARGIN' | 'ENTRY_FEE'
  | 'LIQUIDATION_PRICE' | 'LIQUIDATION_DISTANCE';

/**
 * 한 칸의 값.
 *
 * `UNKNOWN`이 **0과 다른 것**이 이 타입의 존재 이유다. 화면이 `?? 0`을
 * 쓰지 못하게 하려면 타입에서 0이 될 수 없어야 한다.
 */
export type ReviewValue =
  | { kind: 'TEXT'; text: string }
  /** 통화 금액 — 화면이 장부 범위(`MoneyScope`)에 맞춰 적는다 */
  | { kind: 'MONEY'; amount: number }
  | { kind: 'QTY'; amount: number }
  | { kind: 'PRICE'; amount: number }
  | { kind: 'PERCENT'; amount: number }
  /** 확인하지 못했다. **0이 아니다** */
  | { kind: 'UNKNOWN'; reason: string };

export interface ReviewRow {
  key: ReviewRowKey;
  label: string;
  value: ReviewValue;
}

/**
 * 시트가 읽는 계획. `PaperPlanResult`의 **부분집합**이다 — 이 모듈은
 * 계획을 만들지 않고 읽기만 하므로 필요한 칸만 받는다.
 */
export interface ReviewPlan {
  ok: boolean;
  reason?: string;
  notional: number;
  requiredMargin: number;
  entryFee: number;
  /** 못 구했으면 null. **0이 아니다** */
  liquidationPrice: number | null;
  /** 정본 계획. 없으면 청산 거리도 없다 */
  plan?: { liquidationDistancePct: number } | null;
}

export interface ReviewInput {
  /** 내부 시장 id (`'USDM'`) */
  market: string;
  /** 사람이 읽는 시장 이름 (`capability().label`) — 화면이 지어내지 않는다 */
  marketLabel: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** 이 시장의 방향 말 (`LONG`/`SHORT`, 현물이면 `BUY`/`SELL`) */
  sideLabel: string;
  /** 주문 방식. 모의 장부는 시장가뿐이다 */
  orderTypeLabel: string;
  /**
   * ★ 미리보기 기준가. **폼이 내보낸 값을 그대로 받는다.**
   *
   * `notional / quantity`로 되만들면 안 된다 — 수량이 격자에 맞춰 잘린
   * 뒤에는 그 나눗셈이 기준가가 아니라 평균가가 되고, 둘은 다른 값이다.
   */
  referencePrice: number | null;
  quantity: number | null;
  leverage: number | null;
  marginMode: MarginMode | null;
  plan: ReviewPlan;
}

/**
 * 청산까지 거리 — **정본 계획이 낸 값 하나.**
 *
 * ★ `leverageMath.liquidationDistancePct(lev)`를 쓰면 안 된다. 같은 화면에
 *   두 숫자가 생긴다:
 *
 *     leverageMath   기본 MMR 0.4% · **배율만** 본다
 *     buildPaperPlan 기본 MMR 0.5% · 교차(CROSS)에서는 수량·지갑잔고까지 본다
 *
 *   격리 10배만 해도 9.6% 대 9.5%로 갈리고, 교차에서는 정본이
 *   `liquidationPrice=null`인데 배율식은 유한한 숫자를 내놓는다. 확인 창을
 *   열기 전과 연 뒤의 "청산까지"가 달라지면 사용자는 어느 쪽을 믿어야 할지
 *   알 수 없다.
 *
 *   청산가가 없으면 거리도 없다. **0%는 "이미 청산됐다"로 읽힌다.**
 */
export function planLiquidationDistancePct(
  plan: Pick<ReviewPlan, 'liquidationPrice' | 'plan'>,
): number | null {
  if (plan.liquidationPrice == null) return null;
  const d = plan.plan?.liquidationDistancePct;
  return typeof d === 'number' && Number.isFinite(d) ? d : null;
}

const unknown = (reason: string): ReviewValue => ({ kind: 'UNKNOWN', reason });

/** 계산하지 못한 계획의 0을 값으로 읽지 않는다 */
function planned(plan: ReviewPlan, amount: number): ReviewValue {
  if (!plan.ok) return unknown(plan.reason || '주문 계획을 만들지 못했습니다');
  if (!Number.isFinite(Number(amount))) return unknown('값을 확인하지 못했습니다');
  return { kind: 'MONEY', amount: Number(amount) };
}

/**
 * 시트에 적을 줄들. **순서가 곧 화면 순서다.**
 *
 * 한 곳에서 만드는 이유: 값이 어디서 왔는지를 시험이 한 번에 확인할 수
 * 있어야 하고, 화면이 칸마다 다른 출처를 쓰기 시작하면 그중 하나가 폼과
 * 어긋나도 아무도 모른다.
 */
export function reviewRows(i: ReviewInput): ReviewRow[] {
  const rows: ReviewRow[] = [
    { key: 'MARKET', label: '시장', value: { kind: 'TEXT', text: i.marketLabel } },
    { key: 'SYMBOL', label: '종목', value: { kind: 'TEXT', text: i.symbol } },
    { key: 'SIDE', label: '방향', value: { kind: 'TEXT', text: i.sideLabel } },
    { key: 'ORDER_TYPE', label: '주문 방식', value: { kind: 'TEXT', text: i.orderTypeLabel } },
    {
      key: 'REFERENCE_PRICE', label: '미리보기 기준가',
      value: i.referencePrice == null || !Number.isFinite(Number(i.referencePrice))
        ? unknown('시세를 확인하지 못했습니다')
        : { kind: 'PRICE', amount: Number(i.referencePrice) },
    },
    {
      key: 'QUANTITY', label: '수량',
      value: i.quantity == null || !Number.isFinite(Number(i.quantity))
        ? unknown('수량을 확인하지 못했습니다')
        : { kind: 'QTY', amount: Number(i.quantity) },
    },
    { key: 'NOTIONAL', label: '명목가', value: planned(i.plan, i.plan.notional) },
    {
      key: 'MARGIN_MODE', label: '증거금 방식',
      value: i.marginMode == null
        ? unknown('증거금 방식을 확인하지 못했습니다')
        : { kind: 'TEXT', text: i.marginMode === 'ISOLATED' ? '격리' : '교차' },
    },
    {
      key: 'LEVERAGE', label: '레버리지',
      value: i.leverage == null || !Number.isFinite(Number(i.leverage))
        ? unknown('배율을 확인하지 못했습니다')
        : { kind: 'TEXT', text: `${Number(i.leverage)}배` },
    },
    { key: 'REQUIRED_MARGIN', label: '필요 증거금', value: planned(i.plan, i.plan.requiredMargin) },
    { key: 'ENTRY_FEE', label: '예상 진입 수수료', value: planned(i.plan, i.plan.entryFee) },
    {
      key: 'LIQUIDATION_PRICE', label: '청산가',
      // ★ `plan.plan.liquidationPrice`를 쓰지 않는다 — 그쪽은 못 구했을 때
      //   0이다. null을 유지하는 것은 `plan.liquidationPrice` 하나뿐이다.
      value: i.plan.liquidationPrice == null
        ? unknown('청산가를 계산하지 못했습니다')
        : { kind: 'PRICE', amount: Number(i.plan.liquidationPrice) },
    },
    {
      key: 'LIQUIDATION_DISTANCE', label: '청산까지',
      // ★ 정보줄과 **같은 함수**를 쓴다. 두 곳이 각자 계산하면 확인 창을
      //   열기 전과 연 뒤의 숫자가 달라진다.
      value: (() => {
        const d = planLiquidationDistancePct(i.plan);
        return d == null
          ? unknown('청산가가 없어 거리를 낼 수 없습니다')
          : { kind: 'PERCENT' as const, amount: d };
      })(),
    },
  ];
  return rows;
}

/**
 * 화면 숫자를 약속으로 읽지 않게 하는 문장.
 *
 * 서버는 제출 시점에 `readPaperMarkPrice()`로 가격을 **다시** 읽는다.
 * 그래서 여기 적힌 가격은 확정 체결가가 아니다. 이 문장을 화면마다
 * 다르게 적으면 어딘가는 빠진다.
 */
/**
 * 모의 장부가 보낼 수 있는 **유일한** 주문 방식.
 *
 * 능력표의 `TYPE_MARKET`은 지원, `TYPE_LIMIT`은 미지원이다. 그 사실이
 * 바뀌기 전에 이 글자만 바뀌면 화면이 거짓말을 한다 — 검사기가 둘을
 * 같이 본다.
 */
export const PAPER_ORDER_TYPE_LABEL = '시장가';

export const REVIEW_SERVER_RECALC_NOTE =
  '최종 가격·허용 수량은 주문 제출 시 서버가 다시 계산합니다.';

// ══════════════ 확인 버튼 판정 ══════════════

export type ConfirmAction = 'NONE' | 'SUBMIT';

export interface ConfirmVerdictInput {
  phase: ReviewPhase;
  /** 시트를 열 때 붙잡은 주문 */
  opened: ReviewTicket | null;
  /** 지금 폼이 다루는 주문 */
  current: ReviewTicket | null;
  /**
   * ★ **지금 화면이 진입인가.** 창을 열어 둔 채 뒤에서 청산 탭으로
   *   바꿀 수 있다(키보드·프로그램). 그때도 확인 버튼이 살아 있으면
   *   청산 화면에서 진입 주문이 나간다 — `#284`가 막은 고장의 다음 판이다.
   */
  intentOpen: boolean;
  gateReady: boolean;
  busy: boolean;
}

export interface ConfirmVerdict {
  /** 꺼져 있는가. **색 · DOM · 클릭이 이 값 하나를 본다** */
  off: boolean;
  action: ConfirmAction;
  reason: string | null;
}

/**
 * ★ 확인 버튼도 판정 하나다.
 *
 * `form.submit()`이 스스로 `gate`와 `busy`를 다시 막지만, **화면이 거짓으로
 * "보낼 수 있다"고 보여 주는 것**은 그것으로 막히지 않는다. 눌러도 아무 일도
 * 없는 버튼은 사용자가 주문이 나갔는지 아닌지 모르게 만든다.
 *
 * 순서가 뜻을 갖는다 — 먼저 걸린 사유가 사용자에게 보여야 하는 사유다.
 */
export function confirmVerdict(i: ConfirmVerdictInput): ConfirmVerdict {
  const offReason =
    i.phase === 'SUBMITTING' || i.busy ? '주문을 보내는 중입니다'
    : i.phase !== 'REVIEW' ? '주문 확인 중이 아닙니다'
    : !i.intentOpen ? '청산 화면입니다 — 진입 주문은 여기서 보내지 않습니다'
    : !sameTicket(i.opened, i.current)
      ? '확인하던 주문과 지금 주문이 다릅니다 — 닫고 다시 확인하세요'
    : !i.gateReady ? '아직 주문을 보낼 수 없습니다'
    : null;

  if (offReason) return { off: true, action: 'NONE', reason: offReason };
  return { off: false, action: 'SUBMIT', reason: null };
}

/**
 * 시트를 **열어도 되는가.**
 *
 * 여는 것 자체에는 부수효과가 없지만, 열 수 없는 상태에서 열리면 사용자는
 * 보낼 수 있는 주문이라고 읽는다. 그리고 `CLOSE` 탭에서 열리면 그것이 바로
 * 직전 hotfix가 막은 고장(청산 화면에서 진입 주문)의 다음 판이다.
 */
export function canOpenReview(i: {
  phase: ReviewPhase; ctaAction: string; ticket: ReviewTicket | null;
}): boolean {
  if (i.phase !== 'NONE') return false;
  if (i.ctaAction !== 'OPEN_REVIEW') return false;
  return i.ticket != null && !!i.ticket.symbol;
}

// ══════════════ 흐름 — **순수 상태 기계** ══════════════
//
// 왜 훅 안에 두지 않는가
// ──────────────────────
// "취소하면 주문이 안 나간다" · "확인을 두 번 눌러도 한 번만 나간다" ·
// "여는 것만으로는 아무 요청도 안 나간다" — 전부 **순서에 관한 사실**이다.
// 이것을 `useState` 안에 두면 시험이 닿지 못하고, 검사기는 낱말만 본다.
// 이 저장소가 인증 복구(`recoveryPhaseOf`)에서 같은 이유로 한 번 옮겼다.
//
// 그래서 상태와 전이를 여기 두고, 훅은 껍데기가 된다.
// **주문 제출이 만들어지는 자리는 이 파일의 `reviewReduce` 한 곳뿐이다.**

export interface ReviewState {
  /** 시트가 붙잡은 주문. 닫혀 있으면 null */
  opened: ReviewTicket | null;
  /** 확인을 눌러 제출이 나갔는가 (응답 대기) */
  sent: boolean;
}

export const REVIEW_CLOSED: ReviewState = { opened: null, sent: false };

export interface ReviewEnv {
  /** 지금 폼이 다루는 주문 */
  current: ReviewTicket | null;
  gateReady: boolean;
  busy: boolean;
  /**
   * 지금 진입 화면인가. **실제 화면 상태에서 와야 한다** — 상수 `true`를
   * 박아 두면 시험은 초록인데 제품은 이 조건을 한 번도 받지 못한다.
   */
  intentOpen: boolean;
}

export type ReviewEvent =
  /**
   * 확인 창을 연다. **실행 버튼이 받은 판정을 그대로 들고 온다** —
   * 여기서 `ctaVerdict`를 한 번 더 부르면 입력이 다른 두 번째 판정이
   * 생기고, 버튼은 꺼져 있는데 창은 열리는 상태가 만들어진다.
   */
  | { type: 'OPEN'; ctaAction: string }
  | { type: 'CANCEL' }
  | { type: 'CONFIRM' }
  /** 주문 결과가 왔다 */
  | { type: 'RESULT'; ok: boolean }
  /** 둘러싼 문맥이 바뀌었다 — 종목·방향 또는 진입/청산 */
  | { type: 'CONTEXT' };

/**
 * 이 전이가 **실제로 일으키는 일.**
 *
 * `'SUBMIT'` 하나뿐이다. 조회도 예약도 없다 — 확인 시트를 여는 것으로
 * 서버에 아무 흔적도 남지 않아야 한다.
 */
export type ReviewEffect = 'SUBMIT';

export interface ReviewStep {
  state: ReviewState;
  effects: ReviewEffect[];
}

export function reviewPhaseOf(s: ReviewState, busy: boolean): ReviewPhase {
  if (s.opened == null) return 'NONE';
  return (s.sent || busy) ? 'SUBMITTING' : 'REVIEW';
}

const stay = (state: ReviewState): ReviewStep => ({ state, effects: [] });

export function reviewReduce(s: ReviewState, env: ReviewEnv, e: ReviewEvent): ReviewStep {
  const phase = reviewPhaseOf(s, env.busy);

  switch (e.type) {
    case 'OPEN':
      // ★ 여는 것에는 부수효과가 없다.
      if (!canOpenReview({ phase, ctaAction: e.ctaAction, ticket: env.current })) return stay(s);
      if (!env.intentOpen) return stay(s);
      return stay({ opened: env.current, sent: false });

    case 'CANCEL':
      // 보내는 중에는 못 닫는다 — 결과 메시지가 갈 곳이 없어진다.
      if (phase === 'SUBMITTING') return stay(s);
      return stay(REVIEW_CLOSED);

    case 'CONFIRM': {
      // 판정을 여기서 다시 쓰지 않는다. `confirmVerdict` 하나가 정한다.
      const v = confirmVerdict({
        phase, opened: s.opened, current: env.current,
        intentOpen: env.intentOpen, gateReady: env.gateReady, busy: env.busy,
      });
      if (v.action !== 'SUBMIT') return stay(s);
      // `sent`를 **먼저** 세운다. 연타의 두 번째는 위 판정에서 막힌다.
      return { state: { opened: s.opened, sent: true }, effects: ['SUBMIT'] };
    }

    case 'RESULT':
      // 실패면 **열어 둔다.** 닫으면 왜 실패했는지가 사라진다.
      return stay({ opened: e.ok ? null : s.opened, sent: false });

    case 'CONTEXT':
      if (phase === 'SUBMITTING') return stay(s);
      if (s.opened == null) return stay(s);
      // ★ 청산 탭으로 바뀌었으면 **읽던 진입 주문은 더 이상 이 화면의
      //   주문이 아니다.** 창을 그대로 두면 청산 화면 위에 진입 주문이
      //   떠 있는 상태가 된다.
      if (!env.intentOpen) return stay(REVIEW_CLOSED);
      // 읽던 주문과 지금 주문이 다르면 **그대로 두는 것 자체가 거짓말**이다
      if (sameTicket(s.opened, env.current)) return stay(s);
      return stay(REVIEW_CLOSED);

    default:
      return stay(s);
  }
}
