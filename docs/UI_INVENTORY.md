# UI Inventory (5B)

> **이 파일은 손으로 고치지 않는다.** `node scripts/gen-ui-inventory.mjs`가
> 코드에서 굽는다. 낡으면 CI(`scripts/check-ui-inventory.mjs`)가 실패한다.
>
> 문서로만 두면 화면이 바뀔 때마다 어긋나고, **어긋난 것을 아무도 못 본다.**
> 이 저장소는 그 실패를 이미 겪었다(FULL_COMPLETION_STATUS.md).

## 지금 어디까지 왔나

| | 수 |
|---|---|
| 사용자 화면 | 57 |
| 화면 파일을 찾은 것 | 55 |
| 이관 완료 | 0 (0%) |
| 일부 이관 | 1 |
| 미이관 | 54 |
| 라우트 | 10 |

화면들이 아직 각자 정하고 있는 것 (화면 파일 기준):

- `toFixed` **144** · `toLocaleString` **74**
- '확인 불가' 직접 표기 **7**
- 사설 포매터(`const fmt…`) **8**

## 0. 화면 목록이 세 곳에 있다

| 정의 위치 | 무엇 |
|---|---|
| `src/lib/menuItems.tsx` `MENU` | 검색·카테고리 메뉴 |
| `src/app/page.tsx` `BTABS` | 하단 탭 |
| `src/app/page.tsx` `MTABS` | '더보기' 시트 |

| 도달 경로 | 화면 수 |
|---|--:|
| MENU + MTABS | 27 |
| MTABS | 24 |
| MENU + BTABS | 3 |
| BTABS | 1 |
| BTABS + MTABS | 1 |
| (어느 목록에도 없음) | 1 |

**어느 목록에도 없는데 화면 분기만 있는 것** — 사용자가 찾아갈 길이
코드 안에만 있다. 죽은 화면이거나, 다른 화면이 프로그램으로만 여는 곳이다.

- `menu_hub` → `MenuHubPage`

> `check-nav.mjs`는 `MENU` → `case` 방향만 본다. `BTABS`·`MTABS`와
> 반대 방향(화면은 있는데 목록에 없는 경우)은 아무도 안 보고 있었다.

## 1. 전체 사용자 화면

`목적`은 메뉴의 설명문 그대로다 — 여기서 새로 짓지 않는다.

### 거래

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **매매하기** `trading` | 차트·호가·주문 통합 화면 | MENU+BTABS | `pages/TradingPage.tsx` | 미이관 | 33 | 3 | 0 | 1 |
| **전략빌더** `strategies` | 나만의 매매 규칙 만들기 | MENU+MTABS | `pages/StrategyBuilderPage.tsx` | 미이관 | 1 | 2 | 0 | 0 |
| **공포 DCA** `fear_dca` | 공포일 때 분할 매수 | MENU+MTABS | `pages/FearDcaPage.tsx` | 미이관 | 1 | 0 | 0 | 0 |
| **백테스트** `backtest` | 과거 데이터로 전략 검증 | MENU+MTABS | `pages/BacktestPage.tsx` | 미이관 | 8 | 2 | 0 | 0 |
| **모의매매** `paper` | 가짜 돈으로 연습 | MENU+MTABS | `pages/PaperTradingPage.tsx` | 미이관 | 3 | 6 | 0 | 0 |

### 자동화

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **자동매매** `auto` | AI가 대신 자동 거래 | MENU+BTABS | `pages/AutoPage.tsx` | 일부 이관(구간 잠금) | 10 | 3 | 0 | 0 |
| **봇 목록** `autobot` | 실행 중인 봇 관리 | MENU+MTABS | `pages/AutoBotLabPage.tsx` | 미이관 | 7 | 0 | 0 | 0 |
| **실행기록** `history` | 자동매매 체결 내역 | MENU+MTABS | `pages/HistoryPage.tsx` | 미이관 | 0 | 4 | 0 | 0 |
| **리스크 관리** `risk_settings` | 손실 한도·킬스위치 | MENU+MTABS | `pages/RiskSettingsPage.tsx` | 미이관 | 0 | 2 | 0 | 0 |

