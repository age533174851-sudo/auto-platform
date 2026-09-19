# PAPER 현물 보유·분할매도 회계 계약 (Phase 2.5)

이 문서는 `088_paper_spot_holdings.sql`이 무엇을 약속하는지 적는다.
구현보다 **왜 그 모양인지**가 남아야 다음 사람이 되돌리지 않는다.

## 왜 필요했나

PAPER의 현물은 자산이 아니라 **배율 1짜리 파생 포지션**으로 모델링돼 있었다.
매수대금은 `balance`에서 빠지지 않고 `SUM(margin)`으로만 잠기며, 파는 방법은
포지션 한 줄을 통째로 닫는 것뿐이었다. 사는 화면은 있는데
"100개 중 30개만 판다"가 없었다.

### 막고 있던 것 — cashflow 멱등키

챌린지 원장의 멱등키는
`(challenge_id, cashflow_type, source_event_type, source_event_id)`이고
`ON CONFLICT ... DO NOTHING`이다.

부분매도를 `POSITION_CLOSE`/`position_id`로 적으면 **같은 포지션의 두 번째
매도가 첫 번째와 키가 완전히 같아진다.** 행도 안 생기고, 잔고도 안 움직이고,
오류도 안 난다 — 화면에는 "50% 매도 완료"가 뜨는데 실현이익이 사라진다.

## 칸의 뜻 — 무엇이 불변이고 무엇이 상태인가

| 칸 | 성격 | 부분매도 시 |
|---|---|---|
| `fill_price` · `leverage` · `market` · `side` · `opened_at` | 불변 · 원 체결 증거 | 안 바뀜 |
| **`entry_fee`** | **불변 · 과거 현금 사건** | **안 바뀜** |
| `open_quantity` · `open_notional` · `open_margin` | 불변 · 원 체결 증거 | 안 바뀜 |
| `quantity` · `notional` · `margin` | 가변 · 남은 상태 | 비례 축소 |
| **`remaining_entry_fee_basis`** | 가변 · 남은 원가 귀속 | 비례 축소 |

비대칭은 의도한 것이다.

- `quantity`/`notional`/`margin`은 **"지금 무엇을 들고 있고 현금이 얼마 잠겨
  있나"**라는 상태다. 기존 독자(`SUM(margin)` 용량검사 · exit-monitor ·
  legacy 청산)가 전부 현재값을 원하므로 제자리에서 줄이는 것이 맞다.
- `entry_fee`는 **이미 끝난 현금 사건**이다. 부분매도를 했다고 과거에 낸
  수수료가 줄어들지 않는다.

두 뜻을 한 칸에 담으면 마지막 조각에서 **이미 귀속된 몫을 한 번 더 뺀다.**
설계 단계 실측에서 0.13125만큼 어긋났다 — 앞선 두 매도에 귀속된
0.075 + 0.05625와 정확히 일치했다.

불변 칸은 `paper_positions_freeze_open_trg`(BEFORE UPDATE)가 지킨다.
코드 규율은 운영 수리·수동 UPDATE·앞으로 생길 경로를 지나가지 않는다.

`open_entry_fee`는 **만들지 않았다.** `entry_fee` 자체가 불변 원본이다.

## 등가가 정확히 성립하는 이유

목표는 한 문장이다:

> 25% + 25% + 남은 전부로 팔든 한 번에 100%로 팔든, 최종 보유수량·잔고·
> 손익·수수료·원장·거래통계가 **정확히 같아야 한다.**

JS double로 같은 계산을 돌리면 두 경로가 `-7.1e-15`만큼 다르다. 화면에서는
안 보이고 검사기도 안 잡지만, 그 차이가 lot에 dust로 남으면 **영원히 안 풀리는
잔량**이 된다.

NUMERIC은 곱셈·뺄셈이 정확하다. 그래서 **나눗셈 결과가 총합에 들어가지 않게**
짠다.

```
Σ gross     = Σ (exit − f)·sᵢ = (exit − f)·q₀      곱셈·뺄셈만
Σ exit_fee  = Σ exit·sᵢ·r     = exit·q₀·r          곱셈만
Σ 귀속수수료 = e₁+e₂+e₃ = E₀                        마지막이 남은 전부를 먹는다
```

두 규칙이 이것을 만든다.

