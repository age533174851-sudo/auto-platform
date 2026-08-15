# MASTER_AUDIT — TRAIGO 저장소 전수감사

기준 커밋: `4ca49bf` (main, PR #128 머지 직후)
작성일: 2026-08-15

---

## 이 문서가 존재하는 이유

지금까지 고친 것들의 공통점이 하나 있다. **코드가 있는데 배선이 안 됐거나, 경로가 둘인데 한쪽만 고쳐졌다.**

- `fetchVenueBars`는 봉을 주는데 라우트가 배열로 읽어 매번 빈 값 (#122)
- 저장에는 `strategyId`를 실었는데 토글에는 안 실어 다른 줄이 바뀜 (#125)
- SL은 거는데 TP는 Gate 분기에서 아무 데도 안 감 (#126)
- 진입 id는 소유권을 새겼는데 SL/TP id는 문자열을 이어 붙여 소유권을 잃음 (#128)

전부 **"만들어 놓고 안 씀"** 또는 **"둘 중 하나만 고침"**이다. 그래서 이 감사는 기능 목록이 아니라 **"UI ↔ 실행 경로 ↔ DB ↔ 워커가 실제로 이어져 있는가"**를 본다.

원칙: **UI가 있다는 이유로 완료 처리하지 않는다.**

범례: ✅ 완료 · 🟡 부분 · ❌ 미구현 · 🔴 P0 오류 · ⚪ 연구 전용

---

## 0. 요약 — 지금 가장 급한 것

| # | 항목 | 상태 | 근거 |
|---|---|---|---|
| P0-1 | scalp 점검 플래그 불일치 | 🔴 | registry `checkFlag: 'checkOnly'` ↔ 라우트 `body.dryRun === true` |
| P0-2 | scalp 지원 주기 ↔ 실행 판정 모순 | 🔴 | `supportedIntervals [1,5,15,60]` ↔ `timeframeVerdict` 비용 기준 |
| P0-3 | scalp preflight에 `connectionId` 없음 | 🔴 | `PreflightOptions`에 칸 자체가 없다 |
| P0-4 | exit-monitor가 Binance 전용 | 🔴 | `liveStopFor` · `MOVE_STOP` · 트레일링이 `binanceFutures` 직접 호출 |
| P0-5 | daily-ladder가 Gate 연결에서 Binance 데이터를 읽음 | 🔴 | `getPremiumIndex` 직접 호출 · `exchange: 'binance'` 하드코딩 |
| P0-6 | `oiChangePct` 선언만 있고 값이 없음 | 🔴 | `let oiChangePct` 후 대입 없음 |
| P0-7 | system/status 필수 표 목록이 낡음 | 🟡 | 032까지만. `strategy_cycles`·`worker_heartbeat`·`smoke_tests` 없음 |
| P1-1 | 지갑이 `/api/wallets`를 안 부름 | ❌ | `WalletPage`가 빈 배열을 직접 넣음 |
| P1-2 | 홈이 하드코딩 숫자 | 🔴 | `LONG_VALUE=48500000` 등 · `autoAll=true` |
| P1-3 | `workerPlan.ts` 없음 | ❌ | `src/lib/runtime/`에 파일 자체가 없다 |
| P1-4 | registry note가 코드보다 뒤처짐 | 🟡 | my-original-v1이 아직 "규칙이 입력되지 않았습니다" |

---

## 1. 실행 경로 (주문 · 청산 · 보호주문)

### 1.1 이미 고쳐진 것 — 증거와 함께

| 항목 | 상태 | 증거 |
|---|---|---|
| 봉을 열 단위 객체로 읽기 | ✅ | `venueBarsToWindowBars` (#122) |
| 조회 실패를 CLOSED로 적던 것 | ✅ | `closeEvidence.closeVerdict` (#118) |
| 예약 ON/OFF가 다른 줄을 바꾸던 것 | ✅ | `PATCH {id, enabled}` (#125) |
| 기존 포지션 위 신규 진입 | ✅ | `entryGate` → `SAME_SIDE_BLOCKED` / `REVERSAL_REQUIRED` (#126) |
| 반전을 시장가 상계로 처리 | ✅ | `reversalProgress` 상태기계 (#126) |
| Gate TP 미부착 | ✅ | `gateTakeProfitSpec` + `placeStopGateFutures` 배선 (#126) |
| SL/TP 생성 응답만 믿던 것 | ✅ | `readbackProtective` (#126) |
| 참고가 기준 SL/TP | ✅ | `fillBasedExit.exitFromFill` (#126) |
| `exec.ok`로 ENTERED 판정 | ✅ | `enteredVerdict` (#126) |
| 보호주문 소유권 형식이 깨짐 | ✅ | `protectiveClientOrderId` (#128) |
| 잔여 주문 거짓 PASS | ✅ | `residualVerdict` (#128) |

**이 목록은 "코드가 main에 있다"는 뜻이고, 실제 runtime 검증은 아래 §8이 따로 본다.**

### 1.2 남은 것

#### 🔴 P0-1. scalp 점검 플래그 불일치 — 점검이 주문을 낼 수 있다

```
registry.ts:111   checkFlag: 'checkOnly'      ← scalp
scalp/route.ts:70 const dryRun = body.dryRun === true
```

`strategyRunRequest()`가 registry의 `checkFlag`를 그대로 본문에 넣는다. 화면에서 **[지금 점검하기]**를 누르면 `{checkOnly: true}`가 나가는데, scalp 라우트는 `dryRun`만 본다 — 즉 `dryRun`이 `undefined`라 **주문 경로까지 간다.**

daily-ladder도 `checkFlag: 'checkOnly'`이므로 같은 검사가 필요하다(라우트가 실제로 `checkOnly`를 읽는지 확인해야 함).

**고칠 방향**: 라우트가 registry의 값을 읽게 하거나(권장), 두 이름을 한 곳에서 정의하고 라우트가 그것을 import한다. **이름을 두 곳에 적는 구조 자체를 없앤다.**

#### 🔴 P0-2. scalp 지원 주기 ↔ 실행 판정 모순

`supportedIntervals: [1, 5, 15, 60]`을 화면에 내려보내는데, `timeframeVerdict`의 비용 기준은 짧은 주기를 `timeframe_unusable`로 막는다. **UI에서 고를 수 있는데 실행하면 409로 끝난다.**

#### 🔴 P0-3. preflight에 `connectionId`가 없다

`PreflightOptions`에 `connectionId` 칸 자체가 없다. scalp가 `collectChecklistInput({sb, userId, testnet, symbol, ...})`을 부르는데, 연결이 둘 이상이면 **어느 계좌 상태를 보고 통과/차단하는지 알 수 없다.** 지금은 Gate 하나라 우연히 맞지만, 이건 우연이다.

#### 🔴 P0-4. exit-monitor가 아직 Binance 전용

CLOSE 경로는 #118에서 거래소 공통이 됐지만, 나머지는 그대로다:

```
exit-monitor/route.ts:96   bf.getFuturesOpenOrders   ← liveStopFor
exit-monitor/route.ts:468  bf.placeFuturesTPSL       ← MOVE_STOP
exit-monitor/route.ts:481  bf.getFuturesOpenOrders   ← MOVE_STOP
exit-monitor/route.ts:486  bf.cancelFuturesOrder     ← MOVE_STOP
exit-monitor/route.ts:326  binanceFutures            ← 트레일링 봉
```

**Gate 포지션은 진입되는데 이후 트레일링·본전이동이 안 돈다.** 화면에는 "청산 감시 정상"으로 보인다.

`venuePositionOps`(#126)와 `readbackProtective`(#126)에 이미 두 거래소 경로가 있으므로 새로 만들 필요는 없다.

#### 🔴 P0-5·P0-6. daily-ladder venue 일관성

```
daily-ladder/route.ts:221  bf.getPremiumIndex(symbol, useTestnet)  ← Gate 연결에서도 Binance
daily-ladder/route.ts:218  let oiChangePct: number | undefined;    ← 대입이 없다
daily-ladder/route.ts:259  oiChangePct,                            ← 언제나 undefined
daily-ladder/route.ts:341  exchange: 'binance', mode: opMode       ← SHADOW 기록 하드코딩
```

펀딩은 거래소마다 다르다. Gate로 거래하면서 Binance 펀딩으로 판단하면 **다른 시장을 보고 주문하는 것**이다.

`oiChangePct`는 선언만 있고 값이 없어 판단에 기여하지 못한다 — 조용히 빠진 지표다.

#### 🟡 P0-7. system/status 필수 표 목록이 낡음

```
TABLES = [sub_accounts(024), safety_events(026), cron_runs(029),
          trader_signals(030), autotrade_schedules(031), scheduled_exits(032)]
```

없는 것: `strategy_cycles`(051) · `worker_heartbeat` · `smoke_tests`(052) · `smoke_runs`(053) · `account_equity_snapshots`(048) · `mock_sessions`(046).

**`strategy_cycles`가 없으면 my-original-v1이 503으로 막히는데 상태판은 "정상"이라고 적는다.**

#### ❌ P1-3. `workerPlan.ts`가 없다

`src/lib/runtime/`에는 `dataLocation` · `mockSession` · `persistentRuntime`만 있다. `workerPlan.ts`는 PR #107 브랜치에만 있고 현재 main에 없다. **#107을 그대로 머지하지 말고 최신 main 기준으로 필요한 부분만 재작성해야 한다.**

#### 🟡 P1-4. registry 설명이 코드보다 뒤처짐

```
registry.ts:136  '진입 방향과 손절·익절 규칙이 아직 입력되지 않았습니다 — … 주문은 나가지 않습니다'
```

실제로는 진입 방향(#118)·청산 정책(#119)이 확정됐고 Gate TESTNET 실주문·보호주문·청산까지 확인됐다. **코드는 발전했는데 메타데이터가 남았다** — 화면이 이 문장을 그대로 보여준다.

---

## 2. 지갑 · 장부 · 성과

### ❌ P1-1. 지갑이 `/api/wallets`를 부르지 않는다

`/api/wallets`에는 Gate/Binance 현물·선물 잔고 조회가 **이미 있다.** 그런데 `WalletPage.tsx`는:

```
:65   amountOf(null, 'LOADING')          ← 모든 버킷
:83   const snapshots: any[] = [];
:94   const allAccounts: AccountOption[] = [];
:99   const futuresAccounts = [];
```

주석에는 "아직 거래소를 안 붙였다"고 정직하게 적혀 있다. **정직하지만 배선이 없다.** 돈을 못 읽는 게 아니라 화면이 안 물어본다.

필요한 것(전부 미구현):
현재 총자산 · 시작 자산 · 총 손익/수익률 · 오늘/7일/30일/올해/전체 손익 · 실현/미실현 · 수수료 · 펀딩 · 입출금/순입출금 · 시작 시각 · 운용 경과 · 총 거래수 · 승/패/승률 · 평균 이익/손실 · Profit Factor · Expectancy · MDD · 최고/최저 자산 · 사용/가용 증거금 · 열린 포지션 · 미체결/보호주문 · 마지막 동기화 · 데이터 상태

**전략별로도 같은 분해가 필요하다**(예: `09:10 원본 · 시작 $1,000 · 현재 $1,247 · +24.7% · 운용 4일 13시간 · 3회 진입 · cycle 1 · 계단 $1,000 → 주문증거금 $100`).

### 🔴 P1-2. 홈이 하드코딩

```
HomePage.tsx:79-83  LONG_VALUE=48500000  SHORT_VALUE=1230000
                    CASH_VALUE=5000000   TOTAL_PNL=2870000
HomePage.tsx:66     const [autoAll,setAutoAll]=useState(true)
```

**자동매매가 꺼져 있어도 홈은 켜짐으로 그린다.**

### ❌ 통합 장부(Unified Ledger) 없음

지금 있는 것: `live_orders`(012) · `ladder_daily_trades`(017) · `strategy_cycles`(051) · `account_equity_snapshots`(048).

없는 것: Fill · Fee · Funding · Interest · Dividend · Deposit · Withdrawal · Internal transfer · Corporate action · Futures rollover. 그래서 **"총 얼마 벌었냐"에 정확히 답할 수 없다.**

그리고 **Equity 증가 ≠ Trading PnL ≠ Cash Flow**를 분리하는 계산이 없다. 입금해서 늘어난 것을 수익으로 읽을 위험이 있다.

### 🟡 MOCK이 브라우저 중심

`mock_sessions`(046) 스키마는 있는데 실제 runtime이 브라우저에 남아 있다. `check-runtime.mjs`가 **서버로 옮겨야 하는 실행 타이머 4개**를 이미 빚으로 기록해 두고 있다:

- `MockAutoTrade.tsx` — MOCK 자동매매가 브라우저 타이머로 판단·체결
- `AutoTradeEngine.tsx` — 전략빌더 전략을 60초마다 평가
- `terminal/DemoRunner.tsx`
- `terminal/ScheduledExitPanel.tsx` — **예약 청산 감시. 화면이 닫히면 청산이 안 걸린다**

마지막 것이 가장 위험하다.

`localStorage`를 쓰는 화면 20개 이상(§부록). 원장처럼 쓰는 곳과 단순 UI 기억을 구분해 정리해야 한다.

---

## 3. 전략 시스템

### 실행 가능한 전략 (registry)

| id | 실행 | TESTNET | LIVE | 주기 |
|---|---|---|---|---|
| `daily-ladder` | ✅ | ✅ | ✅ | 60/240/720/1440 |
| `scalp` | ✅ | ✅ | ❌ | 1/5/15/60 (🔴 P0-2 모순) |
| `my-original-v1` | ✅ | ✅ | ❌ | 5/15/30/60 |

### ❌ 미구현

- **표시명 정리** — `my-original-v1` → `09:10 봉 방향 · 원본` 등. **내부 id는 절대 바꾸지 않는다**
- **복수 선택 UI** — 지금은 라디오 하나. `체크 = 선택` / `ON/OFF = 실제 실행` 분리 필요
- **전략별 자금배분** — 고정 증거금 / 계좌 비율 / 위험예산 역산 / 전략 전용 최대 자본. 지금은 사실상 10% 고정
- **1회 위험 % ↔ 1회 증거금 %** 개념 분리가 UI/계산 모두에서 불완전
- **주문금 / 증거금 / notional** 구분 표시 없음 (100x에서 $100 = margin $100 + notional $10,000)
- **전략별 가상계좌(sleeve)** — allocated / available / reserved margin / realized / unrealized / qty ownership / fees / funding / protective orders
- **계좌 전체 위험예산** — 여러 전략 동시 실행 시 합산 위험
- **전략 승격 파이프라인** — SPEC → BACKTEST → WALK_FORWARD → MONTE_CARLO → PAPER → SHADOW → TESTNET → LIVE_SMALL → LIVE_LIMITED

### 🟡 같은 심볼 다중 전략

`symbolOwnershipConflict`(#126)가 **켜져 있는** 다른 전략을 BLOCK_CONFLICT로 막는다. ownership slicing 전까지 이 상태를 유지하는 것이 맞다. 다만 포지션 단위 소유권은 아직 없다.

---

## 4. UI / IA

### 현재

메뉴 29개(`check-nav.mjs` 기준) · 화면 분기 61개 · 페이지 컴포넌트 51개.

### ❌ 미구현

- **6개 IA**(홈/시장/매매/자동/지갑/더보기)로 재편
- 자동 화면을 **관제판**으로 (지금은 설정 폼 + 긴 설명이 먼저 보인다)
- 3단계 progressive disclosure (기본 / 상세 / 고급 진단)
- 디자인 시스템 토큰(spacing · typography · card · row · button · switch · badge · status · accordion · table · bottom sheet)
- ExperienceMode (BEGINNER / INTERMEDIATE / PRO) — **위험 권한은 동일**
- 공통 `TruthValue` 셀 — `null` / `UNKNOWN` / 조회 실패 / 데이터 없음 / 실제 0을 전 화면에서 같은 모양으로

### 🟡 부분

- `runtimeLabels`를 서버가 내려보내 화면이 그대로 쓰는 구조는 이미 있다(#116) — 이걸 전 화면으로 넓히면 된다

---

## 5. 워커 · 스케줄러 · 배포

| 항목 | 상태 | 비고 |
|---|---|---|
| Fly Worker가 예약 polling | ✅ | `schedulePoll` + `evaluateIfDue` (#123) |
| dispatch source 기록 | ✅ | FLY_WORKER / GITHUB_FALLBACK / MANUAL (#124) |
| worker heartbeat → STALE 표시 | ✅ | `WORKER_STALE_MS` (#124) |
| fly-deploy 자동 트리거 | ✅ | `workflow_run` on ci success (#124) |
| 스모크 청산 polling | ✅ | `pollSmokeTests` (#127) |
| 반복 스모크 다음 회차 | ✅ | `pollSmokeRuns` (PR-A #129) |
| `workerPlan.ts` desiredState/observedState | ❌ | 파일 없음 |
| **배포 SHA 대조** | ❌ | Vercel SHA ↔ Fly SHA ↔ main SHA 비교 없음 |

**#124에서 실제로 드러난 것**: 코드가 main에 있어도 Fly에 안 올라가면 없는 코드와 같다(fly-deploy가 8/9 이후 한 번도 안 돌아 8/13 판단 창을 놓쳤다). `CODE_DEPLOYMENT_MISMATCH` 상태가 필요하다.

---

## 6. 거래소 어댑터

| | Gate | Binance |
|---|---|---|
| 포지션 조회 | ✅ | ✅ |
| 시장가 진입 | ✅ | ✅ |
| SL 부착 | ✅ | ✅ |
| SL 되읽기 | ✅ (#126) | ✅ |
| TP 부착 | ✅ (#126) | ✅ |
| TP 되읽기 | ✅ (#126) | ✅ |
| 분할 TP(exitPlan) | ❌ | ✅ |
| 전량 청산 | ✅ | ✅ |
| 조건부 주문 목록 | ✅ | ✅ |
| 지정 id 취소 | ✅ | ✅ |
| 트레일링/본전이동 | ❌ (P0-4) | ✅ |
| 펀딩 조회 | 🟡 (P0-5) | ✅ |

**멀티에셋 확장 전제**: `InstrumentRegistry` · `MarketAdapter` · `BrokerAdapter` · `InstrumentSpec` · `OrderIntent` · `AccountSnapshot` · `SessionCalendar` · `CorporateAction` · `ContractLifecycle` 전부 ❌. 지금 core는 `exchange + symbol` 전용이다.

선물 특화(만기 · first notice · last trade · rollover · 계약승수 · tick value · 실물인수) 전부 ❌.

---

## 7. 연구 · 백테스트 · AI

| 항목 | 상태 |
|---|---|
| 백테스트 화면 | ⚪ 연구 전용 |
| 전략빌더 | ⚪ 연구 전용 (브라우저 타이머로 60초 평가 — 빚) |
| EMA/RSI/MACD/DCA 등 예시 전략 | ⚪ **실행 registry에 없다** — 실행 버튼이 있으면 안 된다 |
| gross ↔ net 분리 | ❌ |
| expectancy / payoff / MDD / liquidation count 분리 | ❌ |
| 자금관리 효과와 전략 edge 분리 | ❌ **가장 중요** |
| 계단식 복리 별도 엔진 | ❌ |
| AI Briefing 하드코딩 제거 | ❌ |

**"1회 위험 10%를 넣으니 수익이 커진다"는 좋은 전략이라는 뜻이 아니다.** 파산확률 26.3% · 최악 MDD −99.8%면 실전 부적합 판정이 맞다. 평가 순서를 **전략 자체 → 자금관리 → 경로 위험**으로 바꿔야 한다.

---

## 8. 실제 runtime 검증 상태

**"머지됨"은 완료가 아니다.**

| 검증 | 상태 |
|---|---|
| Gate TESTNET 실주문 | ✅ 사용자 확인 |
| SL 실제 부착 | ✅ 사용자 확인 |
| 10분 뒤 워커 자동청산 | ✅ 사용자 확인 (Positions 0) |
| 고아 SL/TP 정리 | 🔴 **실패 확인** (Orders 2 남음 → #128에서 원인 수정, **재검증 필요**) |
| TP 실제 부착 | ❓ 미확인 (#126 배선 후 아직) |
| 반복 10회 | ❌ PR-A 머지·배포 후 |
| 마이그레이션 052/053 적용 | ❌ 미적용 |

---

## 9. 부록 — 확인된 사실 목록

### `localStorage`를 쓰는 페이지 (20+)
SearchPage · WatchlistPage · PortfolioPage · PineGuidePage · SettingsPage · HistoryPage · StrategyBuilderPage · NewsPage · FearDcaPage · ChartTab · TradingPage · AnalysisHubPage · AlertsPage · EconCalendarPage · SharedUI · HomePage · JournalReviewPage · PaperTradingPage · WatchGroupsPage · AcademyPage

→ **원장처럼 쓰는 곳**과 단순 UI 기억(관심종목 정렬 등)을 구분해 전자만 서버로 옮긴다.

### 마이그레이션 상태
`002`~`052` 존재. **결번 `047` · `049`** — 049는 PR #107에만 있고 main에 없다.
적용 확인됨: `051`. 미적용: `052`(smoke_tests) · `053`(smoke_runs, PR-A).

### 브라우저 실행 타이머 (서버로 옮겨야 하는 빚 4개)
`MockAutoTrade.tsx` · `AutoTradeEngine.tsx` · `terminal/DemoRunner.tsx` · `terminal/ScheduledExitPanel.tsx`

### 자동 발견 — 요청 목록에 없던 것
1. **`daily-ladder`도 `checkFlag: 'checkOnly'`다.** scalp와 같은 불일치가 있는지 라우트를 확인해야 한다 (P0-1에 포함)
2. **`smoke_tests`/`smoke_runs`가 system/status 목록에 없다** — 스모크가 표 없음으로 막혀도 상태판은 정상이라고 적는다
3. **`account_equity_snapshots`(048)가 아무 데서도 안 채워진다** — 표는 있는데 쓰는 곳이 없다. 지갑 곡선이 영원히 비어 있는 이유
4. **`mock_sessions`(046)도 같다** — 스키마만 있고 runtime 미연결

---

## 10. PR 순서 (의존성)

각 PR은 **직전 PR이 main에 머지되고 Vercel/Fly에 실제 배포된 SHA**에서 시작한다. 오래된 브랜치에 stack하지 않는다.

| PR | 내용 | 선행 |
|---|---|---|
| **A** | 반복 스모크 10회 | — (#129 진행 중) |
| **B** | 실행계층 잔여 P0 (P0-1~P0-7 + workerPlan) | A 실제 10/10 PASS |
| **C** | 통합 장부 + TESTNET/MOCK 지갑 실배선 | B |
| **D** | 다중전략 + 전략별 자금배분/가상계좌 | C |
| **E** | 백테스트/시뮬레이터 재정비 | D |
| **F** | 전체 UI/UX/IA 재구축 | C·D |
| **G** | 멀티에셋/멀티브로커 core | F |
| **H** | observability + 배포 SHA truth | 병렬 가능 |
| **I** | E2E / 회귀 / 모바일 QA | 전부 |

각 PR의 완료 조건: `verify` 초록 → auto-merge → **main SHA 확인 → Vercel production SHA 확인 → (워커 변경 시) Fly production SHA 확인**. 검사 초록만으로 완료라고 하지 않는다.

---

## 11. 절대 하지 않을 것

- 원본 전략(`my-original-v1`) 삭제·수정 — **immutable baseline**
- 검증된 execution path를 UI 리팩터링하면서 새로 작성
- 100x 요청을 조용히 낮추기
- `UNKNOWN` → 0 / 정상 / PASS
- 없는 데이터를 mock으로 채워 실제처럼 표시
- `Cancel All`
- symbol만 보고 주문 소유권 판단
- MOCK / TESTNET / LIVE 자산 합산
- `localStorage`를 authoritative ledger로 사용
- 브라우저가 닫히면 멈추는 자동매매
- UI만 만든 뒤 "기능 완료"
