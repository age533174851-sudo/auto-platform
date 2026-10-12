# TESTNET 최소 수량 실측 계획 (실행 전 승인 필요)

## 왜 실측이 필요한가 — `newOrderRespType` 하나 때문이다

`placeFuturesOrder`는 `newOrderRespType`을 **지정하지 않는다**
(`binanceFutures.ts:1203~1214`, 저장소 전체에 그 파라미터가 없다 — 주석
두 곳에만 언급된다). 그래서 응답 모양이 **거래소 기본값**에 달려 있다.

| 응답 유형 | 담기는 것 | 우리 코드가 받는 결과 |
|---|---|---|
| `ACK` | `orderId`·`symbol`·`status`만 | `executedQty` 없음 → `fillFactsOf`가 `filledQty: null` → 장부 `ACKED` |
| `RESULT` | `status`·`executedQty`·`avgPrice` 포함 | 즉시 체결이면 장부 `FILLED` + 실제 수량 |

**둘 다 안전하다**(증거가 없으면 ACKED로 남는다). 모르는 것은 "시장가가
즉시 체결됐는데 ACK만 와서 `ACKED`로 남는 빈도"다. 그 빈도가 높으면
대조가 매번 한 바퀴 더 돌고, 그동안 계좌 용량 관문이 15분 창 동안 다음
진입을 막는다. 즉 **안전 문제가 아니라 가동률 문제**이고, 응답 한 건을
보면 끝난다.

실측 없이 `newOrderRespType: 'RESULT'`를 넣지 않는 이유: 실주문 요청
모양을 바꾸는 것이고, 표본 0건에서 바꾸면 무엇이 달라졌는지 비교할
기준이 없다.

## 실행 전 확인 (주문 0건으로 가능)

1. **연결·권한** — `exchange_connections`에 `is_testnet = true`,
   `has_withdrawal = false`, `perm_trading = true`인 줄이 있는가.
   출금 권한 키는 코드가 이미 거부한다(`withdrawal_key_blocked`).
2. **호스트** — 테스트넷 선물은 `demo-fapi.binance.com`이다
   (`binanceBase({futures:true, testnet:true})`). `demo-api.binance.com`은
   이름만 데모이고 실전과 같은 거래소다 — 이 구분이 깨지면 실제 돈이다.
3. **시계** — `/fapi/v1/time`과 로컬 차이가 recvWindow(5,000ms) 안인가.
   벗어나면 `-1021`이 **주문을 보낸 뒤에** 돌아온다.
4. **잔고** — 테스트넷 USDⓈ-M 지갑에 증거금이 있는가.
5. **최소 주문** — `exchangeInfo`의 `LOT_SIZE.minQty`와
   `MIN_NOTIONAL.notional`. BTCUSDT 선물은 통상 `minQty 0.001`,
   `minNotional 5 USDT`다. **값은 조회로 확인한다** — 코드가 기본값을
   만들어내지 않으므로(`getSymbolFilters`) 못 읽으면 주문이 막힌다.
6. **포지션·미체결 0 확인** — `/fapi/v2/positionRisk`와
   `/fapi/v1/openOrders`가 둘 다 0이어야 시작한다. 하나라도 있으면
   용량 관문이 막고, 그게 맞다.

## 주문 설계

| 항목 | 값 | 이유 |
|---|---|---|
| 심볼 | `BTCUSDT` | 규격·유동성이 가장 확실하다 |
| 방향 | `BUY` (LONG) | — |
| 유형 | `MARKET` | `newOrderRespType` 질문의 대상이 시장가 즉시 체결이다 |
| 수량 | `minQty` **정확히** (조회값) | 최소. 반올림은 `quantizeOrder`가 한다 |
| 레버리지 | **1배** | ★ Exact100X 계약을 쓰지 않는다. 100배는 응답 모양과 무관하고, 최소 수량에 100배를 걸 이유가 없다 |
| 마진 | `isolated` | 교차면 한 종목 손실이 지갑 전체로 번진다 |
| 멱등 키 | 고정 `clientOrderId` 1개 | 재시도해도 같은 주문이다 |
| 보호주문 | **걸지 않는다** (`protectionPolicy: 'NONE'`) | 즉시 종료하므로 손절이 필요 없다. 대신 아래 종료 절차를 **반드시** 수행한다 |

## 절차 (각 단계의 증거를 남긴다)

1. 전 상태 기록 — 포지션·미체결·지갑 잔고 (3건 조회)
2. 주문 1건 전송 (`executeOrder`, `mode: 'TESTNET'`)
3. **응답 원문의 키 목록을 기록** — `executedQty`·`avgPrice`·`status`가
   있는가. **이것이 실측의 목적이다.** 값은 기록하되 키·서명은 남기지
   않는다(지문 규칙).
4. 장부 줄 확인 — `status`·`filled_qty`·`avg_price`가 응답과 모순 없는가
5. 포지션 재조회 — 실제로 열렸는가, 수량이 일치하는가
6. **즉시 종료** — `reduceOnly` 시장가로 전량 청산
7. 종료 후 재조회 — 포지션 0, 미체결 0을 **확인**한다. 0으로 적지 않고
   확인한다
8. 대조 1회 실행 — `reconcilePendingOrders`가 남은 줄을 어떻게 처리하는가
9. 삼자 대조 — 거래소 거래 내역 · 장부 줄 · 응답 원문 셋이 같은 수량·
   같은 가격을 말하는가

## 중단·금지 조건

- **재전송 금지**: 어느 단계든 타임아웃·연결 끊김이면 **같은 주문을 다시
  보내지 않는다.** `unknownResultVerdict`가 UNKNOWN을 주고, 그 뒤는 조회로만
  확정한다(`reconcileDecision`이 `mayResend: false`).
- 포지션이 예상과 다르면 **추가 주문 없이 중단**하고 보고한다.
- 종료가 확인되지 않으면(7단계 실패) 거래소 화면에서 사람이 직접 확인한다.
  자동으로 또 닫지 않는다 — 반대 포지션이 열린다.
- 1건으로 끝낸다. 통계를 내려고 반복하지 않는다.

## 필요한 승인 (셋)

1. **TESTNET 실주문 1건 집행 승인** — 위 설계 그대로
2. 테스트넷 연결의 거래 권한이 켜져 있다는 확인 (사용자만 할 수 있다)
3. 결과에 따라 `newOrderRespType`을 지정할지에 대한 **후속 판단**
   (응답에 체결 증거가 없으면 지정 쪽이 유리하고, 그 변경은 별도 PR이다)

## 이 컨테이너에서 할 수 없는 것

DB·거래소 자격증명이 없고 프로덕션 엔드포인트는 프록시가 막는다. 그래서
1~9단계는 **운영 환경에서** 실행해야 하고, 그 실행 자체가 승인 대상이다.
