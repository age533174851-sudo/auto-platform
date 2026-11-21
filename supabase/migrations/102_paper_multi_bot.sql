-- 모의 자동매매를 **봇 단위**로 바꾼다. 사용자당 하나였다.
--
-- 왜
-- ──
-- 099는 `paper_automation_settings`의 기본키를 `user_id`로 잡았다. 그래서
-- 사용자 한 명이 봇을 **하나만** 돌릴 수 있다. 전략을 몇 개 만들든 모의
-- 장부에는 한 전략의 기록만 쌓이고, "어느 전략이 나은가"를 물을 수 없다.
--
-- 전략 라이브러리는 이미 있다(추세·역추세·돌파·그리드·공포지수 DCA·스캘핑).
-- 판정 규율도 이미 있다(`edgeTypes.ts`의 MeasuredEdge · MIN_TRADES 100 ·
-- MIN_OOS_TRADES 30). **없는 것은 여러 봇을 동시에 돌릴 자리뿐이다.**
--
-- 무엇을 바꾸나
-- ─────────────
--   · `bot_id`를 두 표에 더한다. 기본값은 `paper-auto-v1` —
--     **지금 돌고 있는 봇이 그대로 이어진다.**
--   · 기본키를 `(user_id, bot_id)`로 바꾼다.
--   · 한 번에 한 회차 제약을 **봇마다**로 바꾼다. 예전에는 사용자마다였다.
--   · RPC 넷을 봇을 받도록 바꾼다.
--
-- `bot_id`가 곧 전략 식별자다. 진입할 때 `paper_positions.strategy_id`로
-- 들어가므로, 닫힌 거래를 전략별로 모을 수 있게 된다 — 점수판의 전제다.
--
-- ★ 재적용 가능하다 (#636)
-- ★ 돌고 있는 봇을 멈추지 않는다 — 기존 행은 `paper-auto-v1`이 된다
-- ★ 거래 정책을 바꾸지 않는다. 진입 조건·손절·배율에 손대지 않는다

-- ── 1. bot_id ──
ALTER TABLE public.paper_automation_settings
  ADD COLUMN IF NOT EXISTS bot_id text NOT NULL DEFAULT 'paper-auto-v1';
ALTER TABLE public.paper_automation_runs
  ADD COLUMN IF NOT EXISTS bot_id text NOT NULL DEFAULT 'paper-auto-v1';

-- 빈 이름이나 공백으로 봇을 만들 수 없다. 식별자는 장부에 그대로 들어간다.
ALTER TABLE public.paper_automation_settings DROP CONSTRAINT IF EXISTS paper_automation_settings_bot_id_shape;
ALTER TABLE public.paper_automation_settings ADD CONSTRAINT paper_automation_settings_bot_id_shape
  CHECK (bot_id ~ '^[a-z0-9][a-z0-9-]{1,62}$');

-- ── 2. 기본키를 봇 단위로 ──
-- 자식 FK가 기본키를 붙잡고 있으므로 먼저 전부 떼어야 한다.
--
-- **둘 다 지운다.** 처음에는 옛 이름(`..._user_id_fkey`)만 지웠는데, 두 번째
-- 적용에서는 이미 새 이름(`..._bot_fkey`)이 붙어 있어 기본키를 못 떼고
-- `cannot drop constraint ... because other objects depend on it`으로 죽었다.
-- 재적용 시험이 그것을 잡았다 — #636이 가르친 자리다.
ALTER TABLE public.paper_automation_runs DROP CONSTRAINT IF EXISTS paper_automation_runs_user_id_fkey;
ALTER TABLE public.paper_automation_runs DROP CONSTRAINT IF EXISTS paper_automation_runs_bot_fkey;
ALTER TABLE public.paper_automation_settings DROP CONSTRAINT IF EXISTS paper_automation_settings_pkey;
ALTER TABLE public.paper_automation_settings ADD CONSTRAINT paper_automation_settings_pkey
  PRIMARY KEY (user_id, bot_id);
ALTER TABLE public.paper_automation_runs DROP CONSTRAINT IF EXISTS paper_automation_runs_bot_fkey;
ALTER TABLE public.paper_automation_runs ADD CONSTRAINT paper_automation_runs_bot_fkey
  FOREIGN KEY (user_id, bot_id) REFERENCES public.paper_automation_settings(user_id, bot_id);

-- ── 3. "한 번에 한 회차"를 봇마다로 ──
--
-- 예전 인덱스는 `(user_id) WHERE state='CLAIMED'`였다. 그대로 두면 봇이
-- 둘일 때 **한 봇이 돌면 나머지가 영원히 못 돈다.** 이 줄이 다중화의 핵심이다.
DROP INDEX IF EXISTS public.paper_automation_one_claim;
CREATE UNIQUE INDEX IF NOT EXISTS paper_automation_one_claim_bot
  ON public.paper_automation_runs(user_id, bot_id) WHERE state='CLAIMED';
CREATE INDEX IF NOT EXISTS paper_automation_history_bot
  ON public.paper_automation_runs(user_id, bot_id, created_at DESC);

COMMENT ON COLUMN public.paper_automation_settings.bot_id IS
  'Bot identity and strategy id. Enters paper_positions.strategy_id so closed trades group by strategy.';

-- ── 4. RPC 넷을 봇 단위로 ──
--
-- 옛 5인자 서명은 **얇은 래퍼로 남긴다.** 지우면 아직 그것을 부르는
-- 코드(`/api/paper/automation`)가 그 순간 깨진다. 그 파일은 지금 열린
-- PR 둘(#525 · #504)이 잡고 있어 여기서 함께 고칠 수 없다.
--
-- 래퍼는 **판단을 갖지 않는다.** 봇 이름 기본값만 채우고 본체를 부른다 —
-- 그래서 "경로가 둘"이 아니라 입구가 둘이고 판단은 하나다.
DROP FUNCTION IF EXISTS public.paper_auto_claim();

CREATE OR REPLACE FUNCTION public.paper_auto_control(p_user_id uuid,p_bot_id text,p_enabled boolean,p_symbol text,p_interval integer,p_config jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE a public.paper_accounts%ROWTYPE; s public.paper_automation_settings%ROWTYPE;
BEGIN
  IF p_bot_id IS NULL OR p_bot_id !~ '^[a-z0-9][a-z0-9-]{1,62}$' THEN RAISE EXCEPTION 'invalid bot id'; END IF;
  -- 잠금도 봇마다다. 다른 봇을 켜는 일이 서로를 기다리지 않는다.
  PERFORM pg_advisory_xact_lock(hashtextextended('paper-auto:'||p_user_id::text||':'||p_bot_id,0));
  SELECT * INTO s FROM public.paper_automation_settings WHERE user_id=p_user_id AND bot_id=p_bot_id FOR UPDATE;
  IF NOT p_enabled THEN
    UPDATE public.paper_automation_settings SET enabled=false,generation=generation+1,updated_at=clock_timestamp()
      WHERE user_id=p_user_id AND bot_id=p_bot_id RETURNING * INTO s;
    UPDATE public.paper_automation_runs SET state='CANCELLED',finished_at=clock_timestamp(),result=jsonb_build_object('code','STOPPED','message','사용자가 서버 반복을 정지했습니다')
      WHERE user_id=p_user_id AND bot_id=p_bot_id AND state='CLAIMED';
    RETURN jsonb_build_object('enabled',false,'botId',p_bot_id);
  END IF;
  IF p_enabled IS NULL OR p_symbol NOT IN ('BTCUSDT','ETHUSDT') OR p_interval NOT IN (60,300,900) THEN RAISE EXCEPTION 'invalid PAPER automation settings'; END IF;
  SELECT * INTO a FROM public.paper_accounts WHERE user_id=p_user_id AND is_default FOR UPDATE;
  IF a.id IS NULL OR a.started_at IS NULL THEN RAISE EXCEPTION 'PAPER_ACCOUNT_NOT_STARTED'; END IF;
  IF s.enabled AND s.symbol=p_symbol AND s.interval_seconds=p_interval THEN RETURN to_jsonb(s)-'user_id'-'paper_account_id'; END IF;
  UPDATE public.paper_automation_runs SET state='CANCELLED',finished_at=clock_timestamp(),result=jsonb_build_object('code','RECONFIGURED')
    WHERE user_id=p_user_id AND bot_id=p_bot_id AND state='CLAIMED';
  INSERT INTO public.paper_automation_settings(user_id,bot_id,paper_account_id,account_started_at,enabled,symbol,interval_seconds,config)
  VALUES (p_user_id,p_bot_id,a.id,a.started_at,true,p_symbol,p_interval,p_config)
  ON CONFLICT(user_id,bot_id) DO UPDATE SET enabled=true,generation=paper_automation_settings.generation+1,
    paper_account_id=a.id,account_started_at=a.started_at,symbol=p_symbol,interval_seconds=p_interval,config=p_config,next_run_at=clock_timestamp(),updated_at=clock_timestamp()
  RETURNING * INTO s;
  RETURN to_jsonb(s)-'user_id'-'paper_account_id';
END $$;

-- 옛 입구. 봇 이름만 채우고 본체로 넘긴다. 판단은 본체에만 있다.
CREATE OR REPLACE FUNCTION public.paper_auto_control(p_user_id uuid,p_enabled boolean,p_symbol text,p_interval integer,p_config jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.paper_auto_control(p_user_id,'paper-auto-v1',p_enabled,p_symbol,p_interval,p_config);
$$;

CREATE OR REPLACE FUNCTION public.paper_auto_claim()
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.paper_automation_settings%ROWTYPE; r public.paper_automation_runs%ROWTYPE;
BEGIN
  SELECT a.* INTO s FROM public.paper_automation_settings a
  WHERE a.enabled AND a.next_run_at<=clock_timestamp()
    AND NOT EXISTS (SELECT 1 FROM public.paper_automation_runs b
                    WHERE b.user_id=a.user_id AND b.bot_id=a.bot_id AND b.state='CLAIMED' AND b.lease_until>clock_timestamp())
  ORDER BY a.next_run_at,a.user_id,a.bot_id FOR UPDATE OF a SKIP LOCKED LIMIT 1;
  IF s.user_id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.paper_automation_runs WHERE user_id=s.user_id AND bot_id=s.bot_id AND state='CLAIMED' FOR UPDATE;
  IF r.id IS NULL THEN
    INSERT INTO public.paper_automation_runs(user_id,bot_id,generation,lease_until) VALUES(s.user_id,s.bot_id,s.generation,clock_timestamp()+interval '45 seconds') RETURNING * INTO r;
  ELSE
    UPDATE public.paper_automation_runs SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' WHERE id=r.id RETURNING * INTO r;
  END IF;
  RETURN NEXT to_jsonb(r)||jsonb_build_object('paper_account_id',s.paper_account_id,'symbol',s.symbol,'config',s.config,'bot_id',s.bot_id);
END $$;

-- open·finish는 서명이 그대로다. 안에서 봇으로 찾는다.
CREATE OR REPLACE FUNCTION public.paper_auto_open(p_run_id uuid,p_token uuid,p_order jsonb)
RETURNS TABLE(status text,position_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.paper_automation_settings%ROWTYPE; r public.paper_automation_runs%ROWTYPE; a public.paper_accounts%ROWTYPE; v record;
BEGIN
  SELECT * INTO r FROM public.paper_automation_runs WHERE id=p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RETURN QUERY SELECT 'STALE_RUN'::text,NULL::uuid; RETURN; END IF;
  SELECT * INTO s FROM public.paper_automation_settings WHERE user_id=r.user_id AND bot_id=r.bot_id FOR UPDATE;
  IF NOT s.enabled OR s.generation<>r.generation OR r.state<>'CLAIMED' OR r.lease_token<>p_token OR r.lease_until<=clock_timestamp() THEN RETURN QUERY SELECT 'STALE_RUN'::text,NULL::uuid; RETURN; END IF;
  IF r.entry_position_id IS NOT NULL THEN RETURN QUERY SELECT 'DUPLICATE'::text,r.entry_position_id; RETURN; END IF;
  SELECT * INTO a FROM public.paper_accounts WHERE id=s.paper_account_id AND user_id=s.user_id FOR UPDATE;
  IF r.lease_until<=clock_timestamp() THEN RETURN QUERY SELECT 'STALE_RUN'::text,NULL::uuid; RETURN; END IF;
  IF NOT a.is_default OR a.started_at IS DISTINCT FROM s.account_started_at THEN RETURN QUERY SELECT 'ACCOUNT_CHANGED'::text,NULL::uuid; RETURN; END IF;
  -- **자리 다툼은 봇마다가 아니라 계좌마다다.** 모의 계좌 하나에 포지션
  -- 하나라는 기존 계약을 바꾸지 않는다 — 바꾸면 거래 정책이 바뀐다.
  IF EXISTS(SELECT 1 FROM public.paper_positions p WHERE p.paper_account_id=a.id AND p.status='open') THEN RETURN QUERY SELECT 'SLOT_BUSY'::text,NULL::uuid; RETURN; END IF;
  IF p_order->>'p_symbol' IS DISTINCT FROM s.symbol OR p_order->>'p_market' IS DISTINCT FROM 'USDM'
    OR p_order->>'p_side' NOT IN ('LONG','SHORT') OR (p_order->>'p_stop_loss')::numeric IS NULL
    OR (p_order->>'p_leverage')::integer NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid PAPER entry'; END IF;
  SELECT * INTO v FROM public.paper_open_position(s.user_id,'paper-auto:'||r.id::text,s.bot_id,NULL,s.symbol,'USDM',p_order->>'p_side',
    (p_order->>'p_entry_price')::numeric,(p_order->>'p_fill_price')::numeric,(p_order->>'p_quantity')::numeric,
    (p_order->>'p_notional')::numeric,(p_order->>'p_leverage')::integer,(p_order->>'p_margin')::numeric,
    (p_order->>'p_stop_loss')::numeric,(p_order->>'p_take_profit')::numeric,(p_order->>'p_liquidation_price')::numeric,
    (p_order->>'p_entry_fee')::numeric,'ISOLATED',clock_timestamp(),a.id);
  IF v.status IN ('OPENED','DUPLICATE') THEN UPDATE public.paper_automation_runs SET entry_position_id=v.position_id WHERE id=r.id; END IF;
  RETURN QUERY SELECT v.status::text,v.position_id::uuid;
END $$;

CREATE OR REPLACE FUNCTION public.paper_auto_finish(p_run_id uuid,p_token uuid,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.paper_automation_settings%ROWTYPE; r public.paper_automation_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.paper_automation_runs WHERE id=p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO s FROM public.paper_automation_settings WHERE user_id=r.user_id AND bot_id=r.bot_id FOR UPDATE;
  IF NOT s.enabled OR s.generation<>r.generation OR r.state<>'CLAIMED' OR r.lease_token<>p_token OR r.lease_until<=clock_timestamp() THEN RETURN false; END IF;
  IF octet_length(p_result::text)>8000 THEN RAISE EXCEPTION 'PAPER result too large'; END IF;
  IF r.entry_position_id IS NOT NULL THEN p_result:=p_result||jsonb_build_object('code','ENTERED','positionId',r.entry_position_id,'message','모의 장부에 체결했습니다'); END IF;
  UPDATE public.paper_automation_runs SET state='DONE',result=p_result,finished_at=clock_timestamp() WHERE id=r.id;
  UPDATE public.paper_automation_settings SET next_run_at=clock_timestamp()+make_interval(secs=>interval_seconds),updated_at=clock_timestamp()
    WHERE user_id=s.user_id AND bot_id=s.bot_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.paper_auto_control(uuid,text,boolean,text,integer,jsonb),public.paper_auto_control(uuid,boolean,text,integer,jsonb),public.paper_auto_claim(),public.paper_auto_open(uuid,uuid,jsonb),public.paper_auto_finish(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.paper_auto_control(uuid,text,boolean,text,integer,jsonb),public.paper_auto_control(uuid,boolean,text,integer,jsonb),public.paper_auto_claim(),public.paper_auto_open(uuid,uuid,jsonb),public.paper_auto_finish(uuid,uuid,jsonb) TO service_role;
