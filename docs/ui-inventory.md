# UI Inventory

> **자동 생성 파일. 손으로 고치지 마세요.**
> 진실은 `src/lib/ui/inventory.ts`에 있습니다.
> 다시 만들기: `npm run gen:ui-inventory`
>
> 문서를 손으로 고쳐 진실을 관리하면 곧 코드와 갈리고,
> **갈린 것을 아무도 못 봅니다.** CI(`check-ui-inventory.mjs`)가 막습니다.

## 요약

| | 수 |
|---|--:|
| 화면 | 17 |
| 들여다본 화면 (SURVEYED) | 6 |
| 존재만 확인 (LISTED_ONLY) | 11 |
| 이관 완료 / 일부 / PR 대기 / 미이관 | 1 / 1 / 1 / 14 |
| primitive (있음 / 중복 / 없음 / 옛방식 / 제안) | 10 / 3 / 6 / 2 / 1 |
| 네비게이션 정의 위치 | 3 |
| 겹쳐 뜨는 층 | 7 |
| 피드백 | 3 |
| 상태 종류 | 7 |

`LISTED_ONLY`는 **존재를 확인했지만 상태·액션까지는 아직 안 본 화면**입니다.
확인하지 못한 것을 통과로 적지 않습니다.

## 1. 화면

| 화면 | 위치 | 목적 | 환경 | 이관 | 깊이 | 대상 |
|---|---|---|---|---|---|---|
| **홈** `home` | `tab:home` | 오늘 무슨 일이 있었는지 한 화면에서 본다 | LIVE · TESTNET · PAPER | LEGACY | 본 것 | USER |
| **시장 보기** `market` | `tab:market` | 실시간 코인·주식 시세 | NA | LEGACY | 본 것 | USER |
| **매매하기** `trading` | `tab:trading` | 차트·호가·주문 통합 화면 | LIVE · TESTNET · PAPER | LEGACY | 본 것 | USER |
| **터미널** `terminal` | `/terminal` | 주문·호가·차트를 붙인 전문 화면 | LIVE · TESTNET | LEGACY | 목록만 | USER |
| **자동매매** `auto` | `tab:auto` | AI가 대신 자동 거래 | LIVE · TESTNET · PAPER | PARTIAL | 본 것 | USER |
| **모의매매** `paper` | `tab:paper` | 가짜 돈으로 연습 | PAPER | MIGRATED | 본 것 | USER |
| **전략빌더** `strategies` | `tab:strategies` | 나만의 매매 규칙 만들기 | NA | LEGACY | 목록만 | USER |
| **포트폴리오** `portfolio` | `tab:portfolio` | 내 자산 현황 | LIVE · TESTNET | LEGACY | 목록만 | USER |
| **지갑** `wallet` | `tab:wallet` | 환경별 총자산·오늘 손익·모의계좌 | LIVE · TESTNET · PAPER | PENDING_PR | 본 것 | USER |
| **실행기록** `history` | `tab:history` | 자동매매 체결 내역 | LIVE · TESTNET · PAPER | LEGACY | 목록만 | USER |
| **백테스트** `backtest` | `tab:backtest` | 과거 데이터로 전략 검증 | NA | LEGACY | 목록만 | USER |
| **알림** `alerts` | `tab:alerts` | 가격·체결 알림 설정 | NA | LEGACY | 목록만 | USER |
| **API 진단** `diagnostics` | `tab:diagnostics` | 연결 상태 점검 | LIVE · TESTNET | LEGACY | 목록만 | DIAGNOSTICS |
| **운영** `ops` | `tab:ops` | 점검·배포·복구를 명령 하나로 | LIVE · TESTNET | LEGACY | 목록만 | DIAGNOSTICS |
| **API 연결** `accounts` | `tab:accounts` | 거래소 API 연결 | LIVE · TESTNET | LEGACY | 목록만 | USER |
| **설정** `settings` | `tab:settings` | 통화·언어·알림 | NA | LEGACY | 목록만 | USER |
| **관리자** `admin` | `/admin` | 운영자 전용 관리 | NA | LEGACY | 목록만 | ADMIN |

### 화면별 주요 액션 · 상태 · primitive

