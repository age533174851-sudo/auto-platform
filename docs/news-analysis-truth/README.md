# 뉴스 분석 사실성 (PR N1)

**관측하지 않은 값을 만들지 않는다.** 뉴스 번역은 이 PR에 없다(N2).

| | |
|---|---|
| base | `7101916e55eb8f9e5719b9091823b5777f922d43` |
| 검사기 | `scripts/check-news-truth.mjs` (CI 배선) |
| 정본 | `analyzeOne.ts` → `schema.ts` → `news_articles` → `/api/news/stored` |

## 무엇이 고장나 있었나

AI 분석 경로가 **둘**이었다.

```
정본   크론 → analyzeOne.ts → schema.validateAnalysis → news_articles
              → /api/news/stored → AiVerdict

두번째 화면 열기 → analyzer.ts → /api/news/analyze → OpenAI
              → 실패하면 mockAnalyze()
```

`NewsPage.tsx`는 정본을 읽으면서 주석에 *"화면에서 다시 부르지 않는다 —
사람 수만큼 요금이 곱해진다"*고 적어 뒀는데, **바로 아래에서** 상위 5개를
브라우저에서 다시 분석하고 있었다.

### 두 번째 경로가 만들어낸 값

`mockAnalyzer.ts`는 관측이 아니라 키워드 개수와 id 해시로 값을 만든다.

```ts
let confidence = 50 + diff * 8 + Math.min(15, totalSignals * 2);
confidence += (hash(item.id || item.title) % 11) - 5;   // id 해시로 ±5
confidence = Math.max(45, Math.min(88, Math.round(confidence)));
if (매크로 키워드) confidence = Math.min(90, confidence + 8);
```

`prediction` · `reasons`(`'투자 심리 개선'`) · `affectedAssets.direction`도
같은 방식이다. `quickTranslate()`는 정규식 32개로 단어를 부분 치환해
영한 혼종 문자열을 만들고 그것을 `titleKo`에 넣었다 — 화면은 그 자리를
한국어 제목으로 그린다.

**production 폴백이 두 층이었다.**

| 층 | 위치 | 조건 |
|---|---|---|
| 서버 | `api/news/analyze/route.ts:156` | 한 건 실패 |
| 서버 | `api/news/analyze/route.ts:162` | `OPENAI_API_KEY` 없음 |
| 브라우저 | `analyzer.ts:87` | API 응답에서 누락 |
| 브라우저 | `analyzer.ts:93` | 응답이 ok가 아님 |
| 브라우저 | `analyzer.ts:99` | 호출 자체가 예외 |

### 지어냈다는 표시가 사라졌다

```
analyzer.ts:99   mockAnalyze()               source: 'mock'
analyzer.ts:100  saveCachedAnalysis()        sessionStorage 24h
analyzer.ts:28   { ...entry, source: 'cache' }   ← 'mock'이 덮인다
NewsPage:400     source === 'cache' → "캐시된 분석"
NewsPage:427     "상승 예상 73%" + 확신도 막대
```

첫 렌더는 `"키워드 기반 분석"`이라고 정직하게 적었다. 그런데 캐시에서
한 번 읽히면 `source`가 `'cache'`로 덮여, 그 뒤 24시간 동안 **무엇으로
만든 값인지 화면도 코드도 되짚을 수 없었다.**

### 그 값이 사람을 깨웠다

```
matcher.ts:92   calculateImpact({ prediction, confidence, … })
sources.ts:95   const conf = … input.confidence ?? 50      ← 없으면 50 가정
matcher.ts:101  shouldNotify = impact.total >= 60
NewsPage:311    triggerNotification(...)                    ← 브라우저 알림
```

## 무엇을 했나

### ① 두 번째 경로를 없앴다

`src/lib/news/analyzer.ts`와 `src/app/api/news/analyze/route.ts`를 지웠다.
소비처를 전수 검색한 결과 각각 **1곳뿐**이었다(`NewsPage` → `analyzer` →
라우트). 새 UNAVAILABLE 계약을 붙여 legacy 경로를 살리는 대신, **이미 있는
정본 하나만 남겼다.**

`mockAnalyzer.ts`는 `src/lib/news/__fixtures__/`로 옮겼다. 결정적(같은
입력 → 같은 출력)이라 시험 fixture로는 쓸모가 있고, production import 0을
CI가 강제한다.

### ② 없는 값을 숫자로 만들지 않는다

```diff
- let confidence = parseConfidence(raw.confidence);
- if (confidence == null) {
-   confidence = 0;
-   repaired.push('confidence 없음 → 0 (판단 보류로 처리)');
- }
+ const confidence = parseConfidence(raw.confidence);
+ if (confidence == null) repaired.push('confidence 없음 → null (숫자를 만들지 않는다)');
```

