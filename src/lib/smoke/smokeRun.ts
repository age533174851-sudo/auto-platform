// src/lib/smoke/smokeRun.ts
//
// **한 번 통과한 것은 통과가 아니다.**
//
// 왜 반복이 필요한가
// ──────────────────
// 스모크 테스트 1회가 PASS했다. 그런데 이번에 실제로 터진 고장들은
// 전부 **한 번으로는 안 보이는 것**이었다:
//
//   · 전날 포지션이 남은 상태에서 다음 진입 → 수량 2배 / netting 찌꺼기
//   · 이전 회차 SL/TP가 안 치워진 채 새 SL/TP가 쌓임 (Gate Orders 4개)
//   · 소유권 형식이 깨져 내 보호주문을 매번 못 지움
//
// 셋 다 **두 번째 회차부터** 드러난다. 첫 회차는 깨끗한 계좌에서
// 시작하므로 무엇을 안 치웠는지 알 수가 없다.
//
// 그래서 방향 교대가 특히 중요하다
// ────────────────────────────────
// LONG → SHORT → LONG → SHORT로 번갈아 돌면 매 회차가 **반전 경로**를
// 지난다. 같은 방향 10번은 "청산 후 다시 열기"만 보지만, 교대는
// "이전 방향이 완전히 정리됐는가"를 매번 묻는다 — 이번에 터진 고장의
// 정확한 모양이다.
//
// 반드시 순차다
// ─────────────
// 10개를 동시에 내지 않는다. ONE_WAY 계좌는 종목당 포지션이 하나라,
// 병렬로 내면 서로의 포지션을 상계하고 서로의 손절을 발동시킨다.
// 그건 반복 검증이 아니라 어제 사고의 재현이다.
//
// **그리고 다음 회차의 조건은 "주문이 성공했다"가 아니다.**
// 포지션 0과 이번 회차 보호주문 0이 **증명돼야** 넘어간다.

/** 고를 수 있는 시도 횟수 */
export const ATTEMPT_CHOICES = [1, 3, 5, 10] as const;
export const DEFAULT_ATTEMPTS = 1;

/**
 * 직접 입력의 상한.
 *
 * 유지 1분 × 50회면 50분이고, 10분 × 50회면 8시간이 넘는다. 그동안
 * 워커가 죽으면 마지막 포지션이 남는다. 그 노출을 묶는다 —
 * TESTNET 검증에 50회 이상이 필요한 경우는 없다.
 */
export const MAX_ATTEMPTS = 50;

export type DirectionMode = 'LONG' | 'SHORT' | 'ALTERNATE';

/**
 * 한 회라도 어긋나면 어떻게 할 것인가.
 *
 *   SAFE       FAIL이든 UNKNOWN이든 **즉시 전체 중지.** 기본값이다.
 *   DURABLE    포지션 0과 잔여 0이 **증명된 경우에만** 계속한다.
 *              실패한 회차는 실패로 남고, 다음 회차가 깨끗한 계좌에서
 *              시작한다는 것이 확인됐을 때만 이어 간다.
 *
 * **어느 쪽이든 UNKNOWN에서는 다음 회차로 가지 않는다.**
 * 모르는 상태에서 새 주문을 내는 것이 이번에 터진 사고의 뿌리다.
 */
export type FailurePolicy = 'SAFE' | 'DURABLE';

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── 회차의 방향 ──────────────────────────────────────

/**
 * 이번 회차는 어느 방향인가.
 *
 * `attemptNo`는 1부터다. 교대면 홀수 회차가 시작 방향, 짝수 회차가
 * 반대다 — 사용자가 고른 방향이 1회차가 된다.
 */
