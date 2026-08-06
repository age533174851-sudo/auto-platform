// src/lib/autotrade/nextRun.test.ts
//
// 막으려는 것:
//  1. **"다음 실행 매일 23:00 UTC"** — 실행기가 15분마다 도는데 화면은
//     하루 한 번을 가리켰다. 사용자는 켜 놓고 다음 날 아침까지 기다린다
//  2. 아직 안 돈 것을 '실행된 적 없음'으로 적어, 켜기가 실패한 줄 알게 하는 것
//  3. 간격 0을 유효한 값으로 읽어 매 분 진입하는 것
//  4. 서버 현지시각을 한국 시각인 척 적는 것
//  5. HTTP 200을 '주문 성공'으로 읽는 것 — 대부분의 응답은 관망이다
//  6. 중복 방지가 일한 것을 빨간 실패로 적어, 사용자가 다시 누르게 하는 것
import { test, assert, eq } from '../../test/harness';
import {
  nextRunPlan, nextRunLines, intervalMinOf, kstClock, fmtKst, fmtUtc,
  RUNNER_INTERVAL_MIN, DEFAULT_INTERVAL_MIN,
} from './nextRun';
import { classifyRun, blockCodeOf, savedButBlockedText, CONCURRENT_CODES } from './runOutcome';

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);   // 2026-08-06 12:00 UTC = 한국 21:00
const MIN = 60_000;

