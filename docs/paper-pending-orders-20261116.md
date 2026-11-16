# 모의 대기 주문 — 설계 (2026-11-16)

> 코드 전에 적는다. 이 변경은 **모의 장부의 돈 경로**를 건드리고, 한 번
> 잘못 넣으면 기존 질의 전부가 조용히 틀어진다.

## 왜 필요한가

보내주신 매매법 목록 중 **그리드 · 마켓 메이킹 · 지정가 진입**이 지금
구조적으로 불가능하다. 호가 데이터가 없어서가 아니다:

```
모의 장부에 대기 주문이 없습니다 — 지정가는 아직 지원하지 않습니다
(src/lib/trading/capability.ts:109 — paper_positions.status는 open|closed 뿐)
```

**호가만 모아도 쓸 데가 없다.** 걸어 둘 자리가 없으면 호가는 구경거리다.
그래서 호가 수집보다 이것이 먼저다.

지금 열려 있는 전략 중에도 이게 없어서 손해 보는 것이 있다. 오더블록과
공정가치 갭은 "그 구간으로 **돌아오면** 산다"는 논리인데, 지금은 회차가
돌 때 가격이 이미 구간 안이어야 진입한다. 60초에 한 번 보면 그 사이에
들렀다 나간 것은 못 잡는다. **지정가로 걸어 두면 그게 잡힌다.**

## 하지 않을 것 — `paper_positions.status`에 `pending`을 더하지 않는다

가장 적게 고치는 길처럼 보이지만 가장 비싼 길이다. `status='open'`을 세는
곳이 전부 조용히 틀어진다:

| 세는 곳 | 'pending'이 섞이면 |
|---|---|
| `paper_auto_open`의 자리 판정 (104) | 안 열린 주문이 자리를 먹은 것처럼 보인다 |
| `availableView`의 가용 잔고 | 안 나간 증거금을 나간 것으로 센다 |
| 청산 감시 (`planExits`) | 포지션이 아닌 것에 손절·보유시간을 적용한다 |
| 화면의 "보유 중" 목록 | 체결되지 않은 것을 보유로 보여 준다 |

대기 주문은 **포지션이 아니다.** 청산가도 없고, 영원히 포지션이 되지
않을 수도 있다. 다른 표에 둔다.

## 표: `paper_orders`

```
id              uuid primary key
user_id         uuid not null
paper_account_id uuid not null          -- 어느 장부인가
bot_id          text not null           -- 어느 봇이 걸었나 (성적표 귀속)
run_id          uuid                    -- 어느 회차가 걸었나 (증거)
symbol          text not null
market          text not null           -- 'USDM'
side            text not null           -- LONG | SHORT
type            text not null           -- 'LIMIT' (지금은 이것뿐)
price           numeric not null        -- 걸어 둔 값
quantity        numeric not null
leverage        integer not null
margin          numeric not null        -- 체결되면 나갈 증거금
stop_loss       numeric not null        -- 체결 즉시 붙을 보호
take_profit     numeric
state           text not null           -- PENDING | FILLED | CANCELLED | EXPIRED
placed_at       timestamptz not null    -- **체결 판정의 시작선**
expires_at      timestamptz             -- null이면 만료 없음
filled_at       timestamptz
position_id     uuid                    -- 체결로 생긴 포지션
cancel_reason   text                    -- 왜 취소됐나 (정지·세대·만료·자리없음)
```

**봇당 PENDING 하나**를 부분 유일 인덱스로 고정한다 — `paper_automation_runs`가
`CLAIMED`에 쓰는 것과 같은 방식이다:

```sql
CREATE UNIQUE INDEX paper_orders_one_pending_bot
  ON public.paper_orders(user_id, bot_id) WHERE state='PENDING';
```

그리드(한 봇에 여러 개)는 **이 인덱스를 푸는 다음 단계**다. 지금 풀면
자리·증거금 계산이 한꺼번에 복잡해지고, 둘을 같은 회차에 넣으면 어느
쪽이 틀렸는지 못 가린다.

## 체결 판정 — 여기가 거짓말하기 가장 쉬운 자리

판정은 `src/lib/engine/paperOrderFill.ts`(순수)에 두고 시험을 붙인다.
입력은 **주문 + 걸린 뒤의 봉들**이다. 지금 마크가 하나로는 판정할 수 없다 —
60초 사이에 들렀다 나간 가격을 못 보기 때문이다. 봉 전체를 받는 길은
#659에서 열렸다(`fetchBars`).

