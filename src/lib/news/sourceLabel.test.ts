// src/lib/news/sourceLabel.test.ts
//
// 이 시험이 막는 것: **캐시를 거쳤다고 출처가 바뀌는 것.**
//
// 예전에는 `loadCachedAnalysis`가 `source`를 `'cache'`로 덮어썼고,
// 그래서 키워드로 지어낸 값(mock)이 캐시를 한 번 거치면 화면에
// "캐시된 분석"으로 보였다 — 실제 분석이었던 적이 없다는 사실이 사라졌다.
import { test, eq, assert } from '../../test/harness';
import { analysisSourceLabel } from './sourceLabel';

export function runNewsSourceLabelTests() {
  console.log('[뉴스 분석 출처 — 캐시가 출처를 덮지 않는다]');

  test('캐시에서 온 키워드 분석은 **키워드 분석이라고** 적는다', () => {
    const s = analysisSourceLabel({ source: 'mock', cached: true } as any);
    assert(s.includes('키워드 기반 분석'), s);
    assert(s.includes('캐시'), `캐시에서 왔다는 사실도 적어야 한다: ${s}`);
  });

  test('캐시에서 온 실제 분석도 실제 분석이라고 적는다', () => {
    const s = analysisSourceLabel({ source: 'openai', cached: true } as any);
    assert(s.includes('OpenAI 분석'), s);
    assert(s.includes('캐시'), s);
  });

  test('**지어낸 값이 실제 분석처럼 보이지 않는다**', () => {
    const s = analysisSourceLabel({ source: 'mock', cached: true } as any);
    assert(!s.includes('OpenAI'), `지어낸 값에 실제 분석 이름이 붙었다: ${s}`);
  });

  test('캐시가 아니면 캐시라고 적지 않는다', () => {
    eq(analysisSourceLabel({ source: 'openai' } as any), 'OpenAI 분석');
    eq(analysisSourceLabel({ source: 'mock' } as any), '키워드 기반 분석');
  });

  test('옛 캐시 항목은 **출처 미상**이다 — 둘 중 하나로 찍지 않는다', () => {
    // 세션 저장소에 `source: 'cache'` 로 이미 저장된 것들. 원래 무엇이었는지
    // 알 방법이 없다.
    const s = analysisSourceLabel({ source: 'cache' } as any);
    assert(s.includes('출처 미상'), s);
    assert(!s.includes('OpenAI'), s);
    assert(!s.includes('키워드'), s);
  });

  test('분석이 없으면 "분석 중"이고, 거기에 캐시를 붙이지 않는다', () => {
    eq(analysisSourceLabel(null), '분석 중...');
    eq(analysisSourceLabel(undefined), '분석 중...');
    eq(analysisSourceLabel({ source: 'unknown-future', cached: true } as any), '분석 중...');
  });
}
