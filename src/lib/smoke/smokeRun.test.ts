// src/lib/smoke/smokeRun.test.ts
//
// **반복이 병렬이 되거나, 안 깨끗한 계좌에서 다음 회차가 시작되는 길을
// 전부 막는다.**
//
// 이번에 실제로 터진 고장은 셋 다 "이전 회차가 남긴 것" 때문이었다.
// 그래서 반복 테스트에서 가장 위험한 실수는 **정리되지 않은 상태에서
// 다음 회차를 시작하는 것**이다 — 그러면 반복 테스트 자체가 어제
// 사고를 10번 재현하는 도구가 된다.

import { test, eq, assert } from '../../test/harness';
import {
  sideForAttempt, runRequestVerdict, advanceVerdict, runProgress,
  runMetrics, runSummary,
  ATTEMPT_CHOICES, MAX_ATTEMPTS, DEFAULT_ATTEMPTS,
  type AttemptSummary, type DirectionMode,
} from './smokeRun';

/** 끝난 회차 하나 */
const done = (n: number, verdict: string, clean = true): AttemptSummary => ({
  attemptNo: n, state: verdict === 'BLOCKED' ? 'BLOCKED' : verdict === 'PASS' ? 'PASS' : 'FAIL',
  verdict, positionZero: clean ? true : false, residualZero: clean ? true : false,
});
const running = (n: number): AttemptSummary => ({
  attemptNo: n, state: 'HOLDING', verdict: null, positionZero: null, residualZero: null,
});

const RUN = (over: any = {}) => ({
  attempts: 10, directionMode: 'ALTERNATE' as DirectionMode, failurePolicy: 'SAFE' as const,
  firstSide: 'LONG' as const, state: 'RUNNING', ...over,
});

