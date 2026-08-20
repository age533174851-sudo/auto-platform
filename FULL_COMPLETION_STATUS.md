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

## 아직 남은 것 (다음 PR에서 **이어서** 진행)

| # | 항목 | 상태 |
|---|---|---|
| 2 | Wallet: account selector 실제 배선 | `NOT_STARTED` |
| 2 | Wallet: placeholder 상세 제거(`snapshots=[]` 등) | `NOT_STARTED` |
| 2 | Wallet: snapshot writer → Worker + bucket unique | `NOT_STARTED` |
| 2 | Wallet: TESTNET credit/reset 분리 | `NOT_STARTED` |
| 3 | Unified Ledger | `NOT_STARTED` |
| — | #142 cleanup evidence UI (actual-auto) | `NOT_STARTED` |
| — | #142 Gate 실측 `Positions 0 / Orders 0` | **`BLOCKED`** — 아래 참조 |
| — | TypeScript 73 → 0 | `NOT_STARTED` (현재 73, 기준선) |

### #142 런타임 검증이 막힌 이유

코드는 main에 있고 배포도 MATCHED다. 남은 것은 **새 actual-auto 사이클
한 번**이다 — 진입 → 보호주문 → 청산 → 형제 정리 → 재조회. 그 사이클이
돌아야 Gate에서 0/0을 증거로 확인할 수 있다.
