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
import { attestationVerdict } from './exposureAttestation';

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

// ── 스모크는 **확인된 테스트넷 연결**에만 주문을 낸다 ───────────

export type SmokeTestnetCode = 'OK' | 'LIVE_CONNECTION' | 'ENV_UNVERIFIED';

export interface SmokeTestnetVerdict {
  ok: boolean;
  code: SmokeTestnetCode;
  reason: string;
}

/**
 * 스모크 주문을 낼 수 있는 연결인가.
 *
 * **왜 저장소 규칙보다 좁은가**
 * ─────────────────────────────
 * `loadFuturesCreds`는 `is_testnet !== false`를 테스트넷으로 읽는다.
 * 그 해석은 전체 경로에서 맞다 — 모르는 값이 실전이 되면 안 되고,
 * 빈 값을 테스트넷으로 읽으면 요청이 테스트넷 호스트로 나가 인증
 * 오류로 끝난다. **읽기·조회에는 그걸로 충분하다.**
 *
 * 그런데 스모크는 **없던 주문을 새로 만든다.** 테스트넷 호스트로
 * 나간다는 것과 그 계좌가 테스트넷 계좌임이 확인됐다는 것은 다른
 * 사실이고, 확인되지 않은 연결에까지 주문을 낼 이유가 없다.
 *
 * 그래서 여기서만 `is_testnet === true`를 요구한다. `null` ·
 * `undefined` · 누락은 **거부**다 — 실전이라고 부르지는 않지만
 * 주문도 내지 않는다. 그 둘을 다른 코드로 구분해 적는다.
 *
 * **전체 해석 체계는 그대로 둔다.** 이 함수는 스모크 주문 경로만
 * 부른다.
 */
export function smokeTestnetVerdict(isTestnetRaw: unknown): SmokeTestnetVerdict {
  if (isTestnetRaw === true) {
    return { ok: true, code: 'OK', reason: '테스트넷 연결이 확인됐습니다' };
  }
  if (isTestnetRaw === false) {
    return {
      ok: false, code: 'LIVE_CONNECTION',
      reason: '실전 연결로는 스모크 테스트를 돌리지 않습니다 — 진짜 돈으로 배관을 확인하지 않습니다',
    };
  }
  return {
    ok: false, code: 'ENV_UNVERIFIED',
    reason: '이 연결이 테스트넷인지 확인되지 않았습니다 — 확인되지 않은 환경에는 '
      + '주문을 내지 않습니다(실전이라는 뜻은 아닙니다). 연결을 다시 등록하세요',
  };
}

// ── 정리되지 않은 노출 위에 새 회차를 열지 않는다 ───────────────

export type ExposureBlockCode =
  /** 막을 것이 없다 */
  | 'CLEAR'
  /** 보호 없는 노출이 남아 있다 */
  | 'UNPROTECTED_UNRESOLVED'
  /** 노출이 남았는지 **모른다** */
  | 'EXPOSURE_UNKNOWN'
  /** 장부를 못 읽었다 — 못 읽은 것은 "없음"이 아니다 */
  | 'LEDGER_UNREADABLE';

export interface ExposureBlockVerdict {
  blocked: boolean;
  code: ExposureBlockCode;
  /** 막은 근거가 된 회차 id들. 사람이 바로 찾아볼 수 있어야 한다 */
  offenders: string[];
  reason: string;
}

/** 단계의 상태. 옛 행의 문자열 형태도 허용한다. */
function zeroStepOf(row: any, id: 'POSITION_ZERO' | 'ORDERS_ZERO'): string | null {
  const v = row?.steps?.[id];
  if (v == null) return null;
  const st = typeof v === 'string' ? v : v?.state;
  return st == null ? null : String(st).toUpperCase();
}

