// src/lib/smoke/smokePlan.ts
//
// **아침 9시를 기다리지 않고 지금 한 바퀴 돌린다.**
//
// 왜 필요한가
// ───────────
// 원본 전략의 판단 창은 하루에 한 번, KST 09:10~09:30 20분뿐이다.
// 그래서 "진입은 되나 · 손절이 실제로 붙나 · 익절이 붙나 · 브라우저를
// 닫아도 청산이 도나 · 고아 주문이 남나"를 확인하려면 **매일 아침
// 한 번씩만** 시도할 수 있었다. 실제로 그렇게 며칠을 썼고, 그 사이
// 어제 사고(수량 2배 · netting 찌꺼기 · 조건부 주문 4개)가 났다.
//
// 스모크 테스트는 그 한 바퀴를 **지금 강제로** 돌린다. 시장 판단은
// 하지 않는다 — 방향은 사람이 고르고, 목적은 "배관이 뚫려 있는가"다.
//
// 절대 섞지 않는 것
// ─────────────────
// 이 거래는 **전략의 성과가 아니다.** 사람이 방향을 고른 10분짜리
// 왕복이고, 승률·손익에 섞이면 전략 평가가 통째로 오염된다.
// 그래서 별도 전략 id로 기록하고 `strategy_cycles`를 건드리지 않는다.
//
// 여기서 새로 만들지 않는 것
// ──────────────────────────
// 진입 관문 · 반전 상태기계 · 소유권 · 실제 체결가 기준 SL/TP ·
// 보호주문 되읽기 · 진입 완료 판정은 **전부 이미 있다**(positionLifecycle ·
// orderOwnership · fillBasedExit · protectiveReadback · entryEvidence).
// 스모크 테스트는 그것들을 **순서대로 부르는 것**이지 다시 짜는 것이 아니다.
// 다시 짜면 스모크에서는 통과하고 실전에서는 막히는 두 벌이 생긴다.

/**
 * 이 거래의 소유 전략.
 *
 * **실제 전략 id가 아니다.** registry에도 없고, 예약도 없고, 원장도 없다.
 * 오직 "이 주문은 스모크 테스트가 냈다"를 표시하는 데만 쓴다.
 */
export const SMOKE_STRATEGY_ID = 'smoke-test';

/** 고를 수 있는 유지 시간(분) */
export const HOLD_CHOICES = [1, 5, 10, 30] as const;
export const DEFAULT_HOLD_MIN = 10;

/** 스모크로 열 수 있는 종목. **아무 종목이나 열지 않는다** */
export const SMOKE_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;

/**
 * 유지 시간의 상한.
 *
 * 브라우저를 닫아도 워커가 닫아 주지만, **워커가 죽으면 아무도 안
 * 닫는다.** 그 위험을 30분으로 묶는다 — 더 길게 들고 있을 이유가
 * 스모크 테스트에는 없다.
 */
export const MAX_HOLD_MIN = 30;

// ── 시작 요청 검사 ───────────────────────────────────

export interface SmokeRequest {
  symbol: string;
  side: 'LONG' | 'SHORT';
  connectionId: string;
  mode: string;
  marginUsd: number;
  leverage: number;
  holdMin: number;
}

export interface SmokeRequestVerdict {
  ok: boolean;
  code: 'OK' | 'NOT_TESTNET' | 'BAD_SYMBOL' | 'BAD_SIDE' | 'BAD_MARGIN'
    | 'BAD_LEVERAGE' | 'BAD_HOLD' | 'NO_CONNECTION';
  request: SmokeRequest | null;
  message: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 시작 요청을 값으로 확정한다.
 *
 * **테스트넷에서만 연다.** 실전 계좌에서 "배관 확인용"으로 진짜 돈을
 * 넣고 10분 뒤에 닫는 것은 스모크 테스트가 아니라 그냥 매매다.
 *
 * 배율은 **낮추지 않는다.** 이 저장소의 규칙이다 — 100배로 도는 배관을
 * 확인하려는 것이므로 5배로 바꿔서 시험하면 확인한 것이 아니다.
 */
export function smokeRequestVerdict(body: any): SmokeRequestVerdict {
  const bad = (code: SmokeRequestVerdict['code'], message: string): SmokeRequestVerdict =>
    ({ ok: false, code, request: null, message });

  const mode = String(body?.mode ?? 'TESTNET').toUpperCase();
  if (mode !== 'TESTNET') {
    return bad('NOT_TESTNET',
      '스모크 테스트는 테스트넷에서만 돕니다 — 실계좌에서 배관 확인용으로 주문을 내지 않습니다');
  }

  const symbol = String(body?.symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!(SMOKE_SYMBOLS as readonly string[]).includes(symbol)) {
    return bad('BAD_SYMBOL', `스모크 테스트로 열 수 있는 종목은 ${SMOKE_SYMBOLS.join(' · ')} 입니다 (받은 값: ${body?.symbol})`);
  }

  const side = String(body?.side ?? '').toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') {
    return bad('BAD_SIDE', `방향은 LONG 또는 SHORT여야 합니다 (받은 값: ${body?.side})`);
  }

