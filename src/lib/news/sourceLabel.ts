// src/lib/news/sourceLabel.ts
//
// **"어디서 나온 값인가"를 화면에 적는 한 곳.**
//
// 무엇이 있었나
// ─────────────
// 분석 API가 실패하면 `analyzer.ts`가 전부 `mockAnalyze`로 채운다.
// 그 자체는 정직했다 — mock은 `source: 'mock'`을 달고 나오고, 화면도
// 그걸 "키워드 기반 분석"으로 적었다.
//
// 그런데 캐시에서 다시 읽을 때 이랬다:
//
//     return { ...entry.analysis, source: 'cache' };
//
// **`'mock'`을 `'cache'`로 덮어썼다.** 그리고 화면의 분기는
// `source === 'cache'`를 "캐시된 분석"으로 적었다. 그래서 키워드로
// 지어낸 값이 캐시를 한 번 거치면 **실제 분석이었던 적이 없다는 사실이
// 사라졌다.** mock은 `saveCachedAnalysis`로 저장되므로, 전송 실패 한
// 번이 그 세션 내내 가짜를 진짜처럼 보이게 했다.
//
// 그래서 캐시 여부는 `cached`로 따로 두고, 출처는 **덮어쓰지 않는다.**
//
// 옛 값은 지어내지 않는다
// ───────────────────────
// 세션 저장소에는 이미 `source: 'cache'`로 저장된 항목이 남아 있을 수
// 있다. 그 값은 **원래 무엇이었는지 알 수 없다.** openai였는지 mock
// 이었는지 알 방법이 없으므로 "출처 미상"으로 적는다 — 둘 중 하나로
// 찍지 않는다.
import type { NewsAnalysis } from './types';

export function analysisSourceLabel(
  an: Pick<NewsAnalysis, 'source' | 'cached'> | null | undefined,
): string {
  if (!an) return '분석 중...';

  const base =
    an.source === 'openai' ? 'OpenAI 분석'
      : an.source === 'mock' ? '키워드 기반 분석'
        // **옛 캐시 항목.** 덮어쓰기 때문에 원래 출처를 잃었다.
        : an.source === 'cache' ? '출처 미상(옛 캐시)'
          : '분석 중...';

  // 아직 분석 전인 것에 "· 캐시"를 붙이지 않는다.
  if (base === '분석 중...') return base;
  return an.cached ? `${base} · 캐시` : base;
}
