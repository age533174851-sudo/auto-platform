-- 104 · 봇마다 한 자리 — 계좌 전체 한도는 켜 둔 봇 수
--
-- 무엇이 막고 있었나
-- ──────────────────
-- 102가 봇을 여러 개 만들 수 있게 했지만, 자리 판정은 그대로 뒀다:
--
--   IF EXISTS(SELECT 1 FROM paper_positions p
--             WHERE p.paper_account_id=a.id AND p.status='open')
--     THEN SLOT_BUSY
--
-- **계좌 하나에 포지션 하나.** 그래서 BTC 봇과 ETH 봇을 둘 다 켜도, 먼저
-- 들어간 쪽이 닫히기 전에는 다른 쪽이 한 건도 못 연다. 봇을 여러 개 만들
-- 수 있게 해 놓고 **동시에 돌지는 못하는** 상태였다.
--
-- 102의 주석은 그걸 알고 미뤄 둔 것이다: "바꾸면 거래 정책이 바뀐다."
-- 맞는 말이고, 그래서 지금 바꾸는 것이 무엇인지 적어 둔다.
--
-- 무엇이 바뀌는가 — 정확히
-- ────────────────────────
--   전  계좌 전체에 열린 포지션 1개
--   후  ① 봇 하나는 자기 포지션을 하나만 연다
--       ② 계좌 전체로는 **켜 둔 봇 수**까지 (최소 1)
--
-- **봇이 하나면 전과 완전히 같다** (켜진 봇 1개 → 한도 1). 바뀌는 것은
-- 봇을 둘 이상 켰을 때뿐이고, 그건 사용자가 봇을 둘 켰다는 뜻이다.
--
-- 노출이 그만큼 늘어난다. 봇 2개를 켜면 같은 모의 계좌에서 동시에 2개를
-- 들 수 있고, 회차당 위험도 2배다. 숨기지 않는다 — 화면이 "동시 보유
-- 최대 N개"를 그대로 적는다.
--
-- 왜 ①이 필요한가 (②만으로는 부족하다)
-- ─────────────────────────────────────
-- ②만 두면 한 봇이 자리 두 개를 가져갈 수 있다. 그러면 전략별 성적표가
-- 깨진다 — 같은 전략이 동시에 둘을 들면 다른 전략과 비교가 안 된다.
-- 봇당 하나로 묶어야 "전략 하나당 한 번에 한 포지션"이 유지된다.
--
-- 수동 주문은 그대로 자리를 차지한다
-- ──────────────────────────────────
-- ②의 세는 대상은 `paper_positions`의 열린 것 **전부**다. 손으로 연
-- 포지션도 포함된다 — 기존 시험이 고정하고 있는 계약이고, 여기서 빼면
-- 사람이 연 포지션 위에 봇이 또 들어간다.
--
-- 경합은 나지 않는다
-- ──────────────────
-- 이 함수는 세기 전에 `paper_accounts`를 `FOR UPDATE`로 잡는다. 같은
-- 계좌에 대한 두 호출은 그 줄에서 줄을 선다. 수동 주문 경로
-- (`paper_open_position`)도 같은 줄을 잡는다.
--
-- 재적용 가능하다
-- ───────────────
-- `CREATE OR REPLACE FUNCTION` 하나뿐이다. `DROP`도 `ADD CONSTRAINT`도
-- 없다. 두 번 올려도 같은 결과다.

CREATE OR REPLACE FUNCTION public.paper_auto_open(p_run_id uuid,p_token uuid,p_order jsonb)
RETURNS TABLE(status text,position_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.paper_automation_settings%ROWTYPE; r public.paper_automation_runs%ROWTYPE; a public.paper_accounts%ROWTYPE; v record;
        v_cap integer; v_open integer;
BEGIN
  SELECT * INTO r FROM public.paper_automation_runs WHERE id=p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RETURN QUERY SELECT 'STALE_RUN'::text,NULL::uuid; RETURN; END IF;
  SELECT * INTO s FROM public.paper_automation_settings WHERE user_id=r.user_id AND bot_id=r.bot_id FOR UPDATE;
  IF NOT s.enabled OR s.generation<>r.generation OR r.state<>'CLAIMED' OR r.lease_token<>p_token OR r.lease_until<=clock_timestamp() THEN RETURN QUERY SELECT 'STALE_RUN'::text,NULL::uuid; RETURN; END IF;
  IF r.entry_position_id IS NOT NULL THEN RETURN QUERY SELECT 'DUPLICATE'::text,r.entry_position_id; RETURN; END IF;
  SELECT * INTO a FROM public.paper_accounts WHERE id=s.paper_account_id AND user_id=s.user_id FOR UPDATE;
  IF r.lease_until<=clock_timestamp() THEN RETURN QUERY SELECT 'STALE_RUN'::text,NULL::uuid; RETURN; END IF;
  IF NOT a.is_default OR a.started_at IS DISTINCT FROM s.account_started_at THEN RETURN QUERY SELECT 'ACCOUNT_CHANGED'::text,NULL::uuid; RETURN; END IF;

  -- ① **이 봇은 한 번에 하나만 든다.** 전략별 성적표가 비교 가능하려면
  --    같은 전략이 동시에 둘을 들면 안 된다.
  IF EXISTS(SELECT 1 FROM public.paper_positions p
            WHERE p.paper_account_id=a.id AND p.status='open' AND p.strategy_id=s.bot_id) THEN
    RETURN QUERY SELECT 'SLOT_BUSY'::text,NULL::uuid; RETURN;
  END IF;

  -- ② **계좌 전체 한도는 켜 둔 봇 수.** 봇이 하나면 1 — 전과 같다.
  --    `greatest(1, ...)`는 이 봇이 방금 꺼진 경우에도 0으로 내려가지
  --    않게 한다(위에서 `s.enabled`를 이미 확인했으므로 최소 1이 맞다).
  SELECT greatest(1,count(*)) INTO v_cap
    FROM public.paper_automation_settings x WHERE x.user_id=s.user_id AND x.enabled;
  -- 손으로 연 포지션도 센다. 빼면 사람이 연 자리 위에 봇이 또 들어간다.
  SELECT count(*) INTO v_open
    FROM public.paper_positions p WHERE p.paper_account_id=a.id AND p.status='open';
  IF v_open>=v_cap THEN RETURN QUERY SELECT 'SLOT_BUSY'::text,NULL::uuid; RETURN; END IF;

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

-- `CREATE OR REPLACE`는 기존 권한을 유지하지만, 이 파일만 올린 DB에서도
-- 맞도록 이 함수의 권한만 다시 적어 둔다. **서비스 롤만 부를 수 있다.**
REVOKE ALL ON FUNCTION public.paper_auto_open(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.paper_auto_open(uuid,uuid,jsonb) TO service_role;