| 화면 | 주요 액션 | 그리는 상태 | 쓰는 primitive | 진단 노출 |
|---|---|---|---|---|
| `home` | 자산 열기 · 화면 이동 | LOADING · SUCCESS · UNKNOWN | Card · Badge | — |
| `market` | 종목 열기 · 통화 전환 | LOADING · SUCCESS · UNKNOWN | Card · Badge | — |
| `trading` | 주문 · 수동 연습 매매 | LOADING · SUCCESS · WARNING · ERROR | Card · Button · Badge | — |
| `terminal` | 주문 · 호가 보기 | LOADING · SUCCESS · ERROR | Card · Button | — |
| `auto` | 전략 켜기/끄기 · 예약 등록 · 지금 중지 | LOADING · EMPTY · SUCCESS · WARNING · ERROR · UNKNOWN | Card · Badge · MoneyValue · PnlValue | 진단 탭 |
| `paper` | 모의투자 시작 · 초기화 | LOADING · EMPTY · SUCCESS · UNKNOWN · DISABLED | Card · ValueRow · MoneyValue | — |
| `strategies` | 전략 생성 · 전략 저장 | LOADING · EMPTY · SUCCESS · ERROR | Card · Button · Input | — |
| `portfolio` | 자산 열기 | LOADING · EMPTY · SUCCESS · UNKNOWN | Card · MoneyValue | — |
| `wallet` | 환경 전환 · 통화 전환 · 모의투자 시작·충전 | LOADING · EMPTY · SUCCESS · WARNING · ERROR · UNKNOWN · DISABLED | StatusCard · EnvBadge · Details · SafeNote · MoneyValue · PnlValue | 각 상태 카드의 접히는 "진단 정보" |
| `history` | 기록 보기 | LOADING · EMPTY · SUCCESS · UNKNOWN | Card · ValueRow | — |
| `backtest` | 백테스트 실행 | LOADING · EMPTY · SUCCESS · ERROR | Card · Button | — |
| `alerts` | 알림 추가 · 알림 끄기 | LOADING · EMPTY · SUCCESS · ERROR | Card · Toast | — |
| `diagnostics` | 점검 실행 | LOADING · SUCCESS · WARNING · ERROR · UNKNOWN | Card · Badge | 화면 전체가 진단이다 |
| `ops` | 전체 점검 · 배포 · 복구 | LOADING · SUCCESS · WARNING · ERROR · UNKNOWN | Card · Button | 단계별 결과 로그 |
| `accounts` | 거래소 연결 · 연결 해제 | LOADING · EMPTY · SUCCESS · ERROR | Card · Button · Input · Toast | — |
| `settings` | 설정 변경 | LOADING · SUCCESS | Card · SettingField | — |
| `admin` | 사용자 관리 | LOADING · SUCCESS · ERROR | Card | 화면 전체가 관리자용이다 |

### 화면 메모

- **`home`** — '확인 불가'를 직접 적는 자리가 남아 있다
- **`market`** — 시세는 환경과 무관하다 — 환경 배지를 붙이지 않는다
- **`trading`** — **로컬 원화 연습 장부가 남아 있다** — canonical PAPER가 아니다. DECISION 참조. 이번 단계에서 바꾸지 않는다
- **`terminal`** — Inventory 완료 전에는 이관을 시작하지 않는다
- **`auto`** — 모의 잔고 카드만 표시 계층으로 옮겼다(구간 잠금 AUTOPAGE-PAPER-CARD). 나머지는 만원 단위 원화 표기 등 legacy
- **`paper`** — MockAutoTrade가 이 화면의 본체. 표시 계층 전체 이관 완료(파일 잠금)
- **`strategies`** — `my-original-v1` 원본 전략은 덮어쓰거나 삭제하지 않는다
- **`wallet`** — PR #213에서 이관. **MENU에 없고 BTABS·MTABS에만 있다** — 스캐너가 MENU만 읽었을 때 통째로 빠졌던 화면이다
- **`backtest`** — 청산 규칙은 실전과 같은 `exitRules`를 쓴다
- **`ops`** — 사용자가 명령 하나로 부르는 자리 — 최상위 규칙의 "사용자는 명령만 한다"
- **`accounts`** — **키·시크릿 값은 화면에도 로그에도 남기지 않는다.** 지문만 비교한다
- **`admin`** — 일반 사용자 화면 목록에 넣지 않는다

## 2. 네비게이션 — 목록이 여러 곳에 있다

| 이름 | 정의 위치 | 심볼 | 개수 | 메모 |
|---|---|---|--:|---|
| 검색·카테고리 메뉴 | `src/lib/menuItems.tsx` | `MENU` | 30 | 유일하게 목적(desc)과 분류(cat)를 갖고 있다. `check-nav.mjs`가 보는 곳 |
| 하단 탭 | `src/app/page.tsx` | `BTABS` | 5 | 홈·시장·매매·자동·지갑. 마지막 칸의 더보기는 화면이 아니라 겹치는 층이라 여기 없다 |
| '더보기' 시트 | `src/app/page.tsx` | `MTABS` | 53 | 가장 많은 화면이 여기에만 있다. `check-nav.mjs`의 범위 밖이었다 |

