-- Browser-independent PAPER runner. No exchange scheduler or live ledger changes.
-- Lock order: settings -> run -> existing paper account -> existing money RPC.
CREATE TABLE public.paper_automation_settings (
  user_id uuid PRIMARY KEY,
  paper_account_id uuid NOT NULL,
  account_started_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 1,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT','ETHUSDT')),
  interval_seconds integer NOT NULL CHECK (interval_seconds IN (60,300,900)),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (paper_account_id,user_id) REFERENCES public.paper_accounts(id,user_id)
);
CREATE INDEX paper_automation_due ON public.paper_automation_settings(next_run_at) WHERE enabled;
CREATE TABLE public.paper_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.paper_automation_settings(user_id),
  generation bigint NOT NULL,
  state text NOT NULL DEFAULT 'CLAIMED' CHECK (state IN ('CLAIMED','DONE','CANCELLED')),
  lease_token uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_until timestamptz NOT NULL,
  entry_position_id uuid REFERENCES public.paper_positions(id) ON DELETE SET NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX paper_automation_one_claim ON public.paper_automation_runs(user_id) WHERE state='CLAIMED';
CREATE INDEX paper_automation_history ON public.paper_automation_runs(user_id,created_at DESC);
ALTER TABLE public.paper_automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_automation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY paper_automation_settings_owner ON public.paper_automation_settings FOR SELECT TO authenticated USING (user_id=auth.uid());
CREATE POLICY paper_automation_runs_owner ON public.paper_automation_runs FOR SELECT TO authenticated USING (user_id=auth.uid());
CREATE POLICY paper_automation_settings_service ON public.paper_automation_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY paper_automation_runs_service ON public.paper_automation_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.paper_automation_settings,public.paper_automation_runs FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.paper_automation_settings,public.paper_automation_runs TO authenticated;
GRANT ALL ON public.paper_automation_settings,public.paper_automation_runs TO service_role;