export function sideForAttempt(
  mode: DirectionMode, attemptNo: number, firstSide: 'LONG' | 'SHORT',
): 'LONG' | 'SHORT' | null {
  const n = num(attemptNo);
  if (n == null || n < 1 || Math.round(n) !== n) return null;
  if (mode === 'LONG') return 'LONG';
  if (mode === 'SHORT') return 'SHORT';
  if (mode !== 'ALTERNATE') return null;
  const flip = (n - 1) % 2 === 1;
  return flip ? (firstSide === 'LONG' ? 'SHORT' : 'LONG') : firstSide;
}

// ── 시작 요청 ────────────────────────────────────────

export interface RunRequest {
  attempts: number;
  directionMode: DirectionMode;
  failurePolicy: FailurePolicy;
}

export interface RunRequestVerdict {
  ok: boolean;
  code: 'OK' | 'BAD_ATTEMPTS' | 'BAD_DIRECTION' | 'BAD_POLICY' | 'TOO_LONG';
  request: RunRequest | null;
  /** 전부 통과했을 때 걸리는 대략의 시간(분). 화면이 미리 알려 준다 */
  estimatedMin: number | null;
  message: string;
}

/**
 * 반복 설정을 값으로 확정한다.
 *
 * **총 소요 시간을 미리 계산해서 돌려준다.** 10분 × 10회는 100분이
 * 넘는데, 그걸 모르고 시작하면 "왜 안 끝나지"가 된다. 검증은
 * 1분 × 10회로 먼저 하고, 안정되면 10분 × 10회를 한 번 더 돌리는
 * 것이 맞다.
 */
export function runRequestVerdict(body: any, holdMin: number): RunRequestVerdict {
  const bad = (code: RunRequestVerdict['code'], message: string): RunRequestVerdict =>
    ({ ok: false, code, request: null, estimatedMin: null, message });

  const attempts = num(body?.attempts) ?? DEFAULT_ATTEMPTS;
  if (attempts < 1 || attempts > MAX_ATTEMPTS || Math.round(attempts) !== attempts) {
    return bad('BAD_ATTEMPTS',
      `시도 횟수는 1~${MAX_ATTEMPTS}회 사이 정수여야 합니다 (받은 값: ${body?.attempts})`);
  }

  const directionMode = String(body?.directionMode ?? 'ALTERNATE').toUpperCase() as DirectionMode;
  if (!['LONG', 'SHORT', 'ALTERNATE'].includes(directionMode)) {
    return bad('BAD_DIRECTION', `방향 모드는 LONG · SHORT · ALTERNATE 중 하나입니다 (받은 값: ${body?.directionMode})`);
  }

  const failurePolicy = String(body?.failurePolicy ?? 'SAFE').toUpperCase() as FailurePolicy;
  if (!['SAFE', 'DURABLE'].includes(failurePolicy)) {
    return bad('BAD_POLICY', `실패 정책은 SAFE(즉시 중지) 또는 DURABLE(정리 확인 후 계속)입니다`);
  }

  const hm = num(holdMin);
  if (hm == null || hm <= 0) return bad('BAD_ATTEMPTS', '유지 시간을 읽지 못했습니다');
  // 회차당 유지 시간 + 진입/청산/대조에 드는 여유 1분.
  const estimatedMin = attempts * (hm + 1);

  return {
    ok: true, code: 'OK',
    request: { attempts, directionMode, failurePolicy },
    estimatedMin,
    message: `${attempts}회 · ${directionMode === 'ALTERNATE' ? 'LONG↔SHORT 교대' : `${directionMode} 고정`}`
      + ` · ${failurePolicy === 'SAFE' ? '안전 모드(한 번이라도 어긋나면 중지)' : '내구성 모드(정리 확인 시 계속)'}`
      + ` · 예상 ${estimatedMin}분`,
  };
}

// ── 다음 회차로 가도 되는가 ──────────────────────────

