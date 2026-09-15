-- 087_paper_challenge_cancel.sql
--
-- **사용자가 챌린지를 그만둔다 — 그런데 돈은 여기서 움직이지 않는다.**
--
-- 무엇이 없었나
-- ─────────────
-- `083`이 `CANCELLED`를 사유 목록에 넣어 두었고, `086`의 스윕은 `EXPIRED`만
-- 만든다. 즉 **사용자가 스스로 끝내는 길이 한 줄도 없었다.** 사유는 있는데
-- 그 사유를 적을 수 있는 자리가 없는 상태다 — 이 저장소가 반복해서 겪은
-- "만들어 놓고 배선을 안 함"이다.
--
-- 왜 API가 아니라 함수인가
-- ────────────────────────
-- 취소는 "상태를 CLOSING으로 바꾼다" 한 줄이 아니다. 계좌와 챌린지를 같은
-- 순서로 잠그고, 이미 정해진 사유가 있으면 **덮지 않고 물러나야** 한다.
-- 그 판단이 라우트에 있으면 워커·스윕과 다른 트랜잭션 경계에서 돌고,
-- 그러면 만료와 취소가 서로를 덮는다.
--
-- **여기서 돈을 만들지 않는다**
-- ─────────────────────────────
-- 잔고 UPDATE도, `paper_challenge_cashflows` INSERT도, 포지션 청산도 없다.
-- 이 함수가 하는 일은 **사유를 CANCELLED로 얼리고 CLOSING으로 미는 것**
-- 뿐이고, 남은 포지션 정리와 마감은 이미 있는 스윕(`086`)이 한다:
--
--   취소 → CLOSING(CANCELLED)  →  스윕이 포지션을 강제청산
--                              →  paper_challenge_finalize가 CLOSED
--
-- 취소가 직접 정산하면 정산 경로가 둘이 되고, `paper_settle_close` 하나뿐인
-- 회계 권위가 깨진다.
--
-- 사유는 덮지 않는다
-- ──────────────────
-- 목표 달성(`paper_challenge_judge`)이나 만료(`paper_challenge_sweep_due`)가
-- 먼저 사유를 정했으면 **그대로 둔다.** `paperChallenge.freezeCloseIntent`의
-- SQL 쪽 절반이고, `083`의 `..._terminal_matches_intent_chk`가 마지막 방어선이다.
-- 사용자가 "달성했는데 취소로 적힌" 기록을 보게 두지 않는다.
--
-- 전이 로그 키
-- ────────────
-- `judge`·`sweep`과 **같은 `INTENT:<id>` 키**를 쓴다. 새 키를 만들면 같은
-- 챌린지의 CLOSING 전이가 두 줄이 되고, 어느 쪽이 진짜인지 알 수 없게 된다.
--
-- 더하기만 한다(ADDITIVE)
-- ───────────────────────
-- 새 함수 하나뿐이다. `DROP`도, 기존 함수 대체도, 표 변경도 없다.

