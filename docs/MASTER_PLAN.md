# TRAIGO 전체 개발 마스터 플랜

> 이 문서는 **작업 순서의 단일 출처**다. 세션이 끊기거나 사람이 바뀌어도
> "다음에 뭘 하기로 했는지"를 여기서 읽는다.
>
> 계획은 전부 적혀 있지만 **한 번에 한 단계만 구현한다.** 각 단계가 끝나면
> 멈추고 보고하고, 승인을 받은 뒤에 다음으로 간다.

TRAIGO는 단순 BTC 자동매매 페이지가 아니라
**암호화폐 + 주식 + ETF + 원자재 + 선물 + 모의투자를 하나의 엔진에서
운용하는 멀티에셋 자동매매 플랫폼**으로 발전시킨다.

---

## 작업 방식 — 반드시 지킬 것

1. 한 번에 한 단계만 진행한다
2. 단계가 끝나면 구현을 멈추고 보고한다
3. 사용자가 외부 리뷰를 받은 뒤 다음 단계를 지시한다
4. 임의로 merge하지 않는다
5. 오래된 PR을 한꺼번에 merge/rebase하지 않는다
6. 최신 main 기준으로 필요한 변경만 재구성한다
7. **기존 안전장치를 UI 리팩터링 때문에 다시 작성하지 않는다**
8. **UNKNOWN / null / 조회 실패를 0 · 정상 · 없음으로 바꾸지 않는다**
9. **LIVE / TESTNET / PAPER 자금과 성과를 절대 합산하지 않는다**
10. **브라우저를 자동주문의 실행 주체로 만들지 않는다**
11. 새 기능은 가능하면 **순수 판정 함수 + 회귀 테스트를 먼저** 둔다
12. 기존 Supabase + Next.js + Fly Worker 구조를 유지한다
13. Vercel Postgres · Make.com 같은 새 핵심 인프라를 도입하지 않는다
14. TradingView webhook이 필요하면 **TRAIGO API가 직접** 받는다
15. 실제 secret 값을 로그 · PR · 응답에 출력하지 않는다
16. `EXCHANGE_ENCRYPTION_KEY`를 새로 생성하거나 교체하지 않는다
17. LIVE 자동매매를 임의로 활성화하지 않는다
18. 당분간 실제 운용 검증은 **TESTNET / PAPER만** 사용한다

### 매 단계 종료 보고 형식

```
단계:
base SHA:
head SHA:

변경:
-

기존 동작 보존:
-

테스트:
-

CI:
-

migration:
-

남은 위험:
-

merge 여부:
```

---

## PHASE 0 — 현재 안전 PR 정리 ✅

#182 Kill Switch. 새 기능을 추가하지 않고 완료한다.

merge 후 확인할 것:

- main CI success
- migration 067 적용
- pending migrations = 0
- Vercel / Fly deployment SHA
- Worker heartbeat fresh
- Worker alive
- runtime / deployment 상태 정상

이상이 있으면 다음 단계로 가지 않고 보고한다.

---

## PHASE 1 — 기존 자동매매 P0/P1 안전성 정리

오래된 PR을 기계적으로 merge하지 않는다. **최신 main 기준으로 각각
재검토 · 재구성**한다.

순서: **#178 → #180 → #181 → #183 → #184 → #186 → #179**

| PR | 목적 |
|---|---|
| #178 | 자동매매 ON 순간 실평가가 **두 번 열리지 않도록** 실행 경로 단일화 |
| #180 | 진입 장부에 stop loss · take profit · connection ownership이 정확히 남을 것. 청산 감시가 손절값 누락으로 포지션을 놓치면 안 된다 |
| #181 | 주문 상태 **UNKNOWN을 REJECTED처럼 처리하지 않는다.** 주문이 나갔는지 모르면 같은 날 재주문 금지 · reconciliation 필요 상태 유지 |
| #183 | Gate 포지션의 trailing / high-water를 **Binance 데이터로 계산하지 않는다** (venue-aware 시세). 진행 중인 봉이 high-water에 포함되는지 기존 계약은 보존 |
| #184 | 이동한 SL의 새 거래소 orderId와 ownership을 장부에 기록. **새 SL ownership을 기록하기 전에 기존 SL을 제거하지 않는다** |
| #186 | Binance / Gate 보호주문 모두 deterministic clientOrderId · ownership. 고아 주문 정리에서 **남의 주문을 Cancel All로 지우지 않는다** |
| #179 | daily-ladder뿐 아니라 **모든 실행 전략**의 포지션 · 고아 보호주문 감시 공통화 |

