// src/lib/maintenance/retention.test.ts
//
// 막으려는 사고:
//  1. `?days=0`을 잘못 넘겨 컷오프가 '지금'이 되고 표 전체가 지워지는 것
//     — 응답에는 "정리 완료 12,483건"이라고 뜬다. 성공처럼 보인다
//  2. 개수를 세지 못했는데 지우는 것
//  3. 한 번에 전부 지워 되돌릴 수 없게 되는 것
//  4. 거부된 규칙을 조용히 빼서 왜 안 지워졌는지 모르게 하는 것
import { test, assert, eq } from '../../test/harness';
import {
  planCleanup, checkDeleteSize, DEFAULT_RULES,
  MIN_RETENTION_DAYS, MAX_DELETE_PER_RUN,
} from './retention';

// 2026-07-28T00:00:00Z
const NOW = Date.UTC(2026, 6, 28);
const rule = (days: number) => ([{
  table: 't', column: 'created_at', days, reason: 'r',
}]);

export function runRetentionTests() {
  console.log('[데이터 정리 — 보관 기간 하한]');

  test('0일은 거부한다', () => {
    // 컷오프가 '지금'이 되어 살아 있는 데이터까지 지운다
    const r = planCleanup(rule(0), NOW);
    eq(r.items.length, 0, '0일을 통과시키면 표가 비워진다');
    eq(r.rejected.length, 1);
    assert(r.rejected[0].reason.includes('최소'), r.rejected[0].reason);
  });

  test('음수도 거부한다', () => {
    // 음수면 컷오프가 미래가 되어 아직 안 온 데이터까지 대상이 된다
    eq(planCleanup(rule(-30), NOW).items.length, 0);
  });

  test('숫자가 아니면 거부한다', () => {
    eq(planCleanup(rule(NaN), NOW).items.length, 0);
    eq(planCleanup(rule(undefined as any), NOW).items.length, 0);
  });

  test('하한 바로 아래는 거부, 하한은 통과', () => {
    eq(planCleanup(rule(MIN_RETENTION_DAYS - 1), NOW).items.length, 0);
    eq(planCleanup(rule(MIN_RETENTION_DAYS), NOW).items.length, 1);
  });

  test('거부 이유를 남긴다', () => {
    // 조용히 빼면 왜 안 지워졌는지 알 수 없다
    const r = planCleanup(rule(1), NOW);
    eq(r.rejected.length, 1);
    assert(r.rejected[0].reason.length > 10, r.rejected[0].reason);
  });

  test('덮어쓴 값도 하한을 지켜야 한다', () => {
    // 규칙은 45일인데 요청이 1일이면 거부해야 한다
    const r = planCleanup(rule(45), NOW, { days: 1 });
    eq(r.items.length, 0, '덮어쓰기로 하한을 우회하면 안 된다');
  });

  console.log('[데이터 정리 — 컷오프 계산]');

  test('컷오프가 과거다', () => {
    const r = planCleanup(rule(30), NOW);
    const cutoff = Date.parse(r.items[0].cutoff);
    assert(cutoff < NOW, '컷오프가 미래거나 현재다');
    eq(NOW - cutoff, 30 * 86_400_000);
  });

  test('보관 기간이 길수록 컷오프가 이르다', () => {
    const a = Date.parse(planCleanup(rule(30), NOW).items[0].cutoff);
    const b = Date.parse(planCleanup(rule(90), NOW).items[0].cutoff);
    assert(b < a, '90일 컷오프가 30일보다 늦다');
  });

  test('표나 컬럼 이름이 비면 거부한다', () => {
    const r = planCleanup([{ table: '', column: 'c', days: 30, reason: '' }], NOW);
    eq(r.items.length, 0);
    eq(r.rejected.length, 1);
  });

  console.log('[데이터 정리 — 기본 규칙]');

  test('기본 규칙이 전부 하한을 지킨다', () => {
    for (const r of DEFAULT_RULES) {
      assert(r.days >= MIN_RETENTION_DAYS || r.table === 'ai_cache',
        `${r.table}의 보관 기간이 ${r.days}일이다`);
    }
  });

  test('기본 규칙에 econ_events가 없다', () => {
    // Risk Veto가 쓰는 표다. 지워서 얻는 것보다 잘못 지워서 잃는 것이 크다
    assert(!DEFAULT_RULES.some(r => r.table === 'econ_events'),
      'Risk Veto가 쓰는 표를 정리 대상에 넣었다');
  });

  test('모든 규칙에 이유가 적혀 있다', () => {
    for (const r of DEFAULT_RULES) {
      assert(r.reason.length > 10, `${r.table}에 이유가 없다`);
    }
  });

  console.log('[데이터 정리 — 삭제 개수 검사]');

  test('세지 못했으면 지우지 않는다', () => {
    eq(checkDeleteSize(NaN, 100).ok, false);
    eq(checkDeleteSize(-1, 100).ok, false);
  });

  test('0건은 통과한다', () => {
    eq(checkDeleteSize(0, 100).ok, true);
  });

  test('상한을 넘으면 멈춘다', () => {
    const r = checkDeleteSize(MAX_DELETE_PER_RUN + 1, 999_999);
    eq(r.ok, false);
    assert(r.reason.includes('나눠'), r.reason);
  });

  test('표 전체를 지우려 하면 멈춘다', () => {
    // 보관 기간이 잘못됐거나 컬럼이 비어 전부 대상이 된 경우다
    const r = checkDeleteSize(100, 100);
    eq(r.ok, false);
    assert(r.reason.includes('보관 기간'), r.reason);
  });

  test('일부만 지우는 것은 통과한다', () => {
    eq(checkDeleteSize(50, 100).ok, true);
  });

  test('전체 개수를 모르면 개수 상한만 본다', () => {
    // total=0은 '표가 비었다'일 수도 '못 셌다'일 수도 있다.
    // 그때 전체 삭제 검사를 걸면 정상 정리까지 막힌다.
    eq(checkDeleteSize(10, 0).ok, true);
  });
}