CREATE OR REPLACE FUNCTION public.paper_challenge_cancel(
  p_challenge          UUID,
  p_user               UUID,
  p_event_effective_at TIMESTAMPTZ
)
RETURNS TABLE (
  cancelled    BOOLEAN,
  -- CLOSING          이 호출이 사유를 CANCELLED로 얼렸다
  -- ALREADY_CLOSING  이미 CLOSING이다 (같은 요청의 재시도 포함) — 실패가 아니다
  -- INTENT_FROZEN    다른 사유가 먼저 정해져 있다. 덮지 않았다
  -- ALREADY_CLOSED   이미 끝났다
  -- NOT_FOUND        이 사용자의 챌린지가 아니다 (없는 것과 같은 답을 준다)
  code         TEXT,
  status       TEXT,
  close_intent TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_acct   UUID;
  v_locked UUID;
  v_ch     RECORD;
  v_now    TIMESTAMPTZ;
BEGIN
  IF p_event_effective_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22004',
      MESSAGE = 'paper_challenge_cancel: 사건 시각이 없습니다 — 아무것도 바꾸지 않습니다';
  END IF;
  IF p_user IS NULL OR p_challenge IS NULL THEN
    RETURN QUERY SELECT FALSE, 'NOT_FOUND'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- ① **소유자까지 함께 본다.** 남의 챌린지 id를 넣어도 여기서 안 잡힌다.
  --    없는 것과 남의 것에 같은 답을 준다 — 존재 여부를 알려 주지 않는다.
  SELECT c.paper_account_id INTO v_acct
    FROM public.paper_challenges c
   WHERE c.id = p_challenge AND c.user_id = p_user;

  IF v_acct IS NULL THEN
    RETURN QUERY SELECT FALSE, 'NOT_FOUND'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- ② 계좌 → ③ 챌린지. **`086`의 finalize·sweep과 같은 순서다.**
  --    뒤집으면 정산과 순환 대기가 생긴다.
  SELECT a.id INTO v_locked
    FROM public.paper_accounts a WHERE a.id = v_acct FOR UPDATE;
  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'paper_challenge_cancel: 계좌가 없습니다 (%)', v_acct;
  END IF;

  SELECT c.id AS cid, c.user_id AS uid, c.status AS st, c.close_intent AS intent
    INTO v_ch
    FROM public.paper_challenges c
   WHERE c.id = p_challenge AND c.user_id = p_user
     FOR UPDATE;

  IF v_ch.cid IS NULL THEN
    RETURN QUERY SELECT FALSE, 'NOT_FOUND'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- ④ **잠금을 전부 잡은 뒤에 시각을 본다.** `086`이 진입에서 하는 것과
  --    같은 이유다 — 잠금을 기다리는 동안 낡은 사건이 만료 뒤에 도착해
  --    판정을 뒤집는 것을 막는다.
  PERFORM public.paper_event_time_guard(p_event_effective_at);

  IF v_ch.st = 'CLOSED' THEN
    RETURN QUERY SELECT FALSE, 'ALREADY_CLOSED'::TEXT, v_ch.st, v_ch.intent;
    RETURN;
  END IF;

  -- ⑤ 사유가 이미 있으면 **덮지 않는다.**
  --    같은 요청을 두 번 눌러 이미 CANCELLED로 얼어 있는 경우도 여기로 온다 —
  --    그때는 실패가 아니라 `ALREADY_CLOSING`이다.
  IF v_ch.intent IS NOT NULL THEN
    RETURN QUERY SELECT FALSE,
      CASE WHEN v_ch.intent = 'CANCELLED' THEN 'ALREADY_CLOSING' ELSE 'INTENT_FROZEN' END,
      v_ch.st, v_ch.intent;
    RETURN;
  END IF;

  -- ⑥ 여기부터는 READY 또는 RUNNING이고 사유가 없다.
  --    **다른 상태는 조용히 통과시키지 않는다** — 상태가 하나 늘어도 기본이
  --    거부이도록 막는다(fail-closed).
  IF v_ch.st NOT IN ('READY', 'RUNNING') THEN
    RETURN QUERY SELECT FALSE, 'NOT_FOUND'::TEXT, v_ch.st, v_ch.intent;
    RETURN;
  END IF;

  v_now := clock_timestamp();

  -- ⑦ CAS. 잠금을 쥐고 있지만 조건을 한 번 더 적는다 — 이 UPDATE 한 줄만
  --    읽어도 무엇을 보장하는지 알 수 있어야 한다.
  UPDATE public.paper_challenges c
     SET status                = 'CLOSING',
         close_intent          = 'CANCELLED',
         close_intent_at       = v_now,
         close_intent_event_at = p_event_effective_at,
         updated_at            = v_now
   WHERE c.id = p_challenge
     AND c.user_id = p_user
     AND c.close_intent IS NULL
     AND c.status IN ('READY', 'RUNNING');

  IF NOT FOUND THEN
    -- 잠금 안에서 읽은 뒤 아무도 바꿀 수 없으므로 여기 오면 안 된다.
    -- 그래도 **성공으로 적지 않는다.**
    SELECT c.status, c.close_intent INTO v_ch.st, v_ch.intent
      FROM public.paper_challenges c WHERE c.id = p_challenge;
    RETURN QUERY SELECT FALSE, 'INTENT_FROZEN'::TEXT, v_ch.st, v_ch.intent;
    RETURN;
  END IF;

  -- ⑧ 감사 기록. **judge·sweep과 같은 키**라 CLOSING 전이는 한 줄뿐이다.
  INSERT INTO public.paper_challenge_transitions
    (challenge_id, user_id, from_status, to_status, reason,
     transition_key, event_effective_at)
  VALUES
    (p_challenge, v_ch.uid, v_ch.st, 'CLOSING', 'CANCELLED',
     'INTENT:' || p_challenge::TEXT, p_event_effective_at)
  ON CONFLICT ON CONSTRAINT paper_challenge_transitions_idem_key DO NOTHING;

  RETURN QUERY SELECT TRUE, 'CLOSING'::TEXT, 'CLOSING'::TEXT, 'CANCELLED'::TEXT;
END $$;

COMMENT ON FUNCTION public.paper_challenge_cancel(UUID, UUID, TIMESTAMPTZ) IS
  '사용자 취소를 CLOSING(CANCELLED)로 얼린다. 돈을 만들지 않는다 — 잔고도 '
  '원장도 포지션도 건드리지 않고, 정리와 마감은 086의 스윕·finalize가 한다. '
  '계좌 → 챌린지 순으로 잠그고, 이미 정해진 사유는 덮지 않는다. 남의 '
  '챌린지는 없는 것과 같은 NOT_FOUND다.';