최종 목표 — 모든 전략이 같은 안전 체계를 쓴다:

```
진입 → 보호주문 → 포지션 감시 → trailing → break-even
     → 시간청산 → flat 확인 → owned protection cleanup
```

---

## PHASE 2 — 거래소 인증 / 암호화 상태 확정

LIVE 전환이 아니라 **TESTNET 자동매매 신뢰성 확보**가 목적이다.

credential 복호화 상태를 다음으로 구분한다:

```
NO_KEY · KEY_MISMATCH · MALFORMED · EMPTY · OK
```

- 원문 secret · encryption key는 **절대 노출하지 않는다** (지문만 비교)
- Worker의 encryption-key fingerprint와 기대 fingerprint를 비노출 비교
- **새 키를 생성하지 않는다**
- 키가 맞는데 ciphertext가 문제일 때만 연결 재등록을 안내한다
- TESTNET Binance / Gate에 대해 인증 · balance · positions · open orders ·
  leverage/margin metadata를 **read-only** connectivity test로 검증

---

## PHASE 3 — Multi-Asset Architecture **설계**

**설계 먼저.** 즉시 migration이나 대규모 구현을 하지 않는다.

목표 자산: Crypto Spot · Crypto Futures · 한국 주식 · 미국 주식 · ETF ·
원자재 · 원자재 선물 · Paper Trading

최소 Domain:

```
AssetClass · Market · Instrument · Venue · Portfolio · Sleeve
Strategy · StrategyVersion · StrategyBinding · RiskPolicy
Signal · OrderIntent · Execution · Order · Fill · Position · LedgerEvent
```

```
AssetClass                Market
├─ CRYPTO                 ├─ CRYPTO_SPOT
├─ STOCK                  ├─ CRYPTO_FUTURES
├─ ETF                    ├─ KR_STOCK
├─ COMMODITY              ├─ US_STOCK
└─ FUTURES                └─ COMMODITY_FUTURES
```

Instrument는 `BTCUSDT` `ETHUSDT` `AAPL` `NVDA` `QQQ` `SCHD` `GC` `CL` `NG`를
같은 개념으로 표현할 수 있어야 한다.

결과물: architecture diagram · TypeScript interface 초안 · DB entity 관계 ·
기존 테이블 재사용/확장/폐기 후보 · backward compatibility · 단계별 migration plan.

**여기까지 하고 구현하지 않고 보고한다.**

---

## PHASE 4 — Strategy와 Execution 완전 분리

전략 코드가 거래소 API를 직접 호출하지 않는다.

```
Market Data → Strategy → Signal → OrderIntent
            → Portfolio Risk Manager → Execution Adapter
                                       ├─ Binance
                                       ├─ Gate
                                       ├─ KIS
                                       └─ Paper
```

Strategy가 아는 것: 시장 데이터 · 포지션 상태 · 전략 설정.
Strategy가 만드는 것: `BUY · SELL · CLOSE · REDUCE · HOLD` + 이유 + 위험 정보.
거래소별 API 형식 · 서명 · endpoint는 **adapter가** 담당한다.

---

## PHASE 5 — Paper Trading을 정식 환경으로

MOCK은 UI 탭이 아니라 **정식 execution environment**가 된다.

```
paper_accounts · paper_orders · paper_fills
paper_positions · paper_ledger · paper_equity_snapshots
```

**기존 paper 관련 테이블이 이미 있으면 중복 생성하지 말고 먼저 조사한다.**

첫 사용 시 "모의투자 시작하기" — 초기자금 1,000만원 / 5,000만원 / 1억원 / 직접입력.

지갑 MOCK 탭 표시: 총자산 · 현금 · 포지션 평가액 · 실현손익 · 미실현손익 ·
오늘 손익 · 수수료 · 자산곡선.

Crypto와 Stock Paper Trading이 **같은 canonical paper ledger**를 쓴다.

---

## PHASE 6 — Paper 자동매매