`NewsAnalysisV2.confidence`가 `number | null`이 됐다. 0은 "모델이 0%라고
했다"이고 null은 "모델이 답하지 않았다"다 — 다른 말이다.

`calculateImpact`의 `?? 50`도 없앴다. 방향은 있는데 확신도를 관측하지
못했으면 강도 몫을 주지 않는다(보합과 같은 10점).

### ③ 모델 자기평가가 알림 권한을 쥐지 않는다

여기를 **두 번 고쳤다.** 첫 번째는 틀린 방향이었다.

처음에는 "없는 값으로 깨우지 않으려고" 확신도 관측을 알림 관문으로 걸었다.

```ts
// 첫 시도 — 틀렸다
const observedConfidence = typeof analysis.confidence === 'number' && …;
const shouldNotify = observedDirection && observedConfidence && impact.total >= 60 && …;
```

그런데 이것은 **보정되지 않은 자기평가 숫자에게 알림 권한을 준다.**
`calculateImpact`도 그 숫자를 최대 50점으로 환산하고 있었다. 화면에서
`72%`를 지운 이유가 "모델이 스스로 매긴 값이고 확률이 아니다"인데,
화면에서만 지우고 알림 판정에는 그대로 쓰면 **표시만 안 할 뿐 여전히
그 숫자가 사람을 깨운다.**

그래서 confidence를 알림 경로에서 **구조적으로** 없앴다 — 주석으로
"쓰지 말자"고 적는 것이 아니라, 타입에서 지워 **볼 수 없게** 했다.

```diff
  export interface MatchAnalysis {
    direction: string | null;
-   confidence: number | null;
    affectedAssets?: string[] | null;
  }

  interface CalcInput {
    sourceName?:  string;
    prediction?:  'up' | 'down' | 'flat';
-   confidence?:  number | null;
    publishedAt?: number;
    numAffectedAssets?: number;
  }
```

```ts
const observedDirection = prediction === 'up' || prediction === 'down';
const shouldNotify = observedDirection && impact.total >= 60 && !hasSeen(newsId);
```

영향도는 이제 **관측 가능한 것만** 쓴다 — 출처 신뢰도 · 최신성 · 영향
자산 수. 방향은 점수 크기에 영향을 주지 않고(`DIRECTION_POINTS = 10`
고정), 있고 없고만 관문에서 본다. `uncertain`은 판단 보류라 사람을
깨우지 않는다.

**새 공식을 만들지 않았다.** `DIRECTION_POINTS = 10`은 발명한 숫자가
아니라 이미 코드에 있던 하한값(확신도를 관측하지 못했을 때 주던 값)을
그대로 상수로 옮긴 것이다. 올리려면 보정된 적중률이 먼저다.

confidence 값 자체는 `news_articles`에 그대로 남는다 — 저장은 하되
판단에는 0 영향이다.

`matcher.ts`는 legacy `NewsAnalysis` 대신 정본 모양(`MatchAnalysis` —
`direction` · `affectedAssets`)만 받는다.

### ④ 확신도 %를 화면에서 뺐다

`72%`는 정밀해 보이지만 **모델이 스스로 매긴 값**이고 과거 적중률로 보정된
적이 없다 — 상승 확률이 아니다. 그런데 %와 막대로 그리면 사람은 확률로
읽는다. `PredictionBadge`와 `ConfidenceBar`를 없애고, 방향 · 근거 · 위험 ·
분석 모델만 적는 `AiVerdict`가 그 자리를 대신한다. 값 자체는 데이터에
남아 있다(내부 metadata).

### ⑤ 실패 상태를 사실대로 적는다

| 상태 | 화면 |
|---|---|
| 아직 분석 안 함 | **AI 분석 대기** |
| 분석할 수 없음 (키 없음 · 저장소 못 읽음) | **AI 분석 사용 불가** + 사유 |
| 분석함 | 방향 · 근거 · 위험 · 모델 |

없는 분석을 채우지 않는다.

### ⑥ 예시(SAMPLE)는 표시 전용이다

`/api/news?action=latest`는 NewsAPI가 비면 `MOCK_NEWS`를 돌려준다.
`feed.ts`는 그것을 SAMPLE로 정직하게 격리하는데, **`NewsPage`는 `feed.ts`를
쓰지 않아 `d.source`를 아예 읽지 않았다.** 그래서 예시 기사 5건이 분석
요청으로 나갔다.

이제 `NewsPage`가 `provenanceOf(d.source)`를 읽고, 알림은 `LIVE`일 때만
나간다. `/api/news`의 기본 분기(`route.ts:50`)에는 `source` 필드가 아예
없었다 — 받는 쪽이 판정할 값 자체가 없었다. 붙였다.

**알림만 막는 것으로는 부족했다.** 저장된 분석은 URL로 잇기 때문에, 예시
기사의 주소가 저장된 기사의 주소와 같으면 예시에 진짜 분석이 달라붙는다.
그러면 화면에 "예시인데 AI가 상승이라고 했다"가 남는다 — 계약은 분석 0 ·
알림 0이다.