export type AdvanceCode =
  /** 다음 회차를 시작해도 된다 */
  | 'START_NEXT'
  /** 첫 회차를 시작한다 */
  | 'START_FIRST'
  /** 전부 끝났다 */
  | 'DONE'
  /** 아직 도는 회차가 있다 */
  | 'IN_PROGRESS'
  /** 실패해서 멈춘다 */
  | 'STOP_FAILED'
  /** **모르는 상태라 멈춘다.** 어느 정책이든 여기서는 안 간다 */
  | 'STOP_UNKNOWN'
  /** 계좌가 깨끗하다는 증거가 없어 멈춘다 */
  | 'STOP_NOT_CLEAN'
  /** 사람이 중지시켰다 — 다음 회차를 열지 않는다 */
  | 'STOPPED'
  /** 사람이 "지금 테스트 종료"를 눌렀고 그 절차가 도는 중이다 */
  | 'CANCELLING'
  /** 중지 절차가 끝났다 */
  | 'CANCELLED';

export interface AdvanceVerdict {
  code: AdvanceCode;
  /** 시작할 회차 번호. 시작하지 않으면 null */
  nextAttemptNo: number | null;
  /** 그 회차의 방향 */
  nextSide: 'LONG' | 'SHORT' | null;
  reason: string;
}

export interface AttemptSummary {
  attemptNo: number;
  state: string;
  verdict: string | null;
  /** 이 회차가 끝난 뒤 포지션이 0으로 **증명**됐는가 */
  positionZero: boolean | null;
  /** 이 회차의 보호주문 잔여가 0으로 **증명**됐는가 */
  residualZero: boolean | null;
  reason?: string | null;
}

const LIVE_STATES = ['PREFLIGHT', 'ENTERING', 'HOLDING', 'CLOSING'];

/**
 * 다음 회차를 시작해도 되는가.
 *
 * **순서가 곧 규칙이다:**
 *   1. 사람이 중지시켰으면 끝
 *   2. 도는 회차가 있으면 기다린다 — **병렬로 내지 않는다**
 *   3. 마지막 회차가 UNKNOWN이면 어느 정책이든 멈춘다
 *   4. 마지막 회차가 실패면 정책이 정한다
 *      · SAFE    즉시 멈춘다
 *      · DURABLE **포지션 0과 잔여 0이 증명됐을 때만** 계속한다
 *   5. 목표 횟수를 채웠으면 끝
 *
 * 4번이 핵심이다. "주문이 실패했으니 다시 해 보자"가 아니라
 * **"계좌가 깨끗해진 것이 확인됐으니 다시 해도 된다"**여야 한다.
 * 전자는 어제 사고를 반복하는 길이다.
 */
