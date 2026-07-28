// src/lib/news/enrichPlan.test.ts
//
// 막으려는 사고:
//  1. 실패한 기사를 크론이 돌 때마다 다시 분석하는 것 — 15분마다 돌면
//     하루 96번 과금된다
//  2. 일시적 오류(429·타임아웃)를 기사 문제로 세어 멀쩡한 기사를 영영
//     포기하는 것
//  3. 오래된 기사부터 처리해 정작 지금 중요한 기사가 계속 밀리는 것
//  4. 한 번에 너무 많이 돌려 요금 한도를 넘는 것
import { test, assert, eq } from '../../test/harness';
import {
  planEnrichment, isTransient, nextAttempts, shouldStopBatch, MAX_ATTEMPTS, DEFAULT_BATCH,
} from './enrichPlan';

const c = (hash: string, publishedAt: string, attempts = 0) => ({ hash, publishedAt, attempts });

export function runEnrichPlanTests() {
  console.log('[분석 크론 — 대상 선정]');

  test('최신 기사부터 분석한다', () => {
    // 밀린 게 많을 때 오래된 것부터 하면 지금 중요한 기사가 계속 밀린다
    const r = planEnrichment([
      c('old', '2026-07-01T00:00:00Z'),
      c('new', '2026-07-28T00:00:00Z'),
      c('mid', '2026-07-15T00:00:00Z'),
    ], 2);
    eq(r.take.map(x => x.hash).join(','), 'new,mid');
    eq(r.deferred, 1);
  });

  test('배치 크기를 넘지 않는다', () => {
    const many = Array.from({ length: 30 }, (_, i) => c('h' + i, '2026-07-28T00:00:00Z'));
    eq(planEnrichment(many, 5).take.length, 5);
    eq(planEnrichment(many, 5).deferred, 25);
  });

  test('배치 크기가 이상하면 안전한 값으로', () => {
    const many = Array.from({ length: 100 }, (_, i) => c('h' + i, '2026-07-28T00:00:00Z'));
    eq(planEnrichment(many, 0).take.length, DEFAULT_BATCH);
    eq(planEnrichment(many, -3).take.length, 1);
    assert(planEnrichment(many, 9999).take.length <= 50, '상한이 없으면 요금이 샌다');
  });

  test('발행 시각을 못 읽으면 맨 뒤로 민다', () => {
    // 앞에 두면 정렬이 흔들려 매번 다른 기사가 뽑히고,
    // 어떤 기사는 영영 분석되지 않는다
    const r = planEnrichment([
      c('bad', '언제인지 모름'),
      c('good', '2026-07-28T00:00:00Z'),
    ], 1);
    eq(r.take[0].hash, 'good');
  });

  test('빈 입력이면 빈 결과', () => {
    const r = planEnrichment([], 5);
    eq(r.take.length, 0); eq(r.givenUp.length, 0); eq(r.deferred, 0);
  });

  console.log('[분석 크론 — 포기 기준]');

  test('시도 한도를 넘긴 기사는 빼고 따로 알린다', () => {
    const r = planEnrichment([
      c('dead', '2026-07-28T00:00:00Z', MAX_ATTEMPTS),
      c('alive', '2026-07-28T00:00:00Z', MAX_ATTEMPTS - 1),
    ], 5);
    eq(r.take.length, 1);
    eq(r.take[0].hash, 'alive');
    eq(r.givenUp.length, 1, '조용히 빼면 왜 분석이 안 되는지 알 수 없다');
  });

  test('한도를 넘겨도 배치 자리를 차지하지 않는다', () => {
    const dead = Array.from({ length: 10 }, (_, i) => c('d' + i, '2026-07-28T00:00:00Z', 5));
    const r = planEnrichment([...dead, c('live', '2026-07-28T00:00:00Z')], 3);
    eq(r.take.length, 1);
    eq(r.take[0].hash, 'live');
  });

  test('attempts가 없으면 0으로 본다', () => {
    const r = planEnrichment([{ hash: 'x', publishedAt: '2026-07-28T00:00:00Z' }], 5);
    eq(r.take.length, 1);
  });

  console.log('[분석 크론 — 일시적 오류 구분]');

  test('한도 초과·타임아웃은 일시적이다', () => {
    for (const m of ['429 rate limit', 'Request timeout', 'ETIMEDOUT', '503 Service Unavailable', 'overloaded']) {
      eq(isTransient(m), true, m);
    }
  });

  test('형식 오류는 일시적이 아니다', () => {
    for (const m of ['AI가 JSON 형식으로 답하지 않았습니다', '검증 실패: titleKo 없음']) {
      eq(isTransient(m), false, m);
    }
  });

  test('일시적 오류는 시도 횟수를 올리지 않는다', () => {
    // 429 때문에 멀쩡한 기사를 세 번 만에 포기하면 안 된다
    eq(nextAttempts(1, '429 rate limit'), 1);
    eq(nextAttempts(2, 'timeout'), 2);
  });

  test('기사 문제는 시도 횟수를 올린다', () => {
    eq(nextAttempts(0, 'JSON 형식 아님'), 1);
    eq(nextAttempts(2, '검증 실패'), 3);
  });

  test('이상한 값이 와도 음수가 되지 않는다', () => {
    eq(nextAttempts(NaN as any, 'x'), 1);
    eq(nextAttempts(-5, 'x'), 1);
  });

  console.log('[분석 크론 — 배치 중단]');

  test('한도 초과면 남은 배치를 멈춘다', () => {
    // 계속 던지면 요금만 나가고 한도 풀리는 시각만 밀린다
    for (const m of ['429 rate limit', 'insufficient_quota', 'quota exceeded']) {
      eq(shouldStopBatch(m), true, m);
    }
  });

  test('타임아웃으로는 멈추지 않는다', () => {
    // 그 기사 하나가 길었을 수 있다. 배치를 버리면 밀린 기사가 쌓인다
    eq(shouldStopBatch('Request timeout'), false);
    eq(shouldStopBatch('ETIMEDOUT'), false);
  });

  test('기사 문제로는 멈추지 않는다', () => {
    eq(shouldStopBatch('AI가 JSON 형식으로 답하지 않았습니다'), false);
  });

  test('세 번이면 포기한다', () => {
    // 일시적 오류가 아닌 실패가 세 번이면 몇 번을 더 불러도 같은 결과다
    let n = 0;
    for (let i = 0; i < 5; i++) n = nextAttempts(n, 'JSON 형식 아님');
    assert(n >= MAX_ATTEMPTS, String(n));
  });
}