> 하나만 읽으면 화면을 놓칩니다. 실제로 `MENU`만 읽었을 때
> **지갑 화면이 통째로 빠졌습니다.**

## 3. 공통 primitive

### 있는 것 (10)

| id | 위치 | 쓰임 | 메모 |
|---|---|---|---|
| `StatusCard` | `src/components/ui/Status.tsx` | 짧은 첫 줄 + 접히는 상세·진단 | PR #213. 아직 main에 없다 |
| `EnvBadge` | `src/components/ui/Status.tsx` | LIVE·TESTNET·PAPER를 색과 글자 둘 다로 구분 | PR #213. **색만으로 구분하지 않는다** |
| `Details` | `src/components/ui/Status.tsx` | 접히는 상세. 최소 높이 32px(손가락) | PR #213 |
| `SafeNote` | `src/components/ui/Status.tsx` | 서버 문장을 본문/진단으로 갈라 그린다 | PR #213. 원문을 버리지 않고 자리만 옮긴다 |
| `StatusDot` | `src/components/ui/Status.tsx` | 표 안의 가장 작은 상태 표시 | PR #213 |
| `MoneyValue` | `src/lib/ui/display.ts` | 금액 문자열 — 자릿수는 값의 크기가 정한다 | `moneyText`. 컴포넌트가 아니라 함수다 |
| `PnlValue` | `src/lib/ui/display.ts` | 손익 — 부호와 색이 값에서 나온다 | `pnlText`. 음수는 하이픈이 아니라 − |
| `DataBadge` | `src/components/ui/DataBadge.tsx` | 값이 어디서 왔고 얼마나 오래됐는지 | 기호로 구분한다 — 색만 쓰지 않는다 |
| `SettingField` | `src/components/ui/SettingField.tsx` | 설정 한 줄 | — |
| `Icon` | `src/components/ui/Icon.tsx` | 아이콘 | — |

### 여러 벌인 것 (3)

| id | 위치 | 쓰임 | 메모 |
|---|---|---|---|
| `Card` | `src/components/pages/SharedUI.tsx` | 기본 카드 | SharedUI의 `Card`가 있지만 화면마다 인라인 스타일 카드를 따로 만든다. **하나로 모을 대상** |
| `Badge` | `src/components/pages/SharedUI.tsx` | 작은 라벨 | SharedUI의 `Bdg`·`Pill`·`Dot`이 겹친다 |
| `Toast` | `src/components/notify/NotifyHost.tsx` | 잠깐 뜨는 알림 | NotifyHost가 있는데 여러 화면이 각자 toast 문자열·표시를 만든다. FEEDBACK 항목과 같은 것을 가리킨다 |

### 없는 것 (6)

| id | 위치 | 쓰임 | 메모 |
|---|---|---|---|
| `Button` | — | 버튼 | 공통 버튼이 없다. 화면마다 인라인 스타일 `<button>`을 만든다. 누를 수 있는 최소 크기가 화면마다 다르다 |
| `Input` | — | 입력 | `src/components/inputs/QuickInput.tsx`가 있지만 일부 화면 전용이다 |
| `Tabs` | — | 탭 전환 | 자동매매·지갑·터미널이 각자 탭을 그린다 |
| `ValueRow` | — | 라벨 + 값 한 줄 (모르는 값은 —) | MockAutoTrade·WalletPage가 각자 `Row`를 만들었다 |
| `EmptyState` | — | 비어 있음 — **왜 비었는지까지 적는다** | WalletPage의 `emptyBox`가 그 역할을 한다. 화면 전용이다 |
| `LoadingState` | — | 조회 중 | '⏳ 로딩 중...' 같은 문자열이 화면마다 흩어져 있다 |

### 제안 (아직 만들지 않음) (1)

| id | 위치 | 쓰임 | 메모 |
|---|---|---|---|
| `ErrorState` | — | 막힘 | `StatusCard kind="ERROR"`로 덮을 수 있는지 먼저 본다 — **컴포넌트를 늘리기 전에 있는 것으로 되는지 확인한다** |

### 옛 방식 (걷어낼 대상) (2)

| id | 위치 | 쓰임 | 메모 |
|---|---|---|---|
| `InlineWarningBox` | — | 화면마다 직접 만든 경고 박스 | 지갑 한 화면에만 빨강·노랑 색 지정이 23곳 있었다. **StatusCard로 모을 대상** |
| `PrivateFormatter` | — | 화면마다 만든 `const fmt = …` | `toFixed` 144곳 · `toLocaleString` 74곳. **display.ts로 모을 대상** |

