-- Preserve 099 history; fix the post-lock lease race observed in native CI.
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
  -- The candidate SELECT owns an earlier statement snapshot. Another
  -- transaction may have committed a lease before we acquired these locks.
  -- Recheck the locked, current run before rotating a fencing token.
  IF r.id IS NOT NULL AND r.lease_until>clock_timestamp() THEN RETURN; END IF;
  IF r.id IS NULL THEN
    INSERT INTO public.paper_automation_runs(user_id,generation,lease_until) VALUES(s.user_id,s.generation,clock_timestamp()+interval '45 seconds') RETURNING * INTO r;
  ELSE
    -- Same durable signal after a crash, with a new fencing token.
    UPDATE public.paper_automation_runs SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' WHERE id=r.id RETURNING * INTO r;
  END IF;
  RETURN NEXT to_jsonb(r)||jsonb_build_object('paper_account_id',s.paper_account_id,'symbol',s.symbol,'config',s.config);
END $$;
REVOKE ALL ON FUNCTION public.paper_auto_claim() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.paper_auto_claim() TO service_role;
