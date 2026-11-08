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
  cadenceNote,
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
    eq(p.latestCheckMs, null, '대기 중이어도 다음 실행 완료 시각은 보장되지 않는다');
  });

  test('간격이 지났으면 실행기가 오는 대로다', () => {
    const p = nextRunPlan({ nowMs: NOW, lastRunAtMs: NOW - 90 * MIN, intervalMin: 60 });
    eq(p.state, 'DUE');
    // **단정하지 않는다.** GitHub Actions는 부하에 따라 늦는다.
    eq(p.latestCheckMs, null, 'cron 지연에는 보장된 상한이 없다');
    assert(!p.summary.includes('최대'), p.summary);
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

  test('켰는데 아직 안 돌았으면 실행기 주기를 완료 상한으로 주장하지 않는다', () => {
    const p = nextRunPlan({ nowMs: NOW, enabledAtMs: NOW - 2 * MIN, lastRunAtMs: null });
    eq(p.state, 'NEVER_RAN');
    eq(p.nextCheckMs, null, '모르는 시각을 지어내면 안 된다');
    eq(p.latestCheckMs, null);
    assert(p.summary.includes('보장되지'), p.summary);
    const line = nextRunLines({ nowMs: NOW, enabledAtMs: NOW - 2 * MIN, lastRunAtMs: null }, p)
      .find(l => l.label === '다음 확인 가능');
    assert(line?.value.includes('지연 가능') === true, String(line?.value));
    assert(line?.value.includes('최대') === false, String(line?.value));
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
    assert(l != null && l.value.includes('보장되지'), String(l?.value));
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

  // ── 주기를 약속하지 않는다 (#592 2번) ───────────────────────────
  //
  // 화면 세 자리가 "서버가 **15분마다** 확인합니다"라고 적고 있었다.
  // 그 15분은 `RUNNER_INTERVAL_MIN`, 즉 **워크플로에 선언된 값**이다.
  // 2026-11-07 실측에서 GitHub Actions `schedule`은 선언과 무관하게
  // 하루 4~5회만 돌았다(`autotrade-tick` 실측 4.9회/일 ≒ 294분 간격).
  // 즉 화면이 약속한 주기가 실제보다 **약 20배** 낙관적이었다.
  // `TrailPanel`은 "청산 감시가 5분마다"라고 적었는데 그건 Fly Worker의
  // 주기이고, 실측 대체 주기는 ~320분이다 — **64배**.
  //
  // 손절·트레일링 문구라 이쪽이 더 무겁다: 사용자는 약속을 읽고
  // 손절이 그 간격으로 확인된다고 믿는다.
  //
  // 고치는 방향은 "관측을 적는 것"이지만, `AutotradeControl`에는 관측값
  // (`runnerLastSeenMs`)이 **아예 없다.** 없는 관측을 꾸며 낼 수는 없으므로
  // 이 단계에서 하는 일은 **약속을 지우는 것**이다: 선언값임을 적고,
  // 관측이 주어지면 그것을 앞세운다. 그리고 그 문구를 **한 곳**에 둔다 —
  // 세 자리에 따로 적어 두면 언젠가 한쪽만 고쳐진다.
  console.log('[실행기 주기 문구 — 주기를 약속하지 않는다]');

  test('관측이 없으면 선언값이라고 적고 보장하지 않는다', () => {
    const n = cadenceNote({ declaredMin: 15, subject: '서버 실행기' });
    eq(n.code, 'DECLARED_ONLY', n.text);
    eq(n.agoMin, null);
    assert(n.text.includes('선언'), n.text);
    assert(n.text.includes('보장'), n.text);
  });

  test('★ 어떤 입력에서도 "N분마다"라고 약속하지 않는다', () => {
    const cases = [
      { declaredMin: 15, subject: '서버 실행기' },
      { declaredMin: 5, subject: '청산 감시' },
      { declaredMin: 15, lastSeenMs: 1_000_000, nowMs: 1_600_000, subject: '서버 실행기' },
      { declaredMin: 15, lastSeenMs: 1_000_000, nowMs: 99_000_000, subject: '서버 실행기' },
      { declaredMin: null, subject: '서버 실행기' },
      { declaredMin: 0, subject: '서버 실행기' },
      { declaredMin: 15, lastSeenMs: 2_000_000, nowMs: 1_000_000, subject: '서버 실행기' },
    ];
    for (const c of cases) {
      const t = cadenceNote(c as never).text;
      assert(!t.includes('분마다'), `★ 주기를 약속했다 — ${t}`);
    }
  });

  test('관측이 있으면 마지막 확인이 언제였는지를 앞세운다', () => {
    const n = cadenceNote({
      declaredMin: 15, lastSeenMs: 1_000_000, nowMs: 1_000_000 + 7 * 60_000,
      subject: '서버 실행기',
    });
    eq(n.code, 'OBSERVED', n.text);
    eq(n.agoMin, 7);
    assert(n.text.includes('7분 전'), n.text);
    assert(n.text.includes('15'), `선언값도 같이 적는다 — ${n.text}`);
  });

  test('선언 주기를 크게 넘기면 STALE로 적는다 — 정상으로 적지 않는다', () => {
    const n = cadenceNote({
      declaredMin: 15, lastSeenMs: 0, nowMs: 294 * 60_000, subject: '서버 실행기',
    });
    eq(n.code, 'STALE', n.text);
    eq(n.agoMin, 294);
    assert(n.text.includes('넘겼'), n.text);
  });

  test('경계 — 선언 × 3배까지는 STALE이 아니다', () => {
    const ok = cadenceNote({ declaredMin: 15, lastSeenMs: 0, nowMs: 45 * 60_000 });
    eq(ok.code, 'OBSERVED', ok.text);
    const over = cadenceNote({ declaredMin: 15, lastSeenMs: 0, nowMs: 46 * 60_000 });
    eq(over.code, 'STALE', over.text);
  });

  test('주기를 모르면 "모른다"고 적는다 — 0분이나 정상으로 적지 않는다', () => {
    for (const d of [null, 0, -5, NaN]) {
      const n = cadenceNote({ declaredMin: d as never, subject: '서버 실행기' });
      eq(n.code, 'UNKNOWN', `declaredMin=${String(d)} — ${n.text}`);
      assert(/돌고 있다는 뜻도|알 수 없/.test(n.text), n.text);
      assert(!n.text.includes('0분'), `★ 모르는 것을 0분으로 적었다 — ${n.text}`);
    }
  });

  test('마지막 확인이 미래면(시계 어긋남) 그대로 믿지 않는다', () => {
    const n = cadenceNote({ declaredMin: 15, lastSeenMs: 2_000_000, nowMs: 1_000_000 });
    eq(n.code, 'UNKNOWN', n.text);
    eq(n.agoMin, null);
  });

  test('주기를 몰라도 관측이 있으면 관측은 적는다', () => {
    const n = cadenceNote({ declaredMin: null, lastSeenMs: 0, nowMs: 12 * 60_000 });
    eq(n.agoMin, 12, n.text);
    assert(n.text.includes('12분 전'), n.text);
    assert(!n.text.includes('분마다'), n.text);
  });

  test('빈 입력에서 터지지 않는다', () => {
    eq(cadenceNote(null as never).code, 'UNKNOWN');
    eq(cadenceNote(undefined as never).agoMin, null);
  });
}