CREATE OR REPLACE FUNCTION public.paper_auto_control(p_user_id uuid,p_enabled boolean,p_symbol text,p_interval integer,p_config jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE a public.paper_accounts%ROWTYPE; s public.paper_automation_settings%ROWTYPE;
BEGIN
  -- Serialize even first-ever start. Account lock is taken only after settings.
  PERFORM pg_advisory_xact_lock(hashtextextended('paper-auto:'||p_user_id::text,0));
  SELECT * INTO s FROM public.paper_automation_settings WHERE user_id=p_user_id FOR UPDATE;
  IF NOT p_enabled THEN
    UPDATE public.paper_automation_settings SET enabled=false,generation=generation+1,updated_at=clock_timestamp() WHERE user_id=p_user_id RETURNING * INTO s;
    UPDATE public.paper_automation_runs SET state='CANCELLED',finished_at=clock_timestamp(),result=jsonb_build_object('code','STOPPED','message','사용자가 서버 반복을 정지했습니다') WHERE user_id=p_user_id AND state='CLAIMED';
    RETURN jsonb_build_object('enabled',false);
  END IF;
  IF p_enabled IS NULL OR p_symbol NOT IN ('BTCUSDT','ETHUSDT') OR p_interval NOT IN (60,300,900) THEN RAISE EXCEPTION 'invalid PAPER automation settings'; END IF;
  SELECT * INTO a FROM public.paper_accounts WHERE user_id=p_user_id AND is_default FOR UPDATE;
  IF a.id IS NULL OR a.started_at IS NULL THEN RAISE EXCEPTION 'PAPER_ACCOUNT_NOT_STARTED'; END IF;
  -- Repeated Start does not revoke a running lease or cause an extra entry.
  IF s.enabled AND s.symbol=p_symbol AND s.interval_seconds=p_interval THEN RETURN to_jsonb(s)-'user_id'-'paper_account_id'; END IF;
  UPDATE public.paper_automation_runs SET state='CANCELLED',finished_at=clock_timestamp(),result=jsonb_build_object('code','RECONFIGURED') WHERE user_id=p_user_id AND state='CLAIMED';
  INSERT INTO public.paper_automation_settings(user_id,paper_account_id,account_started_at,enabled,symbol,interval_seconds,config)
  VALUES (p_user_id,a.id,a.started_at,true,p_symbol,p_interval,p_config)
  ON CONFLICT(user_id) DO UPDATE SET enabled=true,generation=paper_automation_settings.generation+1,
    paper_account_id=a.id,account_started_at=a.started_at,symbol=p_symbol,interval_seconds=p_interval,config=p_config,next_run_at=clock_timestamp(),updated_at=clock_timestamp()
  RETURNING * INTO s;
  RETURN to_jsonb(s)-'user_id'-'paper_account_id';
END $$;

CREATE OR REPLACE FUNCTION public.paper_auto_claim()
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.paper_automation_settings%ROWTYPE; r public.paper_automation_runs%ROWTYPE;
BEGIN
  SELECT a.* INTO s FROM public.paper_automation_settings a
  WHERE a.enabled AND a.next_run_at<=clock_timestamp()
    AND NOT EXISTS (SELECT 1 FROM public.paper_automation_runs b WHERE b.user_id=a.user_id AND b.state='CLAIMED' AND b.lease_until>clock_timestamp())
  ORDER BY a.next_run_at,a.user_id FOR UPDATE OF a SKIP LOCKED LIMIT 1;
  IF s.user_id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.paper_automation_runs WHERE user_id=s.user_id AND state='CLAIMED' FOR UPDATE;
  IF r.id IS NULL THEN
    INSERT INTO public.paper_automation_runs(user_id,generation,lease_until) VALUES(s.user_id,s.generation,clock_timestamp()+interval '45 seconds') RETURNING * INTO r;
  ELSE
    -- Same durable signal after a crash, with a new fencing token.
    UPDATE public.paper_automation_runs SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' WHERE id=r.id RETURNING * INTO r;
  END IF;
  RETURN NEXT to_jsonb(r)||jsonb_build_object('paper_account_id',s.paper_account_id,'symbol',s.symbol,'config',s.config);
END $$;

-- Fenced final write. Reuses the existing atomic fill/fee/ledger implementation.
CREATE OR REPLACE FUNCTION public.paper_auto_open(p_run_id uuid,p_token uuid,p_order jsonb)
RETURNS TABLE(status text,position_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.paper_automation_settings%ROWTYPE; r public.paper_automation_runs%ROWTYPE; a public.paper_accounts%ROWTYPE; v record;
BEGIN
  SELECT setting.* INTO s FROM public.paper_automation_settings setting WHERE setting.user_id=(SELECT b.user_id FROM public.paper_automation_runs b WHERE b.id=p_run_id) FOR UPDATE;
  SELECT * INTO r FROM public.paper_automation_runs WHERE id=p_run_id FOR UPDATE;
  IF r.id IS NULL OR NOT s.enabled OR s.generation<>r.generation OR r.state<>'CLAIMED' OR r.lease_token<>p_token OR r.lease_until<=clock_timestamp() THEN RETURN QUERY SELECT 'STALE_RUN'::text,NULL::uuid; RETURN; END IF;
  IF r.entry_position_id IS NOT NULL THEN RETURN QUERY SELECT 'DUPLICATE'::text,r.entry_position_id; RETURN; END IF;
  SELECT * INTO a FROM public.paper_accounts WHERE id=s.paper_account_id AND user_id=s.user_id FOR UPDATE;
  IF r.lease_until<=clock_timestamp() THEN RETURN QUERY SELECT 'STALE_RUN'::text,NULL::uuid; RETURN; END IF;
  IF NOT a.is_default OR a.started_at IS DISTINCT FROM s.account_started_at THEN RETURN QUERY SELECT 'ACCOUNT_CHANGED'::text,NULL::uuid; RETURN; END IF;
  -- Manual orders also lock this account in paper_open_position. Capacity cannot race.
  IF EXISTS(SELECT 1 FROM public.paper_positions p WHERE p.paper_account_id=a.id AND p.status='open') THEN RETURN QUERY SELECT 'SLOT_BUSY'::text,NULL::uuid; RETURN; END IF;
  IF p_order->>'p_symbol' IS DISTINCT FROM s.symbol OR p_order->>'p_market' IS DISTINCT FROM 'USDM'
    OR p_order->>'p_side' NOT IN ('LONG','SHORT') OR (p_order->>'p_stop_loss')::numeric IS NULL
    OR (p_order->>'p_leverage')::integer NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid PAPER entry'; END IF;
  SELECT * INTO v FROM public.paper_open_position(s.user_id,'paper-auto:'||r.id::text,'paper-auto-v1',NULL,s.symbol,'USDM',p_order->>'p_side',
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
  SELECT a.* INTO s FROM public.paper_automation_settings a WHERE a.user_id=(SELECT b.user_id FROM public.paper_automation_runs b WHERE b.id=p_run_id) FOR UPDATE;
  SELECT * INTO r FROM public.paper_automation_runs WHERE id=p_run_id FOR UPDATE;
  IF r.id IS NULL OR NOT s.enabled OR s.generation<>r.generation OR r.state<>'CLAIMED' OR r.lease_token<>p_token OR r.lease_until<=clock_timestamp() THEN RETURN false; END IF;
  IF octet_length(p_result::text)>8000 THEN RAISE EXCEPTION 'PAPER result too large'; END IF;
  IF r.entry_position_id IS NOT NULL THEN p_result:=p_result||jsonb_build_object('code','ENTERED','positionId',r.entry_position_id,'message','모의 장부에 체결했습니다'); END IF;
  UPDATE public.paper_automation_runs SET state='DONE',result=p_result,finished_at=clock_timestamp() WHERE id=r.id;
  UPDATE public.paper_automation_settings SET next_run_at=clock_timestamp()+make_interval(secs=>interval_seconds),updated_at=clock_timestamp() WHERE user_id=s.user_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.paper_auto_control(uuid,boolean,text,integer,jsonb),public.paper_auto_claim(),public.paper_auto_open(uuid,uuid,jsonb),public.paper_auto_finish(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.paper_auto_control(uuid,boolean,text,integer,jsonb),public.paper_auto_claim(),public.paper_auto_open(uuid,uuid,jsonb),public.paper_auto_finish(uuid,uuid,jsonb) TO service_role;