### 투자정보

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **시장 보기** `market` | 실시간 코인·주식 시세 | MENU+BTABS | `pages/MarketPage.tsx` | 미이관 | 3 | 2 | 0 | 0 |
| **뉴스** `news` | 최신 코인·주식 뉴스 | MENU+MTABS | `pages/NewsPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **AI 분석** `analysis` | AI 시장 분석 허브 | MENU+MTABS | `pages/AnalysisHubPage.tsx` | 미이관 | 2 | 0 | 0 | 0 |
| **시즌전략** `season` | 계절·시즌 전략 | MENU+MTABS | `SeasonDashboard.tsx` | 미이관 | 4 | 0 | 0 | 1 |
| **AI 브리핑** `briefing` | 오늘의 시장 요약 | MENU+MTABS | `pages/BriefingPage.tsx` | 미이관 | 5 | 2 | 0 | 0 |
| **경제캘린더** `calendar` | FOMC·CPI 등 일정 | MENU+MTABS | `pages/EconCalendarPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **스캐너** `scanner` | 급등·급락 종목 탐색 | MENU+MTABS | `pages/ScannerPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |

### 자산관리

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **포트폴리오** `portfolio` | 내 자산 현황 | MENU+MTABS | `pages/PortfolioPage.tsx` | 미이관 | 1 | 1 | 0 | 0 |
| **장기투자** `growth` | 장기 적립·성장 자산 | MENU+MTABS | `pages/GrowthPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **배당/이자** `dividends` | 배당·이자 일정 | MENU+MTABS | `pages/DividendCalendarPage.tsx` | 미이관 | 4 | 1 | 0 | 0 |
| **리밸런싱** `ai_portfolio` | AI 자동 자산 배분 | MENU+MTABS | `pages/AIPortfolioPage.tsx` | 미이관 | 2 | 0 | 0 | 0 |

### 학습

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **아카데미** `academy` | 투자 기초부터 차근차근 | MENU+MTABS | `pages/AcademyPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **투자기초** `posters` | 그림으로 배우는 투자 | MENU+MTABS | `PosterLibrary.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **AI 복기** `review` | 지난 매매 AI 분석 | MENU+MTABS | `pages/JournalReviewPage.tsx` | 미이관 | 7 | 3 | 0 | 0 |
| **소셜** `social` | 다른 투자자와 소통 | MENU+MTABS | `pages/SocialPage.tsx` | 미이관 | 0 | 1 | 0 | 0 |