/**
 * 이 **연결**에 정리되지 않은 노출이 남아 있는가.
 *
 * 무엇을 막는가
 * ─────────────
 * `ENTERED_UNPROTECTED` 뒤 청산이 실패했거나 포지션을 읽지 못하면,
 * 거래소에 보호 없는 포지션이 남아 있을 수 있다. 그 위로 새 회차를
 * 열면 ONE_WAY 계좌에서 서로를 상계하거나 노출이 겹친다.
 *
 * `preflightVerdict`는 **요청한 종목만** 본다. 노출은 다른 종목에
 * 남아 있을 수 있으므로, 이 판정은 **연결 단위**로 본다.
 *
 * 언제 풀리는가
 * ─────────────
 * `POSITION_ZERO`와 `ORDERS_ZERO`가 **둘 다 PASS**여야 풀린다.
 * 정산 경로에서 거래소 재조회로 두 값을 확인한다. 포지션이 0이어도
 * 미체결 주문이 남거나 확인 불가하면 다음 진입을 막는다.
 *
 * **`rows`가 null이면 막는다.** 못 읽은 것은 "없음"이 아니다.
 */
export function unresolvedExposureBlock(i: {
  rows: any[] | null | undefined;
  connectionId?: string | null;
  /** 지금. 사후 확인의 유효 기간을 재는 데만 쓴다 (시험이 시계를 넣는다) */
  nowMs?: number;
}): ExposureBlockVerdict {
  if (!Array.isArray(i?.rows)) {
    return {
      blocked: true, code: 'LEDGER_UNREADABLE', offenders: [],
      reason: '정리되지 않은 노출이 있는지 장부에서 확인하지 못했습니다 — '
        + '못 읽은 것을 "없음"으로 보지 않습니다',
    };
  }

  const conn = i.connectionId == null ? null : String(i.connectionId);
  const now = Number.isFinite(Number(i?.nowMs)) ? Number(i.nowMs) : Date.now();
  const unresolved: string[] = [];
  const unknown: string[] = [];

  for (const r of i.rows) {
    if (conn != null && r?.connection_id != null && String(r.connection_id) !== conn) continue;

    const pz = zeroStepOf(r, 'POSITION_ZERO');
    const oz = zeroStepOf(r, 'ORDERS_ZERO');
    const state = String(r?.state ?? '').toUpperCase();
    // 진입 전에 끝난 줄은 노출이 없지만, 진입 중/유지/청산 중인 줄은
    // 단계 기록이 없어도 미확인 노출이다. PZ PASS만으로는 충분하지 않다.
    if (pz == null && oz == null && !['ENTERING', 'HOLDING', 'CLOSING'].includes(state)) continue;
    if (pz === 'PASS' && oz === 'PASS') continue;

    const id = String(r?.id ?? '?');
    // **본 적 있는 FAIL은 사후 확인으로 덮지 않는다.** "주문이 남은 것을
    // 봤다"는 기록된 사실이고, 지금 비어 있다는 관측이 그 사실을 지우지
    // 않는다. 사람이 그 줄을 직접 보고 판단해야 한다.
    if (pz === 'FAIL' || oz === 'FAIL') { unresolved.push(id); continue; }

    // 모르는 줄은 **증거로** 풀 수 있다. 간격을 둔 두 번의 관측이 모두
    // 비어 있었다면 이 줄은 더 이상 차단 사유가 아니다. 판정은
    // `exposureAttestation`에 한 곳으로 두고 여기서는 묻기만 한다.
    if (attestationVerdict(r?.steps?._attestation, now).accepted) continue;

    unknown.push(id);                           // UNKNOWN · PENDING · 누락 · 그 밖
  }

  if (unresolved.length) {
    return {
      blocked: true, code: 'UNPROTECTED_UNRESOLVED', offenders: unresolved,
      reason: `정리되지 않은 노출이 ${unresolved.length}건 있습니다(${unresolved.join(' · ')}) — `
        + '거래소에서 포지션 0과 잔여 주문 0을 확인한 뒤에 다시 시작하세요',
    };
  }
  if (unknown.length) {
    return {
      blocked: true, code: 'EXPOSURE_UNKNOWN', offenders: unknown,
      // **사람이 할 일을 적지 않는다.** 이 상태를 푸는 것은 사람이 거래소
      // 화면을 열어 보고 DB를 고치는 일이 아니라 명령 하나다. 그 명령이
      // 무엇인지까지 여기 적는다 — 안 적으면 결국 사람이 DB를 고친다.
      reason: `노출이 정리됐는지 확인하지 못한 회차가 ${unknown.length}건 있습니다`
        + `(${unknown.join(' · ')}) — 모르는 것 위에 새 회차를 열지 않습니다. `
        + `노출 해소(attest-exposure)를 실행하면 거래소를 두 번 읽어 비어 있음을 확인하고 자동으로 풉니다`,
    };
  }
  return {
    blocked: false, code: 'CLEAR', offenders: [],
    reason: '이 연결에 정리되지 않은 노출이 없습니다',
  };
}