  const connectionId = String(body?.connectionId ?? '').trim();
  if (!connectionId) {
    return bad('NO_CONNECTION', '거래소 연결을 골라야 합니다 — 연결 없이는 주문을 낼 수 없습니다');
  }

  const marginUsd = num(body?.marginUsd);
  if (marginUsd == null || marginUsd <= 0 || marginUsd > 10_000) {
    return bad('BAD_MARGIN', `증거금은 0보다 크고 $10,000 이하여야 합니다 (받은 값: ${body?.marginUsd})`);
  }

  const leverage = num(body?.leverage);
  if (leverage == null || leverage < 1 || leverage > 125 || Math.round(leverage) !== leverage) {
    return bad('BAD_LEVERAGE', `배율은 1~125 사이 정수여야 합니다 (받은 값: ${body?.leverage})`);
  }

  const holdMin = num(body?.holdMin) ?? DEFAULT_HOLD_MIN;
  if (!(HOLD_CHOICES as readonly number[]).includes(holdMin)) {
    return bad('BAD_HOLD', `유지 시간은 ${HOLD_CHOICES.join(' · ')}분 중에서 고릅니다 (받은 값: ${body?.holdMin})`);
  }

  return {
    ok: true, code: 'OK',
    request: { symbol, side, connectionId, mode: 'TESTNET', marginUsd, leverage, holdMin },
    message: `${symbol} ${side} · 증거금 $${marginUsd} · ${leverage}배 · ${holdMin}분 유지`,
  };
}

// ── 단계 ─────────────────────────────────────────────

export type StepId =
  | 'PREFLIGHT'      // 기존 포지션·주문이 0인가
  | 'ENTRY'          // 시장가 진입을 보냈는가
  | 'FILL'           // 실제 체결을 확인했는가
  | 'STOP'           // 실제 체결가 기준 손절이 **되읽혔는가**
  | 'TAKE_PROFIT'    // 익절이 되읽혔는가
  | 'HOLD'           // 유지 시간을 채웠는가
  | 'CLOSE'          // reduceOnly 전량청산을 보냈는가
  | 'POSITION_ZERO'  // 포지션 0을 재조회로 확인했는가
  | 'ORDERS_ZERO'    // 남은 보호주문이 0인가
  | 'RECONCILE';     // 장부와 거래소가 맞는가

export const STEP_ORDER: StepId[] = [
  'PREFLIGHT', 'ENTRY', 'FILL', 'STOP', 'TAKE_PROFIT',
  'HOLD', 'CLOSE', 'POSITION_ZERO', 'ORDERS_ZERO', 'RECONCILE',
];

export const STEP_LABEL: Record<StepId, string> = {
  PREFLIGHT: '사전 확인 (기존 포지션·주문 0)',
  ENTRY: '진입',
  FILL: '체결',
  STOP: '손절 부착 (거래소 되읽기)',
  TAKE_PROFIT: '익절 부착 (거래소 되읽기)',
  HOLD: '유지',
  CLOSE: '청산',
  POSITION_ZERO: '포지션 0',
  ORDERS_ZERO: '잔여 보호주문 0',
  RECONCILE: '장부·거래소 대조',
};

export type StepState = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'UNKNOWN' | 'SKIPPED';

export interface SmokeStep {
  id: StepId;
  label: string;
  state: StepState;
  note: string;
}

/**
 * 기록된 단계 → 화면이 그릴 목록.
 *
 * **없는 단계를 PASS로 만들지 않는다.** 기록에 없으면 PENDING이고,
 * PENDING은 통과가 아니다. 이 구분이 무너지면 아무것도 안 한 테스트가
 * 초록으로 보인다.
 */
