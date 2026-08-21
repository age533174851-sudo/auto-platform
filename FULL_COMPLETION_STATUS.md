# TRAIGO FULL COMPLETION — 상태판

**이 문서를 쓰는 것이 목적이 아니다.** 코드가 실제로 고쳐지고 런타임에서
확인돼야 항목이 DONE이 된다. `RUNTIME_VERIFIED`는 배포·마이그레이션·워커
생존·실제 거래소 증거·화면 일치가 **전부** 충족됐을 때만 적는다.

## 완료 기준

| 단계 | 뜻 |
|---|---|
| `FIXED` | 코드가 고쳐졌다 |
| `TESTED` | 단위/통합 테스트가 값으로 막는다 |
| `MERGED` | main에 들어갔다 |
| `DEPLOYED` | Vercel·Fly SHA가 main과 같다 (`deployment MATCHED`) |
| `RUNTIME_VERIFIED` | **실제 거래소·실제 화면에서 확인됐다** |

## PR 체인

1. **Auto Runtime Truth** ← 진행 중
2. Wallet Completion (#145가 남긴 것)
3. Unified Ledger
4. Multi Strategy Ownership
5. MOCK Runtime Unification
6. Backtest Truth
7. Feature / Promotion Registry
8. Full UI/UX
9. Type Debt / Security / Recovery
10. Multi-asset foundation

---

## 1. Auto Runtime Truth

### 1-1. 화면이 죽은 워커를 말하고 살아 있는 워커를 숨겼다

- **ISSUE** 실측 `main = Vercel = Fly = 3c46151` · `MATCHED` · Fly Worker alive.
  그런데 자동 화면은 `Worker (Railway) · 없음`, `자동매매는 Vercel 크론이
  돌립니다`, `Railway 워커는 Binance 지역 차단으로 쓰지 않습니다`,
  `이 판은 브라우저 엔진 상태입니다`라고 표시.
- **ROOT CAUSE** 운영 사실(공급자 이름·무엇이 돌리는가)이 **화면 파일에
  문자열 상수로** 박혀 있었다. 코드는 안 틀렸고 문장만 늙었다.
- **FILES** `src/components/AutoStatusBoard.tsx` ·
  `src/app/api/worker/status/route.ts` · `src/lib/engine/autoRuntimeView.ts`
- **FIX** canonical view model 도입. 화면은 운영 사실을 한 글자도 직접
  쓰지 않는다. 공급자 이름은 서버가 주고, 모르면 `실행기`라고만 적는다
  (언제나 참인 말). 판정·문장·색 전부 `autoRuntimeView`가 만든다.
- **UNIT** 15건 — 살아 있으면 정상 · 조회 실패는 '없음'이 아님 · 모르는
  상태를 정상으로 눕히지 않음 · 공급자를 모르면 지어내지 않음
- **CI** `check-runtime`에 stale-claim 검사 추가. 옛 문구를 되돌려 실제로
  잡히는 것까지 확인함
- **STATUS** `FIXED` `TESTED` — merge 대기

### 1-2. 화면끼리 서로 다른 말을 했다

- **ISSUE** 위는 `RUNNING`, 아래는 `워커 없음`, 예약은 켜짐, 실제 Fly는 alive.
- **FIX** `runtimeContradictions()`가 값으로 잡고 화면이 먼저 말한다.
- **UNIT** 4건 (정상 상태에서 경고를 띄우지 않는 것 포함)
- **STATUS** `FIXED` `TESTED`

### 1-3. 배포 어긋남을 '정상'으로 그렸다

- **ISSUE** 워커가 살아 있으면 SHA가 달라도 초록.
- **FIX** `MISMATCH`면 초록 대신 노랑 + `배포 버전 불일치 · 자동매매 확인 필요`.
- **STATUS** `FIXED` `TESTED`

---

---

## 2. Wallet Completion — 계좌 선택과 상세 배선

### 2-1. 계좌 선택 버튼이 장식이었다

- **ISSUE** 계좌 버튼을 눌러도 `account` 상태만 바뀌고 합계는 환경 전체
  그대로. Gate를 눌러도 Binance를 눌러도 같은 숫자.
- **ROOT CAUSE** **서버에 계좌 단위 집계 경로가 아예 없었다.** UI만
  고치면 "선택은 되는데 숫자는 그대로"가 또 난다.
- **FILES** `src/lib/portfolio/walletOverview.ts` ·
  `src/app/api/wallets/overview/route.ts` · `src/components/pages/WalletPage.tsx`
- **FIX** `accountWalletOf()` — **환경 합계와 같은 함수**를 재사용해 계좌
  하나를 계산한다(두 규칙이 갈리지 않게). 라우트가 계좌별 total·spot·
  futuresEquity·available·positionMargin·unrealized·unpriced를 내려주고,
  화면은 고른 계좌 값을 쓴다.
- **UNIT** 7건 — A와 B가 다른 숫자 · 계좌 합 = 환경 합 · 한 계좌 실패가
  다른 계좌를 망가뜨리지 않음 · 환경 모르는 계좌는 합계 없음
- **STATUS** `FIXED` `TESTED`

### 2-2. 자산 곡선이 구조적으로 영원히 비어 있었다

- **ISSUE** `const snapshots: any[] = []`
- **ROOT CAUSE** 서버는 기록을 읽어 성과까지 계산하면서 **원본을 안
  내려줬고**, 화면은 빈 배열을 직접 넣었다. 데이터가 없어서가 아니라
  배선이 없어서.
- **FIX** 라우트가 `snapshotSeries`(환경별, 오래된 순)를 준다. 없는
  구간은 지어내지 않는다.
- **STATUS** `FIXED`

### 2-3. 선물/현물 상세 탭이 빈 배열이었다

- **ISSUE** `futuresAccounts = []`, `spotRowsOf([])`
- **FIX** 라우트가 계좌별 `spotAssets`·`futuresDetail`을 준다. 포지션
  조회 실패면 미실현손익 칸은 **0이 아니라 `FAILED`**, 가격을 못 매긴
  자산의 평가액도 `FAILED`, 24h 변동률은 이 경로가 안 주므로 `UNSUPPORTED`.
- **STATUS** `FIXED`

### 2-4. 오늘 손익이 아무 자료도 없이 계산되고 있었다

- **ISSUE** `equityChangeOf(null, {})`
- **FIX** 아는 것(오늘 스냅샷 델타 · 미실현손익)은 넣고, 모르는 것
  (입출금 · 수수료 · 펀딩)은 null로 둔다 → 화면이 **무엇을 몰라서
  확정 못 했는지** 말한다. 통합 장부가 붙으면 그 자리가 채워진다.
- **STATUS** `FIXED` (완전한 값은 Ledger 이후)

---

## 3. Unified Ledger — 잔고 변화로 수익을 추측하지 않는다

### 3-1. 테스트넷 충전이 수익으로 잡힐 수 있었다

- **ISSUE** 손익을 자산 스냅샷 차이로 추측했다. 자산은 매매가 아닌
  이유로도 변한다 — 입출금 · 이체 · 수수료 · 펀딩 · **Gate 테스트넷 일일
  충전 · Binance 테스트 자금 초기화**.
- **ROOT CAUSE** 사건 단위 기록이 아예 없었다. 합계밖에 없으니 "왜
  늘었는지"를 물을 수 없다.
- **FILES** `supabase/migrations/056_ledger_events.sql` ·
  `src/lib/ledger/ledgerEvent.ts` · `src/lib/ledger/writeLedger.ts`
- **FIX** 불변 사건 장부. `매매손익 = 자산변화 − 외부유입 − 수수료 − 펀딩`
  이고 **네 항을 전부 알 때만** 숫자를 만든다. 장부가 기간을 다 덮지
  못하면(`ledgerComplete !== true`) `null`이다 — 사건을 절반만 읽고
  계산하면 나머지 절반이 전부 수익으로 둔갑한다.
- **UNIT** 21건 — 충전 10,000 + 실현 12일 때 매매손익이 **12**로 나오는지,
  int64 주문번호가 문자열로 남는지, 끝자리만 다른 두 체결이 한 열쇠로
  합쳐지지 않는지
- **STATUS** `FIXED` `TESTED` — 마이그레이션 **056 적용 필요**

### 3-2. 표만 만들고 채우는 코드가 없는 고장을 반복하지 않았다

- 048(자산 스냅샷)이 그랬고 그래서 지갑 곡선이 구조적으로 비어 있었다.
- **FIX** 같은 PR에서 writer를 붙였다 — `my-original-v1` 진입 확인
  시점과 스모크 청산(포지션 0 증명 시점). **접수가 아니라 증거가 확인된
  뒤에만** 적는다.
- 장부 쓰기 실패가 매매를 막지 않는다. 다만 조용히 삼키지도 않는다.
- **STATUS** `FIXED`

---

## 아직 남은 것 (다음 PR에서 **이어서** 진행)

| # | 항목 | 상태 |
|---|---|---|
| 2 | Wallet: snapshot writer → Worker + bucket unique | `NOT_STARTED` (마이그레이션 필요) |
| 2 | Wallet: TESTNET credit/reset 분리 | `PARTIAL` — 장부 분류는 됨, 거래소 income 수집 미구현 |
| 3 | Ledger: 거래소 income(FEE/FUNDING) 수집 | `NOT_STARTED` |
| 3 | Ledger: Wallet 화면 배선(tradingPnl 표시) | `NOT_STARTED` |
| 2 | Wallet: 전략계좌·장기투자 귀속 | `NOT_STARTED` (Ledger 선행) |
| 2 | Wallet: price/FX provenance | `NOT_STARTED` |
| 3 | Unified Ledger | `NOT_STARTED` |
| — | #142 cleanup evidence UI (actual-auto) | `NOT_STARTED` |
| — | #142 Gate 실측 `Positions 0 / Orders 0` | **`BLOCKED`** — 아래 참조 |
| — | TypeScript 73 → 0 | `NOT_STARTED` (현재 73, 기준선) |

### #142 런타임 검증이 막힌 이유

코드는 main에 있고 배포도 MATCHED다. 남은 것은 **새 actual-auto 사이클
한 번**이다 — 진입 → 보호주문 → 청산 → 형제 정리 → 재조회. 그 사이클이
돌아야 Gate에서 0/0을 증거로 확인할 수 있다.
