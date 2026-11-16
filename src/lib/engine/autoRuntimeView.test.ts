// src/lib/engine/autoRuntimeView.test.ts
//
// **화면이 운영 사실을 지어내지 못하게 한다.**
//
// 2026-08-19 실측: main = Vercel = Fly = 3c46151, deployment MATCHED,
// Fly Worker alive. 그런데 자동 화면은 "Worker (Railway) · 없음",
// "자동매매는 Vercel 크론이 돌립니다", "Railway 워커는 Binance 지역
// 차단으로 쓰지 않습니다"라고 말하고 있었다. 전부 예전에는 사실이었고
// 지금은 아니다 — 화면이 자신 있게 틀린 말을 했다.

import { test, eq, assert } from '../../test/harness';
import { autoRuntimeView, runtimeContradictions, agoText, deploymentFactsOf } from './autoRuntimeView';
import { deploymentVerdict, runtimeSkew } from '../runtime/workerPlan';

const alive = (over: any = {}) => ({
  provider: 'Fly', status: 'running', workerId: '784ed315f23358',
  ageSec: 3, version: '3c46151abcdef', task: 'jobs+monitor', errorCount: 0, ...over,
});

export function runAutoRuntimeViewTests() {
  console.log('[자동 실행기 — 살아 있으면 살아 있다고 말한다]');

  test('**워커가 살아 있으면 정상으로 표시한다**', () => {
    const v = autoRuntimeView({ worker: alive(), deployment: { code: 'MATCHED' } });
    eq(v.health, 'RUNNING');
    eq(v.tone, 'GREEN');
    eq(v.canRun, true);
    eq(v.action, null);
    assert(v.title.includes('정상'), v.title);
  });

  test('**공급자 이름과 버전은 서버 값에서 온다**', () => {
    const v = autoRuntimeView({ worker: alive() });
    assert(v.detail.includes('Fly'), v.detail);
    assert(v.detail.includes('3c46151'), v.detail);
  });

  test('**공급자를 모르면 이름을 지어내지 않는다**', () => {
    // 'Railway'라고 적어 둔 것이 Fly로 옮긴 뒤에도 남아 화면이 거짓말을
    // 했다. 모를 때는 언제나 참인 말만 한다.
    const v = autoRuntimeView({ worker: alive({ provider: null }) });
    assert(v.detail.startsWith('실행기'), v.detail);
    assert(!/Railway|Fly/.test(v.detail), `모르는데 이름을 지어냈다: ${v.detail}`);
  });

  console.log('[자동 실행기 — 모르는 것을 없음이나 정상으로 바꾸지 않는다]');

  test('**조회 실패는 "없음"이 아니라 "확인 불가"다**', () => {
    const v = autoRuntimeView({ worker: { readFailed: true } });
    eq(v.health, 'UNKNOWN');
    eq(v.canRun, false);
    assert(/없다는 뜻이 아닙니다/.test(v.sub || ''), v.sub || '');
  });

  test('하트비트 행이 없으면 ABSENT이고 그건 빨강이다', () => {
    const v = autoRuntimeView({ worker: { status: 'absent' } });
    eq(v.health, 'ABSENT'); eq(v.tone, 'RED'); eq(v.canRun, false);
  });

  test('모르는 상태 문자열을 정상으로 눕히지 않는다', () => {
    for (const bad of ['ok', 'alive', 'yes', '???']) {
      const v = autoRuntimeView({ worker: { status: bad } });
      eq(v.health, 'UNKNOWN', `${bad}가 통과했다`);
      eq(v.canRun, false);
    }
  });

  test('지연은 실행 가능하되 그 사실을 말한다 — 느린 것과 죽은 것은 다르다', () => {
    const v = autoRuntimeView({ worker: alive({ status: 'degraded', ageSec: 40 }) });
    eq(v.health, 'DEGRADED'); eq(v.tone, 'YELLOW'); eq(v.canRun, true);
    assert(!!v.action, '지연인데 아무 말도 안 했다');
  });

  test('중단이면 무엇이 같이 멈추는지 말한다', () => {
    const v = autoRuntimeView({ worker: { status: 'stopped' } });
    eq(v.canRun, false);
    assert(/손절 감시/.test(v.sub || ''), v.sub || '');
  });

  console.log('[자동 실행기 — 배포가 어긋나면 정상이 아니다]');

  test('**워커가 살아 있어도 SHA가 다르면 다른 코드가 도는 것이다**', () => {
    const v = autoRuntimeView({
      worker: alive(), deployment: { code: 'MISMATCH', webSha: 'aaa', workerSha: 'bbb' },
    });
    eq(v.health, 'RUNNING');       // 살아 있는 것은 사실이다
    eq(v.tone, 'YELLOW');          // 그러나 초록으로 그리지 않는다
    assert(/배포 버전 불일치/.test(v.action || ''), v.action || '');
  });

  console.log('[자동 실행기 — 화면이 서로 다른 말을 하지 않는다]');

  test('**"실행 중"인데 워커가 없으면 모순으로 잡는다**', () => {
    const c = runtimeContradictions({ autoRunning: true, worker: { status: 'absent' } });
    assert(c.some(x => x.code === 'RUNNING_WITHOUT_WORKER'), JSON.stringify(c));
  });

  test('예약은 켜졌는데 실행기가 없으면 모순으로 잡는다', () => {
    const c = runtimeContradictions({ scheduleEnabled: true, worker: { status: 'absent' } });
    assert(c.some(x => x.code === 'SCHEDULE_WITHOUT_WORKER'), JSON.stringify(c));
  });

  test('배포 불일치도 모순으로 잡는다', () => {
    const c = runtimeContradictions({ worker: alive(), deployment: { code: 'MISMATCH' } });
    assert(c.some(x => x.code === 'DEPLOY_SKEW'), JSON.stringify(c));
  });

  test('**정상 상태에서는 모순이 없다** — 멀쩡한 화면에 경고를 띄우지 않는다', () => {
    const c = runtimeContradictions({
      autoRunning: true, scheduleEnabled: true,
      worker: alive(), deployment: { code: 'MATCHED' },
    });
    eq(c.length, 0, JSON.stringify(c));
  });

  console.log('[자동 실행기 — 서버 응답에서 배포 사실을 고르는 한 곳]');

  // ── 2026-11-01 ~ 11-13. 화면은 12일 동안 이 사고를 말하지 않았다 ──
  //
  // 워커가 96커밋 뒤처진 채 돌고 있었다. 서버는 그걸 알고 있었다 —
  // `skew`가 MISMATCH라고 적고 있었다. 그런데 화면은 `verdict.code`를
  // 먼저 읽고, 그 값이 `'UNKNOWN'`이었다. `??`는 null·undefined에서만
  // 넘어가므로 **`skew`로 넘어가는 길은 죽어 있었다.**
  //
  // 즉 `DEPLOY_SKEW` 경고도, "웹과 워커가 다른 코드를 돌리고 있습니다"도
  // 코드로는 있었지만 **켜질 수 없었다** — `CLAUDE.md`의 "만들어 놓고
  // 배선을 안 함". 그래서 그 선택 규칙을 한 곳에 두고 여기서 지킨다.

  test('★ 운영에서 난 그 응답이 화면까지 가면 경고가 켜진다 — 판정기부터 끝까지', () => {
    // 서버가 실제로 만들어 내던 모양 그대로 만든다 (손으로 적지 않는다).
    const dj = {
      verdict: deploymentVerdict({ mainSha: null, vercelSha: '220f8001', flySha: '4f6ee8c6' }),
      skew: runtimeSkew({ vercelSha: '220f8001', flySha: '4f6ee8c6' }),
      vercel: { sha: '220f8001' }, fly: { sha: '4f6ee8c6' },
    };
    const facts = deploymentFactsOf(dj);
    eq(facts.code, 'MISMATCH', JSON.stringify(dj.verdict));

    const c = runtimeContradictions({ worker: alive(), deployment: facts });
    assert(c.some(x => x.code === 'DEPLOY_SKEW'), JSON.stringify(c));

    const v = autoRuntimeView({ worker: alive(), deployment: facts });
    assert(v.sub === '웹과 워커가 다른 코드를 돌리고 있습니다', String(v.sub));
  });

  test('★ verdict가 모름이어도 skew가 아는 것을 덮지 않는다', () => {
    // verdict가 어떤 이유로든 UNKNOWN이면, 아는 쪽(skew)을 쓴다.
    const facts = deploymentFactsOf({
      verdict: { code: 'UNKNOWN' }, skew: { code: 'MISMATCH' },
      vercel: { sha: 'aaa1111' }, fly: { sha: 'bbb2222' },
    });
    eq(facts.code, 'MISMATCH');
  });

  test('★ skew는 판정을 내리기만 한다 — 모름을 "같다"로 풀어 주지 못한다', () => {
    // skew는 SHA 둘만 본다. 그걸로 "배포 끝"이라고 적으면 마이그레이션이
    // 안 됐어도 초록이 된다 — 모르는 것을 '같다'로 읽는 것이다.
    const facts = deploymentFactsOf({
      verdict: { code: 'UNKNOWN' }, skew: { code: 'MATCHED' },
      vercel: { sha: 'aaa1111' }, fly: { sha: 'aaa1111' },
    });
    eq(facts.code, 'UNKNOWN');
  });

  test('verdict가 확정이면 verdict를 쓴다 — skew보다 많이 본다', () => {
    // verdict는 마이그레이션까지 본다. skew는 SHA 둘만 본다.
    const facts = deploymentFactsOf({
      verdict: { code: 'MISMATCH' }, skew: { code: 'MATCHED' },
      vercel: { sha: 'aaa1111' }, fly: { sha: 'aaa1111' },
    });
    eq(facts.code, 'MISMATCH');
  });

  test('둘 다 없으면 "같다"로 읽지 않는다 — null이다', () => {
    eq(deploymentFactsOf({}).code, null);
    eq(deploymentFactsOf(null).code, null);
    eq(deploymentFactsOf({ verdict: {}, skew: {} }).code, null);
  });

  test('SHA도 같이 고른다 — 화면이 다시 응답 모양을 뒤지지 않게', () => {
    const facts = deploymentFactsOf({ vercel: { sha: 'aaa1111' }, fly: { sha: 'bbb2222' } });
    eq(facts.webSha, 'aaa1111');
    eq(facts.workerSha, 'bbb2222');
  });

  console.log('[자동 실행기 — 시각 표시]');

  test('마지막 확인 시각을 사람 말로 적는다', () => {
    eq(agoText(3), '방금 확인');
    eq(agoText(32), '32초 전');
    eq(agoText(240), '4분 전');
  });

  test('**시각을 모르면 "방금"이라고 하지 않는다**', () => {
    eq(agoText(null), '시각 모름');
    eq(agoText(undefined), '시각 모름');
  });
}