export function stepsOf(saved: any): SmokeStep[] {
  const map = (saved && typeof saved === 'object') ? saved : {};
  return STEP_ORDER.map(id => {
    const s = map[id];
    const state: StepState = s?.state && ['PENDING', 'RUNNING', 'PASS', 'FAIL', 'UNKNOWN', 'SKIPPED'].includes(s.state)
      ? s.state : 'PENDING';
    return { id, label: STEP_LABEL[id], state, note: String(s?.note ?? '') };
  });
}

export type SmokeVerdictCode = 'PASS' | 'FAIL' | 'RUNNING' | 'BLOCKED' | 'UNKNOWN';

export interface SmokeVerdict {
  code: SmokeVerdictCode;
  /** 전부 통과했는가 */
  pass: boolean;
  passed: number;
  total: number;
  reason: string;
}

/**
 * 최종 판정.
 *
 * 규칙은 셋뿐이다:
 *   · **하나라도 FAIL이면 FAIL이다.** 나머지가 다 초록이어도.
 *   · **하나라도 UNKNOWN이면 PASS가 아니다.** 확인하지 못한 것은 통과가 아니다.
 *   · 전부 PASS(또는 정당하게 SKIPPED)일 때만 PASS다.
 *
 * 특히 `ORDERS_ZERO`가 중요하다 — 고아 주문이 남았는데 "청산 성공"으로
 * 끝내면, 그 주문이 다음 진입을 친다. 어제 Gate에 4개가 쌓인 이유다.
 */
export function smokeVerdict(steps: SmokeStep[], state?: string): SmokeVerdict {
  const total = steps.length;
  const passed = steps.filter(s => s.state === 'PASS' || s.state === 'SKIPPED').length;

  if (String(state).toUpperCase() === 'BLOCKED') {
    return { code: 'BLOCKED', pass: false, passed, total,
      reason: '시작하지 못했습니다 — 기존 포지션이나 주문이 남아 있습니다' };
  }
  const failed = steps.filter(s => s.state === 'FAIL');
  if (failed.length > 0) {
    return { code: 'FAIL', pass: false, passed, total,
      reason: `실패: ${failed.map(f => f.label).join(' · ')}` };
  }
  const unknown = steps.filter(s => s.state === 'UNKNOWN');
  const pending = steps.filter(s => s.state === 'PENDING' || s.state === 'RUNNING');

  if (pending.length > 0) {
    return { code: 'RUNNING', pass: false, passed, total,
      reason: `진행 중 — 남은 단계: ${pending.map(p => p.label).join(' · ')}` };
  }
  if (unknown.length > 0) {
    // **확인하지 못한 것은 통과가 아니다.**
    return { code: 'UNKNOWN', pass: false, passed, total,
      reason: `확인하지 못한 단계가 있습니다: ${unknown.map(u => u.label).join(' · ')} — 통과로 적지 않습니다` };
  }
  return { code: 'PASS', pass: true, passed, total, reason: '모든 단계를 통과했습니다' };
}

// ── 유지 시간 ────────────────────────────────────────

/** 언제 닫을 것인가 */
export function holdUntilMs(startedMs: number, holdMin: number): number | null {
  const s = num(startedMs); const m = num(holdMin);
  if (s == null || m == null || m <= 0 || m > MAX_HOLD_MIN) return null;
  return s + m * 60_000;
}

export type CloseDueCode = 'DUE' | 'WAITING' | 'NOT_HOLDING' | 'NO_DEADLINE';

export interface CloseDueVerdict {
  due: boolean;
  code: CloseDueCode;
  remainingMs: number | null;
  reason: string;
}

/**
 * 지금 닫을 차례인가.
 *
 * **마감 시각을 못 읽으면 닫지 않는다.** `Date.parse` 실패를 0으로 읽으면
 * 1970년이 되어 **모든 테스트가 즉시 마감**으로 보인다 — 방금 연 포지션이
 * 바로 닫힌다. 이 저장소에서 `Number(null) === 0`으로 물린 것과 같은 함정이다.
 */