붙이는 자리가 셋이라(카드 · 상세 · 알림) 조건을 자리마다 적으면 언젠가
한 곳이 빠진다. 그래서 결합 자체를 한 곳에만 둔다.

```ts
const storedFor = useCallback(
  (url?: string): AiVerdictData | undefined =>
    (provenance === 'LIVE' && url) ? aiByUrl[String(url)] : undefined,
  [provenance, aiByUrl],
);
```

검사기는 `aiByUrl[…]` 결합이 **한 곳뿐이고 그 한 곳이 LIVE 관문 뒤에
있는지**를 본다. 예시 기사의 상세에는 "예시로 보여 주는 기사입니다 —
AI 분석 대상이 아닙니다"라고 적는다.

## 감사 기록 — `newsImportance()`

**DERIVED_HEURISTIC. 표시 전용이고 권위값이 아니다.**

`NewsPage.tsx:39`의 `newsImportance(n, impactTotal?)`는 출처 신뢰도 ·
최신성 · 감성 · 영향종목수로 1~5 별점을 만든다. 유일한 소비처는
`StarRow`(카드 우측 별점)이고, 실행 판단 · 주문 · 알림 어디에도 들어가지
않는다. 이번 PR에서 제거하지 않는다.

`src/lib/ai/gateway.ts:44`의 `EscalationInput.newsImportance`는 **이름만
같은 다른 값**이고, 저장소 전체에서 그 필드를 채워 `escalate()`를 부르는
곳이 없다(호출부 0). 죽은 입력이다.

이 PR에서 `newsImportance`의 `impactTotal` 인자는 이제 **저장된 분석이
있을 때만** 채워진다. 지어낸 confidence로 계산한 영향도가 별점을 올리던
경로가 함께 없어졌다.

## 검사기가 막는 것

| # | 규칙 |
|---|---|
| ① | production 파일이 `mockAnalyz*` 또는 `__fixtures__`를 참조 |
| ① | `analyzer.ts` · `/api/news/analyze`가 되살아남 |
| ① | production에서 `/api/news/analyze` 호출 |
| ② | `schema.ts`가 confidence 없을 때 숫자를 **대입** (문구가 아니라 대입을 본다) |
| ② | `confidence` 타입이 null을 허용하지 않음 |
| ② | `sources.ts`에 `confidence ?? <숫자>` |
| ③ | 알림 조건에 `observedDirection` · `hasSeen` 누락 |
| ③ | 방향 관문이 **실제 값 검사가 아님** (`= true`로 죽이기) |
| ③ | **알림 경로가 `confidence`를 봄** — `MatchAnalysis`·`CalcInput`의 필드 포함 |
| ③ | `matcher.ts`가 legacy 타입을 다시 import |
| ④ | 화면이 확신도를 `%`로 그림 |
| ⑤ | `NewsPage`가 출처를 안 읽음 · 알림에 LIVE 게이트 없음 |
| ⑤ | 저장 분석 결합이 **2곳 이상**이거나 LIVE 관문 뒤가 아님 |
| ⑤ | `/api/news`가 뉴스를 주면서 `source`를 안 붙임 |

검사기가 한 번 **잘못된 정책을 잠갔다.** 첫 판에서 `observedConfidence`를
알림 조건에 **필수**로 요구했는데, 그것은 보정되지 않은 자기평가 숫자가
알림 권한을 쥐는 상태를 CI가 강제하는 것이었다. 지금은 그 반대를 강제한다.

## 이 PR이 하지 않는 것

번역 통합(N2) · `/api/translate` 변경 · 안정 식별자(`contentHash`) 도입 ·
`terminal/LeftRail.tsx` 배선 결함 · 자동매매 · 주문 · riskManager ·
`MOCK_NEWS` 삭제(`feed.ts`가 지우면 안 되는 이유를 이미 적어 뒀다).

## N2로 넘긴 것

- `newsapi.ts:62` `id: String(i)` — 번역·분석 캐시 키 충돌의 뿌리
- 번역 경로 통합 (홈 · 우측 레일이 아직 영어 원문)
- `/api/translate` public + rate limit (기존 limiter 재사용, 새로 만들지 않음)

## 이 PR과 #244가 겹치는 파일

제품 파일은 겹치지 않지만 **파일이 하나도 안 겹치는 것은 아니다.**

```
.github/workflows/ci.yml     두 PR 모두 검사기 단계를 추가한다
scripts/run-tests.mjs        두 PR 모두 시험 스위트를 등록한다
```

먼저 머지되는 쪽이 base를 바꾸므로, **나중 PR은 새 main 기준으로 재정합하고
새 exact-head CI를 받아야 한다.**