1. **`percent = 100`은 나눗셈을 하지 않는다.** 남은 전부를 그대로 가져간다.
2. **여러 lot 배분은 비례 내림 + 잔여 흡수.**

```
① take_i := FLOOR_18( q_i × sold / held )     항상 비례분 이하 → 합이 sold 이하
② residue := sold − Σ take_i                  항상 ≥ 0
③ 줄 순서대로 여유(q_i − take_i)에 residue를 채운다
   Σ여유 = held − sold + residue ≥ residue  →  **항상 소진된다**
```

결과: `Σ take_i = sold` 정확, 각 `take_i ≤ q_i`.

**반올림이 아니라 내림인 이유**: 반올림하면 배분 합이 매도 수량을 넘을 수 있고,
그러면 마지막 줄이 가진 것보다 많이 팔린다. 내림은 항상 모자라고, 모자란
만큼은 잔여 흡수가 여유 있는 줄에 채운다 — 넘치는 쪽으로는 가지 않는다.

보유 중에는 `margin`과 `remaining_entry_fee_basis`가 아주 약간 **크게** 남는다
(예약 현금이 약간 많게 잡혀 가용 잔고가 약간 작게 보인다 — fail-closed 방향).
마지막 매도가 남은 전부를 먹어 0으로 정확히 수렴한다.

## 원장 모델 — 그대로다

```
REALIZED_PNL = gross (수수료 차감 전)
TRADING_FEE  = -exit_fee (음수)
```

순액을 한 줄로 적으면 수수료가 두 번 빠진다(`085`가 적어 둔 그대로).
진입 수수료는 `POSITION_OPEN`에서 이미 정확히 한 번 적혔다.

| | 원장 사건 |
|---|---|
| 진입 | `TRADING_FEE` / `POSITION_OPEN` / `position_id` — **1회** |
| 부분매도 | `REALIZED_PNL` + `TRADING_FEE` / `POSITION_SELL` / **`sell_id`** |
| legacy 전량청산 | `REALIZED_PNL` + `TRADING_FEE` / `POSITION_CLOSE` / `position_id` |

불변식 `paper_accounts.balance = SUM(paper_challenge_cashflows.amount)`는
깨지지 않는다. 기존 `POSITION_CLOSE` 이력은 **읽지도 쓰지도 않는다.**

## 매도 사건의 신원

`paper_sell_events`의 유니크는 `(paper_account_id, client_sell_id)`다.

| 상황 | 결과 |
|---|---|
| 같은 `client_sell_id` + 같은 내용 | `REPLAYED` — 저장된 답을 그대로 준다 |
| 같은 `client_sell_id` + 다른 내용 | `CONFLICT` — **아무것도 안 움직인다** |
| 다른 `client_sell_id` | 새 매도 |

**계좌는 요청 본문에서 오지 않는다.** `challengeId`(또는 없으면 기본 계좌)로
서버가 정한다. 그래서 사용자가 임의 문자열을 보내도 자기 계좌 밖에 닿을 수 없다.

`challengeId`가 있는데 못 풀리면 **기본 계좌로 내려가지 않는다.** 내려가면
사용자가 고른 적 없는 장부의 자산이 팔린다.

## 거래 통계 (D1)

**부분매도는 거래로 세지 않는다.** lot의 남은 수량이 0이 되는 순간에만
`trade_count`를 1 올리고, 승패는 그 lot에 귀속된 **누적** 실현손익
(`paper_sell_event_lots` 합)으로 판정한다.

누적을 칸으로 또 들고 있지 않는다 — 돈의 정본이 둘이 되기 때문이다.

legacy 전량청산(`paper_settle_close`)도 같은 규칙을 쓴다(A2). 부분매도된 적
없는 줄은 앞선 합이 0이라 **예전과 완전히 같은 값**이다.

## 하루 손실 한도

예전에는 `closed_at >= 오늘`인 줄의 `realized_pnl`을 직접 합산했다.
부분매도가 생기면 두 가지로 틀린다.

- 부분매도는 줄을 **닫지 않는다** → 하루 종일 손절해도 한도에 한 푼도 안 잡힌다
- 어제 부분매도한 줄이 오늘 닫히면 → **어제 손실이 오늘로 옮겨 온다**

`paper_realized_between`(088) 한 곳이 합산한다.

