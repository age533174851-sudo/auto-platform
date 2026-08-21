# TRAIGO FULL COMPLETION — 상태판

**이 문서를 쓰는 것이 목적이 아니다.** 코드가 실제로 고쳐지고 런타임에서
확인돼야 항목이 DONE이 된다. `RUNTIME_VERIFIED`는 배포·마이그레이션·워커
생존·실제 거래소 증거·화면 일치가 **전부** 충족됐을 때만 적는다.

## 최상위 원칙 — ZERO-TOUCH OPS

> **사용자는 명령만 한다.** 기술적으로 자동화 가능한 수동 절차를
> 사용자에게 넘기지 않는다. "사용자가 해야 할 것"이 발생하면 먼저 그것을
> 자동화하는 기능을 구현한다.

작업 보고에 아래 문장이 나오면 **자동화 미완성**으로 본다:
"마이그레이션을 적용해 주세요" · "Vercel 환경변수를 확인해 주세요" ·
"Fly secret을 맞춰 주세요" · "fly logs를 열어 보세요" · "SHA를 비교해 주세요" ·
"heartbeat를 확인해 주세요" · "exit-monitor가 도는지 봐 주세요".

그리고 **자동화를 많이 만드는 것보다 실패 지점 자체를 없애는 것이 낫다.**
`EXIT_MONITOR_SECRET`을 두 곳에서 맞추는 일을 자동화하는 것보다,
exit-monitor를 Worker 안으로 옮겨 그 secret이 필요 없게 만드는 쪽이 옳다.

전체 규칙은 `CLAUDE.md`에 있다.

## 완료 기준

| 단계 | 뜻 |
|---|---|
| `FIXED` | 코드가 고쳐졌다 |
| `TESTED` | 단위/통합 테스트가 값으로 막는다 |
| `MERGED` | main에 들어갔다 |
| `DEPLOYED` | Vercel·Fly SHA가 main과 같다 (`deployment MATCHED`) |
| `RUNTIME_VERIFIED` | **실제 거래소·실제 화면에서 확인됐다** |

## PR 체인