export function advanceVerdict(i: {
  run: { attempts: number; directionMode: DirectionMode; failurePolicy: FailurePolicy;
    firstSide: 'LONG' | 'SHORT'; state?: string };
  attempts: AttemptSummary[];
}): AdvanceVerdict {
  const run = i.run;
  const list = Array.isArray(i.attempts) ? [...i.attempts].sort((a, b) => a.attemptNo - b.attemptNo) : [];
  const stop = (code: AdvanceCode, reason: string): AdvanceVerdict =>
    ({ code, nextAttemptNo: null, nextSide: null, reason });

  // **RUNNING이 아니면 어떤 이유로든 새 회차를 열지 않는다.**
  //
  // 예전에는 'STOPPED' 한 가지만 봤다. 그런데 "지금 테스트 종료"가
  // 생기면서 중지가 **절차**가 됐다 — CANCEL_REQUESTED · CLOSING ·
  // CLEANING_PROTECTION을 지나는 동안 묶음은 STOPPED가 아니다.
  // 그 사이에 다음 회차가 열리면 **청산 중인 포지션 위로 새 진입**이
  // 올라간다. 그래서 이름 하나를 보는 대신 RUNNING만 통과시킨다.
  const runState = String(run.state ?? 'RUNNING').toUpperCase();
  if (runState === 'CANCELLED' || runState === 'CANCEL_FAILED') {
    return stop('CANCELLED', runState === 'CANCELLED'
      ? '사람이 종료한 반복 테스트입니다 — 청산과 보호주문 정리까지 확인됐습니다'
      : '사람이 종료했지만 정리가 확인되지 않은 반복 테스트입니다 — 거래소에서 직접 확인하세요');
  }
  if (runState === 'CANCEL_REQUESTED' || runState === 'CLOSING' || runState === 'CLEANING_PROTECTION') {
    return stop('CANCELLING', '중지 절차가 도는 중입니다 — 끝날 때까지 새 회차를 열지 않습니다');
  }
  if (runState !== 'RUNNING') {
    return stop('STOPPED', runState === 'STOPPED'
      ? '사람이 중지시킨 반복 테스트입니다 — 열린 회차는 마감 시각에 청산됩니다'
      : `묶음이 ${runState} 상태입니다 — 새 회차를 열지 않습니다`);
  }

  // **도는 것이 있으면 기다린다.** 이 한 줄이 순차 실행의 전부다.
  const live = list.find(a => LIVE_STATES.includes(String(a.state).toUpperCase()));
  if (live) {
    return stop('IN_PROGRESS', `${live.attemptNo}회차가 진행 중입니다 — 끝난 뒤에 다음 회차를 시작합니다`);
  }

  const done = list.filter(a => !LIVE_STATES.includes(String(a.state).toUpperCase()));
  const last = done.length ? done[done.length - 1] : null;

  if (last) {
    const verdict = String(last.verdict ?? '').toUpperCase();

    // 3. 모르면 어느 정책이든 멈춘다.
    //
    // UNKNOWN도, 판정이 아예 없는 것도 여기서 걸린다 — **둘 다 '모른다'**다.
    // 모르는 상태에서 새 주문을 내는 것이 이번에 터진 사고의 뿌리다.
    if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'BLOCKED') {
      return stop('STOP_UNKNOWN',
        `${last.attemptNo}회차 결과를 확정하지 못했습니다(${verdict || '판정 없음'}) — `
        + '모르는 상태에서 다음 회차를 시작하지 않습니다. 거래소와 대조가 필요합니다');
    }

    if (verdict !== 'PASS') {
      if (run.failurePolicy === 'SAFE') {
        return stop('STOP_FAILED',
          `${last.attemptNo}회차 ${verdict} — 안전 모드라 전체를 중지합니다`
          + (last.reason ? `: ${last.reason}` : ''));
      }
      // DURABLE — **깨끗함이 증명돼야 계속한다.**
      if (last.positionZero !== true || last.residualZero !== true) {
        return stop('STOP_NOT_CLEAN',
          `${last.attemptNo}회차 ${verdict}이고 계좌가 깨끗하다는 증거가 없습니다 `
          + `(포지션 0 ${fmt(last.positionZero)} · 잔여 주문 0 ${fmt(last.residualZero)}) — `
          + '남은 포지션이나 보호주문 위로 다음 회차를 시작하지 않습니다');
      }
    } else if (last.positionZero !== true || last.residualZero !== true) {
      // PASS인데 증거가 없다 — 판정과 증거가 어긋난다. **넘어가지 않는다.**
      return stop('STOP_NOT_CLEAN',
        `${last.attemptNo}회차는 PASS인데 정리 증거가 없습니다 `
        + `(포지션 0 ${fmt(last.positionZero)} · 잔여 주문 0 ${fmt(last.residualZero)})`);
    }
  }

  const nextNo = done.length + 1;
  if (nextNo > run.attempts) {
    return stop('DONE', `${run.attempts}회를 모두 마쳤습니다`);
  }
  const side = sideForAttempt(run.directionMode, nextNo, run.firstSide);
  if (!side) return stop('STOP_FAILED', '다음 회차의 방향을 정하지 못했습니다');

  return {
    code: nextNo === 1 ? 'START_FIRST' : 'START_NEXT',
    nextAttemptNo: nextNo, nextSide: side,
    reason: `${nextNo}회차 ${side} 시작`
      + (last ? ` (직전 ${last.attemptNo}회차 PASS · 포지션 0 · 잔여 0 확인)` : ''),
  };
}

