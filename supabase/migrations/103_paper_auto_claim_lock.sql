-- 103 · paper_auto_claim 동시 claim 경합 — 중복 방지와 잠금을 같은 것에 걸기
--
-- 무엇이 일어났나
-- ───────────────
-- 8개 동시 깨우기 중 **2개**가 같은 회차를 잡았다. 로컬 PostgreSQL 16에서
-- 40회 중 6회(15%) 재현된다. 099 스키마만 올려도, 102까지 올려도 같은
-- 비율이다 — 102가 고치지 않는다.
--
--   not ok - 8 simultaneous wakeups claim exactly one durable run
--     Expected values to be strictly equal:  2 !== 1
--
-- 왜 새는가
-- ─────────
-- 중복 방지 판단과 잠금이 **서로 다른 것**에 걸려 있었다:
--
--   · 판단: `paper_automation_runs`의 `NOT EXISTS` 서브쿼리
--   · 잠금: `paper_automation_settings` 행의 `FOR UPDATE ... SKIP LOCKED`
--
-- 이긴 트랜잭션은 settings 행을 **쓰지 않는다**(runs에 INSERT만 한다).
-- 그래서 뒤늦게 settings 잠금을 얻은 트랜잭션은 PostgreSQL의 재평가
-- (EvalPlanQual)를 강제받지 않고, 자기 스냅샷에서 "CLAIMED 회차 없음"이라는
-- **낡은 답**을 그대로 들고 관문을 통과한다.
--
-- 그다음 줄은 READ COMMITTED에서 **새 스냅샷**을 잡으므로 이번에는 회차를
-- 보고 `ELSE` 가지로 들어가 **새 `lease_token`을 발급**한다. 그래서 같은
-- 회차에 토큰이 두 번 나오고, 유일 인덱스는 위반되지 않는다(INSERT가
-- 아니므로).
--
-- 돈이 두 번 나가지는 않는다 — 그래도 가볍지 않다
-- ───────────────────────────────────────────────
-- `paper_auto_open`의 토큰 펜싱이 막는다. 문제는 **먼저 돌던 회차가 조용히
-- 취소된다는 것**이다. 시세를 읽고 국면을 판정하고 계획까지 세운 워커가,
-- 리스가 45초 멀쩡히 남았는데 뒤에 들어온 깨우기에게 회차를 빼앗긴다.
-- 그 회차는 로그에 `WAIT`으로만 남아서, 보고 있어도 보이지 않는다.
--
-- "크래시 뒤 같은 신호를 복구한다"는 `ELSE` 가지는 **리스 만료**를 전제로
-- 설계된 것이고, 경쟁 claim이 그 가지를 타는 것은 설계된 경로가 아니다.
--
-- 어떻게 고치나 — 이 파일이 이미 쓰는 방법으로
-- ────────────────────────────────────────────
-- `paper_auto_control`은 이미 사용자·봇 단위 권고 잠금을 먼저 잡는다:
--
--   PERFORM pg_advisory_xact_lock(hashtextextended('paper-auto:'||p_user_id::text||':'||p_bot_id,0));
--
-- claim에도 **같은 키**를 쓴다. 새 기전이 아니다.
--
-- 다만 claim은 "어느 봇을 잡을지"를 아직 모르므로, 후보를 고른 뒤 잠금을
-- 잡고 **조건을 다시 확인한다**. 이 재확인이 핵심이다:
--
--   · 이긴 쪽이 아직 커밋 전이면 그쪽이 권고 잠금을 들고 있으므로
--     `pg_try_advisory_xact_lock`이 실패한다 → 다음 후보로 넘어간다.
--   · 이긴 쪽이 커밋했으면 잠금은 풀렸고, 재확인 SELECT는 **새 스냅샷**에서
--     그 CLAIMED 회차를 본다 → 다음 후보로 넘어간다.
--
-- 즉 판단과 잠금이 드디어 **같은 것**(그 봇)에 걸린다.
--
-- 기다리지 않는다
-- ───────────────
-- `pg_try_advisory_xact_lock`(try)을 쓴다. 블로킹 잠금을 쓰면 깨우기 8개가
-- 줄을 서서 45초 리스를 기다리게 되고, 그건 `SKIP LOCKED`로 설계한 뜻을
-- 뒤집는다. 못 잡으면 **건너뛴다.**
--
-- 바뀌지 않는 것
-- ──────────────
-- 리스 45초 · `ELSE` 복구 가지 · 돌려주는 jsonb 모양(`bot_id` 포함) ·
-- 권한. `CREATE OR REPLACE`는 기존 권한을 유지하지만, 이 파일만 올린 DB에서도
-- 맞도록 `paper_auto_claim()`의 권한만 다시 적어 둔다.
--
-- 재적용 가능하다
-- ───────────────
-- `CREATE OR REPLACE FUNCTION`뿐이다. `ADD CONSTRAINT`도, `DROP`도 없다.
-- 두 번 올려도 같은 결과다 (#636에서 배운 것).

CREATE OR REPLACE FUNCTION public.paper_auto_claim()
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.paper_automation_settings%ROWTYPE; r public.paper_automation_runs%ROWTYPE;
BEGIN
  -- 후보를 **여러 개** 본다. 권고 잠금을 못 잡은 봇은 건너뛰고 다음을 보므로,
  -- LIMIT 1이면 "맨 앞 봇이 도는 동안 나머지가 전부 막히는" 일이 생긴다.
  FOR s IN
    SELECT a.* FROM public.paper_automation_settings a
    WHERE a.enabled AND a.next_run_at<=clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM public.paper_automation_runs b
                      WHERE b.user_id=a.user_id AND b.bot_id=a.bot_id AND b.state='CLAIMED' AND b.lease_until>clock_timestamp())
    ORDER BY a.next_run_at,a.user_id,a.bot_id
    FOR UPDATE OF a SKIP LOCKED LIMIT 32
  LOOP
    -- ① 이 봇을 잡는다. 못 잡으면 다른 깨우기가 지금 이 봇을 처리하는 중이다.
    --    기다리지 않고 넘어간다.
    IF NOT pg_try_advisory_xact_lock(hashtextextended('paper-auto:'||s.user_id::text||':'||s.bot_id,0)) THEN
      CONTINUE;
    END IF;

    -- ② **잠금을 잡은 뒤 다시 확인한다.** 위 서브쿼리는 이 문장보다 앞선
    --    스냅샷에서 평가됐을 수 있다 — 그 틈이 이 버그였다. 여기서 보는 것은
    --    새 스냅샷이고, 잠금을 들고 있던 쪽은 이미 커밋했다.
    IF EXISTS (SELECT 1 FROM public.paper_automation_runs b
               WHERE b.user_id=s.user_id AND b.bot_id=s.bot_id
                 AND b.state='CLAIMED' AND b.lease_until>clock_timestamp()) THEN
      CONTINUE;
    END IF;

    -- ③ 설정도 다시 읽는다. 잠금을 기다리는 사이 정지됐거나 세대가 올라갔으면
    --    그 봇은 지금 돌 대상이 아니다.
    SELECT a.* INTO s FROM public.paper_automation_settings a
    WHERE a.user_id=s.user_id AND a.bot_id=s.bot_id;
    IF s.user_id IS NULL OR NOT s.enabled OR s.next_run_at>clock_timestamp() THEN
      CONTINUE;
    END IF;

    SELECT * INTO r FROM public.paper_automation_runs WHERE user_id=s.user_id AND bot_id=s.bot_id AND state='CLAIMED' FOR UPDATE;
    IF r.id IS NULL THEN
      INSERT INTO public.paper_automation_runs(user_id,bot_id,generation,lease_until) VALUES(s.user_id,s.bot_id,s.generation,clock_timestamp()+interval '45 seconds') RETURNING * INTO r;
    ELSE
      -- 리스가 만료된 같은 신호를 새 펜싱 토큰으로 복구한다 (설계된 경로).
      UPDATE public.paper_automation_runs SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' WHERE id=r.id RETURNING * INTO r;
    END IF;
    RETURN NEXT to_jsonb(r)||jsonb_build_object('paper_account_id',s.paper_account_id,'symbol',s.symbol,'config',s.config,'bot_id',s.bot_id);
    RETURN;
  END LOOP;
  RETURN;
END $$;

REVOKE ALL ON FUNCTION public.paper_auto_claim() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.paper_auto_claim() TO service_role;
