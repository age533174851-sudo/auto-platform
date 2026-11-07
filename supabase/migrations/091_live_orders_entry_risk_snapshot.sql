-- 091_live_orders_entry_risk_snapshot.sql
--
-- **진입 허가가 실제로 쓴 위험 좌표 두 개를 그 순간에 박아 둔다.**
--
-- 왜 칸이 필요한가
-- ────────────────
-- Exact100X 진입은 불변식 하나로 허가된다:
--
--     RAW 청산여유(%)  >  변동성 위험거리(%)
--     liquidationDistancePct > adverseDistancePct
--
-- 그런데 그 둘 다 **진입 시점에만 존재한다.** `adverseDistancePct`는
-- 신호의 ATR에서 왔고 `live_orders`에 칸이 없다(`NO_FIXED_SL`이라
-- `stop_loss`도 NULL이다). 청산여유도 마찬가지로 남지 않는다.
--
-- 그래서 포지션을 연 뒤에는 **그 불변식이 아직 성립하는지 물을 수 없다.**
-- 물으려면 둘 중 하나를 해야 하는데 둘 다 틀렸다:
--
--   · ATR을 지금 다시 잰다   → 변동성이 커지면 **기준 자체가 움직인다.**
--                              진입 때 허가한 위험 예산이 포지션을 가진
--                              뒤에 바뀌는 것이고, 그건 다른 전략이다.
--   · "몇 % 소진이면 위험"    → 아무도 고르지 않은 새 숫자가 필요하다.
--                              이 저장소가 계속 피해 온 그 숫자다.
--
-- 진입 당시의 값을 그대로 남기면 둘 다 필요 없다.
--
-- 두 칸의 뜻
-- ──────────
--   entry_adverse_distance_pct
--     진입 **허가 판정이 실제로 사용한** 변동성 위험 거리(%).
--     신호를 나중에 다시 계산한 값이 아니다 — 허가를 내린 바로 그 값이다.
--
--   entry_liquidation_distance_pct_raw
--     그 주문이 **얼마의 RAW 청산여유로 입장했는가**(%).
--     `headroomKind: 'RAW'`다. 비용을 반영한 EFFECTIVE가 아니다.
--
-- 전자는 "그때의 위험 예산", 후자는 "그때의 감사 좌표"다.
--
-- ★ 불변(immutable)이다
-- ─────────────────────
-- 진입 시점에 한 번 적히고 **다시 쓰지 않는다.** 갱신하는 코드를 만들지
-- 않는다 — 갱신하는 순간 "그때 무엇으로 허가했는가"라는 질문에 답할 수
-- 없게 되고, 이 칸의 존재 이유가 사라진다.
--
-- 기존 행에 미치는 영향
-- ─────────────────────
-- NULL로 남는다. **백필하지 않는다.**
--
-- 특히 **지금 ATR을 다시 계산해서 채우지 않는다.** 그 값은 진입 허가가
-- 쓴 값이 아니므로 거짓 기록이다. 0으로도 채우지 않는다 — 0은
-- "위험 거리가 0"으로 읽혀 어떤 청산여유든 통과시킨다.
--
-- NULL은 **UNKNOWN**이다. "위험이 없었다"가 아니다. 이 칸이 NULL인 행은
-- ⑤B의 adverse 판단에 **쓸 수 없는 행**이다. 다만 ⑤A의 4시간 TIME_EXIT은
-- 이 값을 보지 않으므로 **그대로 돈다** — 새 기록이 없다고 이미 검증된
-- 종료 권한까지 죽이지 않는다.
-- (078·090가 같은 이유로 백필하지 않았다.)
--
-- 왜 CHECK 제약을 걸지 않는가
-- ───────────────────────────
-- 090의 세 칸은 **조합 키**라 반쪽이면 나머지를 추측하게 된다. 이 둘은
-- 다르다 — 서로 독립된 관측값이고, 한쪽만 구해진 상황이 실제로 있을 수
-- 있다(청산여유는 쟀는데 ATR을 못 읽은 경우). 그때 저장을 통째로
-- 실패시키면 **구한 값까지 버리게 된다.** 읽는 쪽이 각각 NULL을 UNKNOWN
-- 으로 다루면 된다.

ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS entry_adverse_distance_pct double precision;

ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS entry_liquidation_distance_pct_raw double precision;

COMMENT ON COLUMN public.live_orders.entry_adverse_distance_pct IS
  '진입 허가 판정이 실제로 사용한 변동성 위험 거리(%). 불변 — 진입 시점에만 적히고 갱신하지 않는다. NULL은 UNKNOWN이며 "위험이 없었다"가 아니다. 백필 금지(지금 ATR을 다시 재면 허가가 쓴 값이 아니다).';

COMMENT ON COLUMN public.live_orders.entry_liquidation_distance_pct_raw IS
  '진입 당시 실제로 통과한 RAW 청산여유(%). headroomKind=RAW이며 비용 반영 EFFECTIVE가 아니다. 불변 — 갱신하지 않는다. NULL은 UNKNOWN이다.';