0. **ZERO-TOUCH OPS** ← 지금 여기 (P0)
1. Auto Runtime Truth
2. Wallet Completion (#145가 남긴 것)
3. Unified Ledger
4. Multi Strategy Ownership ← 진행 중
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

## 4. 전략 감사 — 우위 가정과 100배 수학

### 4-1. 가정한 우위가 측정한 우위처럼 보였다

- **ISSUE** "우위 10%를 넣으면 수익이 나고 빼면 청산이 쏟아진다."
- **ROOT CAUSE** 맞는 관찰이지만 **전략의 성질이 아니라 산수의 성질**이다 —
  승률을 올려 넣었으니 결과가 좋아지는 것이 당연하다. 화면의 버튼
  라벨이 `우위 +10%p`라 **입력한 가정**을 전략의 속성으로 읽게 했다.
- **FILES** `src/lib/strategies/tradeIdentity.ts` ·
  `src/lib/strategies/simModel.ts` · `src/components/StrategyProfilesPanel.tsx`
- **FIX** `edgeClaimOf()` — 증거 없는 우위는 언제나 `ASSUMED`. 라벨을
  `가정 +10%p`로 바꾸고, 가정을 고르면 **"이 가정이 맞다는 증거는 아직
  없습니다"**를 화면이 먼저 말한다. 선택지도 0/2/5/10/15/20으로 촘촘히.
- **UNIT** 5건
- **STATUS** `FIXED` `TESTED`

### 4-2. 한 점에서만 좋은 것을 우위로 읽을 수 있었다

- **FIX** `edgeFragility()` — `SINGLE_POINT`(+10에서만 좋음) ·
  `SCATTERED`(흩어짐) · `ROBUST_ZONE`(이어짐)을 값으로 판정하고 사다리
  표 아래에 한 줄로 적는다.
- **UNIT** 5건
- **STATUS** `FIXED` `TESTED`
- **참고** `sweepEdges`는 이미 0~15%p를 1%p 간격으로 훑고 흩어진 점을
  구간으로 안 쳤다(`broadRobustZone`). 없던 것은 **그 판정을 사람이 읽는
  문장으로 내놓는 것**이었다.

### 4-3. "100배"가 실제 숫자와 맞는지 볼 방법이 없었다

- **FIX** `tradeIdentity()` — 증거금 × 배율 = 명목(= 수량 × 체결가)이
  성립하는지, 요청 배율과 실제 배율이 같은지, 손절 한 번에 증거금의 몇 %가
  사라지는지를 값으로 낸다.
- **모르는 값을 채워 넣지 않는다** — 실제 배율을 모를 때 요청 배율로
  대신하지 않는다. 그 대입이 "이름만 100배"를 만든다.
- **UNIT** 7건 — `$10 × 100배 = $1,000` · 명목 불일치 · 요청 100/실제 75 ·
  실질 배율이 5배일 때 숨기지 않음 · 손절 시 증거금 110% 소실 →
  "손절보다 청산이 먼저 옵니다"
- **STATUS** `FIXED` `TESTED`

> **레버리지는 기대값을 만들지 않는다.** 손익을 확대할 뿐이다. 1회
> 기대값이 음수면 100배는 파산을 앞당긴다 — 이 모듈은 "100배라서 번다"는
> 말을 만들지 않고 숫자가 맞는지만 본다.

---

## 5. ZERO-TOUCH OPS — 1. 마이그레이션 완전 자동화

### 5-1. 마이그레이션 적용이 사람의 기억에 달려 있었다

- **ISSUE** 파일은 커밋됐는데 아무도 적용하지 않는 상태가 반복됐다.
  054가 빠져 워커 버전이 영영 `모름`이었고, 055 없이 중지가 반쪽으로
  돌았고, 056 없이 장부 writer가 조용히 `TABLE_MISSING`만 남겼다.
  **셋 다 코드는 맞고 DB만 뒤처진 상태였고, 알아채는 유일한 방법이
  사람의 기억이었다.**
- **FILES** `src/lib/system/migrationPlan.ts` ·
  `src/lib/system/migrationStatus.ts` · `scripts/apply-migrations.mjs` ·
  `scripts/gen-migration-manifest.mjs` · `scripts/check-migrations.mjs` ·
  `.github/workflows/migrate.yml` · `supabase/migrations/000_schema_migrations.sql`
- **FIX** main에 머지되면 `detect → classify → adopt → lock → apply →
  verify → record`가 자동으로 돈다. 사람이 SQL 편집기를 여는 절차가
  사라졌다.
- **분류** 더하는 것(표·칸·인덱스·정책·제약·조건부 backfill)은 자동 적용.
  **DROP TABLE · DROP COLUMN · 타입 변경 · 조건 없는 DELETE/UPDATE는
  자동 실행하지 않는다.** 판정하지 못한 문장도 자동 실행하지 않는다 —
  '아마 괜찮겠지'가 데이터를 지운다.
- **기존 53개** 카탈로그에서 표·인덱스·칸·정책이 실제로 있는지 확인한
  뒤에만 `BASELINE`으로 기록한다. **실행하지 않고, 추측으로 적지도 않는다.**
- **적용 후 확인** psql이 0으로 끝난 것과 표가 생긴 것은 다른 사실이다.
  `migrationTargets()`가 뽑은 대상을 `information_schema`·`pg_indexes`·
  `pg_policies`에 다시 물어보고, 확인 실패면 그 자리에서 멈춘다.
- **잠금** 배포 두 개가 겹치면 같은 파일을 두 번 실행한다.
  `schema_migration_lock` 한 줄 + 워크플로 concurrency 두 겹.
- **배포 차단** 남은 마이그레이션이 있으면 fly-deploy가 워커를 바꾸지 않는다.
- **진입 차단** `migrationEntryGate()` — 적용이 안 끝났으면 새 주문을 막는다.
- **비밀 유출 방지** 접속 문자열은 지문 6자만 찍는다. psql 오류 문구에서도
  URL·호스트·비밀번호를 지우고 출력하며, DB에 남는 `error` 칸에도 지운
  문구만 들어간다.
- **CI** `check-migrations` — 번호 없는 파일이 목록에 없거나 번호가
  겹치거나 `migrationManifest.ts`가 낡으면 실패한다
  (**"만들어 놓고 배선을 안 함"을 CI가 잡는다**).
- **화면** `/api/system/status`와 `/api/system/migrations`가 Required /
  Applied / Pending / Failed를 그대로 보여 준다. 문구는 "적용하세요"가
  아니라 **"자동으로 적용하는 중"**이다.
- **UNIT** 38건 (`migrationPlan` 31 · `migrationStatus` 7)
- **STATUS** `FIXED` `TESTED` — 최초 1회 `SUPABASE_DB_URL` 권한 연결 후
  `RUNTIME_VERIFIED`

---

## 아직 남은 것 (다음 PR에서 **이어서** 진행)

| # | 항목 | 상태 |
|---|---|---|
| 2 | Wallet: snapshot writer → Worker + bucket unique | `NOT_STARTED` (마이그레이션 필요) |
| 2 | Wallet: TESTNET credit/reset 분리 | `PARTIAL` — 장부 분류는 됨, 거래소 income 수집 미구현 |
| 3 | Ledger: 거래소 income(FEE/FUNDING) 수집 | `FIXED` `TESTED` — 062가 덮인 구간을 기록. **절반만 읽고 계산하지 않는다** |
| 3 | Ledger: Wallet 화면 배선(tradingPnl 표시) | `FIXED` — 지갑이 '그중 매매로 번 것'을 보여 주고, 못 만들면 무엇을 몰라서인지 적는다 |
| 2 | Wallet: 전략계좌·장기투자 귀속 | `NOT_STARTED` (Ledger 선행) |

### ZERO-TOUCH OPS 남은 축

| # | 항목 | 상태 |
|---|---|---|
| 2 | Secret 단일 출처 + Vercel/Fly 자동 동기화 (지문 비교) | `FIXED` `TESTED` — 어긋나면 **신규 진입 차단**. 동기화는 확인이 기본이고 적용은 명시적 승인 |
| 3 | **exit-monitor를 Worker 내부 스케줄로 이동** — 공유 secret 자체 제거 | `MERGED` (#152) + 회차기록·임차·밀림관문 (#154) |
| 4 | Worker boot 자가기록(provider·sha·지문·startup check) + `/api/system/runtime-health` | `MERGED` (#153) |
| 5 | 배포 워크플로가 main/Vercel/Fly SHA를 스스로 대조 → `DEPLOYMENT_VERIFIED` | `FIXED` `TESTED` — 여섯 가지(코드 셋·워커 생존·마이그레이션·스키마)가 전부 확인돼야 VERIFIED |
| 6 | `WORKER_PROVIDER` 수동 env 제거 — Worker가 heartbeat에 스스로 적는다 | `MERGED` (#153) |
| 7 | Self-healing Worker (stale → probe → restart → 재확인 → rollback) | `FIXED` `TESTED` — 주문 미확인 시 정지, 주문 있으면 대조 우선, 3회 후 GIVE_UP, 3회차부터 재배포로 승격 |
| 8 | Deployment Orchestrator (migration→deploy→verify→verdict 한 줄) | `FIXED` `TESTED` — 배포해 → migrate → fly-deploy → 검증 → verdict 기록 |
| 9 | 배포 후 자동 TESTNET 읽기전용 검증 | `NOT_STARTED` |
| 10 | #142 자동 검증 (position 0 · owned SL/TP absent · reread) | `PARTIAL` — 정리 증거를 `exit_monitor_runs.cleanup_detail`에 저장 (#154) |
| 11 | Ledger health 자동 검사 + 표 없으면 migration이 먼저 복구 | `PARTIAL` (표 자동 적용은 됨) |
| 12 | Recovery Center 자동 우선 (자동 가능/사람 결정 분리) | `FIXED` `TESTED` — `recoveryView()`가 가르고 운영 화면이 두 칸으로 보여 준다. `NEVER_AUTO` 셋은 값으로 박아 둠 |
| 13 | 운영 명령 인터페이스 (`전체 점검해`·`배포해`·`복구해`) | `FIXED` `TESTED` — 점검은 즉시, 중지는 즉시(킬 스위치), 배포·복구는 요청 큐 → ops-runner가 실행 |
| 14 | UI에서 운영 숙제 문구 금지 (CI 검사) | `PARTIAL` (마이그레이션 문구만) |
| 15 | 권한 bootstrap — 없는 credential만 `OPS_BOOTSTRAP_MISSING` | `FIXED` `TESTED` — 실행기가 **실제로 써 보고** CONNECTED/MISSING/INVALID를 적는다 |
| — | **Bootstrap Gate** — 필요한 마이그레이션이 미적용이면 신규 진입 BLOCK · 배포 verified 금지 · 청산/보호/복구는 계속 | `FIXED` `TESTED` |
| 2 | Wallet: price/FX provenance | `NOT_STARTED` |
| 3 | Unified Ledger | `NOT_STARTED` |
| — | #142 cleanup evidence UI (actual-auto) | `NOT_STARTED` |
| — | #142 Gate 실측 `Positions 0 / Orders 0` | **`BLOCKED`** — 아래 참조 |
| — | TypeScript 73 → 0 | `NOT_STARTED` (현재 73, 기준선) |

### #142 런타임 검증이 막힌 이유

코드는 main에 있고 배포도 MATCHED다. 남은 것은 **새 actual-auto 사이클
한 번**이다 — 진입 → 보호주문 → 청산 → 형제 정리 → 재조회. 그 사이클이
돌아야 Gate에서 0/0을 증거로 확인할 수 있다.