```
① 그 기간의 매도 사건에 귀속된 손익   (event_effective_at 기준)
② 그 기간에 닫힌 줄의 legacy 몫       (realized_pnl − 그 줄의 매도 사건 합)
```

②가 겹치지 않는 이유: `paper_sell_holding`이 닫은 줄은 `realized_pnl`이 곧
매도 사건 합이라 차가 0이다. legacy 청산이 닫은 줄만 남는다.

## exit-monitor (D4)

감시기가 `market`을 한 번도 읽지 않고 전부 선물 마크가(`getPremiumIndex`)를
썼다. **익절이 걸린 현물 포지션이 선물 가격으로 닫히고 있었다** —
`/api/paper/close`가 이미 고친 고장이 이 경로에만 남아 있었다.

이제 진입·청산과 같은 `readPaperMarkPrice`를 쓴다. 가격 지도의 키도 심볼이
아니라 **`시장:심볼`**이다 — 같은 심볼이 현물과 선물에 동시에 있으면 심볼만으로는
두 가격이 한 칸을 덮어쓴다.

청산가도 고쳤다. `Number(null)`은 `0`이라, 청산가가 없는 현물이 "청산가 0"이라는
없는 값을 판정 입력으로 넣고 있었다. 지금은 LONG 판정이 `low <= 0`이라 발동하지
않지만, 부등호가 한 번만 바뀌면 전 현물 포지션이 청산된다.

## 잠금 순서

```
paper_accounts  →  paper_challenges  →  paper_positions (행)
```

`084`·`085`·`086`·`087`이 전부 계좌를 먼저 잡는다. 포지션 행잠금을 셋째
자리에 두면 전순서가 유지되고 순환이 생기지 않는다. 계좌 잠금이 이 계좌의
모든 돈 경로가 만나는 한 점이므로, lot 변경은 그 아래에서 이미 직렬화된다.

## 아직 아닌 것

- **venue 정밀도** — `stepSize`/`minQty`/`minNotional`/`tickSize` 권위는
  실거래소 경로에만 있고 paper에 배선돼 있지 않다. DB NUMERIC 소수 보유·매도가
  되는 것과 그 수량이 거래소에서 체결 가능한 것은 **별개다.** 이 변경은
  venue-valid fractional trading이라고 선언하지 않는다.
- **평가손익 · 수익률** — 열린 포지션의 미실현 손익 정본이 이 저장소에 없다.
  여기서 만들면 세 번째 손익 권위가 생긴다. `/api/paper/holdings`는
  `unrealizedPnl: 'UNAVAILABLE_NO_AUTHORITY'`를 값으로 들고 다닌다.
- **화면** — 이 차수는 backend다. 보유 표시와 매도 UI는 Phase 3다.

`avgPrice`는 **수수료를 넣지 않은 체결평균가**(`Σnotional / Σquantity`)다.
취득원가(수수료 포함)와 같은 "평단"이라는 이름으로 섞지 않는다 — 섞으면
사용자가 수수료 포함분을 체결가로 읽는다. 응답이
`avgPriceBasis: 'EXECUTION_AVERAGE_FEE_EXCLUDED'`를 값으로 들고 다닌다.

## 증명

| | 무엇 |
|---|---|
| `scripts/sql/088_paper_spot_holdings_proof.sql` | 실제 Postgres에서 E1–E7 · 멱등 · 충돌 · oversell · freeze · 계좌 격리 · 하루 손실 날짜 |
| `scripts/paper-spot-holdings-concurrency.sh` | psql을 여러 개 띄워 진짜 경합 (같은 식별자 8개 동시 · 70%+70% · 매도 vs legacy 청산 · 매수 vs 매도) |
| `scripts/check-paper-spot-holdings.mjs` | 계약의 **모양** (CI에는 DB가 없다) |
| `scripts/paper-spot-holdings-mutations.mjs` | 위 계약을 하나씩 무력화하고 게이트가 빨개지는지 |
| `src/lib/engine/paperSpotHoldings.test.ts` | TS가 실제로 판단하는 것 (매도 요청 읽기 · 감시기 가격 권위) |

금액 계산은 TS 시험에 **없다.** 그것은 `paper_sell_holding`이 NUMERIC으로
하고, 같은 산수를 TS에 다시 적으면 정본이 둘이 된다.
