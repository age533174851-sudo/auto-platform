# 지금 하던 일

새 세션에서 이어갈 때 이 파일부터 읽으면 된다.

## 방금 끝난 것 (main에 머지됨)

- **손절 되읽기** (`src/lib/engine/stopVerify.ts`) — 주문 낸 뒤 미체결 목록을
  실제로 읽어서 손절이 주문장에 남아 있는지 확인한다. `success`는 "거래소가
  200을 줬다"지 "주문이 살아 있다"가 아니다. 없으면 즉시 청산, **못 읽었으면
  청산 안 한다**(조회 한 번 실패로 멀쩡한 포지션을 닫으면 안 된다).
- **점검 무시** (`src/lib/engine/checkOverride.ts`) — 점검이 막으면 무엇이
  막았는지 보여주고 "네/아니요"를 묻는다. 한 주문 한 번, 항목을 하나하나
  지목, 손실 한도·연패 잠금은 못 넘김. 넘긴 것은 `safety_events`에
  `status='waived'`로 남는다.
- **로그인 유지** (`src/lib/auth/authToken.ts`) — 터미널이 토큰을 한 번 읽고
  계속 들고 있어서 1시간 뒤 전부 401이 됐다. 이제 갱신·앱 복귀·포커스마다
  다시 읽는다. **확인 못 한 것을 로그아웃으로 읽지 않는다.**

## 지금 하는 것 — 주식·ETF 붙이기

한국투자증권(KIS) Open API. **모의투자부터.**

### 끝남
- `src/lib/markets/marketHours.ts` + 테스트 — 장 시간 판정.
  한국 09:00–15:30 / 미국 09:30–16:00(현지). 서머타임은 Intl이 처리한다 —
  손으로 계산하면 반년이 틀린다. 시간대를 못 읽으면 열림이 아니라 UNKNOWN.
  공휴일 목록은 안 들고 있고 `holidaysKnown: false`로 그 사실을 적는다.

### 다음
1. **KIS 어댑터** (`src/lib/exchanges/kis.ts`)
   - 실전 `https://openapi.koreainvestment.com:9443`
   - 모의 `https://openapivts.koreainvestment.com:29443`
   - 토큰: `POST /oauth2/tokenP` — **24시간짜리고 재발급 횟수 제한이 있다.
     반드시 DB에 캐시한다.** 매 요청마다 새로 받으면 금방 막힌다.
   - 주문: `POST /uapi/domestic-stock/v1/trading/order-cash`
     tr_id 실전 매수 `TTTC0802U` / 매도 `TTTC0801U`,
     모의는 앞글자가 `V` (`VTTC0802U` / `VTTC0801U`)
   - 잔고: `GET /uapi/domestic-stock/v1/trading/inquire-balance` — `TTTC8434R`
   - 현재가: `GET /uapi/domestic-stock/v1/quotations/inquire-price` —
     `FHKST01010100`
   - **TR ID가 틀리면 조용히 실패하지 않게** 응답 코드를 그대로 메시지에 싣는다.
2. **`MarketKind`에 `STOCK` 추가** (`src/lib/engine/preTradeChecklist.ts`)
   - 청산가·마진모드·레버리지 검사는 주식 현물에 **해당 없음** → 목록에서 뺀다
     (`pass`로 적으면 확인한 적 없는 것을 확인했다고 적는 셈이다)
   - **장 시간 검사를 추가한다** — 이게 주식의 새 관문이다
3. 연결 저장(`exchange_connections`)에 KIS 추가 — 앱키·시크릿·계좌번호(CANO)
4. 화면: 시장 탭에 주식 추가

### 사용자가 해야 할 것
- [KIS Developers](https://apiportal.koreainvestment.com)에서 **모의투자 신청 +
  앱키/시크릿 발급**. 실계좌 없이도 된다.
- 키는 **채팅에 붙여넣지 말 것.** Vercel 환경변수에 직접 넣는다.

## 아직 남은 숙제
- 마이그레이션 024~027 적용 여부 확인 (`RUN_PENDING.sql`)
- 설정 슬라이더 — 37개 중 1개만 `SliderField`로 바꿈
- AI 추천 기록 확장 (목표가·손절가·보유기간·적중률 화면)
- **제일 큰 구멍**: Gate 선물 / Gate 현물 / COIN-M에 소액 실거래 한 번씩
  넣어서 손절이 실제로 거래소에 걸리는지 확인 (테스트로는 절대 못 잡는다)
