// src/lib/engine/scheduledExitRunner.test.ts
//
// **"이 시각에 팔겠다"를 지킬 실행기가 있는가 — 근거로 답하는가.**
//
// 화면은 이걸 하드코딩 true 세 개로 답하고 있었다. 아무것도 확인하지
// 않고 "앱을 닫아도 제 시각에 나갑니다"를 적었고, 그 약속은 사실이
// 아니었다. 여기서 그 자리를 못 박는다.
import { test, eq, assert } from '../../test/harness';
import {
  scheduledExitRunnerOf, overdueExitsOf, WORKER_FRESH_MS,
  positionAmountRead, exitPortionRead, strictFinite,
} from './scheduledExitRunner';
import { DEFAULT_GRACE_MS } from './scheduleExit';

const MIN = 60_000;
const NOW = Date.parse('2026-08-28T12:00:00Z');

export function runScheduledExitRunnerTests() {
  console.log('\n🧪 예약청산 실행기 (제 시각에 나간다고 함부로 적지 않는다)');

  // ══ 워커가 살아 있으면 브라우저 없이 나간다 ══
  test('워커 신호가 최근이면 앱을 닫아도 나간다고 말할 수 있다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 30_000, overdue: 0, nowMs: NOW, appOpen: false,
    });
    eq(v.code, 'WORKER');
    eq(v.browserFree, true);
    eq(v.canBeOnTime, true);
  });

  test('워커 신호가 끊기면 앱을 닫으면 안 나간다고 말한다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 30 * MIN, overdue: 0, nowMs: NOW, appOpen: false,
    });
    eq(v.code, 'WORKER_STALE');
    eq(v.browserFree, false);
    eq(v.canBeOnTime, false);
  });

  test('워커가 끊겨도 앱이 열려 있으면 그 사실을 정확히 말한다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 30 * MIN, overdue: 0, nowMs: NOW, appOpen: true,
    });
    eq(v.code, 'BROWSER_ONLY');
    eq(v.browserFree, false);
    assert(v.text.includes('앱을 닫거나'), `무엇이 위험한지 말한다 — ${v.text}`);
  });

  // ══ 모르는 것을 "나간다"로도 "안 나간다"로도 적지 않는다 ══
  test('워커 상태를 못 읽었으면 확인하지 못했다고 말한다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: null, overdue: 0, nowMs: NOW, appOpen: true,
    });
    eq(v.code, 'UNKNOWN');
    eq(v.canBeOnTime, false);
    assert(v.text.includes('확인하지 못했습니다'), `모른다고 말한다 — ${v.text}`);
  });

  // ══ **증거가 보고를 이긴다** ══
  test('놓친 예약이 있으면 워커가 살아 있어도 "제 시각에 나간다"고 하지 않는다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 10_000, overdue: 2, nowMs: NOW, appOpen: true,
    });
    // 워커는 살아 있다고 보고됐지만, 실제로 놓친 것이 있다.
    eq(v.code, 'WORKER');
    eq(v.canBeOnTime, false);
    assert(v.text.includes('2건'), `몇 건인지 말한다 — ${v.text}`);
    assert(v.text.includes('자동으로 나가지 않습니다'), '무슨 일이 일어났는지 말한다');
  });

  test('놓친 예약을 못 셌으면(null) 0건으로 읽지 않는다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 10_000, overdue: null, nowMs: NOW, appOpen: false,
    });
    // **못 센 것을 "놓친 것 없음"으로 바꾸지 않는다.**
    eq(v.overdue, null);
    eq(v.code, 'WORKER');
  });

  test('워커 신선도 경계에서 뒤집힌다', () => {
    const at = (lag: number) => scheduledExitRunnerOf({
      workerLastSeenMs: NOW - lag, overdue: 0, nowMs: NOW, appOpen: false,
    }).code;
    eq(at(WORKER_FRESH_MS), 'WORKER');
    eq(at(WORKER_FRESH_MS + 1), 'WORKER_STALE');
  });

  // ══ 놓친 예약 세기 ══
  test('유예를 넘긴 살아 있는 예약만 센다', () => {
    const rows = [
      { run_at: new Date(NOW - 90 * MIN).toISOString() },                       // 놓쳤다
      { run_at: new Date(NOW - 10 * MIN).toISOString() },                       // 아직 유예 안
      { run_at: new Date(NOW + 60 * MIN).toISOString() },                       // 미래
      { run_at: new Date(NOW - 90 * MIN).toISOString(), fired_at: 'x' },        // 이미 쐈다
      { run_at: new Date(NOW - 90 * MIN).toISOString(), cancelled_at: 'x' },    // 취소했다
      { run_at: new Date(NOW - 90 * MIN).toISOString(), enabled: false },       // 꺼 뒀다
    ];
    eq(overdueExitsOf(rows, NOW, DEFAULT_GRACE_MS), 1);
  });

  test('목록을 못 읽었으면 0이 아니라 null이다', () => {
    // **0으로 세면 실행기가 죽어 있어도 화면이 초록이 된다.**
    eq(overdueExitsOf(null, NOW, DEFAULT_GRACE_MS), null);
    eq(overdueExitsOf(undefined, NOW, DEFAULT_GRACE_MS), null);
    eq(overdueExitsOf([], NOW, DEFAULT_GRACE_MS), 0);
  });

  test('유예 경계에서 세는 기준이 바뀐다', () => {
    const at = (ago: number) => overdueExitsOf(
      [{ run_at: new Date(NOW - ago).toISOString() }], NOW, DEFAULT_GRACE_MS);
    eq(at(DEFAULT_GRACE_MS), 0);
    eq(at(DEFAULT_GRACE_MS + 1), 1);
  });

  test('시각을 못 읽은 줄은 놓친 것으로 세지 않는다', () => {
    eq(overdueExitsOf([{ run_at: 'not-a-date' }], NOW, DEFAULT_GRACE_MS), 0);
  });

  // ══ 실행 주기가 유예 안에 들어오는가 ══
  test('워커 주기(60초)는 유예(30분) 안에 충분히 들어온다', () => {
    // GitHub 예약은 실측 중앙값 50분이라 유예를 넘겼다. 그게 이 작업의 이유다.
    const workerIntervalMs = 60_000;
    assert(workerIntervalMs * 2 < DEFAULT_GRACE_MS,
      '실행 주기가 유예의 절반보다 짧아야 한 회차를 놓쳐도 유예 안에 들어온다');
  });

  // ══════════════════════════════════════════════════════════════
  // 숫자를 엄격하게 읽는가 — **못 읽은 것은 0도 전량도 아니다**
  // ══════════════════════════════════════════════════════════════
  //
  // 예약 청산 라우트에 두 줄이 있었다:
  //
  //     const amt = Number(rr.risk.positionAmt) || 0;
  //     const pct = row.portion_pct == null ? 100 : Number(row.portion_pct);
  //
  // 첫 줄은 `'NaN'`·`''`·`'abc'`를 **0**으로 바꾼다. 그러면 바로 아래
  // `amt === 0` 분기가 예약을 `no_position`으로 닫는다 — 포지션은 열려
  // 있는데 예약이 사라져서 **그 청산이 영원히 나가지 않는다.**
  //
  // 둘째 줄은 `'NaN'`을 NaN으로 만들고, Gate 분기의 `pct < 100`이
  // NaN 때문에 **false**가 되어 부분청산 차단을 지나간다 —
  // `closePositionGateFutures`는 **전량 종료**다.
  //
  // 둘 다 "확인하지 못한 것을 통과로 적는" 모양이고, 하필 **못 닫는
  // 쪽**과 **너무 많이 닫는 쪽**으로 갈라진다.

  // ── 정상 0 ──
  //
  // 0 자체는 문제가 아니다. **읽었고 0인 것**은 "닫을 것이 없다"다.
  test('★ 포지션 수량이 정말 0이면 flat이고 실패가 아니다', () => {
    for (const raw of [0, '0', '0.0', '-0', '0e0']) {
      const r = positionAmountRead(raw);
      eq(r.ok, true, `읽었고 0인데 실패로 적었다: ${JSON.stringify(raw)}`);
      eq(r.flat, true, `0인데 flat이 아니다: ${JSON.stringify(raw)}`);
      eq(r.amount, 0);
      eq(r.side, null, '0에는 방향이 없다');
    }
  });

  // ── LONG / SHORT ──
  test('★ 부호로 LONG·SHORT를 가르고 수량을 그대로 들고 나온다', () => {
    const long = positionAmountRead('0.010');
    eq(long.ok, true); eq(long.flat, false);
    eq(long.side, 'LONG'); eq(long.amount, 0.01);

    const short = positionAmountRead('-0.010');
    eq(short.ok, true); eq(short.flat, false);
    eq(short.side, 'SHORT'); eq(short.amount, -0.01);

    // 숫자 타입으로 와도 같다
    eq(positionAmountRead(2.5).side, 'LONG');
    eq(positionAmountRead(-2.5).side, 'SHORT');
  });

  // ── 손상된 포지션 응답 ──
  //
  // **이 줄들이 전에는 전부 `flat: true`로 끝났다.**
  test('★ 손상된 포지션 수량은 실패다 — 0으로 읽지 않는다', () => {
    for (const raw of [
      'NaN', 'Infinity', '-Infinity', '', '   ', 'abc', '1.2.3', '0x10',
      NaN, Infinity, -Infinity, true, false, [], {}, [0], '--1', '+-1',
    ] as unknown[]) {
      const r = positionAmountRead(raw);
      eq(r.ok, false, `손상된 값을 읽었다고 적었다: ${JSON.stringify(raw)}`);
      eq(r.flat, false, `손상된 값을 "포지션 없음"으로 읽었다: ${JSON.stringify(raw)}`);
      eq(r.amount, null, `손상된 값에 수량을 붙였다: ${JSON.stringify(raw)}`);
      eq(r.side, null);
      eq(r.code, 'UNREADABLE');
    }
  });

  test('★ 값이 아예 없으면 MISSING이고 flat이 아니다', () => {
    for (const raw of [null, undefined]) {
      const r = positionAmountRead(raw);
      eq(r.ok, false); eq(r.code, 'MISSING');
      eq(r.flat, false, '없는 것을 "포지션 0"으로 읽지 않는다');
    }
  });

  // ── 유효한 부분 청산 ──
  test('★ 유효한 부분 청산 비율은 그대로 통과하고 full이 아니다', () => {
    for (const [raw, want] of [
      [25, 25], ['25', 25], ['33.5', 33.5], [0.5, 0.5], ['99.999', 99.999],
    ] as Array<[unknown, number]>) {
      const r = exitPortionRead(raw);
      eq(r.ok, true, `유효한 비율을 막았다: ${JSON.stringify(raw)}`);
      eq(r.pct, want);
      eq(r.full, false, `부분 청산을 전량으로 읽었다: ${JSON.stringify(raw)}`);
    }
  });

  test('★ 100은 전량이고, 비율을 안 정했으면(null) 전량이다 (기존 계약)', () => {
    for (const raw of [100, '100', '100.0']) {
      const r = exitPortionRead(raw);
      eq(r.ok, true); eq(r.pct, 100); eq(r.full, true);
    }
    for (const raw of [null, undefined]) {
      const r = exitPortionRead(raw);
      eq(r.ok, true, '정하지 않은 것은 깨진 것이 아니다');
      eq(r.pct, 100); eq(r.full, true);
    }
  });

  // ── 손상된 비율 ──
  //
  // **`full`이 true가 되면 Gate에서 전량 청산이 나간다.**
  // 그래서 여기서 `full: false`를 같이 못 박는다.
  test('★ 손상된 청산 비율은 실패다 — 전량으로 읽지 않는다', () => {
    for (const raw of [
      'NaN', 'Infinity', '', '   ', 'abc', NaN, Infinity, -Infinity,
      true, [], {}, '50%', '1/2',
    ] as unknown[]) {
      const r = exitPortionRead(raw);
      eq(r.ok, false, `손상된 비율을 읽었다고 적었다: ${JSON.stringify(raw)}`);
      eq(r.full, false, `손상된 비율을 전량으로 읽었다 — Gate에서 전량 청산이 나간다: ${JSON.stringify(raw)}`);
      eq(r.pct, null);
      eq(r.code, 'UNREADABLE');
    }
  });

  test('★ 범위를 벗어난 비율은 OUT_OF_RANGE이고 전량이 아니다', () => {
    for (const raw of [0, '0', -1, '-25', 100.1, '101', 1000]) {
      const r = exitPortionRead(raw);
      eq(r.ok, false, `쓸 수 없는 비율을 통과시켰다: ${JSON.stringify(raw)}`);
      eq(r.code, 'OUT_OF_RANGE');
      eq(r.full, false, `범위를 벗어난 값을 전량으로 읽었다: ${JSON.stringify(raw)}`);
      eq(r.pct, null);
    }
  });

  // ── 바탕 파서 ──
  //
  // `Number()`를 그대로 쓰면 `''`→0 · `[]`→0 · `true`→1이 된다.
  // 거래소 응답이 비어서 온 것을 "0개 보유"로 읽는 길이 그 변환이다.
  test('★ strictFinite는 Number()가 0·1로 바꾸던 값들을 null로 돌린다', () => {
    for (const raw of ['', '  ', [], true, false, {}, null, undefined, 'NaN', 'Infinity']) {
      eq(strictFinite(raw), null, `추측했다: ${JSON.stringify(raw)}`);
    }
    eq(strictFinite('1e-7'), 1e-7, '지수 표기는 거래소가 실제로 보낸다');
    eq(strictFinite(' -0.5 '), -0.5, '앞뒤 공백은 떼고 읽는다');
    eq(strictFinite('.5'), 0.5);
  });

}