### 설정

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **API 연결** `accounts` | 거래소 API 연결 | MENU+MTABS | `ExchangeConnectPage.tsx` | 미이관 | 2 | 1 | 0 | 0 |
| **설정** `settings` | 통화·언어·알림 | MENU+MTABS | `pages/SettingsPage.tsx` | 미이관 | 0 | 1 | 0 | 0 |
| **알림** `alerts` | 가격·체결 알림 설정 | MENU+MTABS | `pages/AlertsPage.tsx` | 미이관 | 0 | 1 | 0 | 0 |
| **API 진단** `diagnostics` | 연결 상태 점검 | MENU+MTABS | `pages/DiagnosticsPage.tsx` | 미이관 | 0 | 1 | 0 | 0 |
| **운영** `ops` | 점검·배포·복구를 명령 하나로 | MENU+MTABS | `pages/OpsPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **보안** `safety` | 계정 보안·안전장치 | MENU+MTABS | `SafetyDashboard.tsx` | 미이관 | 1 | 3 | 0 | 1 |

### 하단탭 전용

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **홈** `home` | — | BTABS | `pages/HomePage.tsx` | 미이관 | 0 | 0 | 1 | 0 |
| **지갑** `wallet` | — | BTABS+MTABS | `pages/WalletPage.tsx` | 미이관 | 3 | 9 | 6 | 0 |

### 더보기 전용

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **왓치리스트** `watchlist` | — | MTABS | `pages/WatchlistPage.tsx` | 미이관 | 1 | 0 | 0 | 0 |
| **AI 관리센터** `ai_usage` | — | MTABS | `pages/AiUsagePage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **Pine 가이드** `pine_guide` | — | MTABS | `pages/PineGuidePage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **계절성 분석** `seasonality` | — | MTABS | `pages/SeasonalityPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **AI채팅** `ai` | — | MTABS | `pages/AIPage.tsx` | 미이관 | 1 | 0 | 0 | 0 |
| **통합운용** `hub_accounts` | — | MTABS | `pages/HubAccountsPage.tsx` | 미이관 | 2 | 0 | 0 | 0 |
| **자동적립** `dca` | — | MTABS | `pages/DCAPage.tsx` | 미이관 | 1 | 0 | 0 | 0 |
| **수동자산등록** `manual_accounts` | — | MTABS | `pages/ManualAccountsPage.tsx` | 미이관 | 2 | 1 | 0 | 1 |
| **입출금** `funding` | — | MTABS | `pages/FundingPage.tsx` | 미이관 | 3 | 1 | 0 | 0 |
| **수익계산** `pnl` | — | MTABS | `PnLCalculator.tsx` | 미이관 | 6 | 2 | 0 | 0 |
| **Hedge OS** `hedgeos` | — | MTABS | `pages/HedgeOSPage.tsx` | 미이관 | 5 | 4 | 0 | 0 |
| **인텔리전스** `intelligence` | — | MTABS | `IntelligencePage.tsx` | 미이관 | 11 | 2 | 0 | 2 |
| **차트** `chart` | — | MTABS | `pages/ChartTab.tsx` | 미이관 | 3 | 1 | 0 | 0 |
| **WUNDER봇** `wunder` | — | MTABS | `pages/WunderPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **TradFi** `tradfi` | — | MTABS | `pages/TradFiPage.tsx` | 미이관 | 5 | 2 | 0 | 0 |
| **실시간** `realtime` | — | MTABS | `pages/RealtimePage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **분석** `analytics` | — | MTABS | `pages/AnalyticsPage.tsx` | 미이관 | 2 | 0 | 0 | 0 |
| **손익·세금** `tax` | — | MTABS | `pages/TaxPage.tsx` | 미이관 | 1 | 7 | 0 | 0 |
| **히트맵** `heatmap` | — | MTABS | — | 화면 파일 못 찾음 | — | — | — | — |
| **세계시장** `clock` | — | MTABS | — | 화면 파일 못 찾음 | — | — | — | — |
| **검색** `search` | — | MTABS | `pages/SearchPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **관심그룹** `groups` | — | MTABS | `pages/WatchGroupsPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **구독** `subscription` | — | MTABS | `pages/SubscriptionPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |
| **허브** `hub` | — | MTABS | `HubDashboard.tsx` | 미이관 | 4 | 6 | 0 | 2 |

### 목록에 없음

| 화면 | 목적 | 경로 | 파일 | 상태 | fx | loc | 확불 | fmt |
|---|---|---|---|---|--:|--:|--:|--:|
| **menu_hub** `menu_hub` | — | **없음** | `pages/MenuHubPage.tsx` | 미이관 | 0 | 0 | 0 | 0 |

`fx`=toFixed · `loc`=toLocaleString · `확불`='확인 불가' 직접 표기 · `fmt`=사설 포매터

## 2. 라우트

- `/`
- `/admin`
- `/auth`
- `/auth/callback`
- `/chart`
- `/developer`
- `/privacy`
- `/terminal`
- `/terms`
- `/unauthorized`

메인 앱(`/`)이 위 30개 화면을 탭으로 그린다. `/terminal`·`/chart`는
별도 라우트이고, `/admin`·`/developer`는 일반 사용자 UI가 아니다.

## 3. 공통 primitive

| 모듈 | 파일 | 있음 | 내보내는 것 |
|---|---|---|---|
| display | `src/lib/ui/display.ts` | ○ | Tone · UNKNOWN_TEXT · UNKNOWN_LABEL · ValueKind · Shown · unknownShown · numOrNull · digitsFor … (22) |
| status | `src/lib/ui/status.ts` | **없음** | — |
| statusView | `src/components/ui/Status.tsx` | **없음** | — |
| strategyCard | `src/lib/ui/strategyCard.ts` | ○ | StrategyKind · kindOf · KIND_LABEL · FieldFormat · FieldSpec · KIND_FIELDS · showsTpSl · CardRow … (33) |
| autoOverview | `src/lib/ui/autoOverview.ts` | ○ | AutoTabId · AUTO_TABS · tabOf · RunEnv · envOf · ENV_LABEL · ENV_TONE · autoTitle … (32) |
| overlayStack | `src/lib/nav/overlayStack.ts` | ○ | OverlayStack · nextStack · topmost · historyDelta |
| mobileSheet | `src/lib/ui/mobileSheet.ts` | ○ | HistoryAction · SheetHistoryState · historyAction · KEYBOARD_MIN_PX · ViewportSample · keyboardInset · isKeyboardOpen · SheetMetrics … (9) |
| displayScale | `src/lib/ui/displayScale.ts` | ○ | SCALE_KEY · SCALE_STEPS · MIN_SCALE · MAX_SCALE · normalizeScale · nextScale · prevScale · readScale … (10) |

## 4. Modal / Sheet / Confirm / Toast

- `src/components/AssetDetailModal.tsx`
- `src/components/ConfirmHost.tsx`
- `src/components/LoginModal.tsx`
- `src/components/NewsDetailModal.tsx`
- `src/components/TradeReplayModal.tsx`

겹침 순서는 `src/lib/nav/overlayStack.ts`, 모바일 시트의 키보드·높이는
`src/lib/ui/mobileSheet.ts`가 판정한다.

## 5. Breakpoint (실제 쓰이는 것)

| 조건 | 쓰인 곳 |
|---|--:|
| `max-width: 767px` | 2 |
| `min-width: 768px` | 2 |
| `max-width: 640px` | 1 |
| `min-width: 420px` | 1 |
| `min-width: 1024px` | 1 |
| `min-width: 1440px` | 1 |
| `max-width: 360px` | 1 |

## 6. 확정된 표시 규칙

아래는 **문장이 아니라 코드에서 읽어 온 것**이다. 여기 적힌 값이
바뀌면 이 문서도 같이 바뀐다.

### 환경 (LIVE / TESTNET / PAPER)

> ⚠ `src/lib/ui/status.ts`가 **아직 main에 없다.** 이 정의는
> PR #213(지갑 + 상태 표현)에 있고, 머지되면 이 표가 자동으로 채워진다.
> **여기에 손으로 옮겨 적지 않는다** — 적는 순간 두 벌이 된다.

> PAPER는 코드 쪽 이름이고 저장값은 `MOCK`이다. 두 이름이 함께
> 쓰여 왔으므로 **표시할 때만** 한 단어(모의)로 모은다.

### 상태 (SUCCESS / WARNING / ERROR / UNKNOWN / DISABLED)

> ⚠ 위와 같다 — 정의가 아직 main에 없다(PR #213).

> **막힌 것만 빨갛다.** 못 읽은 것(UNKNOWN)은 회색이다 — 전부
> 빨가면 어느 것도 빨갛지 않은 것과 같다.
> 색만으로 구분하지 않는다. 기호가 먼저다.

### 계좌 상태 — 셋을 절대 섞지 않는다

| 코드 | 뜻 | 사용자가 할 일 |
|---|---|---|
| `NO_ACCOUNT` | 계좌가 아직 없다 | 시작하면 만들어진다 |
| `UNREADABLE` | 값을 못 읽었다 | **0도 아니고 없음도 아니다** |
| `READY` (잔고 0) | 읽었고 0이다 | 정상. 충전하면 된다 |

### 숫자 · 금액 · 수량 · 퍼센트

자릿수는 **값의 크기가 정한다.** 고정하지 않는다 — 8자리 고정이
잔고 0을 `0.00000000`으로 만들었고, 2자리 고정은 작은 코인 수량을
전부 `0.00`으로 만든다.

```ts
export function digitsFor(n: number, kind: ValueKind): number {
  const a = Math.abs(n);
  if (kind === 'count' || kind === 'score') return 0;
  if (kind === 'pct') return a >= 100 ? 1 : 2;
  if (kind === 'qty') {
    if (a === 0) return 0;          // 0개는 그냥 0이다
    if (a >= 1) return 4;
    if (a >= 0.001) return 6;
    return 8;                        // 진짜 작은 수량만 8자리를 쓴다
  }
  if (a === 0) return 0;             // **0은 0이다.** 0.00000000이 아니다
  if (a >= 0.1) return 2;            // 0.5 USDT는 '0.50'이지 '0.5000'이 아니다
  if (a >= 0.001) return 4;
  return 8;                          // 소수점 아래로 내려가는 코인 가격만
}
```

- 모르는 값은 표에서 `—`, 문장에서 `확인 불가` — **0으로 채우지 않는다**
- 음수는 하이픈이 아니라 `−` (하이픈은 빈칸 표시 `—`와 헷갈린다)
- 손익 0은 이겼다고도 졌다고도 하지 않는다 (부호·색 없음)
- 날짜·시간 표기는 **아직 표시 계층에 없다** — 각 화면이 정하고 있다

### 일반 사용자 UI와 진단/관리자

| 구분 | 위치 |
|---|---|
| 일반 사용자 | `/` (위 화면 목록) |
| 진단 | 화면 `diagnostics` · `ops` · 각 카드의 접히는 "진단 정보" |
| 관리자 | `/admin` · `/developer` — 화면 목록에 넣지 않는다 |

> 개발자용 원문(DB·API 오류)은 본문에서 떼어 `Details`로 접는다.
> `splitDiagnostics`가 가른다. **원문을 버리지는 않는다** — 버리면
> 진짜 고장 났을 때 아무도 원인을 못 찾는다.

## 7. 이관 잠금 상태

**파일 전체 잠금** (`MIGRATED`)
- `src/components/MockAutoTrade.tsx`

**구간 잠금** (`PARTIAL_MIGRATED`)
- `src/components/pages/AutoPage.tsx` — `AUTOPAGE-PAPER-CARD`

**상태 표현 계약** (`STATUS_SCREENS`)