// ── 진입이 확정되지 않았을 때 포지션을 방치하지 않는다 ─────────

/** 이 회차 줄을 어떻게 끝낼 것인가 */
export type ExposureHandoff =
  /** 포지션 없음이 **재조회로 확인됐다.** 줄을 닫아도 된다 */
  | 'CLOSE_RECORD'
  /** 거래소에 노출이 남았거나 **모른다.** 정산 경로로 넘긴다 */
  | 'SETTLE';

export interface ExposureVerdict {
  handoff: ExposureHandoff;
  /** `POSITION_ZERO` 단계에 적을 값. **모르면 UNKNOWN이지 PASS가 아니다** */
  positionZero: 'PASS' | 'FAIL' | 'UNKNOWN';
  /** 사람이 깨어나야 하는가 (보호 없는 노출이 열려 있다) */
  alert: boolean;
  reason: string;
}

/**
 * 진입이 확정되지 않은 회차를 **어떻게 끝낼지** 정한다.
 *
 * 무엇이 문제였나
 * ───────────────
 * `enteredVerdict`가 `ENTERED_UNPROTECTED`를 주는 경우가 있다 —
 * **체결은 됐는데 보호주문을 확인하지 못한 것이다.** 실행기는
 * `protectionPolicy: 'REQUIRED'`에서 `undoEntry()`로 되돌리려 하지만,
 * 그 되돌리기 자체가 실패할 수 있다.
 *
 * 그때 예전 코드는 줄에 `closed_at`을 적고 끝냈다. 그런데 `/settle`은
 * `state = 'HOLDING'`인 줄만 고르므로, **닫힌 줄은 아무도 다시 보지
 * 않는다.** 거래소에는 보호 없는 포지션이 열린 채로 남는다.
 *
 * 그래서 여기서는 **재조회 결과로** 끝내는 방법을 고른다:
 *
 *   읽었고 · 없다        → 줄을 닫는다 (POSITION_ZERO PASS)
 *   읽었고 · 남았다      → 정산으로 넘긴다 (FAIL · 경고)
 *   **못 읽었다**        → 정산으로 넘긴다 (UNKNOWN · 경고)
 *
 * **못 읽은 것을 0으로 적지 않는다.** 그리고 못 읽었을 때 줄을 닫으면
 * 모르는 노출을 아무도 다시 보지 않게 된다.
 *
 * 여기서 청산을 보내지 않는 이유
 * ──────────────────────────────
 * 보내는 일은 `settleAttempt` 하나가 한다 — 선점(compare-and-set) ·
 * reduceOnly 전량청산 · 재조회로 0 확인 · 내 보호주문만 취소까지
 * 이미 거기 있고 시험이 붙어 있다. 여기서 한 번 더 보내면 **같은
 * 주문을 내는 곳이 둘**이 되고, 그게 중복 청산의 모양이다.
 *
 * 그리고 정산은 **회차당 한 번씩만** 보낸다 — 무제한 재주문이 아니다.
 */
export function unprotectedExposureVerdict(i: {
  /** `enteredVerdict`의 코드 */
  code: string;
  /** 진입 뒤 **재조회한** 포지션 */
  position: { ok?: boolean; found?: boolean; qty?: number | null } | null | undefined;
}): ExposureVerdict {
  const p = i?.position;
  const unprotected = String(i?.code ?? '') === 'ENTERED_UNPROTECTED';

  if (!p || p.ok !== true) {
    return {
      handoff: 'SETTLE', positionZero: 'UNKNOWN', alert: true,
      reason: '진입 뒤 포지션을 재조회하지 못했습니다 — 모르는 것을 0으로 적지 않고 '
        + '정산 경로로 넘깁니다',
    };
  }

  const qty = Number(p.qty);
  const hasQty = Number.isFinite(qty) && Math.abs(qty) > 0;
  if (p.found === true || hasQty) {
    return {
      handoff: 'SETTLE', positionZero: 'FAIL', alert: true,
      reason: unprotected
        ? `⚠ 보호주문 없는 포지션이 거래소에 남았습니다(수량 ${p.qty}) — 정산 경로가 닫습니다`
        : `진입이 확정되지 않았는데 포지션이 남았습니다(수량 ${p.qty}) — 정산 경로가 닫습니다`,
    };
  }

  return {
    handoff: 'CLOSE_RECORD', positionZero: 'PASS', alert: false,
    reason: '진입은 확정되지 않았고 거래소 포지션도 재조회로 0을 확인했습니다',
  };
}

