# 거래소 파라미터 — 별도 증거 요청

이 문서는 **코드로 확인할 수 없고, 추측으로 채우면 안 되는 값**만 모은다.
여기 적힌 것이 채워지기 전까지 해당 경로는 `NOT_VERIFIED`로 남고, 그
상태에서 주문을 내지 않는다(`attempted: false`).

> 이 목록은 다른 작업의 **선행 조건이 아니다.** 감시·잠금·집계 수정은 이
> 값들과 무관하게 끝났다. 여기 있는 것은 "지금 막혀 있는 것"이 아니라
> "증거 없이는 켜지 않는 것"이다.

## 0. 왜 코드로 못 채우나

이 환경의 네트워크 정책이 아래 호스트로의 CONNECT를 거부한다
(2026-09-25 측정, `curl`·WebFetch 양쪽 동일):

| 호스트 | 결과 |
| --- | --- |
| `developers.binance.com:443` | `403 to CONNECT` (policy denial) |
| `www.gate.com:443` | `403 to CONNECT` |
| `fapi.binance.com:443` | `403 to CONNECT` |

이전에 같은 이유로 막힌 곳: `krx.co.kr`, `regulation.krx.co.kr`,
`support.upbit.com`, `bithumb.com`, `en.wikipedia.org`.

**우회하지 않는다.** 필요하면 환경 설정의 Network access에서 접근 수준을
넓히거나 위 호스트를 허용 목록에 넣는 것이 바른 길이다. 그 전까지는 아래
값을 사람이 한 번 붙여 주는 것으로 대신한다.

## 1. 양방향(HEDGE) 계좌의 종료 규격 — **P0**

지금 상태: `venuePositionOps.closeSymbolPosition`이 `futuresPositionMode`로
계좌 모드를 먼저 읽고, `HEDGE`면 **보내지 않는다**(`attempted: false`).
진입도 같은 이유로 막았다(`scalp/route.ts`) — 열 수는 있고 닫을 수는 없는
상태가 더 나쁘기 때문이다.

필요한 것:

1. Binance USDⓈ-M `POST /fapi/v1/order`에서 **`positionSide`가 필수인 조건**
   (Hedge Mode에서 `BOTH`가 거부되는지, `LONG`/`SHORT` 중 무엇을 줄이는
   방향으로 보내야 하는지)
2. Hedge Mode에서 `reduceOnly`가 **허용되는지 금지되는지**
   (One-way에서는 허용. Hedge에서 `reduceOnly`와 `positionSide`를 같이
   보내는 조합이 유효한지)
3. `closePosition=true`(또는 그에 해당하는 전량 종료 파라미터)가 Hedge
   Mode에서 동작하는지
4. 위 조합을 틀렸을 때 **거부되는지, 아니면 반대 방향 신규 진입이 되는지**
   — 후자면 이 경로는 증거 없이 절대 열 수 없다

증거 형식: 위 엔드포인트 공식 문서의 해당 문단 캡처 또는 인용 + URL.

## 2. `MARKET_LOT_SIZE`의 존재 보장 — P1

지금 상태: 스키마에 이 필터가 **있을 수 있다**는 것만 확인했다. 모든 심볼에
항상 있다는 근거는 없다. 그래서 없으면 시장가 격자만 `null`로 두고
`LOT_SIZE`로 대신 채우지 않는다.

필요한 것: `GET /fapi/v1/exchangeInfo`의 `filters`에서 `MARKET_LOT_SIZE`가
모든 심볼에 존재하는지, 또는 선택적인지에 대한 문서 문장.

## 3. 펀딩 수수료 — P1

지금 상태: 100X LIVE 경로에 펀딩이 **어디에도 모델링되어 있지 않다.**
이전 참고 자료의 "00/08/16시 고정"은 하드코딩할 수 없다고 판정했다.

필요한 것:

1. USDⓈ-M 펀딩 정산 간격이 심볼별로 다를 수 있는지, 그리고 현재 간격을
   **API로** 읽는 방법 (`GET /fapi/v1/fundingInfo` 또는 동등한 것)
2. `GET /fapi/v1/premiumIndex`의 `nextFundingTime` 의미 (정산 시각인지
   다음 갱신 시각인지)

시각을 코드에 적는 대신 **거래소에서 읽는다**는 것이 이 항목의 목표다.

## 4. 100배 청산 거리 — P1

지금 상태: 이 경로에서 청산가를 **계산하지 않는다.** `NO_FIXED_SL`에서는
`LIQUIDATION_DISTANCE` 체크리스트 항목이 제거된다
(`preTradeChecklist.ts:748`). 그래서 "0.5~0.6%"는 코드의 계약이 아니다.

필요한 것:

1. USDⓈ-M 유지증거금률(maintenance margin rate) 계층표를 **API로** 읽는
   방법 (`GET /fapi/v1/leverageBracket` 응답의 `maintMarginRatio` 해석)
2. `positionRisk`의 `liquidationPrice`가 **격리 모드에서** 그 심볼 하나만
   보고 계산되는지

이 둘이 있으면 청산 거리를 관측값으로 적을 수 있다. 없으면 계속
`UNKNOWN`으로 남기고 `0`으로 적지 않는다.

## 5. Gate 선물 종료 규격 — P2

Gate 현물 쪽 정밀도는 사용자가 공식 문서로 확정해 주었다
(`amount_precision` = 수량 정밀도, `precision` = 가격 정밀도).

필요한 것: Gate 선물에서 **전량 종료**를 보내는 방법
(`size: 0` + `close: true`가 정본인지, `reduce_only`와의 관계), 그리고
`quanto_multiplier`가 적용된 계약 수로 보낼 때의 반올림 방향.

## 6. 국내 거래소 — P3

Upbit·Bithumb의 추천(referral) 제도는 **공식 확인 전까지 `UNAVAILABLE` 또는
`NOT VERIFIED`로 둔다.** 할인율·추천 코드를 만들어 내지 않는다.
사용자 제공값으로 확정된 것은 Gate `VLUSVLXAAW`, Binance `978395966` 둘뿐이다.
