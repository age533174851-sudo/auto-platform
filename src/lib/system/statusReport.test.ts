import { test, eq, assert } from '../../test/harness';
import {
  cronStatus, tableStatus, connectionStatus, overallSummary, ago,
  type CronExpectation,
} from './statusReport';

export function runStatusReportTests() {
  console.log('[시스템 상태 — 못 읽은 것을 초록으로 그리지 않는다]');

  const HOUR = 3_600_000;
  const now = 1_800_000_000_000;
  const EXPECT: CronExpectation[] = [
    { job: 'exit-monitor', label: '청산 감시', maxGapMs: 6 * HOUR },
  ];
  const row = (o: any) => ({ job: 'exit-monitor', status: 'ok', started_at: new Date(o.at).toISOString(), ...o });

  // ── 크론 ────────────────────────────────────────────────
  test('최근에 돌았으면 정상', () => {
    eq(cronStatus([row({ at: now - HOUR })], EXPECT, now)[0].health, 'ok');
  });

  test('간격을 넘기면 문제', () => {
    const r = cronStatus([row({ at: now - 8 * HOUR })], EXPECT, now)[0];
    eq(r.health, 'bad');
    assert(r.action != null, '무엇을 해야 하는지 적어야 한다');
  });

  test('절반을 넘으면 미리 알린다', () => {
    // 완전히 멈춘 뒤에 아는 것보다 낫다.
    eq(cronStatus([row({ at: now - 4 * HOUR })], EXPECT, now)[0].health, 'warn');
  });

  test('실패는 최근이어도 문제다', () => {
    // 성공만 보면 "마지막 성공이 3일 전"과 "3일 동안 매번 실패"가
    // 똑같이 보인다. 뒤쪽이 훨씬 급하고 더 조용하다.
    const r = cronStatus([row({ at: now - 60_000, status: 'failed', detail: '토큰 만료' })], EXPECT, now)[0];
    eq(r.health, 'bad');
    assert(r.detail.includes('토큰 만료'), r.detail);
  });

  test('할 일이 없어서 안 한 것은 정상이다', () => {
    // skipped를 failed와 합치면 "아무것도 안 했다"가 정상인지 사고인지 모른다.
    const r = cronStatus([row({ at: now - HOUR, status: 'skipped' })], EXPECT, now)[0];
    eq(r.health, 'ok');
    assert(r.detail.includes('할 일 없음'), r.detail);
  });

  test('기록이 아예 없으면 확인된 문제다', () => {
    // 캘린더 크론이 vercel.json에 등록조차 안 된 채로 몇 달을 보냈다.
    const r = cronStatus([], EXPECT, now)[0];
    eq(r.health, 'bad');
    assert(r.detail.includes('한 번도'), r.detail);
    assert(r.action!.includes('vercel.json'), r.action!);
  });

  test('못 읽은 것과 안 돈 것은 다르다', () => {
    // 이 구분이 이 파일의 존재 이유다.
    eq(cronStatus(null, EXPECT, now)[0].health, 'unknown');
    eq(cronStatus([], EXPECT, now)[0].health, 'bad');
  });

  test('다른 작업의 기록에 속지 않는다', () => {
    const r = cronStatus([{ job: 'calendar-sync', status: 'ok', started_at: new Date(now).toISOString() }], EXPECT, now)[0];
    eq(r.health, 'bad');
  });

  test('가장 최근 것을 본다', () => {
    const r = cronStatus([
      row({ at: now - 9 * HOUR }),
      row({ at: now - HOUR }),
    ], EXPECT, now)[0];
    eq(r.health, 'ok');
  });

  test('시각이 깨진 줄은 무시한다', () => {
    const r = cronStatus([
      { job: 'exit-monitor', status: 'ok', started_at: '아무거나' },
      row({ at: now - HOUR }),
    ], EXPECT, now)[0];
    eq(r.health, 'ok');
  });

  // ── 마이그레이션 ────────────────────────────────────────
  test('표가 없으면 무엇을 해야 하는지 적는다', () => {
    // '표 없음'만 적으면 사용자가 할 수 있는 일이 없다.
    const r = tableStatus([{ name: 'safety_events', label: '안전 기록', exists: false, migration: '026' }])[0];
    eq(r.health, 'bad');
    assert(r.action!.includes('026'), r.action!);
  });

  test('표가 있으면 정상', () => {
    eq(tableStatus([{ name: 'x', label: 'X', exists: true, migration: '1' }])[0].health, 'ok');
  });

  test('확인 못 한 것을 없는 것으로 치지 않는다', () => {
    eq(tableStatus([{ name: 'x', label: 'X', exists: null, migration: '1' }])[0].health, 'unknown');
  });

  // ── 연결 ────────────────────────────────────────────────
  test('연결이 있고 최근에 확인했으면 정상', () => {
    eq(connectionStatus({ count: 2, lastOkMs: now - HOUR, untested: 0 }, now).health, 'ok');
  });

  test('연결이 없는 것은 문제가 아니라 알림이다', () => {
    // 모의만 쓰는 사람도 있다.
    const r = connectionStatus({ count: 0, lastOkMs: null, untested: 0 }, now);
    eq(r.health, 'warn');
  });

  test('한 번도 확인 안 한 연결이 있으면 알린다', () => {
    const r = connectionStatus({ count: 3, lastOkMs: now, untested: 1 }, now);
    eq(r.health, 'warn');
    assert(r.detail.includes('1개'), r.detail);
  });

  test('오래 확인 안 했으면 알린다', () => {
    eq(connectionStatus({ count: 1, lastOkMs: now - 10 * 24 * HOUR, untested: 0 }, now).health, 'warn');
  });

  test('연결 목록을 못 읽으면 확인 불가다', () => {
    eq(connectionStatus({ count: null, lastOkMs: null, untested: 0 }, now).health, 'unknown');
  });

  test('연결은 있는데 확인 기록이 없으면 확인 불가다', () => {
    eq(connectionStatus({ count: 2, lastOkMs: null, untested: 0 }, now).health, 'unknown');
  });

  // ── 전체 요약 ───────────────────────────────────────────
  const item = (h: any) => ({ id: 'x', label: 'x', health: h, detail: '', action: null });

  test('문제가 하나라도 있으면 문제다', () => {
    eq(overallSummary([item('ok'), item('bad'), item('warn')]).health, 'bad');
  });

  test('확인 불가를 정상으로 합치지 않는다', () => {
    // 못 읽은 것을 초록으로 그리면 이 화면 자체가 "켜져 있다고 믿는데
    // 안 도는" 것이 된다.
    const r = overallSummary([item('ok'), item('unknown')]);
    eq(r.health, 'unknown');
    assert(r.text.includes('확인하지 못'), r.text);
  });

  test('문제가 확인 불가보다 먼저다', () => {
    eq(overallSummary([item('bad'), item('unknown')]).health, 'bad');
  });

  test('전부 정상이면 정상', () => {
    eq(overallSummary([item('ok'), item('ok')]).health, 'ok');
  });

  test('빈 목록은 정상이 아니다', () => {
    // 아무것도 확인 안 한 것이 '이상 없음'이 되면 안 된다.
    eq(overallSummary([]).health, 'unknown');
    eq(overallSummary(null as any).health, 'unknown');
  });

  // ── 시간 표기 ───────────────────────────────────────────
  test('경과 시간을 사람이 읽게 적는다', () => {
    eq(ago(now - 30_000, now), '방금');
    eq(ago(now - 5 * 60_000, now), '5분 전');
    eq(ago(now - 3 * HOUR, now), '3시간 전');
    eq(ago(now - 50 * HOUR, now), '2일 전');
  });

  test('미래 시각은 방금으로 본다', () => {
    // 시계가 조금 어긋난 것이지 사고는 아니다.
    eq(ago(now + 60_000, now), '방금');
  });

  test('없는 시각은 빈 문자열', () => {
    eq(ago(null, now), '');
    eq(ago(NaN, now), '');
  });
}
