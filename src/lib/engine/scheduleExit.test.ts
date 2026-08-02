// src/lib/engine/scheduleExit.test.ts
//
// 이 테스트가 막는 것: **예약해 놓고 안 나가는 것**, 그리고
// **예약한 적 없는 시각에 나가는 것.**
//
// 화면에 "15:30 매도 예약됨"이 뜨면 사람은 그 시각에 팔릴 것을 전제로
// 다른 결정을 한다. 그 전제가 틀리면 예약 기능이 없는 것보다 나쁘다.

import { test, eq, assert } from '../../test/harness';
import {
  checkDue, toUtcMs, validateSchedule, accuracyNote, fmtGap,
  DEFAULT_GRACE_MS, type ExitSchedule,
} from './scheduleExit';

export function runScheduleExitTests() {
  console.log('[시간 예약 청산 — 예약해 놓고 안 나가는 것이 가장 위험하다]');

  const NOW = Date.UTC(2026, 7, 2, 6, 0, 0);   // 2026-08-02 06:00 UTC
  const s = (o: Partial<ExitSchedule> = {}): ExitSchedule => ({
    symbol: 'BTCUSDT', runAtMs: NOW, action: 'CLOSE', enabled: true, ...o,
  });

  // ── 언제 실행하는가 ──────────────────────────────────────
  test('시각이 되면 due', () => {
    eq(checkDue(s(), NOW).verdict, 'due');
  });

  test('아직이면 waiting — 늦은 정도는 음수다', () => {
    const r = checkDue(s({ runAtMs: NOW + 60_000 }), NOW);
    eq(r.verdict, 'waiting');
    assert(r.latenessMs! < 0, `아직인데 늦음이 양수다: ${r.latenessMs}`);
  });

  test('유예 안이면 조금 늦어도 나간다', () => {
    eq(checkDue(s(), NOW + DEFAULT_GRACE_MS - 1000).verdict, 'due');
  });

  // **이 테스트가 이 파일의 이유다.**
  // 하루 1회 크론만 있으면 15:30 예약이 다음날 09:00에 나간다. 17시간 반
  // 늦게 시장가로 던지는 것은 사용자가 예약한 그 거래가 아니다.
  test('너무 늦으면 stale — 자동으로 안 나간다', () => {
    const r = checkDue(s(), NOW + DEFAULT_GRACE_MS + 1000);
    eq(r.verdict, 'stale');
    assert(r.reason.includes('늦'), r.reason);
  });

  test('17시간 늦은 예약은 절대 안 나간다', () => {
    eq(checkDue(s(), NOW + 17 * 3_600_000).verdict, 'stale');
  });

  test('꺼져 있으면 안 나가고, 이미 나갔으면 다시 안 나간다', () => {
    eq(checkDue(s({ enabled: false }), NOW).verdict, 'off');
    eq(checkDue(s({ firedAtMs: NOW - 1000 }), NOW).verdict, 'done');
  });

  // 0을 '지금'으로 읽으면 시각을 못 채운 예약이 만들어지자마자 나간다.
  test('시각이 없으면 invalid — 0을 지금으로 읽지 않는다', () => {
    for (const v of [0, null, undefined, NaN, -1]) {
      eq(checkDue(s({ runAtMs: v as any }), NOW).verdict, 'invalid', `runAtMs=${v}`);
    }
    eq(checkDue(null, NOW).verdict, 'invalid');
  });

  // ── 벽시계 시각 → UTC ────────────────────────────────────
  test('서울 15:30은 06:30 UTC다', () => {
    eq(toUtcMs('2026-08-02', '15:30', 'Asia/Seoul'), Date.UTC(2026, 7, 2, 6, 30));
  });

  test('자정과 23:59도 맞는다', () => {
    eq(toUtcMs('2026-08-02', '00:00', 'Asia/Seoul'), Date.UTC(2026, 7, 1, 15, 0));
    eq(toUtcMs('2026-08-02', '23:59', 'Asia/Seoul'), Date.UTC(2026, 7, 2, 14, 59));
  });

  // 손으로 +9를 더하는 코드는 한 번은 맞고 그다음에 틀린다. 서머타임이
  // 있는 시간대에서 같은 벽시계 시각이 다른 UTC 순간이 되는지 본다.
  test('서머타임이 있는 시간대도 Intl에 맡긴다', () => {
    const winter = toUtcMs('2026-01-15', '09:30', 'America/New_York');
    const summer = toUtcMs('2026-07-15', '09:30', 'America/New_York');
    eq(winter, Date.UTC(2026, 0, 15, 14, 30), '겨울 EST는 UTC-5');
    eq(summer, Date.UTC(2026, 6, 15, 13, 30), '여름 EDT는 UTC-4');
    assert(winter !== summer, '두 계절이 같은 오프셋으로 계산됐다');
  });

  test('모양이 틀리면 null — 0으로 떨어뜨리지 않는다', () => {
    // 0을 돌려주면 1970년이 되고, 그건 언제나 '지났음'이라 즉시 실행된다
    for (const [d, t] of [['', '15:30'], ['2026-8-2', '15:30'], ['2026-08-02', ''],
                          ['2026-08-02', '25:00'], ['2026-08-02', '15:60']] as const) {
      eq(toUtcMs(d, t, 'Asia/Seoul'), null, `${d} ${t}`);
    }
  });

  test('모르는 시간대는 null', () => {
    eq(toUtcMs('2026-08-02', '15:30', 'Not/AZone'), null);
  });

  // ── 만들 수 있는가 ───────────────────────────────────────
  // 지난 시각으로 만들면 저장되자마자 stale이 되는데 화면에는 '예약됨'으로
  // 뜬다 — 영원히 안 나가는 예약이다.
  test('과거는 예약할 수 없다', () => {
    eq(validateSchedule(NOW - 1000, NOW).ok, false);
    eq(validateSchedule(NOW, NOW).ok, false, '같은 시각도 이미 지난 것이다');
    eq(validateSchedule(NOW + 1000, NOW).ok, true);
  });

  test('너무 먼 예약은 거부한다', () => {
    eq(validateSchedule(NOW + 31 * 86_400_000, NOW).ok, false);
    eq(validateSchedule(NOW + 29 * 86_400_000, NOW).ok, true);
  });

  test('시각을 못 읽으면 거부하고 이유를 적는다', () => {
    const r = validateSchedule(null, NOW);
    eq(r.ok, false);
    assert(r.reason.length > 0, '이유가 비어 있다');
  });

  // ── 제때 나갈 수 있는가 ──────────────────────────────────
  //
  // 화면이 이 문구를 그대로 적는다. 하루 1회 크론뿐인데 "15:30에 팝니다"
  // 라고 쓰면 그건 거짓말이다.
  test('하루 1회 크론뿐이면 제때 못 나간다고 말한다', () => {
    const a = accuracyNote({ dailyCron: true });
    eq(a.canBeOnTime, false);
    assert(a.text.includes('나가지 않습니다'), a.text);
  });

  test('앱이 열려 있으면 제때 나가되, 닫으면 안 된다고 말한다', () => {
    const a = accuracyNote({ appOpen: true, dailyCron: true });
    eq(a.canBeOnTime, true);
    assert(a.text.includes('닫'), `앱을 닫으면 안 된다는 말이 없다: ${a.text}`);
  });

  test('외부 스케줄러가 있으면 제 시각', () => {
    eq(accuracyNote({ external: true }).canBeOnTime, true);
  });

  test('실행기가 하나도 없으면 나가지 않는다고 말한다', () => {
    const a = accuracyNote({});
    eq(a.canBeOnTime, false);
    assert(a.text.includes('나가지 않습니다'), a.text);
  });

  test('간격 표시', () => {
    eq(fmtGap(30_000), '30초');
    eq(fmtGap(90_000), '2분');
    eq(fmtGap(3_600_000), '1시간');
    eq(fmtGap(5_400_000), '1시간 30분');
    eq(fmtGap(90_000_000), '1일 1시간');
  });
}
