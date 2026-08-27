-- 068: 거래가 **어느 연결에서** 열렸는지 남긴다
--
-- 청산 감시는 거래마다 계좌를 이렇게 골랐다:
--
--   .eq('user_id', uid).eq('is_active', true).limit(1).maybeSingle()
--
-- 거래를 보지 않는다. 바이낸스 테스트넷과 Gate 테스트넷을 둘 다 연결해
-- 두면 Gate 포지션의 트레일링을 바이낸스 봉으로 계산하고 **청산 주문도
-- 바이낸스로** 나간다. 고를 근거가 표에 없었기 때문이다.
--
-- ADDITIVE 전용이다. 기존 줄은 NULL로 남고, 읽는 쪽이 그것을 "모름"으로
-- 다룬다(활성 연결이 하나뿐이면 그 하나, 여럿이면 손대지 않는다).
ALTER TABLE public.ladder_daily_trades
  ADD COLUMN IF NOT EXISTS connection_id UUID;

-- 감시는 status='OPEN'만 훑는다. 그 안에서 연결로 다시 가른다.
CREATE INDEX IF NOT EXISTS ladder_daily_trades_open_conn_idx
  ON public.ladder_daily_trades (status, connection_id);