export function runSmokeRunTests() {
  console.log('[반복 스모크 — 방향 교대]');

  test('교대는 사용자가 고른 방향으로 시작한다', () => {
    const seq = [1, 2, 3, 4, 5, 6].map(n => sideForAttempt('ALTERNATE', n, 'LONG'));
    eq(seq.join(','), 'LONG,SHORT,LONG,SHORT,LONG,SHORT');
    const seq2 = [1, 2, 3, 4].map(n => sideForAttempt('ALTERNATE', n, 'SHORT'));
    eq(seq2.join(','), 'SHORT,LONG,SHORT,LONG');
  });

  test('고정 모드는 회차와 무관하게 같은 방향이다', () => {
    for (const n of [1, 2, 7, 10]) {
      eq(sideForAttempt('LONG', n, 'SHORT'), 'LONG', String(n));
      eq(sideForAttempt('SHORT', n, 'LONG'), 'SHORT', String(n));
    }
  });

  test('회차 번호가 이상하면 방향을 짐작하지 않는다', () => {
    for (const n of [0, -1, 1.5, NaN, null as any]) {
      eq(sideForAttempt('ALTERNATE', n, 'LONG'), null, String(n));
    }
    eq(sideForAttempt('SIDEWAYS' as any, 1, 'LONG'), null);
  });

  console.log('[반복 스모크 — 시작 설정]');

  test('고를 수 있는 횟수는 1·3·5·10회다', () => {
    eq(ATTEMPT_CHOICES.join(','), '1,3,5,10');
    eq(DEFAULT_ATTEMPTS, 1, '기본이 1회가 아니면 실수로 10회가 돈다');
    for (const n of ATTEMPT_CHOICES) {
      eq(runRequestVerdict({ attempts: n }, 10).ok, true, String(n));
    }
  });

  test('직접 입력도 되지만 상한이 있다', () => {
    eq(runRequestVerdict({ attempts: 7 }, 1).ok, true);
    eq(runRequestVerdict({ attempts: MAX_ATTEMPTS }, 1).ok, true);
    eq(runRequestVerdict({ attempts: MAX_ATTEMPTS + 1 }, 1).code, 'BAD_ATTEMPTS');
    eq(runRequestVerdict({ attempts: 0 }, 1).code, 'BAD_ATTEMPTS');
    eq(runRequestVerdict({ attempts: 2.5 }, 1).code, 'BAD_ATTEMPTS');
  });

  test('예상 소요 시간을 미리 알려 준다 — 10분 × 10회는 100분이 넘는다', () => {
    // 그래서 검증은 1분 × 10회로 먼저 한다.
    eq(runRequestVerdict({ attempts: 10 }, 10).estimatedMin, 110);
    eq(runRequestVerdict({ attempts: 10 }, 1).estimatedMin, 20);
  });

  test('모르는 방향 모드·실패 정책을 받지 않는다', () => {
    eq(runRequestVerdict({ directionMode: 'BOTH' }, 1).code, 'BAD_DIRECTION');
    eq(runRequestVerdict({ failurePolicy: 'IGNORE' }, 1).code, 'BAD_POLICY');
  });

  test('기본은 안전 모드다', () => {
    const v = runRequestVerdict({ attempts: 3 }, 1);
    eq(v.request!.failurePolicy, 'SAFE');
    eq(v.request!.directionMode, 'ALTERNATE');
  });

  console.log('[반복 스모크 — 반드시 순차다]');

  test('도는 회차가 있으면 다음을 시작하지 않는다', () => {
    // 10개를 동시에 내면 서로의 포지션을 상계한다 — 어제 사고의 재현이다.
    const v = advanceVerdict({ run: RUN(), attempts: [done(1, 'PASS'), running(2)] });
    eq(v.code, 'IN_PROGRESS');
    eq(v.nextAttemptNo, null, '진행 중인데 다음 회차를 시작하려 했다');
  });

  test('아무것도 없으면 1회차부터 시작한다', () => {
    const v = advanceVerdict({ run: RUN(), attempts: [] });
    eq(v.code, 'START_FIRST'); eq(v.nextAttemptNo, 1); eq(v.nextSide, 'LONG');
  });

  test('직전 회차가 PASS + 정리 확인이면 다음으로 간다', () => {
    const v = advanceVerdict({ run: RUN(), attempts: [done(1, 'PASS')] });
    eq(v.code, 'START_NEXT'); eq(v.nextAttemptNo, 2);
    eq(v.nextSide, 'SHORT', '교대인데 같은 방향으로 갔다');
    assert(v.reason.includes('잔여 0 확인'), v.reason);
  });

  test('목표 횟수를 채우면 끝난다', () => {
    const attempts = [1, 2, 3].map(n => done(n, 'PASS'));
    eq(advanceVerdict({ run: RUN({ attempts: 3 }), attempts }).code, 'DONE');
  });

  console.log('[반복 스모크 — 안 깨끗하면 다음 회차 없음]');

  test('직전 회차가 UNKNOWN이면 어느 정책이든 멈춘다', () => {
    for (const policy of ['SAFE', 'DURABLE'] as const) {
      const v = advanceVerdict({
        run: RUN({ failurePolicy: policy }),
        attempts: [{ attemptNo: 1, state: 'FAIL', verdict: 'UNKNOWN', positionZero: true, residualZero: true }],
      });
      eq(v.code, 'STOP_UNKNOWN', policy);
      eq(v.nextAttemptNo, null, policy);
    }
  });

  test('판정이 없는 회차도 UNKNOWN으로 본다', () => {
    const v = advanceVerdict({
      run: RUN(), attempts: [{ attemptNo: 1, state: 'FAIL', verdict: null, positionZero: true, residualZero: true }],
    });
    eq(v.code, 'STOP_UNKNOWN');
  });

  test('안전 모드는 한 번이라도 FAIL이면 즉시 중지한다', () => {
    const v = advanceVerdict({ run: RUN({ failurePolicy: 'SAFE' }), attempts: [done(1, 'FAIL')] });
    eq(v.code, 'STOP_FAILED'); eq(v.nextAttemptNo, null);
  });

  test('내구성 모드도 정리가 확인돼야만 계속한다', () => {
    // 포지션 0 · 잔여 0이 증명된 FAIL — 다음 회차가 깨끗한 계좌에서 시작한다.
    const okToGo = advanceVerdict({
      run: RUN({ failurePolicy: 'DURABLE' }), attempts: [done(1, 'FAIL', true)],
    });
    eq(okToGo.code, 'START_NEXT'); eq(okToGo.nextAttemptNo, 2);

    // 증거가 없으면 안 간다 — 남은 포지션/주문 위로 다음 회차를 열지 않는다.
    const blocked = advanceVerdict({
      run: RUN({ failurePolicy: 'DURABLE' }), attempts: [done(1, 'FAIL', false)],
    });
    eq(blocked.code, 'STOP_NOT_CLEAN'); eq(blocked.nextAttemptNo, null);
  });

  test('정리 증거가 "미확인"이면 내구성 모드에서도 안 간다', () => {
    const v = advanceVerdict({
      run: RUN({ failurePolicy: 'DURABLE' }),
      attempts: [{ attemptNo: 1, state: 'FAIL', verdict: 'FAIL', positionZero: null, residualZero: null }],
    });
    eq(v.code, 'STOP_NOT_CLEAN');
    assert(v.reason.includes('미확인'), v.reason);
  });

  test('PASS인데 정리 증거가 없으면 넘어가지 않는다 — 판정과 증거가 어긋난다', () => {
    const v = advanceVerdict({
      run: RUN(), attempts: [{ attemptNo: 1, state: 'PASS', verdict: 'PASS', positionZero: true, residualZero: false }],
    });
    eq(v.code, 'STOP_NOT_CLEAN');
  });

  test('사람이 중지시키면 더 시작하지 않는다', () => {
    eq(advanceVerdict({ run: RUN({ state: 'STOPPED' }), attempts: [] }).code, 'STOPPED');
  });

  console.log('[반복 스모크 — 진행 화면]');

  test('총 10회 · 완료 3 · 진행 1 · 대기 6', () => {
    const p = runProgress({
      total: 10, firstSide: 'LONG', directionMode: 'ALTERNATE',
      attempts: [done(1, 'PASS'), done(2, 'PASS'), done(3, 'PASS'), running(4)],
    });
    eq(p.headline, '총 10회 · 완료 3 · 진행 1 · 대기 6');
    eq(p.passed, 3); eq(p.failed, 0);
    eq(p.marks.length, 10);
    eq(p.marks[3].state, 'RUNNING');
    eq(p.marks[4].state, 'WAITING');
    // 교대이므로 회차마다 방향이 바뀐다 — 화면이 그대로 그린다.
    eq(p.marks.map(m => m.side).slice(0, 4).join(','), 'LONG,SHORT,LONG,SHORT');
  });

  test('아직 안 한 회차를 "대기"로 분명히 적는다', () => {
    const p = runProgress({ total: 5, firstSide: 'LONG', directionMode: 'LONG', attempts: [] });
    eq(p.waiting, 5); eq(p.completed, 0);
    for (const m of p.marks) eq(m.label, '대기');
  });

  test('판정이 없는 끝난 회차를 PASS로 세지 않는다', () => {
    const p = runProgress({
      total: 2, firstSide: 'LONG', directionMode: 'LONG',
      attempts: [{ attemptNo: 1, state: 'FAIL', verdict: null, positionZero: null, residualZero: null }],
    });
    eq(p.passed, 0); eq(p.failed, 1);
    eq(p.marks[0].state, 'UNKNOWN');
  });

  console.log('[반복 스모크 — 최종 집계]');

  test('전부 통과해야 PASS다', () => {
    const attempts = Array.from({ length: 10 }, (_, k) => done(k + 1, 'PASS'));
    const s = runSummary({
      total: 10, attempts,
      stepPass: { FILL: 10, STOP: 10, TAKE_PROFIT: 10, POSITION_ZERO: 10, ORDERS_ZERO: 10 },
    });
    eq(s.code, 'PASS'); eq(s.pass, true);
    assert(s.lines.some(l => l.includes('PASS 10 / FAIL 0')), s.lines.join(' | '));
    assert(s.lines.some(l => l.includes('SL 확인 10')), s.lines.join(' | '));
  });

  test('중간에 멈추면 그때까지 통과했어도 전체는 PASS가 아니다', () => {
    const s = runSummary({
      total: 10, attempts: [done(1, 'PASS'), done(2, 'PASS'), done(3, 'FAIL')],
      advance: { code: 'STOP_FAILED', nextAttemptNo: null, nextSide: null, reason: '3회차 FAIL — 안전 모드' },
    });
    eq(s.code, 'STOPPED'); eq(s.pass, false);
    assert(s.reason.includes('3회차 FAIL'), s.reason);
  });

  test('한 회라도 실패하면 FAIL이다', () => {
    const attempts = [...Array.from({ length: 9 }, (_, k) => done(k + 1, 'PASS')), done(10, 'FAIL')];
    const s = runSummary({ total: 10, attempts });
    eq(s.code, 'FAIL'); eq(s.pass, false);
  });

  test('단계 집계가 없으면 0으로 적되 통과로 세지 않는다', () => {
    const s = runSummary({ total: 1, attempts: [done(1, 'PASS')], stepPass: null });
    assert(s.lines.some(l => l.includes('SL 확인 0')), s.lines.join(' | '));
  });

  console.log('[반복 스모크 — 성능 기록]');

  test('평균과 최대를 낸다', () => {
    const m = runMetrics([
      { entry_latency_ms: 400, exit_latency_ms: 1200, slippage_pct: 0.05, api_latency_ms_max: 900 },
      { entry_latency_ms: 600, exit_latency_ms: 800, slippage_pct: 0.15, api_latency_ms_max: 1500 },
    ]);
    eq(m.entryLatencyMsAvg, 500);
    eq(m.exitLatencyMsAvg, 1000);
    eq(m.slippagePctAvg, 0.1);
    eq(m.apiLatencyMsMax, 1500);
    eq(m.samples, 2);
  });

  test('표본이 없으면 0이 아니라 null이다', () => {
    // 0으로 적으면 "지연 0ms"로 읽힌다 — 측정한 적 없는 값을 근거로 쓰게 된다.
    const m = runMetrics([]);
    eq(m.entryLatencyMsAvg, null);
    eq(m.slippagePctAvg, null);
    eq(m.apiLatencyMsMax, null);
    eq(m.samples, 0);
  });

  test('일부만 측정됐으면 그 일부로만 평균을 낸다', () => {
    const m = runMetrics([
      { entry_latency_ms: 400 },
      { entry_latency_ms: null, exit_latency_ms: 800 },
      {},
    ]);
    eq(m.entryLatencyMsAvg, 400);
    eq(m.exitLatencyMsAvg, 800);
  });
}
