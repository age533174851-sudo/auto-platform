// src/lib/engine/exitMonitorWake.test.ts
//
// **⑤B-3A-1.1 — 누가 깨웠는지를 틀리게 적지 않는가.**
//
// 여기서 지키는 핵심은 하나다: 헤더가 없다고 `manual`로 적지 않는다.
// Vercel Cron은 Bearer로 들어오면서 source 헤더를 보내지 않기 때문에,
// 그 추측이 실제 자동 호출 전부를 거짓으로 적게 만들었다.
import { test, assert, eq } from '../../test/harness';
import {
  resolveWakeSource, resolveWakeCadence, wakeCadenceHeaders,
  WAKE_SOURCE_CRON_BEARER, WAKE_SOURCE_UNATTRIBUTED_ADMIN,
  WAKE_INTERVAL_HEADER, WAKE_EXPECTED_AT_HEADER,
} from './exitMonitorWake';

const NOW = 1_780_000_000_000;

export function runExitMonitorWakeTests() {
  // ── source ──

  test('명시한 source는 그대로 보존된다', () => {
    eq(resolveWakeSource('worker', 'ADMIN_HEADER'), 'worker');
    eq(resolveWakeSource('github-backup', 'ADMIN_HEADER'), 'github-backup');
    // 사람이 직접 명시한 manual은 **진짜 manual이다**
    eq(resolveWakeSource('manual', 'ADMIN_HEADER'), 'manual');
  });

  test('★ 헤더가 없다고 manual로 적지 않는다', () => {
    for (const empty of [null, undefined, '', '   ']) {
      for (const kind of ['CRON_BEARER', 'ADMIN_HEADER'] as const) {
        const got = resolveWakeSource(empty, kind);
        assert(got !== 'manual',
          `★ source 헤더가 없는데 manual로 적었다 (${kind}) — Vercel cron이 전부 manual이 된다`);
        assert(got != null, `인증된 호출인데 출처가 비었다 (${kind})`);
      }
    }
  });

  test('★ Bearer cron과 admin 호출이 같은 이름이 되지 않는다', () => {
    const cron = resolveWakeSource(null, 'CRON_BEARER');
    const admin = resolveWakeSource(null, 'ADMIN_HEADER');
    eq(cron, WAKE_SOURCE_CRON_BEARER);
    eq(admin, WAKE_SOURCE_UNATTRIBUTED_ADMIN);
    assert(cron !== admin,
      '★ 두 인증 경로를 한 이름으로 합쳤다 — 어느 쪽이 깨웠는지 영구히 알 수 없게 된다');
  });

  test('인증 실패는 출처가 없다 (실행 자체가 없다)', () => {
    eq(resolveWakeSource(null, 'NONE'), null);
    // 다만 명시한 값이 있으면 그 값은 그대로다 — 인증 판단은 여기가 아니다
    eq(resolveWakeSource('worker', 'NONE'), 'worker');
  });

  // ── cadence ──

  test('헤더가 있으면 실제 간격과 지연을 적는다', () => {
    const c = resolveWakeCadence({
      intervalHeader: '300000',
      expectedAtHeader: String(NOW - 12_000),
      observedAtMs: NOW,
    });
    eq(c.intervalMs, 300_000);
    eq(c.delayMs, 12_000);
  });

  test('★ 예정 시각을 모르면 지연은 null이다 — 0도 5분도 아니다', () => {
    for (const exp of [null, undefined, '', 'abc', '0', '-1']) {
      const c = resolveWakeCadence({ intervalHeader: '300000', expectedAtHeader: exp, observedAtMs: NOW });
      eq(c.delayMs, null, `★ 예정 시각 없이 지연을 적었다 (${String(exp)})`);
      assert(c.delayMs !== 0, '★ 모르는 지연을 0으로 적었다 — 0은 "정시"라는 다른 사실이다');
      assert(c.delayMs !== 300_000, '★ 모르는 지연을 5분으로 추정했다');
    }
  });

  test('★ 간격을 모르면 null이다 — 라우트가 5분을 가정하지 않는다', () => {
    for (const iv of [null, undefined, '', 'abc', '0', '-5']) {
      const c = resolveWakeCadence({ intervalHeader: iv, expectedAtHeader: null, observedAtMs: NOW });
      eq(c.intervalMs, null, `★ 간격 없이 값을 적었다 (${String(iv)})`);
      assert(c.intervalMs !== 300_000, '★ 모르는 간격을 5분 상수로 채웠다');
    }
  });

  test('초 단위로 잘못 온 예정 시각은 쓰지 않는다', () => {
    // 1780000000(초)을 그대로 빼면 56년짜리 지연이 된다
    const c = resolveWakeCadence({ intervalHeader: null,
      expectedAtHeader: String(Math.floor(NOW / 1000)), observedAtMs: NOW });
    eq(c.delayMs, null);
  });

  test('일찍 깨어난 것도 부호로 그대로 적는다', () => {
    const c = resolveWakeCadence({ intervalHeader: null,
      expectedAtHeader: String(NOW + 4_000), observedAtMs: NOW });
    eq(c.delayMs, -4_000);
  });

  // ── 부르는 쪽 ──

  test('부르는 쪽은 실제 간격과 예정 시각을 보낸다', () => {
    const h = wakeCadenceHeaders({ lastRunMs: NOW - 300_000, intervalMs: 300_000 });
    eq(h[WAKE_INTERVAL_HEADER], '300000');
    eq(h[WAKE_EXPECTED_AT_HEADER], String(NOW));
  });

  test('★ 첫 tick에는 예정 시각 헤더를 보내지 않는다', () => {
    const h = wakeCadenceHeaders({ lastRunMs: null, intervalMs: 300_000 });
    eq(Object.prototype.hasOwnProperty.call(h, WAKE_EXPECTED_AT_HEADER), false,
      '★ 직전 실행이 없는데 예정 시각을 지어냈다');
    // 간격은 알고 있으니 보낸다
    eq(h[WAKE_INTERVAL_HEADER], '300000');
  });

  test('★ 모르는 값은 빈 문자열이 아니라 키 자체가 없다', () => {
    const h = wakeCadenceHeaders({ lastRunMs: null, intervalMs: null });
    eq(Object.keys(h).length, 0);
    for (const k of Object.keys(h)) assert(h[k] !== '', `빈 문자열을 보냈다 (${k})`);
  });

  test('부른 쪽의 간격이 바뀌면 적히는 값도 바뀐다 (상수가 아니다)', () => {
    const a = wakeCadenceHeaders({ lastRunMs: NOW, intervalMs: 90_000 });
    eq(a[WAKE_INTERVAL_HEADER], '90000');
    eq(a[WAKE_EXPECTED_AT_HEADER], String(NOW + 90_000));
  });

  test('보낸 헤더를 받는 쪽이 그대로 복원한다 (양쪽이 같은 정본이다)', () => {
    const h = wakeCadenceHeaders({ lastRunMs: NOW - 300_000, intervalMs: 300_000 });
    const c = resolveWakeCadence({
      intervalHeader: h[WAKE_INTERVAL_HEADER] ?? null,
      expectedAtHeader: h[WAKE_EXPECTED_AT_HEADER] ?? null,
      observedAtMs: NOW + 1_500,
    });
    eq(c.intervalMs, 300_000);
    eq(c.delayMs, 1_500);
  });

  // ── 권한과 섞이지 않는다 ──

  test('★ wake 모듈에 거래소를 바꿀 수단이 없다', async () => {
    const src = await import('./exitMonitorWake');
    for (const bad of ['sendClose', 'placeFuturesOrder', 'runExitAuthority',
                       'closePosition', 'authorized']) {
      eq(Object.keys(src).includes(bad), false, `★ ${bad}를 내보낸다`);
    }
  });

  test('★ cadence 결과에 판정 칸이 없다', () => {
    const c = resolveWakeCadence({ intervalHeader: '300000',
      expectedAtHeader: String(NOW), observedAtMs: NOW });
    for (const k of Object.keys(c)) {
      assert(!/threshold|verdict|should|allow|ok\b/i.test(k), `판정 칸 (${k})`);
    }
    eq(Object.keys(c).sort().join(','), 'delayMs,intervalMs');
  });
}