const fmt = (v: boolean | null | undefined) => v === true ? '확인' : v === false ? '실패' : '미확인';

// ── 진행 상황 ────────────────────────────────────────

export interface RunProgress {
  total: number;
  completed: number;
  running: number;
  waiting: number;
  passed: number;
  failed: number;
  /** '총 10회 · 완료 3 · 진행 1 · 대기 6' */
  headline: string;
  /** 회차별 한 줄. 화면이 그대로 그린다 */
  marks: Array<{ attemptNo: number; state: StepMark; side: 'LONG' | 'SHORT' | null; label: string }>;
}

export type StepMark = 'PASS' | 'FAIL' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'UNKNOWN' | 'CANCELLED';

/**
 * 진행 상황 한 덩어리.
 *
 * **아직 안 한 회차를 '대기'로 명확히 적는다.** 화면에 안 보이면
 * 사람은 끝난 줄 알고, 그 사이 다음 회차가 돌면 놀란다.
 */
export function runProgress(i: {
  total: number; firstSide: 'LONG' | 'SHORT'; directionMode: DirectionMode;
  attempts: AttemptSummary[];
}): RunProgress {
  const total = Math.max(0, Math.round(num(i.total) ?? 0));
  const byNo = new Map<number, AttemptSummary>();
  for (const a of (Array.isArray(i.attempts) ? i.attempts : [])) byNo.set(a.attemptNo, a);

  const marks: RunProgress['marks'] = [];
  let completed = 0, running = 0, waiting = 0, passed = 0, failed = 0;

  for (let n = 1; n <= total; n++) {
    const a = byNo.get(n);
    const side = sideForAttempt(i.directionMode, n, i.firstSide);
    let state: StepMark;
    if (!a) { state = 'WAITING'; waiting++; }
    else if (LIVE_STATES.includes(String(a.state).toUpperCase())) { state = 'RUNNING'; running++; }
    else {
      const v = String(a.verdict ?? '').toUpperCase();
      // **사람이 종료한 회차는 FAIL이 아니다.** 고장이 아니라 사람이
      // 그만둔 것이고, 그 둘을 같은 칸에 넣으면 다음에 로그를 읽는
      // 사람이 없던 고장을 찾게 된다. 통과도 아니다 — 유지 시간을
      // 안 채웠으므로 무엇도 증명하지 않았다.
      state = v === 'PASS' ? 'PASS' : v === 'BLOCKED' ? 'BLOCKED' : v === 'FAIL' ? 'FAIL'
        : v === 'CANCELLED' ? 'CANCELLED' : 'UNKNOWN';
      completed++;
      if (state === 'PASS') passed++;
      else if (state !== 'CANCELLED') failed++;
    }
    marks.push({
      attemptNo: n, state, side,
      label: state === 'PASS' ? 'PASS' : state === 'FAIL' ? 'FAIL'
        : state === 'RUNNING' ? '진행 중' : state === 'WAITING' ? '대기'
          : state === 'BLOCKED' ? '시작 못 함' : state === 'CANCELLED' ? '중지됨' : '확인 못 함',
    });
  }

  return {
    total, completed, running, waiting, passed, failed,
    headline: `총 ${total}회 · 완료 ${completed} · 진행 ${running} · 대기 ${waiting}`,
    marks,
  };
}

// ── 최종 집계 ────────────────────────────────────────