같은 Strategy가 `PAPER · TESTNET · LIVE`에서 **전략 로직을 바꾸지 않는다.**
바뀌는 것은 execution adapter뿐이다.

Paper에서도 시장가/지정가 · 수수료 · 슬리피지 · partial fill 가능성 ·
SL · TP · trailing · position · realized PnL을 기록한다.

---

## PHASE 7 — Portfolio Risk Manager

멀티전략 · 멀티에셋 주문은 **반드시 중앙 Risk Manager를 통과**한다.

검사: 전략별 배정 자금 · 전략별 최대 위험 · 종목별 최대 노출 ·
자산군별 최대 노출 · gross exposure · net exposure · 선물 총 증거금 ·
사용 증거금 비율 · 최대 동시 위험 · 일 손실 · 주간 손실 · MDD ·
레버리지 · 청산거리 · 동일 종목 전략 충돌 · 높은 상관관계 포지션 · Kill Switch

```
Strategy A → BTC LONG
Strategy B → BTC SHORT      ← 각각 독립 주문으로 무조건 보내면 안 된다
Strategy C → BTC LONG
```

verdict: `ALLOW · REDUCE · BLOCK · CONFLICT · UNKNOWN`

**UNKNOWN은 ALLOW가 아니다.**

---

## PHASE 8 — Strategy Framework v2

전략 하나 추가할 때 API / UI / Worker를 매번 새로 짜지 않는다.

```
id · displayName · version · category · assetClasses · markets
supportedIntervals · parametersSchema
executionReady · paperReady · testnetReady · liveReady
riskTier · signal() · entry policy · exit policy
```

**내부 id와 사용자에게 보이는 이름을 분리한다.**
예: 내부 `my-original-v1` 유지 → 화면 "100배 실험 전략 · 초고위험 · PAPER/TESTNET 전용"

---

## PHASE 9 — 전략 카테고리 / 이름 재편

사용자 화면에서 개발자 이름을 없앤다.

| 시장 | 전략 |
|---|---|
| 코인 | 100배 실험 · 돌파 단타 · 추세 추종 · 추세 스윙 · 반등 매매 · 변동성 돌파 · 일봉 분할 진입 |
| 국내주식 | 장초반 돌파 · 거래량 급증 · 눌림목 단타 · 종가 매매 · 추세 스윙 · 우량주 장기 |
| 미국주식 | 모멘텀 단타 · 갭 돌파 · 추세 스윙 · 실적 모멘텀 · 우량주 장기 |
| ETF | 지수 적립 · VIX 분할매수 · 추세 전환 · 배당 장기 · 자산배분 |
| 원자재 | 금 추세 · 원유 추세 · 천연가스 변동성 |

**이름만 만들고 실행 경로가 없는 전략을 "실행 가능"으로 표시하지 않는다.**

---

## PHASE 10 — 새 코인 전략 개발

기존 전략 안정화 후 성격이 다른 것부터:

- **Trend Rider** — 1H/4H 추세추종
- **Volatility Breakout** — 변동성 수축 후 돌파
- **Mean Reversion** — 과매도/과매수 평균회귀

**처음부터 20개 만들지 않는다.** 3개를 제대로 검증한다.

---

## PHASE 11 — Backtest Engine 고도화

total return · CAGR · MDD · win rate · profit factor · Sharpe · Sortino ·
expectancy · avg R · max losing streak · trade count · turnover · fees ·
slippage · funding · long/short performance · monthly performance ·
instrument performance

- **수수료 / 슬리피지 없는 결과를 정상 성과처럼 표시하지 않는다**
- **표본 수를 반드시 같이 표시한다**

---

## PHASE 12 — Walk Forward / 과최적화 방지

전체 과거 데이터에서 최고 결과 하나만 고르는 방식 금지.

```
2023 Train → 2024 Validate
2024 Train → 2025 Validate
2025 Train → 2026 Validate
```

**본 적 없는 기간에서 검증한다.**

---

## PHASE 13 — Strategy Validation Ladder

```
DRAFT → BACKTESTED → WALK_FORWARD_VALIDATED → PAPER → SHADOW
      → TESTNET → TESTNET_VALIDATED → LIVE_SMALL → LIVE_LIMITED → LIVE_FULL
```

**자동 승격하지 않는다. LIVE 승격은 항상 명시적 승인.**