/**
 * 사전 확인 판정.
 *
 * **기존 포지션이나 주문이 있으면 덮지 않는다.** 스모크 테스트가
 * 남의 포지션을 청산하거나 남의 손절을 지우면, 배관을 확인하려다
 * 사고를 내는 것이다.
 */
/**
 * Historical smoke recovery diagnostic, READ-ONLY.
 *
 * Even if an authenticated venue query proves the position and BOTH order
 * books empty NOW, the previously failed attempt is not retroactively a
 * successful trade. There can be races between the three GET requests, and
 * the nine older ACKED ledger entries require separate order-ID reconciliation.
 *
 * Crucially this classifier can NEVER clear an UNKNOWN DB row or authorize
 * the next smoke test. A separate reviewed/atomic historical-attestation
 * mechanism is required to update any old ORDERS_ZERO evidence.
 */
export function legacySmokeExposureVerdict(i: {
  positionRead: { success?: unknown; positions?: unknown } | null | undefined;
  regularOrderRead: { success?: unknown; orders?: unknown } | null | undefined;
  algoOrderRead: { success?: unknown; orders?: unknown } | null | undefined;
  symbol: string;
}): {
  code: 'UNKNOWN' | 'EXPOSURE_OPEN' | 'OBSERVED_FLAT_NOW';
  positionCount: number | null;
  regularOrderCount: number | null;
  algoOrderCount: number | null;
  canClearHistoricalUnknown: false;
  mayStartSmoke: false;
} {
  const blocked = (code: 'UNKNOWN' | 'EXPOSURE_OPEN',
    positionCount: number | null, regularOrderCount: number | null,
    algoOrderCount: number | null) => ({
    code, positionCount, regularOrderCount, algoOrderCount,
    canClearHistoricalUnknown: false as const, mayStartSmoke: false as const,
  });
  const symbol = String(i?.symbol ?? '').trim();
  const positions = i?.positionRead?.success === true &&
    Array.isArray(i.positionRead.positions) ? i.positionRead.positions : null;
  const regular = i?.regularOrderRead?.success === true &&
    Array.isArray(i.regularOrderRead.orders) ? i.regularOrderRead.orders : null;
  const conditional = i?.algoOrderRead?.success === true &&
    Array.isArray(i.algoOrderRead.orders) ? i.algoOrderRead.orders : null;
  if (!/^[A-Z0-9]{5,24}$/.test(symbol) ||
      positions == null || regular == null || conditional == null) {
    return blocked('UNKNOWN', positions?.length ?? null, regular?.length ?? null,
      conditional?.length ?? null);
  }
  // Binance getFuturesPositions reports only nonzero positions; if an
  // opaque/malformed entry cannot be trusted, do not assert flat.
  if (positions.some((p: any) => typeof p?.symbol !== 'string' ||
      !Number.isFinite(Number(p?.amount)) || Number(p.amount) <= 0)) {
    return blocked('UNKNOWN', positions.length, regular.length, conditional.length);
  }
  // Any open order, even one owned by another strategy, blocks
  // "account is empty" for this symbol-scoped diagnostic.
  if (positions.some((p: any) => p.symbol === symbol) ||
      regular.length > 0 || conditional.length > 0) {
    return blocked('EXPOSURE_OPEN', positions.filter((p: any) => p.symbol === symbol).length,
      regular.length, conditional.length);
  }
  return {
    code: 'OBSERVED_FLAT_NOW',
    positionCount: 0, regularOrderCount: 0, algoOrderCount: 0,
    canClearHistoricalUnknown: false, mayStartSmoke: false,
  };
}

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