export function closeDue(i: {
  nowMs: number; state?: string; holdUntil?: any;
}): CloseDueVerdict {
  const state = String(i?.state ?? '').toUpperCase();
  if (state !== 'HOLDING') {
    return { due: false, code: 'NOT_HOLDING', remainingMs: null,
      reason: `유지 중인 테스트가 아닙니다 (${state || '상태 없음'})` };
  }
  const t = i?.holdUntil == null ? NaN
    : typeof i.holdUntil === 'number' ? i.holdUntil : Date.parse(String(i.holdUntil));
  if (!Number.isFinite(t)) {
    return { due: false, code: 'NO_DEADLINE', remainingMs: null,
      reason: '마감 시각을 읽지 못했습니다 — 읽지 못한 것을 "지금"으로 보지 않습니다' };
  }
  const remaining = t - Number(i.nowMs);
  if (remaining > 0) {
    return { due: false, code: 'WAITING', remainingMs: remaining,
      reason: `${Math.ceil(remaining / 1000)}초 뒤에 청산합니다` };
  }
  return { due: true, code: 'DUE', remainingMs: 0, reason: '유지 시간이 끝났습니다 — 전량 청산합니다' };
}

/**
 * 스모크 테스트가 도는 동안 이 종목에 전략이 들어가도 되는가.
 *
 * **안 된다.** ONE_WAY 계좌는 종목당 포지션이 하나라, 스모크가 열어 둔
 * 0.01 BTC 위로 전략이 들어가면 어제 사고가 그대로 재현된다.
 *
 * `rows`가 **null이면 '못 읽음'이다** — 통과가 아니다.
 */
export function smokeBlocksStrategy(i: {
  rows: any[] | null; symbol: string; connectionId?: string | null;
}): { blocked: boolean; code: 'CLEAR' | 'SMOKE_RUNNING' | 'SMOKE_UNKNOWN'; reason: string } {
  if (i?.rows == null) {
    return { blocked: true, code: 'SMOKE_UNKNOWN',
      reason: '스모크 테스트가 도는지 확인하지 못했습니다 — 확인하지 못한 것은 통과가 아닙니다' };
  }
  const want = String(i.symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const conn = i.connectionId == null ? null : String(i.connectionId);
  const live = i.rows.filter(r => {
    const st = String(r?.state ?? '').toUpperCase();
    if (st !== 'ENTERING' && st !== 'HOLDING' && st !== 'CLOSING') return false;
    if (String(r?.symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== want) return false;
    if (conn != null && r?.connection_id != null && String(r.connection_id) !== conn) return false;
    return true;
  });
  if (live.length === 0) {
    return { blocked: false, code: 'CLEAR', reason: `${i.symbol}에 진행 중인 스모크 테스트가 없습니다` };
  }
  return {
    blocked: true, code: 'SMOKE_RUNNING',
    reason: `${i.symbol}에 스모크 테스트가 진행 중입니다(${live.length}건) — `
      + '같은 종목에 전략 진입을 겹치지 않습니다. 테스트가 끝나면 다시 봅니다',
  };
}

/**
 * 사전 확인 판정.
 *
 * **기존 포지션이나 주문이 있으면 덮지 않는다.** 스모크 테스트가
 * 남의 포지션을 청산하거나 남의 손절을 지우면, 배관을 확인하려다
 * 사고를 내는 것이다.
 */
export function preflightVerdict(i: {
  position: { ok: boolean; found: boolean; qty?: number | null } | null;
  orders: any[] | null;
}): { ok: boolean; code: 'CLEAR' | 'POSITION_OPEN' | 'ORDERS_OPEN' | 'UNKNOWN'; reason: string } {
  if (!i?.position || i.position.ok !== true) {
    return { ok: false, code: 'UNKNOWN',
      reason: '기존 포지션을 조회하지 못했습니다 — 확인하지 못한 채로 주문을 내지 않습니다' };
  }
  if (i.position.found) {
    return { ok: false, code: 'POSITION_OPEN',
      reason: `이미 포지션이 열려 있습니다${i.position.qty != null ? ` (${i.position.qty})` : ''} — `
        + '스모크 테스트가 남의 포지션을 덮거나 청산하지 않습니다. 먼저 정리하세요' };
  }
  if (i.orders == null) {
    return { ok: false, code: 'UNKNOWN',
      reason: '조건부 주문 목록을 읽지 못했습니다 — 0건과 다릅니다' };
  }
  if (i.orders.length > 0) {
    return { ok: false, code: 'ORDERS_OPEN',
      reason: `조건부 주문이 ${i.orders.length}건 남아 있습니다 — 새 포지션을 예상치 못하게 닫습니다. `
        + '먼저 정리하세요 (스모크 테스트가 대신 지우지 않습니다)' };
  }
  return { ok: true, code: 'CLEAR', reason: '기존 포지션 0 · 조건부 주문 0' };
}