규칙:

```
LIMIT BUY  at P → bar.low  <  P  이면 체결, 체결가 = P
LIMIT SELL at P → bar.high >  P  이면 체결, 체결가 = P
```

**스치는 것(`low == P`)은 체결로 적지 않는다.** 실제 호가창에서 그 값에
닿기만 하면 내 주문은 줄 뒤에 있어 안 채워질 수 있고, 큐 순서는 우리가
알 수 없다. 모르는 것을 유리하게 가정하면 성적표가 거짓이 된다. 보수적인
쪽으로 틀리면 성적이 낮게 나오고, 그건 안전한 방향이다.

**더 좋은 값으로 체결됐다고 적지 않는다.** 실제로는 P보다 유리하게 채워질
수 있지만, 그걸 가정하면 백테스트가 늘 이긴다. 체결가는 P다.

**걸린 시각 이전의 봉은 보지 않는다.** `placed_at`보다 먼저 열린 봉으로
체결을 주장하면 과거를 거래하는 것이다.

## 자리와 증거금 — 104의 상한을 깨지 않는다

대기 주문은 **자리를 미리 먹는다.** 안 그러면 봇 2개 한도(104)에 대기
주문 2개가 더 얹혀 최대 4개가 열릴 수 있다. `paper_auto_open`의 세는
식에 `PENDING` 주문 수를 더한다:

```
열린 포지션 + PENDING 주문 >= greatest(1, 켜진 봇 수)  →  SLOT_BUSY
```

증거금도 걸 때 예약한다(`availableView`가 `PENDING`의 `margin`을 뺀다).
예약하지 않으면 같은 돈으로 두 번 걸 수 있다.

## 취소 — 언제 거두는가

| 언제 | 왜 |
|---|---|
| 봇 정지 | 정지는 "새 진입을 멈춘다"다. 걸어 둔 것도 새 진입이다 |
| 세대 변경(`generation`) | 설정이 바뀐 주문은 그 설정의 주문이 아니다 |
| `expires_at` 지남 | 며칠 전 가격에 걸린 주문이 오늘 체결되면 그건 사고다 |
| 체결 시 자리 없음 | 그 순간 자리가 찼으면 `CANCELLED`(사유 적음) — 조용히 넘기지 않는다 |

취소에는 **반드시 사유를 적는다.** 사유 없는 취소는 사용자가 "왜 안
됐냐"를 물을 때 답할 수 없다 — #655에서 고친 것과 같은 종류의 구멍이다.

## 1차 범위 (이번 작업)

1. 마이그레이션 `105_paper_orders.sql` — 표 · 인덱스 · 권한(`service_role`만)
2. RPC: `paper_order_place` · `paper_order_fill` · `paper_order_cancel`
   (전부 `SECURITY INVOKER`, 토큰 펜싱은 `paper_auto_open`과 같은 모양)
3. `paperOrderFill.ts` — 순수 체결 판정 + 시험
4. 러너 배선: 전략이 **지정가 진입**을 내면 걸고, 다음 회차에 봉으로 체결 판정
5. 화면: 대기 주문 목록 + 취소 버튼 + 사유 표시
6. PG 시험: 봇당 하나 · 스치는 것은 체결 아님 · 자리 상한 · 취소 사유
7. `check-paper-orders.mjs` — 위 규칙을 배선으로 고정, 변이 자기점검

## 1차에서 하지 않는 것

- **그리드 (한 봇에 여러 주문)** — 유일 인덱스를 푸는 별도 단계
- **마켓 메이킹** — 양쪽에 동시 호가가 필요하고, 그건 그리드 다음이다
- **호가(depth) 수집** — 대기 주문이 먼저다. 체결 판정에 봉으로 충분하다
- **실거래소 지정가** — 모의 장부만이다. TESTNET/LIVE는 별도 승인 사항

## 모르는 것 (0이 아니라 모름)

- 보수적 체결 규칙(`스치는 것은 체결 아님`)이 실제와 얼마나 벌어지는지
  **모른다.** 실제 체결과 비교할 데이터가 없다. 방향만 안다 — 성적이
  실제보다 낮게 나온다.
- 이 세션은 `api.binance.com`에 닿지 못해(DNS 미해석) 모든 시험이 합성
  봉이다. 실제 1분봉에서 지정가가 얼마나 체결되는지는 돌려 봐야 안다.