export interface RunMetrics {
  /** 진입 지연(ms) 평균. 주문을 보내고 체결이 확인되기까지 */
  entryLatencyMsAvg: number | null;
  /** 청산 지연(ms) 평균. 마감 시각과 실제 청산 완료 사이 */
  exitLatencyMsAvg: number | null;
  /** 슬리피지(%) 평균. 참고가 대비 실제 체결가 */
  slippagePctAvg: number | null;
  /** 한 번이라도 본 가장 느린 API 응답(ms) */
  apiLatencyMsMax: number | null;
  /** 몇 개의 표본에서 나온 값인가. **표본이 없으면 null이지 0이 아니다** */
  samples: number;
}

/**
 * 평균을 낸다.
 *
 * **표본이 없으면 null이다.** 0으로 적으면 "지연이 0ms였다"로 읽히고,
 * 그건 측정한 적 없는 값을 성능 근거로 쓰는 것이다.
 */
export function runMetrics(rows: any[]): RunMetrics {
  const list = Array.isArray(rows) ? rows : [];
  const avg = (key: string): number | null => {
    const vals = list.map(r => num(r?.[key])).filter((n): n is number => n != null);
    if (vals.length === 0) return null;
    return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
  };
  const max = (key: string): number | null => {
    const vals = list.map(r => num(r?.[key])).filter((n): n is number => n != null);
    return vals.length ? Math.max(...vals) : null;
  };
  return {
    entryLatencyMsAvg: avg('entry_latency_ms'),
    exitLatencyMsAvg: avg('exit_latency_ms'),
    slippagePctAvg: avg('slippage_pct'),
    apiLatencyMsMax: max('api_latency_ms_max'),
    samples: list.length,
  };
}

export interface RunSummary {
  code: 'PASS' | 'FAIL' | 'RUNNING' | 'STOPPED';
  pass: boolean;
  /** '10회 시도 · 진입 체결 10 · SL 확인 10 · TP 확인 10 · 정상 청산 10' */
  lines: string[];
  reason: string;
}

/**
 * 최종 결과 요약.
 *
 * **목표 횟수를 다 채우고 전부 PASS일 때만 PASS다.** 중간에 멈췄으면
 * 그때까지 통과한 회차가 몇이든 전체는 PASS가 아니다 — 멈춘 이유가
 * 곧 확인 못 한 것이기 때문이다.
 */
export function runSummary(i: {
  total: number;
  attempts: AttemptSummary[];
  /** 단계별 집계: {ENTRY: 10, FILL: 10, STOP: 10, TAKE_PROFIT: 10, ...} */
  stepPass?: Record<string, number> | null;
  advance?: AdvanceVerdict | null;
}): RunSummary {
  const p = runProgress({
    total: i.total, firstSide: 'LONG', directionMode: 'LONG', attempts: i.attempts,
  });
  const sp = i.stepPass ?? {};
  const lines = [
    `${p.total}회 시도 · 완료 ${p.completed}`,
    `진입 체결 ${sp.FILL ?? 0} · SL 확인 ${sp.STOP ?? 0} · TP 확인 ${sp.TAKE_PROFIT ?? 0}`,
    `정상 청산 ${sp.POSITION_ZERO ?? 0} · 잔여 주문 0 확인 ${sp.ORDERS_ZERO ?? 0}`,
    `PASS ${p.passed} / FAIL ${p.failed}`,
  ];

  if (p.running > 0 || (p.waiting > 0 && (i.advance?.code === 'START_NEXT' || i.advance?.code === 'START_FIRST' || i.advance?.code === 'IN_PROGRESS'))) {
    return { code: 'RUNNING', pass: false, lines, reason: p.headline };
  }
  if (p.completed < p.total) {
    return {
      code: 'STOPPED', pass: false, lines,
      reason: i.advance?.reason || `${p.total}회 중 ${p.completed}회에서 멈췄습니다`,
    };
  }
  if (p.failed > 0) {
    return { code: 'FAIL', pass: false, lines, reason: `${p.failed}회 실패` };
  }
  return { code: 'PASS', pass: true, lines, reason: `${p.total}회 전부 통과했습니다` };
}
