// src/lib/engine/paperOrderTelemetry.ts
//
// **모의 주문이 어디서 막혔는지 셀 수 있게 한다 — 주문 내용은 적지 않는다.**
//
// 왜 필요한가
// ───────────
// 2026-09-15 운영 감사에서 일반 모의투자의 체결이 **30일간 0건**이었다.
// 계좌는 3개 다 있고 기본계좌 0개인 사용자도 없으며, 진입 함수는 20인자
// 하나뿐이고 챌린지는 0개다 — DB 쪽 후보는 전부 지워졌다.
//
// 그런데 **어디서 막혔는지 말해 주는 기록이 한 줄도 없다.** `audit_events`는
// 있지만 모의 주문 경로는 거기에 쓰지 않는다(호출처 4곳: tradingview webhook ·
// safety route · safety/index · auditStore). 그래서 다음에 같은 제보가 와도
// 같은 자리에서 멈춘다.
//
// 무엇을 적나 — **계수에 필요한 최소한**
// ──────────────────────────────────────
//   · 거친 실패 코드(아래 표)   · HTTP status   · 경로 이름   · 서버 시각
//
// 무엇을 적지 않나
// ────────────────
//   user id · 이메일 · 심볼 · 수량/명목가/가격 · position/order id ·
//   요청 본문/쿼리 · JWT/쿠키/헤더 · IP · 스택/예외 원문
//
// **`plan_rejected`의 사유 문구를 적지 않는 이유**가 여기 있다. 그 문구에는
// 수량·배율·가격이 그대로 들어간다(`수량이 유효하지 않습니다 (${i.quantity})`).
// 그래서 사유는 **경로가 이미 아는 사실**로만 가른다 — 마크가를 못 읽었는가,
// 잔고를 모르는가, 그 밖인가. 11개 문구를 억지로 분류하지 않는다.
//
// 이름은 새로 만들지 않았다
// ─────────────────────────
// 아래 코드는 전부 **지금 라우트가 실제로 돌려주는 값**에서 왔다 —
// 종료 지점 10곳과 `openPaperPosition`의 status 열거가 그대로 대응한다.

/** 모의 주문 한 건의 결말. **이 목록은 실제 분기에서 뽑았다** */
export type PaperOrderCode =
  // ── 라우트가 돌려주는 error 값 그대로 ──
  | 'INVALID_JSON'              // 400
  | 'AUTH_REQUIRED'             // 401
  | 'SUPABASE_NOT_CONFIGURED'   // 503
  | 'MISSING_PARAMS'            // 400
  | 'UNSUPPORTED_MARKET'        // 400
  // ── 챌린지 장부를 지정한 주문이 그 장부에 닿기 전에 멈춘 자리 ──
  //    **기본 계좌로 대신 처리하지 않는다.** 그래서 이 셋은 거부이고,
  //    "챌린지가 아닌 주문"으로 조용히 바뀌는 길이 없다.
  | 'CHALLENGE_NOT_FOUND'       // 404  없거나 남의 것이다 (같은 답을 준다)
  | 'CHALLENGE_UNREADABLE'      // 503  조회를 못 했다. '없다'와 다르다
  | 'CHALLENGE_NOT_RUNNING'     // 409  RUNNING이 아니다 (잠그기 전의 관문)
  | 'DAILY_LIMIT'               // 429  실제로 한도에 걸렸다
  | 'DAILY_LIMIT_UNKNOWN'       // 429  확인하지 못해 막았다 (fail-closed)
  // ── plan_rejected를 경로가 아는 사실로만 가른다 ──
  | 'PLAN_NO_MARK_PRICE'        // 400  시세를 못 읽었다
  | 'PLAN_BALANCE_UNKNOWN'      // 400  가용 잔고를 못 읽었다
  | 'PLAN_REJECTED'             // 400  그 밖의 계획 거부 (사유 문구는 안 적는다)
  // ── openPaperPosition의 status 열거 그대로 ──
  | 'DUPLICATE'                 // 409
  | 'OPEN_NO_ACCOUNT'           // 500
  | 'OPEN_INSUFFICIENT_MARGIN'  // 500
  | 'OPEN_CHALLENGE_NOT_RUNNING'// 500
  | 'OPEN_RPC_ERROR'            // 500
  // ── 성공도 센다. **분모가 없으면 실패율을 읽을 수 없다** ──
  | 'OPENED';                   // 200