PAPER / TESTNET 결과도 trade count · unknown order count · protection success ·
slippage · MDD · expected value · system uptime 기준을 충족해야 다음으로 간다.

---

## PHASE 14 — 주식 Execution Adapter

**기존 KIS 기능을 먼저 조사한다.** KIS를 Crypto Adapter 안에 억지로 넣지 않고
같은 상위 execution contract를 구현하게 한다.

순서: PAPER → 한국주식 검증 가능한 환경. 미국주식은 지원 범위 조사 후 설계.

**주문 시간 · 시장 휴장 · 호가단위 · T+규칙을 Crypto 규칙으로 처리하지 않는다.**

---

## PHASE 15~19 · 22 — UI 전면 리빌드

> **UI 리디자인 범위는 Wallet이나 AutoTrade 일부에 한정하지 않는다.
> TRAIGO 전체 사용자 UI가 대상이다.**
>
> 목표는 페이지별로 따로 예쁘게 만드는 것이 아니라
> **전체 제품 디자인 시스템을 통일하는 것**이다.
> 개발자 콘솔 느낌 → 실제 서비스형 트레이딩 플랫폼 UI.

### 대상 화면 inventory (최소)

Home · Market · Trading · Auto Trading · Strategy Builder · Portfolio ·
Wallet · History/Journal · Backtest · Alerts · Diagnostics/Ops ·
Accounts/Exchange Connections · Settings · Admin 사용자-facing 영역 ·
Navigation / Header / Bottom Navigation ·
Modal / Bottom Sheet / Tooltip / Toast ·
Loading / Empty / Error / Unknown states

### 공통 규칙

- 모바일 우선
- **긴 설명 기본 노출 금지** — 핵심 정보 우선, 상세는 progressive disclosure
- Badge / Card / Tabs / Accordion / Bottom Sheet 공통화
- Primary / Secondary / Destructive action 명확히 구분
- **LIVE / TESTNET / PAPER 색상과 의미 통일**
- **SUCCESS / WARNING / ERROR / UNKNOWN / DISABLED 상태 체계 통일**
- **조회 실패를 0이나 없음으로 표시하지 않는다** — "확인 못 함"을 별도 상태로 유지
- 개발자 진단 정보는 일반 사용자 화면에서 분리
- 같은 기능이 페이지마다 다른 UI 규칙을 쓰지 않게 공통 컴포넌트화
- 기존 inline style 난립을 점진적으로 디자인 토큰 / 공통 컴포넌트로 이동

**먼저 전체 화면 inventory · 문제점 · 공통 컴포넌트 후보 · navigation 구조 ·
design token 계획을 설계하고 보고한다. 즉시 모든 화면을 한 PR에서 갈아엎지 않는다.**

### UI 작업 순서

| 차수 | 범위 |
|---|---|
| 1차 | 전체 디자인 시스템 + 네비게이션 |
| 2차 | 홈 / 지갑 / 포트폴리오 |
| 3차 | 자동매매 / 전략 / 예약 |
| 4차 | 매매 / 시장 |
| 5차 | 기록 / 백테스트 / 알림 |
| 6차 | 진단 / 설정 / 계정 / 관리자 |
| 7차 | 전체 모바일 polish + 접근성 + 일관성 점검 |

### PHASE 15 — 자동매매 Dashboard

탭: `개요 · 전략 · 포트폴리오 · 예약 · 기록 · 진단`

- **개요** — 매일 보는 것만: 현재 환경 · 자동매매 정상/중지/오류 · 총 운용자산 ·
  오늘 손익 · 실행 전략 수 · 열린 포지션 · 전체 위험도 · 사용 증거금 · 최근 판단.
  **Worker / migration / smoke test는 개요에서 제거**
- **전략** — `코인 | 국내주식 | 미국주식 | ETF | 원자재`. 카드에 전략명 · 위험도 ·
  검증 단계 · 시장 · 현재 상태 · 오늘 손익 · 포지션. 세부 설정은 카드 진입 후
- **포트폴리오** — 전략별 배정 자금 · 자산군별 노출 · gross/net exposure ·
  사용 증거금 · risk tier · 전략간 충돌
