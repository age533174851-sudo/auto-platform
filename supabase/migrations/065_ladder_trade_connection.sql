-- 065_ladder_trade_connection.sql
--
-- **청산 감시가 거래를 어느 계좌에서 찾아야 하는지 몰랐다.**
--
-- 무엇이 없었나
-- ─────────────
-- `ladder_daily_trades`에는 `user_id`만 있고 **어느 연결로 들어간
-- 포지션인지**가 없다. 그래서 청산 감시(`/api/autotrade/exit-monitor`)는
-- 사용자의 활성 연결 중 하나를 이렇게 골랐다:
--
--     .eq('user_id', uid).eq('is_active', true).limit(1).maybeSingle()
--
-- 정렬도 없고 망 조건도 없다. 활성 연결이 둘 이상이면(바이낸스 테스트넷
-- + Gate 테스트넷처럼) **A 계좌에서 연 포지션을 B 계좌에서 찾는다.**
-- 그러면 조회가 "포지션 없음"으로 돌아오고, 트레일링도 시간 청산도
-- 그 포지션에 닿지 않는다. 조용히.
--
-- 이 저장소에는 "symbol만 보고 주문 소유권을 판단하지 않는다"는 규칙이
-- 있다. **user_id만 보고 연결을 판단하는 것도 같은 종류의 추측이다.**
--
-- 옛 행은 NULL로 남긴다
-- ─────────────────────
-- 이미 쌓인 행에 연결을 채워 넣지 않는다. 어느 연결이었는지 알 수
-- 없고, **모르는 것을 그럴듯한 값으로 채우는 것이 이 저장소가 반복해서
-- 당한 사고다.** 부르는 쪽은 NULL을 '모름'으로 읽고 예전처럼 사용자
-- 단위로 찾되, 그 사실을 기록에 남긴다.

ALTER TABLE public.ladder_daily_trades
  ADD COLUMN IF NOT EXISTS connection_id UUID;

-- 청산 감시는 status='OPEN'인 줄만 훑는다. 부분 인덱스로 충분하다.
CREATE INDEX IF NOT EXISTS ladder_daily_trades_open_conn_idx
  ON public.ladder_daily_trades (connection_id)
  WHERE status = 'OPEN';
