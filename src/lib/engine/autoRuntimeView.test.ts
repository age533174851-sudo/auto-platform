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
import { autoRuntimeView, runtimeContradictions, agoText } from './autoRuntimeView';

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

  // ── Preview에서 운영 Worker가 없는 것은 장애가 아니다 ──
  //
  // 미리보기 배포에 운영 Worker를 붙이지 않는다. 그 상태를 빨갛게
  // 그리면 **운영이 멀쩡한데 미리보기를 운영처럼 진단**하게 되고,
  // 사람이 운영을 고치러 간다.
  console.log('[실행기 — 어느 배포에서 보고 있는가]');

  test('Preview에서 "한 번도 보고한 적이 없습니다"라고 적지 않는다', () => {
    const v = autoRuntimeView({ worker: { status: 'absent' }, deployEnv: 'preview' });
    eq(v.health, 'ABSENT');
    eq(v.tone, 'GRAY', 'Preview에서 운영 Worker 없음을 빨갛게 칠했다');
    assert(!/한 번도 보고한 적이 없습니다/.test(v.sub || ''), v.sub || '');
    assert((v.sub || '').includes('운영 Worker는 여기에 보고하지 않습니다'), v.sub || '');
    assert((v.action || '').includes('운영 배포에서 확인'), v.action || '');
  });

  test('운영에서는 그대로 장애다', () => {
    const v = autoRuntimeView({ worker: { status: 'absent' }, deployEnv: 'production' });
    eq(v.health, 'ABSENT');
    eq(v.tone, 'RED', '운영에서 Worker가 없는데 회색으로 칠했다');
    assert((v.sub || '').includes('한 번도 보고한 적이 없습니다'), v.sub || '');
  });

  test('배포를 모르면 운영과 같은 엄격함이다', () => {
    // 느슨한 쪽이 기본값이면 언젠가 진짜 장애가 조용해진다.
    eq(autoRuntimeView({ worker: { status: 'absent' } }).tone, 'RED');
    eq(autoRuntimeView({ worker: { status: 'absent' }, deployEnv: null }).tone, 'RED');
  });

  test('Preview에서 "예약은 켜져 있는데 실행기가 없다"를 모순으로 적지 않는다', () => {
    const c = runtimeContradictions({
      scheduleEnabled: true, worker: { status: 'absent' }, deployEnv: 'preview',
    });
    eq(c.filter(x => x.code === 'SCHEDULE_WITHOUT_WORKER').length, 0,
      'Preview에서 운영 예약을 모순으로 적었다');
  });

  test('운영에서는 그 모순을 그대로 적는다', () => {
    const c = runtimeContradictions({
      scheduleEnabled: true, worker: { status: 'absent' }, deployEnv: 'production',
    });
    eq(c.filter(x => x.code === 'SCHEDULE_WITHOUT_WORKER').length, 1);
  });

  test('Worker가 살아 있으면 배포 환경과 무관하게 정상이다', () => {
    const v = autoRuntimeView({
      worker: { ageSec: 3, status: 'running' }, deployEnv: 'preview',
    });
    assert(v.canRun, '살아 있는 워커를 못 돈다고 적었다');
  });
}
