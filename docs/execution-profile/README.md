# 실행 프로필 계약 (PR 1A)

화면에서 고른 실행 프로필이 실제 주문 경로에서 **같은 의미**가 되게 하는
작업의 첫 단계다. 이 PR은 **계약만 만든다** — 실행 의미는 아직 바꾸지 않는다.

| | |
|---|---|
| base | `7101916e55eb8f9e5719b9091823b5777f922d43` |
| 정본 | `src/lib/execution/profile.ts` |
| 검사기 | `scripts/check-execution-profile.mjs` (CI 배선) |
| 마이그레이션 | `077_execution_profile.sql` |

## 무엇이 고장나 있었나

`profiles.ts`는 이미 값을 갖고 있었다 — 배율 25~50배, 자산비중 10%,
1회 위험 0.5%, 익절 0.6% / 손절 0.3%, isolated, Post-only 지정가.

그런데 **그 값을 읽는 곳이 화면 하나뿐이었다.**

```
src/lib/strategies/profiles.ts   ← import: StrategyProfilesPanel.tsx 뿐
src/lib/strategies/ruleEngine.ts ← import: StrategyProfilesPanel.tsx 뿐
```

`profiles.ts` 머리말은 *"규칙 엔진이 이 프로필을 참조해 파라미터를 강제
적용/clamp 한다"*고 적어 뒀지만, 실행 경로 어디도 `ruleEngine`을 부르지
않는다. 실제 단타는 ATR에서 손절·목표를 매번 새로 계산한다
(`scalpSignal.ts` — `atrStopMult 1.0`, `stopPct`가 그때그때 다르다).

**만들어 놓고 배선을 안 한 것이다.** 원인은 "값이 분리돼 있다"가 아니라
"값이 실행에 연결된 적이 없다"이다.

### 지금은 sizing과 보호주문이 어긋나 있지 않다

`riskManager.planPosition`은 `signal.stopLoss`에서 손절 거리를 얻고,
scalp의 보호주문도 같은 `scalp.signal.stop`을 쓴다. **오늘은 정합한다.**

그 불일치는 1C에서 프로필을 **보호주문에만** 덮어쓰면 새로 생긴다.
그래서 1C는 보호주문이 아니라 **신호 생성 지점**을 덮어써야 한다.

## 두 층을 한 축으로 섞지 않는다

```
기본 프로필   SCALP_HIGH_LEV · SWING_LOW_LEV · DAILY_HIGH_LEV   profiles.ts
위험 프리셋   STABILIZE · RESEARCH                              profilePreset.ts
```

`RESEARCH`는 **프리셋이지 프로필이 아니다.** 한 칸으로 적으면
`SCALP_HIGH_LEV + RESEARCH`와 `SCALP_HIGH_LEV + STABILIZE`를 구분할 수 없다.

| | RESEARCH | STABILIZE |
|---|---|---|
| leverage | 25 | 5 |
| maxLeverage | 50 | 10 |
| riskPercentPerTrade | 0.5% | 0.25% |
| dailyLossLimitPct | 2% | 2% |

**다섯 배 차이가 같은 값으로 저장된다.** 그래서 선택은 언제나 세 축이다 —
프로필 · 프리셋 · 계약 버전.

## 되돌아가지 않는다

기존 두 함수는 모르는 값을 다른 값으로 바꾼다. 화면에서는 편의지만
실행에서는 **오타 하나가 다른 배율로 주문을 내는 일**이다.

| 함수 | 모르는 값 → |
|---|---|
| `profiles.ts:166` `getProfile()` | `SWING_LOW_LEV` |
| `profilePreset.ts:135` `presetOf()` | `STABILIZE` |

실행 resolver는 둘 다 쓰지 않는다. 그런데 `applyPreset()`은 안에서
`overrideOf()` → `presetOf()`를 부른다. 그래서 "직접 안 쓴다"만으로는
부족하고, **검증 순서**로 도달 자체를 막는다.

```
① 프로필 정확 일치 (PROFILES[id])
② 프리셋 정확 일치 (PRESET_TABLE 키)
③ 버전 일치
④ ── 여기까지 통과해야만 ── applyPreset(검증된 base, 검증된 preset)
⑤ CONTRACT_FIELDS 화이트리스트 투영
```

## 계약은 화이트리스트다