> **없는 컴포넌트를 지금 전부 만들지 않습니다.** 몇 종류가 실제로
> 필요한지 세지 않고 만들면 쓰이지 않는 variant가 생기고,
> 화면은 여전히 인라인으로 만듭니다.

## 4. 겹쳐 뜨는 층 (Modal / Sheet / Confirm)

| id | 위치 | 상태 | 쓰임 | 메모 |
|---|---|---|---|---|
| `AssetDetailModal` | `src/components/AssetDetailModal.tsx` | EXISTS | 자산 상세 | — |
| `NewsDetailModal` | `src/components/NewsDetailModal.tsx` | EXISTS | 뉴스 상세 | — |
| `TradeReplayModal` | `src/components/TradeReplayModal.tsx` | EXISTS | 매매 복기 | — |
| `LoginModal` | `src/components/LoginModal.tsx` | EXISTS | 로그인 | — |
| `ConfirmHost` | `src/components/ConfirmHost.tsx` | EXISTS | 확인 대화상자 | **실전 주문 전 재확인이 여기를 지난다.** 환경별 문구가 다른지 확인 필요 |
| `BottomSheet` | `src/lib/ui/mobileSheet.ts` | DUPLICATED | 모바일 시트 | 높이·키보드 판정은 `mobileSheet.ts`에 있는데, 시트 자체는 화면마다 그린다 |
| `OverlayStack` | `src/lib/nav/overlayStack.ts` | EXISTS | 겹침 순서와 뒤로가기 | 판정만 있다. 그리는 컴포넌트는 없다 |

## 5. 피드백 (Toast / Notice / Details)

| id | 위치 | 상태 | 쓰임 | 메모 |
|---|---|---|---|---|
| `Toast` | `src/components/notify/NotifyHost.tsx` | EXISTS | 잠깐 뜨는 알림 | 여러 화면이 각자 toast 문자열을 만든다 |
| `Notice` | `src/lib/ui/display.ts` | EXISTS | 알림 한 건 — 짧은 첫 줄 + 접는 상세 | `noticeOf`·`splitNotice`·`topNotice` |
| `Diagnostics` | `src/components/ui/Status.tsx` | EXISTS | 개발자용 원문 | PR #213. `splitDiagnostics`가 본문에서 떼어 낸다 |

## 6. 지켜야 할 의미 구분

**구분이 사라지는 것은 코드가 깨지는 것보다 조용합니다.**

| 규칙 | 왜 |
|---|---|
| **UNKNOWN ≠ ERROR** | 못 읽은 것과 막힌 것은 사용자에게 전혀 다른 행동을 요구한다. 모름을 빨갛게 그리면 진짜 막힌 빨강과 구별되지 않는다 |
| **DISABLED ≠ ERROR** | 아직 안 켠 것은 고장이 아니다. 모의계좌를 안 만든 사용자에게 빨간 실패 박스를 띄우면, 자기가 뭘 잘못한 줄 알고 멈춘다. 해야 할 일(시작하기)을 알려 주는 자리다 |
| **NO_ACCOUNT ≠ UNREADABLE** | 계좌가 없는 것과 계좌를 못 읽은 것은 다르다. 스크린샷에서 `0.00000000 USDT`와 "계좌가 없습니다"가 동시에 떠 있었다 |
| **READY(balance=0) ≠ NO_ACCOUNT** | 잔고 0은 정상이다. 실패로 그리지 않는다 |
| **LIVE ≠ TESTNET ≠ PAPER** | 색만 다르면 실전 화면과 테스트넷 화면을 헷갈린 채로 주문을 누른다. 색과 글자 둘 다 달라야 한다. **장부와 자산은 절대 합산하지 않는다** |
| **사용자 상태 ≠ 개발자 진단** | `column paper_accounts.started_at does not exist`가 메인 화면 빨간 박스에 그대로 떴었다. 사용자는 읽을 이유가 없고, 읽어도 할 수 있는 일이 없다. **원문을 버리지는 않는다** — 접어서 진단으로 옮긴다 |

## 7. 지금 / 목표 / 결정

**Inventory는 설계안만 적는 문서가 아닙니다.** "지금 무엇이 있는가"와
"무엇으로 통일할까"는 다른 사실이고, 후자는 아직 안 정한 것도 있습니다.

### 아직 안 정함 (4)

#### `nav-source`

