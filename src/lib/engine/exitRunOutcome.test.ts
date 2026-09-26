// src/lib/engine/exitRunOutcome.test.ts
//
// **표는 실패인데 응답은 성공이던 것을 붙잡아 둔다.**
//
// 같은 실행에서:
//   exit_monitor_runs = FAILED
//   HTTP body         = ok: true
// 가 나올 수 있었다. actionable이 1건 이상인 최종 응답에 `ok: true`가
// 박혀 있었기 때문이다. 부르는 쪽은 초록을 보고 넘어가고 실패는 아무도
// 안 보는 표에만 남는다 — `strategy_id` projection 장애가 25일간 숨어
// 있던 것이 정확히 이 모양이다.
import { test, eq, assert } from '../../test/harness';
import { collectLifecycleFailures, exitRunOutcome } from './exitRunOutcome';

export function runExitRunOutcomeTests() {
  console.log('\n📋 청산 감시 회차 결과 (기록과 응답이 같은 진실)');

  // ══ ① 실패 없음 → ok ══
  test('① lifecycle 실패 없음 + 일반 처리 성공 → top-level ok = true', () => {
    const lifecycleFailed = collectLifecycleFailures({ error: null, results: [{ ok: true }] });
    eq(lifecycleFailed.length, 0);
    const o = exitRunOutcome({
      results: [{ symbol: 'BTCUSDT', action: 'MOVE_STOP', ok: true }],
      lifecycleFailed,
    });
    eq(o.ok, true);
    eq(o.status, 'OK');
    eq(o.errors, null);
  });

  // ══ ② 원래 결함: actionable 있고 lifecycle 실패 ══
  test('★ ② actionable 존재 + lifecycleFailed 존재 → top-level ok = false (원래 결함)', () => {
    // 예전에는 이 경우 응답이 무조건 ok:true였다.
    const lifecycleFailed = collectLifecycleFailures({
      error: 'column live_orders.strategy_id does not exist',
      results: [],
    });
    eq(lifecycleFailed.length, 1);
    const o = exitRunOutcome({
      results: [{ symbol: 'BTCUSDT', action: 'MOVE_STOP', ok: true }],   // 계단식은 성공
      lifecycleFailed,
    });
    eq(o.ok, false, '★ 표는 FAILED인데 응답이 ok:true였습니다');
    eq(o.status, 'FAILED');
    assert(/strategy_id/.test(String(o.errors)), `사유가 남아야 합니다: ${o.errors}`);
  });

  // ══ ③ 조기 반환 경로는 원래대로 ══
  test('③ actionable 없음 + lifecycleFailed 존재 → top-level ok = false (기존 동작 유지)', () => {
    const lifecycleFailed = collectLifecycleFailures({ error: '조회 실패', results: [] });
    const o = exitRunOutcome({ results: [], lifecycleFailed });
    eq(o.ok, false);
    eq(o.status, 'FAILED');
  });

  // ══ ④ 기록 쪽 동작은 그대로 ══
  test('④ lifecycle 실패가 exit_monitor_runs FAILED에 포함된다 (기존 동작 유지)', () => {
    const lifecycleFailed = collectLifecycleFailures({
      error: null,
      results: [{ symbol: 'ETHUSDT', ok: false, reason: '청산 접수 실패' }],
    });
    eq(lifecycleFailed.length, 1);
    const o = exitRunOutcome({ results: [], lifecycleFailed });
    eq(o.status, 'FAILED');
    assert(/ETHUSDT/.test(String(o.errors)), o.errors || '');
  });

  // ══ 두 값이 갈리지 않는다 — 이것이 계약이다 ══
  test('★ ok와 status는 언제나 같은 진실이다', () => {
    const cases = [
      { results: [], lifecycleFailed: [] },
      { results: [{ ok: true }], lifecycleFailed: [] },
      { results: [{ ok: false, symbol: 'A' }], lifecycleFailed: [] },
      { results: [], lifecycleFailed: [{ symbol: 'lifecycle', error: 'x' }] },
      { results: [{ ok: true }], lifecycleFailed: [{ symbol: 'lifecycle', error: 'x' }] },
      { results: [{ ok: false, symbol: 'A' }], lifecycleFailed: [{ symbol: 'lifecycle', error: 'x' }] },
    ];
    for (const c of cases) {
      const o = exitRunOutcome(c as any);
      eq(o.ok, o.status === 'OK', `★ ok(${o.ok})와 status(${o.status})가 갈렸습니다`);
      eq(o.ok, o.failed.length === 0, '★ ok가 failed 집계와 다릅니다');
      eq(o.ok, o.errors === null, '★ 실패인데 사유가 비었거나 그 반대입니다');
    }
  });

  // ══ 계단식 실패도 응답에 반영된다 ══
  test('★ 계단식 처리 실패도 top-level ok를 내린다', () => {
    // 예전 최종 응답은 `ok: true` 고정이라 이것도 초록으로 나갔다.
    const o = exitRunOutcome({
      results: [{ symbol: 'BTCUSDT', action: 'CLOSE', ok: false, error: '거래소 거부' }],
      lifecycleFailed: [],
    });
    eq(o.ok, false);
    assert(/거래소 거부/.test(String(o.errors)), o.errors || '');
  });

  // ══ 조회 실패를 "후보 없음"으로 읽지 않는다 ══
  test('★ lifecycle.error를 빼먹지 않는다 — 조회가 죽은 회차가 정상으로 읽힌다', () => {
    const only = collectLifecycleFailures({ error: '조회 실패', results: [] });
    eq(only.length, 1, '★ error만 있는 경우를 놓쳤습니다');
    eq(only[0].symbol, 'lifecycle');
  });

  test('error와 개별 실패가 같이 있으면 둘 다 센다', () => {
    const f = collectLifecycleFailures({
      error: '조회 실패',
      results: [{ symbol: 'A', ok: false }, { symbol: 'B', ok: true }, { symbol: 'C', ok: false }],
    });
    eq(f.length, 3);
  });

  test('lifecycle이 null이거나 모양이 달라도 던지지 않는다', () => {
    eq(collectLifecycleFailures(null).length, 0);
    eq(collectLifecycleFailures({}).length, 0);
    eq(collectLifecycleFailures({ results: 'nope' }).length, 0);
    eq(exitRunOutcome({}).ok, true);
  });

  test('사유가 없는 실패도 목록에서 빠지지 않는다', () => {
    // 이유를 못 적는 것과 실패가 없는 것은 다르다.
    const f = collectLifecycleFailures({ results: [{ symbol: 'A', ok: false }] });
    eq(f.length, 1);
    eq(f[0].error, 'lifecycle_failed');
  });
}