`StrategyProfile`에는 실행값과 모의 전용값이 같은 객체에 산다
(`simSeed` · `simCurrency` · `simTargetEquity` · `simPrice` · `simHoldSec`).
프로필을 통째로 넘기면 **모의 시드 하나 바꿨다고 실행 계약 버전을 올려야
하는** 구조가 된다.

계약에 들어가는 12칸: `leverage` `maxLeverage` `marginModes`
`maxPortfolioPct` `riskPercentPerTrade` `takeProfitPct` `stopLossPct`
`orderType` `timeoutSec` `dailyLossLimitPct` `maxHoldSec` `maxOpenPositions`.

빠지는 것: `label` `description` `sim*` `leverageBand` `riskBand`,
Monte Carlo · `edgePp` · `assumedWinRate`.

**시뮬레이션 가정(+20%p 같은 것)은 실행 축과 완전히 별개다.** `RESEARCH`를
실행 가능하게 만드는 것은 `+20%p`를 실행 가능하게 만드는 것이 아니다.

## 지금은 잠들어 있다 (dormant)

이 PR의 코드는 계약을 **저장하고 전달만** 한다. 실행기는 아직 읽지 않는다.
그러니 계약을 가진 예약을 켤 수 있게 두면 **"화면은 연구용인데 실제는
ATR"**이라는, 지금 없애려는 고장을 정식 기능으로 만드는 셈이다.

| 층 | 위치 | 규칙 |
|---|---|---|
| **L1 DB** | `077` CHECK | `execution_profile_id IS NULL OR enabled = false` |
| **L2 write** | POST | 프로필을 건드리는 요청은 `enabled:false` 명시 필수 |
| **L3 toggle** | PATCH | 켜기 UPDATE **조건 안**에 프로필 필터 |
| **L4 run** | `evaluationRunner` | 선점·평가보다 **앞에서** BLOCK |

### L1이 왜 필요한가

Worker는 웹의 evaluator를 **빌드 시점에 번들**한다.

```
worker/src/index.ts:30   import { evaluateIfDue } from '../../src/lib/autotrade/evaluationRunner'
worker/tsconfig.json     "rootDir": ".."
```

그래서 구 Worker는 배포 시점의 evaluator 스냅샷을 들고 돈다. 새 컬럼을
모르는 옛 코드다. **코드 층(L2~L4)만 두면 배포가 엇갈리는 창에서
무방비다.** L1은 DB가 강제하므로 그 창에서도 `enabled + selection` 행이
존재할 수 없다.

077이 아직 적용되지 않은 환경에서는 L1이 없지만, 그때는 저장 자체가
`EXECUTION_PROFILE_SCHEMA_MISSING`으로 막히므로 그런 행이 생기지 않는다.
**두 규칙의 조합**으로 닫히는 것이지 단일 층이 아니다.

### 1C에서 푸는 방법

```sql
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT autotrade_schedules_execution_profile_dormant;
```

`_complete`는 그대로 둔다. 반쪽 선택은 그때도 선택이 아니다.

## 077이 없으면 후퇴하지 않는다

이 라우트에는 새 칸이 없는 DB에서 그 칸만 빼고 다시 써서라도 예약을
살리는 패턴이 있다(`needsPhaseB`). 기존 기능에는 맞다.

**실행 프로필에는 쓰면 안 된다.** 사용자가 연구용을 골라 저장했는데 칸이
없다고 세 필드를 떼고 저장하면, 화면에는 저장된 것처럼 보이고 실제로는
기존 ATR 예약이 된다. 그래서 `503 EXECUTION_PROFILE_SCHEMA_MISSING`으로
멈춘다 — 저장 0건, 첫 평가 0회.

읽기(GET)는 후퇴해도 된다. **못 읽는 것과 저장하지 않는 것은 다른 일이다.**

## 설정 변경 ≠ 가동

POST의 `enabled` 기본값은 `body?.enabled !== false` — **생략하면 true**다.
그래서 프로필만 바꾸려고 `enabled`를 생략하면 저장이 곧 가동이 된다.
프로필을 **해제**하는 요청이 "기존 ATR로 지금 켜라"가 되어 버린다.

그래서 실행 프로필 키를 하나라도 실은 POST는 `enabled:false`를 명시해야
한다. 켜는 것은 기존 정본인 PATCH의 몫이다 — 이 라우트를 "켜짐 한 칸"으로
분리한 기존 철학과 같다.

## 안 보냈다 ≠ 비웠다