/** audit_events.result 세 값에 맞춘다 (040이 이미 쓰는 어휘) */
export type PaperOrderResult = 'success' | 'blocked' | 'failed';

/**
 * 막은 것인가 터진 것인가.
 *
 * **일부러 막은 것을 '실패'로 적지 않는다.** 한도·중복·증거금 부족은 안전장치가
 * 제대로 일한 것이고, 그것과 RPC가 터진 것을 같은 칸에 넣으면 나중에 둘을
 * 구분할 수 없다.
 */
export function resultOf(code: PaperOrderCode): PaperOrderResult {
  if (code === 'OPENED') return 'success';
  switch (code) {
    case 'OPEN_RPC_ERROR':
    case 'SUPABASE_NOT_CONFIGURED':
    // 조회 자체를 못 했다. **막은 것이 아니라 못 본 것이다** — 같은 칸에
    // 넣으면 나중에 "안전장치가 일했다"와 "관측이 죽었다"를 못 가른다.
    case 'CHALLENGE_UNREADABLE':
      return 'failed';
    default:
      return 'blocked';
  }
}

/**
 * `openPaperPosition`이 돌려준 status를 코드로 옮긴다.
 *
 * 그 열거는 이미 존재한다 — 여기서 새 이름을 만들지 않는다. 모르는 값이 오면
 * **추측하지 않고** OPEN_RPC_ERROR로 둔다(그 자체가 "모르는 결과"다).
 */
export function openFailureCode(status: string | null | undefined): PaperOrderCode {
  switch (String(status ?? '')) {
    case 'DUPLICATE':              return 'DUPLICATE';
    case 'NO_ACCOUNT':             return 'OPEN_NO_ACCOUNT';
    case 'INSUFFICIENT_MARGIN':    return 'OPEN_INSUFFICIENT_MARGIN';
    case 'CHALLENGE_NOT_RUNNING':  return 'OPEN_CHALLENGE_NOT_RUNNING';
    default:                       return 'OPEN_RPC_ERROR';
  }
}

/**
 * 계획 거부를 **경로가 이미 아는 사실로만** 가른다.
 *
 * 사유 문구는 보지 않는다 — 거기에는 수량·배율·가격이 들어 있다.
 */
export function planRejectionCode(i: {
  markPrice: number | null | undefined;
  available: number | null | undefined;
}): PaperOrderCode {
  const mark = Number(i?.markPrice);
  if (!Number.isFinite(mark) || mark <= 0) return 'PLAN_NO_MARK_PRICE';
  if (i?.available == null || !Number.isFinite(Number(i.available))) return 'PLAN_BALANCE_UNKNOWN';
  return 'PLAN_REJECTED';
}

/** 기록에 넣어도 되는 칸 — **이 셋뿐이다** */
export interface PaperOrderTelemetry {
  code: PaperOrderCode;
  /** HTTP status */
  http: number;
  /** 어느 경로인가 (고정 문자열) */
  route: 'paper_order';
}

/**
 * 적을 것을 만든다.
 *
 * **바깥에서 온 값은 하나도 받지 않는다.** 인자가 코드와 status뿐이라,
 * 실수로 심볼이나 수량을 넣을 자리가 애초에 없다. 이게 이 함수의 요점이다 —
 * 걸러 내는 것보다 **들어올 수 없게 하는 것**이 낫다.
 */
export function paperOrderTelemetry(code: PaperOrderCode, http: number): PaperOrderTelemetry {
  const n = Number(http);
  return { code, http: Number.isFinite(n) ? Math.trunc(n) : 0, route: 'paper_order' };
}

/** 감사 표에 넣을 한 줄. user_id는 **언제나 null**이다 */
export function paperOrderAuditEvent(t: PaperOrderTelemetry): {
  userId: null; action: string; resource: string;
  result: PaperOrderResult; detail: Record<string, any>;
} {
  return {
    // **누가 했는지는 적지 않는다.** 우리가 답해야 하는 질문은 "어디서
    // 막히는가"이지 "누가 막혔는가"가 아니다.
    userId: null,
    action: 'PAPER_ORDER_RESULT',
    resource: t.route,
    result: resultOf(t.code),
    detail: { code: t.code, http: t.http },
  };
}
