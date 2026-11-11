// src/lib/autotrade/evaluationLoop.test.ts
//
// **이 판정이 틀리면 두 방향 모두 사고다.**
//
// 너무 자주 due면 조건이 맞는 동안 매 분 진입한다. 너무 드물게 due면
// 켜 놓은 자동매매가 안 돈다 — 그리고 그건 아무 오류도 안 내므로
// 아무도 모른다. 이 저장소에서 실제로 일어난 쪽은 후자다.

import { test, eq, assert } from '../../test/harness';
import {
  dueCheck, nextEvaluationAtMs, runtimeStateOf, verdictOfOutcome, resultLineOf,
  msOf, MIN_GAP_MS, RUNNER_LATE_FACTOR, dueDiagnostics,
} from './evaluationLoop';
import { envOfMode } from './evaluationRunner';

const MIN = 60_000;
const NOW = 1_800_000_000_000;   // 고정 시각 — Date.now()를 쓰면 테스트가 시간에 따라 흔들린다

export function runEvaluationLoopTests() {
  console.log('[자동매매 주기 — 지금 평가할 차례인가]');

  test('꺼져 있으면 평가하지 않는다', () => {
    const v = dueCheck({ nowMs: NOW, enabled: false, lastRunAtMs: null, intervalMin: 60 });
    eq(v.due, false); eq(v.code, 'OFF');
  });

  test('enabled가 true가 아닌 모든 값은 꺼진 것이다', () => {
    // 'true' 문자열, 1, null 전부 켜진 것이 아니다. 느슨하게 읽으면
    // 사용자가 끈 예약이 계속 돈다.
    for (const e of ['true', 1, null, undefined, 'yes']) {
      eq(dueCheck({ nowMs: NOW, enabled: e as any, lastRunAtMs: null }).code, 'OFF', String(e));
    }
  });

  test('한 번도 안 돌았으면 지금 돌린다 — 켠 직후 첫 평가', () => {
    const v = dueCheck({ nowMs: NOW, enabled: true, lastRunAtMs: null, intervalMin: 60 });
    eq(v.due, true); eq(v.code, 'FIRST');
  });

  test('마지막 평가 시각이 null인 것을 0으로 읽지 않는다', () => {
    // Number(null) === 0. 0으로 읽으면 1970년이 되고 언제나 '간격 지남'이
    // 되어, 한 번도 안 돈 예약이 DUE로 보인다. FIRST와 DUE는 다르다 —
    // 전자는 켠 직후이고 후자는 주기가 온 것이다.
    for (const v of [null, undefined, '']) {
      eq(dueCheck({ nowMs: NOW, enabled: true, lastRunAtMs: v, intervalMin: 60 }).code, 'FIRST', String(v));
    }
  });

  test('간격이 지났으면 평가한다', () => {
    const v = dueCheck({ nowMs: NOW, enabled: true, lastRunAtMs: NOW - 61 * MIN, intervalMin: 60 });
    eq(v.due, true); eq(v.code, 'DUE');
  });

  test('간격이 아직이면 남은 시간을 알려 준다', () => {
    const v = dueCheck({ nowMs: NOW, enabled: true, lastRunAtMs: NOW - 20 * MIN, intervalMin: 60 });
    eq(v.due, false); eq(v.code, 'WAITING'); eq(v.leftMin, 40);
  });

  test('방금 돌았으면 간격이 지났어도 다시 안 돈다 — 중복 클릭', () => {
    // 사용자가 스위치를 두 번 누르면 몇 초 안에 같은 요청이 두 번 온다.
    // 간격(분) 검사만으로는 **둘 다 통과한다** — 평가가 두 번 도는 것은
    // 주문이 두 번 나가는 것과 같다.
    const v = dueCheck({ nowMs: NOW, enabled: true, lastRunAtMs: NOW - 5_000, intervalMin: 1 });
    eq(v.due, false); eq(v.code, 'TOO_SOON');
    assert(MIN_GAP_MS >= 30_000, '최소 간격이 너무 짧으면 아무것도 못 막는다');
  });

  test('간격 0은 유효한 간격이 아니다 — 매 분 진입을 막는다', () => {
    // 0을 그대로 쓰면 간격이 통째로 사라진다.
    const v = dueCheck({ nowMs: NOW, enabled: true, lastRunAtMs: NOW - 10 * MIN, intervalMin: 0 });
    eq(v.due, false, '간격 0이 무제한이 됐다');
  });

  test('연결이 없으면 평가하지 않고 그 사실을 남긴다', () => {
    const v = dueCheck({ nowMs: NOW, enabled: true, connectionId: '', lastRunAtMs: null });
    eq(v.due, false); eq(v.code, 'NO_CONNECTION');
  });

  console.log('[자동매매 주기 — 다음은 언제인가]');

  test('안 돌았으면 다음 시각을 지어내지 않는다', () => {
    eq(nextEvaluationAtMs({ lastRunAtMs: null, intervalMin: 60 }), null);
  });

  test('마지막 평가 + 간격이 다음이다', () => {
    eq(nextEvaluationAtMs({ lastRunAtMs: NOW, intervalMin: 30 }), NOW + 30 * MIN);
  });

  test('ISO 문자열도 읽는다 — DB가 주는 모양이다', () => {
    const iso = new Date(NOW).toISOString();
    eq(msOf(iso), NOW);
    eq(nextEvaluationAtMs({ lastRunAtMs: iso, intervalMin: 15 }), NOW + 15 * MIN);
  });

  console.log('[자동매매 주기 — 결과를 무엇으로 적는가]');

  test('신호 없음은 실패가 아니라 감시다', () => {
    eq(verdictOfOutcome('NO_SIGNAL'), 'WATCHING');
    eq(verdictOfOutcome('ENTERED'), 'ENTERED');
    eq(verdictOfOutcome('BLOCKED'), 'BLOCKED');
    eq(verdictOfOutcome('FAILED'), 'ERROR');
  });

  test('모르는 값을 감시 중으로 적지 않는다', () => {
    eq(verdictOfOutcome('WHATEVER'), 'UNKNOWN');
    eq(verdictOfOutcome(''), 'UNKNOWN');
  });

  test('한 줄 요약에 결과와 사유가 같이 들어간다', () => {
    const s = resultLineOf('NO_SIGNAL', '점수 차이 8점이 최소 12점 미만');
    assert(s.startsWith('진입 안 함'), s);
    assert(s.includes('8점'), s);
  });

  test('요약이 없어도 결과는 남는다', () => {
    eq(resultLineOf('ENTERED', null), '진입');
  });

  console.log('[자동매매 상태 — enabled는 running이 아니다]');

  test('꺼져 있으면 꺼짐이다', () => {
    eq(runtimeStateOf({ nowMs: NOW, enabled: false }).state, 'OFF');
  });

  test('켰지만 아직 안 돌았으면 첫 평가 대기다', () => {
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true, lastRunAtMs: null,
      runnerLastSeenMs: NOW - 2 * MIN, intervalMin: 60,
    });
    eq(s.state, 'NEVER_RAN');
    eq(s.nextEvaluationAtMs, null, '안 돈 예약에 다음 시각을 지어내면 안 된다');
  });

  test('마지막 평가가 정상 관망이면 감시 중이다', () => {
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true, lastRunAtMs: NOW - 5 * MIN, lastOutcome: 'NO_SIGNAL',
      runnerLastSeenMs: NOW - 2 * MIN, intervalMin: 60,
    });
    eq(s.state, 'WATCHING');
    eq(s.tone, 'good', '정상 관망이 경고색이면 화면이 온통 노랑이 된다');
  });

  test('차단과 실패는 감시 중으로 뭉개지 않는다', () => {
    const mk = (o: string) => runtimeStateOf({
      nowMs: NOW, enabled: true, lastRunAtMs: NOW - 5 * MIN, lastOutcome: o,
      runnerLastSeenMs: NOW - 2 * MIN, intervalMin: 60,
    }).state;
    eq(mk('BLOCKED'), 'BLOCKED');
    eq(mk('FAILED'), 'FAILED');
    eq(mk('ENTERED'), 'ENTERED');
  });

  test('실행기가 안 오고 있으면 마지막 결과보다 그것이 먼저다', () => {
    // 마지막 판단이 '감시 중'이어도 그게 몇 시간 전 것이면 지금
    // 감시되고 있지 않다. 옛 결과를 현재 상태로 적으면 거짓말이다.
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - 600 * MIN, lastOutcome: 'NO_SIGNAL',
      runnerLastSeenMs: NOW - 600 * MIN, intervalMin: 60, runnerIntervalMin: 15,
    });
    eq(s.state, 'STALE');
    eq(s.tone, 'bad');
    assert(s.reason.includes('실행기'), s.reason);
  });

  test('한 주기 늦은 정도로는 멈췄다고 적지 않는다', () => {
    // 실행기는 부하에 따라 몇 분 늦는다. 그때마다 경고를 켜면 상시
    // 빨강이 되고, 진짜 멈췄을 때 아무도 안 본다.
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - 70 * MIN, lastOutcome: 'NO_SIGNAL',
      runnerLastSeenMs: NOW - 20 * MIN, intervalMin: 60, runnerIntervalMin: 15,
    });
    eq(s.state, 'WATCHING', s.reason);
    assert(RUNNER_LATE_FACTOR >= 2, '여유가 1배면 정상 지연이 매번 경고가 된다');
  });

  test('실행기 상태를 못 읽었으면 정상이라고 적지 않는다', () => {
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true, lastRunAtMs: null, runnerLastSeenMs: null, intervalMin: 60,
    });
    eq(s.runnerStale, null, '못 읽은 것을 false(정상)로 적으면 멈춘 실행기를 못 본다');
    assert(s.reason.includes('확인하지 못'), s.reason);
  });

  test('기록은 있는데 결과값이 없으면 감시 중이 아니라 확인 못 함이다', () => {
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true, lastRunAtMs: NOW - 5 * MIN, lastOutcome: null,
      runnerLastSeenMs: NOW - 2 * MIN, intervalMin: 60,
    });
    eq(s.state, 'UNKNOWN');
  });

  console.log('[자동매매 상태 — 모드가 실전인가]');

  test('LIVE 계열만 실전이다', () => {
    eq(envOfMode('LIVE_SMALL'), 'LIVE');
    eq(envOfMode('LIVE_LIMITED'), 'LIVE');
    eq(envOfMode('SHADOW_LIVE'), 'LIVE');
    eq(envOfMode('TESTNET'), 'TESTNET');
    eq(envOfMode('PAPER'), 'TESTNET');
    eq(envOfMode(null), 'TESTNET');
  });

  // ─────────────────────────────────────────────────────────────────────
  // **화면이 보는 상태와 틱을 막는 판정이 달랐다.**
  //
  // `runtimeStateOf`는 `dueCheck`를 부르지 않는다. 그래서 화면에는
  // `WATCHING`(감시 중)이 떠 있는데 실행기의 틱은 매번 `WAITING`으로
  // 돌아선다 — 2026-11-02~05 사이 `autotrade-tick` 12회차가 전부
  // `code:"WAITING"`이었고, 그 사실은 워크플로 로그에만 있었다.
  //
  // 조회 응답에는 `interval_min`·`last_run_at`·`nextEvaluationAtMs`가
  // 이미 실린다. 빠진 것은 **"그래서 지금 왜 안 도는가"** 하나다.
  // `dueDiagnostics`는 그 답을 `dueCheck` 정본에서 그대로 가져온다 —
  // 판정을 다시 쓰지 않는다 (`CLAUDE.md`: 같은 판단이 두 곳에 있으면
  // 언젠가 갈린다).
  // ─────────────────────────────────────────────────────────────────────

  console.log('[자동매매 주기 — 왜 안 도는지가 조회에 보인다]');

  test('진단은 dueCheck의 판정을 그대로 싣는다 — 다시 판단하지 않는다', () => {
    const row = { enabled: true, connectionId: 'c1',
      lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 };
    const d = dueDiagnostics({ nowMs: NOW, ...row });
    const v = dueCheck({ nowMs: NOW, ...row });
    eq(d.due.code, v.code, '코드가 갈렸다');
    eq(d.due.due, v.due, 'due가 갈렸다');
    eq(d.due.reason, v.reason, '이유 문구가 갈렸다');
    eq(d.due.leftMin, v.leftMin, 'leftMin이 갈렸다');
  });

  test('WAITING이면 남은 시간과 이유가 값으로 나온다', () => {
    const d = dueDiagnostics({ nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - MIN, intervalMin: 60 });
    eq(d.due.code, 'WAITING');
    eq(d.due.due, false);
    eq(d.due.leftMin, 59);
    assert(d.due.reason.includes('59분'), d.due.reason);
  });

  test('네 값이 한 번에 나온다 — interval·마지막·다음·판정', () => {
    const d = dueDiagnostics({ nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 });
    eq(d.intervalMin, 60, '적용된 간격');
    eq(d.lastEvaluationAtMs, NOW - 10 * MIN);
    eq(d.nextEvaluationAtMs, NOW - 10 * MIN + 60 * MIN);
    eq(d.due.code, 'WAITING');
    // 사람이 읽을 ISO 문자열도 같이 — 화면이 ms를 다시 포맷하지 않게
    eq(d.lastEvaluationAt, new Date(NOW - 10 * MIN).toISOString());
    eq(d.nextEvaluationAt, new Date(NOW - 10 * MIN + 60 * MIN).toISOString());
  });

  test('**간격이 비어 있으면 기본값이 적용된 사실이 보인다**', () => {
    // interval_min이 NULL이면 DEFAULT_INTERVAL_MIN(1440)이 쓰인다.
    // 표에 적힌 값과 실제로 쓰인 값이 다르면 그 사실이 보여야 한다 —
    // 안 보이면 "간격 60분으로 해 뒀는데 왜 안 도나"가 영원히 안 풀린다.
    const d = dueDiagnostics({ nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - 60 * MIN, intervalMin: null });
    eq(d.intervalMinRaw, null, '표에 적힌 값은 그대로 보여준다');
    eq(d.intervalMin, 1440, '실제로 쓰인 값');
    eq(d.intervalMinDefaulted, true, '기본값이 적용됐다는 사실');
    eq(d.due.code, 'WAITING', '하루 간격이면 1시간 뒤에도 아직이다');
  });

  test('0은 유효한 간격이 아니다 — 기본값으로 떨어진 사실이 보인다', () => {
    const d = dueDiagnostics({ nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - 60 * MIN, intervalMin: 0 });
    eq(d.intervalMinRaw, 0);
    eq(d.intervalMin, 1440);
    eq(d.intervalMinDefaulted, true);
  });

  test('한 번도 안 돌았으면 다음 시각은 null이고 FIRST다', () => {
    const d = dueDiagnostics({ nowMs: NOW, enabled: true,
      lastRunAtMs: null, intervalMin: 60 });
    eq(d.lastEvaluationAtMs, null);
    eq(d.lastEvaluationAt, null);
    eq(d.nextEvaluationAtMs, null, "'다음'이 아니라 '처음'이다");
    eq(d.nextEvaluationAt, null);
    eq(d.due.code, 'FIRST');
    eq(d.due.due, true);
  });

  test('꺼져 있으면 OFF이고 간격 계산을 하지 않는다', () => {
    const d = dueDiagnostics({ nowMs: NOW, enabled: false,
      lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 });
    eq(d.due.code, 'OFF');
    eq(d.due.due, false);
  });

  test('연결이 빈 문자열이면 NO_CONNECTION이 그대로 보인다', () => {
    const d = dueDiagnostics({ nowMs: NOW, enabled: true, connectionId: '  ',
      lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 });
    eq(d.due.code, 'NO_CONNECTION');
  });

  test('**시크릿이나 키를 싣지 않는다**', () => {
    const d: any = dueDiagnostics({ nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - MIN, intervalMin: 60,
      // 호출하는 쪽이 행을 통째로 넘겨도 진단은 아는 필드만 돌려준다
      apiKey: 'AK-should-not-appear', apiSecret: 'SK-should-not-appear',
      connectionId: 'c1',
    } as any);
    const flat = JSON.stringify(d);
    assert(!flat.includes('AK-should-not-appear'), '키가 응답에 들어갔다: ' + flat);
    assert(!flat.includes('SK-should-not-appear'), '시크릿이 응답에 들어갔다: ' + flat);
    // 돌려주는 키 집합이 고정이어야 새 필드가 조용히 새지 않는다
    eq(Object.keys(d).sort().join(','),
      ['due','intervalMin','intervalMinDefaulted','intervalMinRaw',
       'lastEvaluationAt','lastEvaluationAtMs',
       'nextEvaluationAt','nextEvaluationAtMs'].sort().join(','));
  });
}