| 상태 | 판정 |
|---|---|
| 세 키가 body에 **없음** | 기존 선택 **보존** (UPDATE 대상 제외) |
| 세 키 전부 명시적 `null` | 해제 — 세 컬럼 NULL |
| 일부만 존재/null | `incomplete_selection` → 400, UPDATE 0건 |

`'executionProfileId' in body`로 가른다. `body.x == null`로 보면 둘이
같아지고, 그러면 이 세 칸을 모르는 구버전 화면이 예약을 한 번 저장하는
것만으로 사용자가 골라 둔 프로필이 조용히 지워진다.

## 버전 — 조용히 올리지 않는다

`EXECUTION_CONTRACT_VERSION` 하나가 **해석된 매트릭스 전체**(3 프로필 ×
2 프리셋)를 가리킨다. 기본 프로필만 버전을 매기면 프리셋의 위험 0.25%가
0.4%로 바뀌어도 같은 버전이 되어 **같은 예약이 다른 의미로 실행된다.**

검사기는 **이전 커밋과 비교**한다. 현재 파일끼리의 자기일치만 보면,
실행값과 스냅샷을 같이 고치고 버전을 그대로 두는 경우가 통과한다. 그래서
`ci.yml`의 checkout에 `fetch-depth: 0`이 필요하다.

```
base 실행 정의 ≠ head 실행 정의  AND  base 버전 == head 버전   → FAIL
```

주석만 바뀐 경우는 통과시킨다 — 주석은 계약이 아니다.

**bootstrap**: 계약이 처음 들어오는 PR에는 비교할 base가 없다. 그때는
조용히 통과시키지 않고 두 가지를 본다 — 버전이 1인가, 그리고 **이 PR에서
실행 정의(`profiles.ts`·`profilePreset.ts`)가 함께 바뀌지 않았는가.**
같이 바뀌면 무엇이 v1인지 정할 수 없다.

### 운영 영향

전역 버전이라 **SWING 값 하나가 바뀌어도 SCALP 예약까지** 전부
`VERSION_MISMATCH`로 막힌다. fail-closed라 안전하지만 영향이 넓다.
자동 승격은 하지 않는다 — 사용자가 새 계약을 명시적으로 다시 저장해야
재개된다.

## 이 PR이 하지 않는 것

PostOnly 실제 실행(1B) · scalp TP/SL 의미 변경(1C) · LIVE 활성화 ·
`riskManager` 변경 · 서버 인증 · kill-switch backend · worker · scheduler ·
새 정본 테이블 · `live_orders` 스냅샷 · 새 분산 락.

`profilePreset.ts`는 **한 글자도 바꾸지 않았다.**

`profiles.ts`는 세 줄 바꿨다 — **계획에 없던 변경이라 따로 적는다.**
resolver를 `evaluationRunner`에 넣으면서 이 파일이 **워커의 컴파일
그래프**로 들어왔고(워커는 웹 소스를 `rootDir: ".."`로 함께 컴파일한다),
워커 tsconfig는 `strict: true`라 기존 `sim*` 헬퍼가 타입 오류를 냈다.

```
-  if (p.simHoldSec > 0) return p.simHoldSec;
+  const s = p.simHoldSec ?? 0;
+  if (s > 0) return s;
```

`simSeedOf`·`simPriceOf`도 같은 모양이다. **동작은 동일하다** —
`undefined > 0`도 `0 > 0`도 false다. 셋 다 모의 전용 헬퍼이고 실행값이
아니다. 계약·지문·주문 경로 어디에도 영향이 없다.

이 때문에 검사기의 bootstrap 규칙도 좁혔다. 파일 바이트를 비교하면 이런
타입 정리까지 "실행 정의 변경"으로 잡혀서, 개발자가 규칙을 우회하는 습관이
든다. 그래서 **계약에 들어가는 칸과 프리셋 override 칸의 값만** 비교한다.

## 1C 예약사항

`AutotradeControl`의 **[지금 점검하기]**도 `strategyRunRequest()`를 쓴다.
1A에서는 UI 선택을 만들지 않으므로 건드리지 않았지만, **1C에서 실행 프로필
UI를 붙이는 순간 이 점검 경로도 같은 composite selection을 써야 한다.**
안 그러면 "예약은 RESEARCH인데 점검은 legacy ATR"이라는 같은 계열 불일치가
생긴다.
