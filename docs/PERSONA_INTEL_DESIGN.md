# 인물·기관·채널 발언 분석 — 설계 (구현 전)

> 작성 2026-10-14 · 기준 main `f902be8` · 상태: **설계·판정 정본·시험만**
> 운영 DB 변경 0 · 마이그레이션 0 · 대량 수집 0 · 매매 신호 연결 0

## 0. 이 문서가 아닌 것

- 승인된 기능 명세가 아니다. 데이터 모델과 계약의 **제안**이다.
- 제미나이 조사 자료의 명단 대조는 **하지 못했다.** 지시에는 자료를
  전달한다고 적혀 있으나 **본문이 전달되지 않았다.** 명단을 받으면
  §5의 절차로 대조한다. 받지 못한 명단을 추측해 적지 않는다.
- `PROJECT_HANDOFF.md` §11의 예시(웨돔·사또·자두두·박호두·짭구·슈카)는
  **제한 목록이 아니다.** §5가 확장 절차를 정한다.

## 1. 우선순위 — 이 기능은 청산 안전성보다 뒤다

핸드오프 §11이 적어 둔 그대로다: "Exact100X 청산 안전성보다 앞선 긴급
구현이라고 해석하지 않는다." 이 설계는 청산 안전성 작업을 멈추지 않고
병행한 것이고, 구현 순서도 그 뒤다.

## 2. 섞지 않는 세 가지

| 구분 | 무엇 | 왜 분리하나 |
|---|---|---|
| **주체** | 사람 / 조직 / 채널 | 한 사람이 여러 채널을 갖고, 한 채널에 여러 사람이 나오고, 기관 공식 발표는 개인 의견과 다르게 다뤄야 한다 |
| **영향력** | 구독자·조회·언급 빈도 | 추적 이유다. **맞히는지와 무관하다** |
| **정확도** | 판정된 전망의 적중률 | 사후 대조로만 나온다 |

`personaScorecard()`가 셋째와 둘째를 나란히 두되 **합성 점수를 만들지
않는다**(`combinedScore: null`). 합성 점수를 한 번 만들면 화면이 그것만
보여 주고, 사람은 구독자 많은 사람을 잘 맞히는 사람으로 읽는다.

## 3. 데이터 모델 (제안 — 적용하지 않았다)

마이그레이션 파일을 만들지 않았다. 이 저장소는 마이그레이션에 계보·
매니페스트·분류 검사가 걸려 있고, 승인 없이 그 줄을 추가하면 운영 적용
경로에 들어간다. 아래는 승인 시 작성할 스키마의 **설계**다.

```
persona_subjects          주체 (사람·조직·채널)
  id, kind, category, display_name, country, lang,
  created_at, updated_at
  · display_name은 키가 아니다 — 동명이인·개명이 있다

persona_accounts          주체의 플랫폼 계정
  id, subject_id, platform, handle, url,
  platform_verified (bool|null),          -- null = 확인 못 함
  linked_from_confirmed_source (bool|null),
  links_to_confirmed_source (bool|null),
  duplicate_of_account_id (nullable),
  verdict,                                 -- judgeAccount의 결과를 저장
  verdict_at
  · UNIQUE (platform, handle)
  · bool 칸은 **nullable이다.** not-null default false를 쓰면
    "확인 못 함"이 "확인했고 아님"으로 기록된다 (출금 권한 칸에서
    같은 실수가 이미 있었다)

persona_statements        발언
  id, subject_id, account_id,
  quote,                                   -- 원문. 요약으로 대체 금지
  source_url, spoken_at, collected_at,     -- 두 시각은 다르다
  lang, platform
  · UNIQUE (source_url, spoken_at) 로 중복 수집 방지

persona_claims            발언에서 뽑은 전망
  id, statement_id,
  asset, direction, horizon_ms,            -- 전부 nullable
  usability,                               -- checkClaim의 결과
  extractor_version
  · 추출기 버전을 남긴다 — 추출 규칙이 바뀌면 과거 판정이 달라진다

persona_outcomes          사후 대조
  id, claim_id,
  price_at_statement, price_at_horizon, covered,
  outcome_code, move_pct, judged_at,
  price_source                             -- 어느 자료로 판정했는가
  · outcome_code에 UNRESOLVED가 있다. 자료 없음을 오답으로 적지 않는다
```

