// src/lib/engine/paperRunnerStatus.test.ts
//
// **이 시험이 지키는 것: "모른다"가 "돌고 있다"로 바뀌지 않는다.**
//
// 2026-11-16에 "모의매매 돌고 있냐"는 질문에 답하지 못했다. 화면은
// "켜져 있다"까지만 말했고, 그걸 깨우는 Fly 워커가 살아 있는지는 아무
// 데도 없었다. 워커가 꺼져 있으면 봇을 켜 두어도 **한 건도 돌지 않는다.**
import { test, eq, assert } from '../../test/harness';
import { paperRunnerStatus, UNKNOWN_INTERVAL_MS } from './paperRunnerStatus';

const NOW = 1_800_000_000_000;
const base = {
  nowMs: NOW, enabledBots: 2,
  workerLastSeen: NOW - 5_000,
  lastRunAt: NOW - 20_000,
  shortestIntervalSec: 60,
};

export function runPaperRunnerStatusTests() {
  console.log('[모의 자동매매 가동 — 모르는 것을 "돌고 있다"로 적지 않는다]');

  test('켜진 봇이 있고 실행기가 살아 있고 회차가 신선하면 돌고 있다', () => {
    const s = paperRunnerStatus(base);
    eq(s.code, 'RUNNING');
    eq(s.running, true);
    eq(s.enabledBots, 2);
  });

  // ★ 이 시험이 이 파일의 이유다.
  test('★ 심장박동 조회가 실패하면 running은 false다 — 정상이라 말하지 않는다', () => {
    const s = paperRunnerStatus({ ...base, workerLastSeen: null, heartbeatReadFailed: true });
    eq(s.code, 'RUNNER_UNKNOWN');
    eq(s.running, false);
    assert(/조회하지 못했습니다/.test(s.reason), s.reason);
  });

  // **"못 읽었다"와 "없다"는 다른 사실이다.** 같은 문장으로 적으면
  // 둘 중 하나는 거짓말이 된다.
  test('조회는 됐는데 워커 행이 없으면 "모름"이 아니라 "없음"이다', () => {
    const s = paperRunnerStatus({ ...base, workerLastSeen: null });
    eq(s.code, 'RUNNER_DOWN');
    eq(s.running, false);
    assert(/등록되어 있지 않습니다/.test(s.reason), s.reason);
  });

  test('★ 실행기가 오지 않으면 켜 두어도 아무도 안 돌린다고 적는다', () => {
    // WORKER_STALE_MS보다 확실히 오래 — 하루 전
    const s = paperRunnerStatus({ ...base, workerLastSeen: NOW - 86_400_000 });
    eq(s.code, 'RUNNER_DOWN');
    eq(s.running, false);
    assert(/아무도 돌리지 않습니다/.test(s.reason), s.reason);
  });

  test('켠 봇이 없으면 고장이 아니다 — 실행기가 죽어 있어도 OFF다', () => {
    const s = paperRunnerStatus({ ...base, enabledBots: 0, workerLastSeen: NOW - 86_400_000 });
    eq(s.code, 'OFF');
    eq(s.running, false);
    assert(/고장이 아닙니다/.test(s.reason), s.reason);
  });

  test('실행기는 살아 있는데 회차 기록이 없으면 돌고 있다고 하지 않는다', () => {
    const s = paperRunnerStatus({ ...base, lastRunAt: null });
    eq(s.code, 'NEVER_RAN');
    eq(s.running, false);
    eq(s.ageMs, null);
  });

  test('마지막 회차가 주기의 10배를 넘으면 밀린 것이다', () => {
    // 주기 60초 → 600초를 넘으면 STALE
    const s = paperRunnerStatus({ ...base, lastRunAt: NOW - 601_000 });
    eq(s.code, 'OVERDUE');
    eq(s.running, false);
  });

  test('주기의 3배를 넘으면 늦었다고 적되 돌고 있는 것은 맞다', () => {
    const s = paperRunnerStatus({ ...base, lastRunAt: NOW - 200_000 });
    eq(s.code, 'RUNNING');
    eq(s.running, true);
    eq(s.freshness, 'LAGGING');
    assert(/평소보다 늦습니다/.test(s.reason), s.reason);
  });

  // 봇 주기를 모를 때 `assess`의 POLLED 기본값(10초)을 그대로 쓰면
  // 1분 전 회차도 '멈춤'이 된다 — 모른다는 이유로 빨간불을 켜지 않는다.
  test('주기를 모르면 보수적인 간격을 쓴다 — 모른다고 빨간불을 켜지 않는다', () => {
    const s = paperRunnerStatus({ ...base, shortestIntervalSec: null, lastRunAt: NOW - 60_000 });
    eq(s.code, 'RUNNING');
    const stale = paperRunnerStatus({
      ...base, shortestIntervalSec: null, lastRunAt: NOW - (UNKNOWN_INTERVAL_MS * 10 + 1_000),
    });
    eq(stale.code, 'OVERDUE');
  });

  test('ISO 문자열 시각도 읽는다 — 라우트가 주는 모양 그대로', () => {
    const s = paperRunnerStatus({
      ...base,
      workerLastSeen: new Date(NOW - 5_000).toISOString(),
      lastRunAt: new Date(NOW - 20_000).toISOString(),
    });
    eq(s.code, 'RUNNING');
  });

  // 순서: 실행기가 죽었으면 회차가 신선해 보여도 RUNNER_DOWN이 먼저다.
  test('실행기가 죽었으면 회차가 신선해도 RUNNER_DOWN이다', () => {
    const s = paperRunnerStatus({
      ...base, workerLastSeen: NOW - 86_400_000, lastRunAt: NOW - 1_000,
    });
    eq(s.code, 'RUNNER_DOWN');
    eq(s.running, false);
  });
}