- **지금** — 화면 목록이 세 곳(MENU 30 · BTABS 5 · MTABS 53)에 따로 있다
- **목표** — 미정 — 한 곳으로 모을지, 셋을 두고 대조 검사만 둘지
- **왜** — 하단 탭·더보기·검색 메뉴는 **용도가 다르다.** 기계적으로 합치면 하단 탭에 53개가 들어가거나 더보기가 5개로 준다. 지금은 대조 검사(`check-ui-inventory.mjs`)로 누락만 막는다

#### `trading-local-ledger`

- **지금** — TradingPage의 수동 연습 매매가 **로컬 원화 장부**를 쓴다. canonical PAPER(서버 `paper_*`)가 아니다
- **목표** — 미정 — ① 별도 연습 모드로 남기고 시각적으로 완전히 분리 ② 서버 PAPER로 흡수
- **왜** — 통화(원화 vs USDT)·체결 방식·TP/SL 규칙이 서버 PAPER와 다르다. 흡수하면 성과 데이터가 오염되고, 남기면 두 모의계좌라는 오해가 남는다. **이번 단계에서 바꾸지 않는다** — Inventory에 기록만 한다

#### `button`

- **지금** — 공통 버튼이 없다. 화면마다 인라인 스타일 `<button>`
- **목표** — 미정 — 공통 Button 하나로 갈지, primary/danger 등 몇 종류를 둘지. 실전 주문 버튼을 별도로 둘지도 아직 안 정했다
- **왜** — 먼저 실제로 몇 종류가 필요한지 세야 한다. 세지 않고 만들면 **쓰이지 않는 variant가 생기고, 화면은 여전히 인라인으로 만든다**

#### `date-time`

- **지금** — `toLocaleString('ko-KR', …)`을 화면마다 다르게 부른다
- **목표** — 미정 — display.ts에 date/time kind를 더할지
- **왜** — 숫자와 달리 "언제인가"는 화면마다 필요한 정밀도가 진짜로 다르다. 먼저 몇 가지 형태가 실제로 쓰이는지 센다

### 정했고 진행 중 (3)

#### `warning-box`

- **지금** — 화면마다 직접 만든 경고 박스. 지갑 한 화면에만 빨강·노랑 색 지정 23곳
- **목표** — StatusCard (짧은 첫 줄 + 접히는 상세)
- **왜** — 전부 빨가면 어느 것도 빨갛지 않은 것과 같다. 막힌 것만 빨갛게 한다

#### `number-format`

- **지금** — `toFixed` 144곳 · `toLocaleString` 74곳 · 사설 포매터 8개
- **목표** — display.ts (자릿수는 값의 크기가 정한다)
- **왜** — 8자리 고정이 잔고 0을 `0.00000000`으로 만들었다. 2자리 고정은 반대로 작은 코인 수량을 전부 `0.00`으로 만든다

#### `unknown-text`

- **지금** — '확인 불가' 직접 표기 7곳 + '확인하지 못했습니다'·'확인 못 함' 등 표현이 갈림
- **목표** — UNKNOWN_LABEL / UNKNOWN_TEXT 한 곳
- **왜** — 문구가 바뀌면 한 곳만 고친다

### 끝남 (2)

#### `paper-single-ledger`

- **지금** — 서버 PAPER 하나가 모의 장부다. 브라우저는 체결하지도 청산하지도 않는다
- **목표** — 같음
- **왜** — 5A(#210)에서 끝났다. `check-mock-single-source.mjs`가 잠근다

#### `env-wording`

- **지금** — 실전·테스트넷·모의 문구가 ENV_VIEW 한 곳에서 나온다
- **목표** — 같음
- **왜** — 예전에는 `portfolio/wallet.ts`와 `ui/autoOverview.ts`에 두 벌이었고 한쪽에만 'live' 색조가 있었다

## 8. 다음 이관 순서

| 순서 | 대상 | 왜 이 순서인가 |
|--:|---|---|
| 1 | Wallet (#213) | 이미 만들어져 있다. Inventory 검토 후 조정 |
| 2 | Portfolio / Home | 같은 값(총자산·손익)을 보는 화면끼리 묶는다 |
| 3 | Auto / Strategy | 자동매매 나머지 — 만원 단위 원화 표기가 남아 있다 |
| 4 | Market | 환경과 무관한 화면이라 상태 종류가 적다 |
| 5 | History / Backtest / Alerts | |
| 6 | Settings / Diagnostics / Admin | 사용자 화면과 분리된 것을 마지막에 |
| — | **Trading / Terminal** | **로컬 원화 연습 장부 결정이 먼저다** (7. `trading-local-ledger`) |