export function runAutotradeTimingTests() {
  console.log('[다음 실행 — 고정된 하루 한 번이 아니다]');

  test('마지막 점검 + 간격이 다음 확인 시각이다', () => {
    const p = nextRunPlan({ nowMs: NOW, lastRunAtMs: NOW - 20 * MIN, intervalMin: 60 });
    eq(p.state, 'WAITING');
    eq(p.nextCheckMs, NOW - 20 * MIN + 60 * MIN);
    assert(p.summary.includes('40분'), p.summary);
  });

  test('간격이 지났으면 실행기가 오는 대로다', () => {
    const p = nextRunPlan({ nowMs: NOW, lastRunAtMs: NOW - 90 * MIN, intervalMin: 60 });
    eq(p.state, 'DUE');
    // **단정하지 않는다.** GitHub Actions는 부하에 따라 늦는다.
    eq(p.latestCheckMs, NOW + RUNNER_INTERVAL_MIN * MIN);
    assert(p.summary.includes('15분'), p.summary);
  });

  test('방금 켰으면 "지금 첫 점검 중"이다', () => {
    // last_run_at이 없는 것과 영영 안 돌았다는 것은 다르다. 켜는 순간
    // 즉시 한 번 돌리므로, 그 몇 초를 '실행된 적 없음'으로 적으면
    // 사용자는 켜기가 실패한 줄 안다.
    const p = nextRunPlan({ nowMs: NOW, lastRunAtMs: null, firstCheckRunning: true });
    eq(p.state, 'FIRST_CHECK_RUNNING');
    eq(p.summary, '지금 첫 점검 중');
    const line = nextRunLines({ nowMs: NOW, firstCheckRunning: true }, p)
      .find(l => l.label === '다음 확인 가능');
    eq(line?.value, '지금 첫 점검 중');
  });

  test('켰는데 아직 안 돌았으면 실행기 주기를 상한으로 적는다', () => {
    const p = nextRunPlan({ nowMs: NOW, enabledAtMs: NOW - 2 * MIN, lastRunAtMs: null });
    eq(p.state, 'NEVER_RAN');
    eq(p.nextCheckMs, null, '모르는 시각을 지어내면 안 된다');
    eq(p.latestCheckMs, NOW - 2 * MIN + RUNNER_INTERVAL_MIN * MIN);
  });

  test('꺼져 있으면 다음 시각이 없다', () => {
    const p = nextRunPlan({ nowMs: NOW, lastRunAtMs: NOW - 5 * MIN, intervalMin: 60 }, false);
    eq(p.state, 'OFF');
    eq(p.nextCheckMs, null);
  });

  console.log('[다음 실행 — 간격 0은 간격이 아니다]');

  test('0이나 빈 값은 하루로 본다', () => {
    // 0으로 읽으면 간격이 통째로 사라져 조건이 맞는 동안 매 분 진입한다.
    eq(intervalMinOf(0), DEFAULT_INTERVAL_MIN);
    eq(intervalMinOf(null), DEFAULT_INTERVAL_MIN);
    eq(intervalMinOf(undefined), DEFAULT_INTERVAL_MIN);
    eq(intervalMinOf('아무거나'), DEFAULT_INTERVAL_MIN);
    eq(intervalMinOf(-5), DEFAULT_INTERVAL_MIN);
    eq(intervalMinOf(60), 60);
    eq(intervalMinOf(1), 1);
  });

  console.log('[다음 실행 — 한국 시각]');

  test('Asia/Seoul은 UTC보다 9시간 앞이다', () => {
    // 표시 문자열이 아니라 숫자로 확인한다. 문자열은 ICU에 따라 달라져서
    // "한국 시각이 맞는가"를 확인할 수 없고, 확인할 수 없으면 어느 날
    // 조용히 서버 현지시각으로 바뀌어도 아무도 모른다.
    eq(kstClock(Date.UTC(2026, 7, 6, 0, 0))?.hh, 9);
    eq(kstClock(Date.UTC(2026, 7, 6, 12, 0))?.hh, 21);
    // 자정을 넘어가는 경우 — '24시'로 주는 환경이 있다
    eq(kstClock(Date.UTC(2026, 7, 6, 15, 0))?.hh, 0);
    eq(kstClock(Date.UTC(2026, 7, 6, 15, 30))?.mm, 30);
  });

  test('한국은 서머타임이 없다 — 겨울과 여름이 같다', () => {
    eq(kstClock(Date.UTC(2026, 0, 15, 3, 0))?.hh, 12);
    eq(kstClock(Date.UTC(2026, 6, 15, 3, 0))?.hh, 12);
  });

  test('시각이 없으면 지어내지 않는다', () => {
    eq(kstClock(null), null);
    eq(kstClock(undefined), null);
    eq(fmtKst(null), '—');
    eq(fmtUtc(null), '—');
    eq(fmtKst(NaN), '—');
  });

  test('UTC 원문은 따로 준다 — 자세히 보기용', () => {
    const s = fmtUtc(Date.UTC(2026, 7, 6, 12, 0));
    assert(s.includes('2026-08-06'), s);
    assert(s.includes('UTC'), s);
  });

  console.log('[다음 실행 — 없는 것을 지어내지 않는다]');

  test('마지막 진입이 없으면 마지막 점검으로 채우지 않는다', () => {
    // 그 둘을 섞으면 "오늘 이미 들어갔나?"에 틀린 답을 준다.
    const lines = nextRunLines(
      { nowMs: NOW, lastRunAtMs: NOW - 10 * MIN, lastEntryAtMs: null, intervalMin: 60 },
      nextRunPlan({ nowMs: NOW, lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 }),
    );
    const entry = lines.find(l => l.label === '마지막 실제 진입');
    eq(entry?.value, '없음');
    eq(entry?.unknown, true);
    const run = lines.find(l => l.label === '마지막 점검');
    assert(run?.unknown !== true, '있는 값을 모름으로 적었다');
  });

  test('실행기 지연을 문구에 적는다 — 1분 늦은 것을 고장으로 읽지 않게', () => {
    const lines = nextRunLines(
      { nowMs: NOW, lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 },
      nextRunPlan({ nowMs: NOW, lastRunAtMs: NOW - 10 * MIN, intervalMin: 60 }),
    );
    const l = lines.find(x => x.label === '실행기 확인 주기');
    assert(l != null && l.value.includes('15분'), String(l?.value));
    assert(l != null && l.value.includes('늦을 수'), String(l?.value));
  });

  console.log('[실행 결과 — HTTP 200은 주문이 나갔다는 뜻이 아니다]');

  test('조건 불충족은 실패가 아니다', () => {
    const v = classifyRun({ status: 200, body: { ok: true, executed: false, reason: '진입 신호 없음' } });
    eq(v.outcome, 'WAITING');
    eq(v.tone, 'info', '관망을 빨간 실패로 적으면 매일이 고장으로 보인다');
    eq(v.ordered, false);
  });

  test('주문 결과 미확정을 체결로 읽지 않는다', () => {
    // 셋을 하나로 뭉치면 '나갔는지 모르는' 상태가 체결로 읽힌다.
    const v = classifyRun({ status: 200, body: { ok: true, executed: true, status: 'UNKNOWN' } });
    eq(v.outcome, 'ORDER_UNKNOWN');
    eq(v.tone, 'warn');
    eq(v.ordered, true, '보내긴 보냈다');
    assert((v.action || '').includes('대조'), v.action);
  });

  test('체결과 전송을 구분한다', () => {
    eq(classifyRun({ status: 200, body: { executed: true, status: 'FILLED' } }).outcome, 'ORDER_FILLED');
    eq(classifyRun({ status: 200, body: { executed: true, status: 'ACKED' } }).outcome, 'ORDER_SENT');
  });

  console.log('[실행 결과 — 중복 방지가 일한 것은 실패가 아니다]');

  test('이미 오늘 진입했으면 그렇게 적는다', () => {
    const v = classifyRun({ status: 409, body: { ok: false, blocked: 'ALREADY_TRADED' } });
    eq(v.outcome, 'ALREADY_TODAY');
    eq(v.tone, 'info', '정상 동작을 빨간 실패로 적으면 사용자가 다시 누른다');
  });

  test('동시 실행은 오류가 아니다', () => {
    for (const c of ['ALREADY_RUNNING', 'ALREADY_RESERVED']) {
      const v = classifyRun({ status: 409, body: { blocked: c } });
      eq(v.outcome, 'IN_PROGRESS', c);
      eq(v.tone, 'info', c);
    }
    eq(CONCURRENT_CODES.length, 3);
  });

  console.log('[실행 결과 — 무엇이 막았는지]');

  test('미확정 주문 차단은 따로 적는다', () => {
    const v = classifyRun({ status: 409, body: {
      blocked: 'CHECKLIST_BLOCKED',
      checklist: { allowed: false, unresolvedOrderCount: 10 },
    } });
    eq(v.outcome, 'BLOCKED_UNRESOLVED');
    assert(v.detail.includes('10'), v.detail);
    assert((v.action || '').includes('미확정 주문 확정'), v.action);
  });

  test('상태 불일치는 몇 건인지 적는다', () => {
    const v = classifyRun({ status: 409, body: {
      blocked: 'STATE_MISMATCH', mismatches: [{}, {}, {}],
    } });
    eq(v.outcome, 'BLOCKED_STATE_MISMATCH');
    assert(v.detail.includes('3건'), v.detail);
  });

  test('그 밖의 체크리스트 차단', () => {
    const v = classifyRun({ status: 409, body: {
      blocked: 'CHECKLIST_BLOCKED', error: '배율이 다릅니다',
      checklist: { allowed: false, blockers: [{ id: 'LEVERAGE_MATCH' }] },
    } });
    eq(v.outcome, 'BLOCKED_CHECKLIST');
    assert(v.detail.includes('배율'), v.detail);
  });

  test('차단 코드는 results 안에서도 찾는다', () => {
    eq(blockCodeOf({ results: [{ blocked: 'ALREADY_TRADED' }] }), 'ALREADY_TRADED');
    eq(blockCodeOf({ blocked: 'state_mismatch' }), 'STATE_MISMATCH', '대소문자로 갈리면 안 된다');
    eq(blockCodeOf({}), '');
    eq(blockCodeOf(null), '');
  });

  console.log('[실행 결과 — 예약이 켜진 사실을 숨기지 않는다]');

  test('첫 실행이 막혀도 예약은 살아 있다고 적는다', () => {
    // "실패"만 적으면 사용자는 자동매매가 안 켜진 줄 알고 다시 누르고,
    // 그러면 같은 자리에서 또 막힌다.
    const v = classifyRun({ status: 409, body: {
      blocked: 'CHECKLIST_BLOCKED', checklist: { allowed: false, unresolvedOrderCount: 3 },
    } });
    const t = savedButBlockedText(v);
    assert(t.includes('자동매매는 켜졌지만'), t);
    assert(t.includes('예약은 그대로'), t);
  });

  test('막히지 않았으면 그 문구를 안 붙인다', () => {
    // 늘 붙으면 아무도 안 읽는다.
    eq(savedButBlockedText(classifyRun({ status: 200, body: { ok: true, executed: false } })), '');
    eq(savedButBlockedText(classifyRun({ status: 200, body: { executed: true, status: 'FILLED' } })), '');
    eq(savedButBlockedText(classifyRun({ status: 409, body: { blocked: 'ALREADY_TRADED' } })), '');
  });

  test('응답이 없으면 성공으로도 실패로도 단정하지 않는다', () => {
    const v = classifyRun(null);
    eq(v.outcome, 'ERROR');
    assert(v.detail.includes('저장되었을 수 있습니다'), v.detail);
  });

  test('크론 모양(results[])도 읽는다', () => {
    eq(classifyRun({ status: 200, body: { ok: true, results: [{ executed: true }] } }).outcome, 'ORDER_SENT');
    const skipped = classifyRun({ status: 200, body: {
      ok: true, results: [{ skipped: true, detail: '아직 간격 안 됨 — 40분 남음' }],
    } });
    eq(skipped.outcome, 'WAITING');
    assert(skipped.detail.includes('40분'), skipped.detail);
  });
}