**UNKNOWN을 표현할 수 있어야 한다**는 것이 이 모델의 유일한 강한 제약이다.
`not null default false`로 적힌 불리언은 "확인하지 못함"을 표현할 수 없고,
그러면 확인한 적 없는 것이 확인된 사실로 남는다.

## 4. API 계약 (읽기 전용 · 라우트는 아직 만들지 않았다)

```
GET /api/intel/personas
  ?q= &kind= &category= &verdict= &minScored= &sort=
  → { subjects: [{ subjectRef, displayName, accounts: [{verdict}],
                   accuracy: AccuracyStats, popularity: PopularityStats,
                   combinedScore: null }], nextCursor }
  · accuracy.hitRatePct는 표본 부족이면 **null**이다. 0이 아니다
  · 정렬 기본값은 적중률이 아니다 — 표본이 적은 사람이 위로 온다

GET /api/intel/personas/:subjectId/statements
  ?since= &asset= &usability=
  → { statements: [{ quote, sourceUrl, spokenAt, collectedAt,
                     claim: ExtractedClaim, usability,
                     outcome: OutcomeJudgement }] }
  · outcome.causality는 항상 'NOT_ESTABLISHED'다

GET /api/intel/personas/alerts
  → 중요 발언 알림 후보. **매매 신호가 아니다**
```

인증은 기존 체계를 그대로 쓴다 (`resolveUserId`). 새 우회 경로를 만들지
않는다. 분석 허브 연동은 기존 화면에 **읽기 전용 패널**을 붙이는 방향이고,
승인 전에는 화면을 건드리지 않는다.

## 5. 확장 절차 — 예시 명단만 구현하지 않는다

후보를 추가할 때 이 순서를 지킨다. 무제한 전원 수집을 보장하지 않는다.

1. **후보 발굴**: 자산군(주식·코인·채권·환율·원자재·부동산) × 지역(국내·
   해외) × 유형(§2의 `InfluenceCategory` 11종)으로 격자를 만들고 빈 칸을 채운다.
2. **동일성 확인**: 이름이 같은 것은 증거가 아니다. `judgeAccount`가
   `OFFICIAL_CONFIRMED`를 주는 계정만 발언의 주체로 적는다.
3. **중복 제거**: 같은 주체의 여러 계정을 `duplicate_of_account_id`로 묶는다.
   묶지 않으면 적중률 통계가 두 번 세진다.
4. **수집 가능성**: 플랫폼 약관·저작권·유료 콘텐츠 권한·개인정보를 확인한다.
   **비공개 지표나 유료 데이터를 무단 복제하지 않는다.**
5. **우선순위**: 발언 빈도 × 자산 관련성 × 검증 가능성. 영향력만으로
   올리지 않는다 — 검증할 수 없는 발언은 통계를 만들지 못한다.

## 6. 하지 않는 것 (명시)

- **제미나이 자료의 VIX 기반 DCA와 Chandelier ATR 청산을 Exact100X로
  채택하지 않는다.** 실제 코드의 Exact100X 계약은 `MAX_LEV_100X` ·
  정확히 100배 · `isolated` · `NO_FIXED_SL` / `NO_FIXED_TP`이고,
  VIX·Chandelier를 쓰는 코드는 저장소에 없다. 조사 자료의 설명을
  현재 구현으로 적지 않는다.
- **발언을 매매 신호로 연결하지 않는다.** `personaCanon.ts`에는 주문을
  낼 수단이 타입에 없고, 시험이 그 사실을 고정한다.
- **발언 뒤 가격 변화를 인과로 적지 않는다.** `OutcomeJudgement.causality`가
  항상 `'NOT_ESTABLISHED'`다. 상수로 둔 이유는 호출부가 인과를 적고
  싶어질 때 여기서 막히게 하려는 것이다.
- 원문이 확인되지 않은 루머를 사실로 적지 않는다 (`UNSOURCED`).

## 7. 지금 있는 것 / 없는 것

| | 상태 |
|---|---|
| 판정 정본 `src/lib/intel/personaCanon.ts` | **있다** (import 0 · 순수) |
| 시험 25건 | **있다** · 전체 7082 통과 / 0 실패 |
| 수집기 **인터페이스** | 있다 (`PersonaCollector`) |
| 수집기 **구현체** | **없다** (승인 사항) |
| DB 표 | **없다** (§3 설계만) |
| API 라우트 | **없다** (§4 계약만) |
| 화면 | **없다** |
| 제미나이 명단 대조 | **못 했다** — 자료 본문 미전달 |