- **기록** — 기본은 최근 몇 건만. 전체 로그는 별도 화면 / accordion
- **진단** — 개발자 기능을 여기로: Worker · heartbeat · Fly/Vercel SHA ·
  migrations · exchange connection · reconciliation · orphan orders ·
  smoke tests · raw diagnostics

### PHASE 16 — 긴 설명 제거

```
기존: 긴 청산 원리 설명
변경: ⚠️ 청산 위험  [자세히]
```

상세는 Bottom Sheet / Modal / Popover. 기본 화면에는 **핵심 사실 + 행동**만.

### PHASE 17 — 상태 디자인 통일

```
🟢 정상   🟡 주의   🔴 오류   ⚪ 비활성
```

**조회 실패를 오류/없음으로 바꾸지 않는다. "확인 못 함"을 별도로 유지한다.**

### PHASE 18 — 지갑 UI

탭 `실전 · 테스트넷 · 모의투자`, 설명은 짧게
(실전 = 실제 자금 / 테스트넷 = 거래소 가상자금 / 모의투자 = TRAIGO 가상자금).

오류 이유를 수십 줄로 메인 카드에 출력하지 않는다:

```
총자산
확인할 수 없음 ⚠
Gate.io 선물 자산 조회 실패
[다시 시도] [자세히]
```

### PHASE 19 — 예약 UX

예약 탭에서 생성 · 수정 · 활성/비활성 · 취소를 모두 처리.

사용자에게는 "예약 삭제"로 보이되 **DB hard-delete를 기본으로 하지 않는다**
(`enabled=false` · `cancelled_at` · 필요 시 `cancelled_by`). 활성 목록에서는 즉시 제거,
취소된 예약은 별도 기록. 이미 실행된 예약은 삭제가 아니라 history.

**실행과 취소의 race condition을 테스트한다.** 취소가 먼저 commit된 예약은
Worker / cron이 이후 주문을 내면 안 된다. 원자적인 claim/cancel 계약을 설계한다.

### PHASE 22 — Global Risk / Core-Satellite View

- **CORE** — 장기/현물(주식 · ETF · 장기 Crypto): 자산비중 · 평균단가 · 배당 · 장기수익
- **SATELLITE** — 단기/선물(Crypto futures · Commodity futures · 단기 주식):
  leverage · margin · liquidation distance · short-term PnL · risk

**Core/Satellite는 UI grouping이다.** 서로 다른 진실 원천이나 별도 주문 엔진을 만들지 않는다.

---

## PHASE 20 — 전략 상세 화면

전략 카드 클릭 시:

```
현재 상태 · 환경 · 현재 포지션 · 진입가 · 현재가 · SL · TP · 청산가 ·
레버리지 · 미실현손익

마지막 판단 — 왜 진입했나 / 왜 관망했나 / 왜 차단됐나
다음 평가 · 최근 거래 · 성과 · 리스크
```

**특히 왜 아무 주문도 안 나갔는지 보여준다:**
`NO_SIGNAL · RISK_BLOCKED · WAITING · CONFLICT · UNKNOWN`

---

## PHASE 21 — 멀티전략 실행 슬롯

```
Slot 1  BTC Trend
Slot 2  ETH Breakout
Slot 3  BTC Mean Reversion
Slot 4  QQQ Swing
Slot 5  SCHD Long-term
```

상태: `RUNNING · WAITING · BLOCKED · CONFLICT · ERROR · PAUSED · EXITING`

각 슬롯은 독립된 strategy version · allocation · instrument binding ·
risk policy · position ownership을 가진다.

---

## PHASE 23 — Webhook Signal Hub

```
TradingView → TRAIGO Webhook API → canonical Signal
            → Strategy/Signal Router → Risk Manager → Execution
```

**Make.com 의존성을 만들지 않는다.**

Webhook 검증: idempotency · timestamp · source · instrument · timeframe ·
direction · signal version · strategy binding.

**웹훅을 받았다고 바로 주문하지 않는다.**

---

## PHASE 24 — 알림 체계 정리

| 레벨 | 내용 |
|---|---|
| CRITICAL | Kill Switch · 보호주문 실패 · liquidation 위험 · Worker 장시간 중단 · 주문 UNKNOWN |
| WARNING | reconciliation 문제 · data stale · 높은 risk |
| INFO | 일반 진입/청산은 기본적으로 대시보드 기록 중심 |

사용자 설정으로 알림 레벨을 조절할 수 있게 한다.

**절대로 확인하지 않은 성공을 알리지 않는다.**

---

## PHASE 25 — Recovery Center

진단 화면을 Recovery Center로 발전시킨다.

확인: Worker dead/stale · migration pending · credential/decryption ·
order UNKNOWN · position mismatch · orphan protection · strategy stalled ·
snapshot stale · ledger incomplete

각 문제마다 **자동 복구 가능 / 사용자 확인 필요 / 수동 조치 필요**를 구분한다.

---

## PHASE 26 — 코드 품질 부채 정리

기능이 안정된 뒤: TypeScript error → 0 · TS 기준선 → 0 ·
`ignoreBuildErrors` 제거 · 중복 타입 제거 · schema drift 정리 · 죽은 코드 제거 ·
오래된 PR close · README 현실과 일치 · Node version 통일 검토

**`ignoreBuildErrors`를 오류가 남아 있는 상태에서 먼저 제거하지 않는다.**

---

## PHASE 27 — 장기 TESTNET / PAPER 검증

기능 개발 중에도 운영 데이터를 계속 축적한다.

uptime · Worker missed runs · signals · fills · UNKNOWN orders ·
duplicate orders · protection success · orphan cleanup · slippage · fees ·
funding · PnL · MDD · Kill Switch incidents · strategy degradation

**수익률만 보지 않는다. 주문 안전성과 운영 안정성이 먼저다.**

---

## PHASE 28 — LIVE는 마지막

```
PAPER → TESTNET → TESTNET_VALIDATED → LIVE_SMALL → LIVE_LIMITED → LIVE_FULL
```

`LIVE_SMALL` 전에 반드시 확인: encryption/credential OK · read/write exchange
test OK · leverage metadata OK · position ownership OK · protection ownership OK ·
Kill Switch OK · reconciliation OK · Worker uptime OK · migration 0 pending ·
no UNKNOWN outstanding

**LIVE 승격은 자동화하지 않는다.**

---

## 부록 — 재구성 대기 중인 옛 브랜치

> 여기 적힌 것은 **아직 main에 없는 작업**이다. 기계적으로 rebase하거나
> merge하지 않는다. 해당 PHASE에 들어갈 때 **최신 main 기준으로 다시
> 만든다** — 판정 함수의 아이디어는 참고하되 배선은 새로 한다.

### `claude/work-status-review-i8ql0m`

main보다 **86 커밋 뒤처져 있고 10 커밋 앞서 있다.** 갈라진 지점은
`a0c7dab`(#106)이다. 그 뒤로 main에서 지갑 · 워커 · 자동매매 개요가
전부 다시 쓰였기 때문에, 이 브랜치의 "수정" 파일들은 지금 main의 같은
파일과 거의 무관하다.

**합치면 안 되는 구체적 이유** — 이 브랜치는 아직
`supabase/migrations/049_worker_heartbeat_note.sql`을 들고 있다.
그런데 main의 마이그레이션은 **048 → 050으로 건너뛴다.** 050~067이
이미 적용된 DB에 049가 뒤늦게 들어가는 모양이 된다.

아직 main에 없는 것 (PHASE 매핑):

| 파일 | 어디로 |
|---|---|
| `src/lib/strategies/validationStage.ts` | PHASE 13 — Strategy Validation Ladder |
| `src/lib/engine/testnetReadiness.ts` · `TestnetReadinessPage.tsx` | PHASE 13 · PHASE 28 승격 전 확인 |
| `src/lib/engine/decisionTrace.ts` | PHASE 20 — 왜 아무 주문도 안 나갔는지 |
| `src/lib/engine/timeWindowOrder.ts` | PHASE 14 — 주식 주문 시간 · 휴장 규칙 |
| `src/lib/portfolio/walletAccounts.ts` | PHASE 18 — 지갑 UI |
| `src/lib/ui/layoutMode.ts` | PHASE 15~17 — 디자인 시스템 1차 |
| `supabase/migrations/049_*.sql` | **버린다** — 번호가 이미 지나갔다 |

브랜치 자체는 지우지 않는다. 위 표가 "무엇이 아직 안 들어왔는지"의
기록이고, 각 PHASE에서 이 표를 지워 가며 진행한다.
