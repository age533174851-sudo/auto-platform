-- 092_exact100x_risk_observations_rls.sql
--
-- **091이 연 표를 닫는다 — 그리고 출처 계약을 DB가 강제하게 한다.**
--
-- 091을 고치지 않고 새 파일로 더한다. 이미 적용된 DB가 있을 수 있고,
-- 적용된 파일을 바꾸면 체크섬이 어긋난다.
--
-- ── ① RLS — 이것이 막고 있던 것 ──
--
-- 091은 `public` 스키마에 표를 만들면서 **RLS를 켜지 않았다.** 이 표에는
-- `connection_id`·포지션 방향·수량·진입가·청산가가 들어간다. 즉 "누가
-- 어느 계좌로 무엇을 얼마나 들고 있고 어디서 청산되는가"다. 무보호로
-- 두면 anon 키 하나로 전부 읽힌다.
--
-- 이 저장소의 다른 표들은 전부 켜 두었다 — 048(`account_equity_snapshots`),
-- 040(`audit_events`), 026(`safety_events`). 091만 빠졌다.
--
-- 왜 소유자(owner) 정책이 아니라 service-only인가
-- ───────────────────────────────────────────────
-- 048은 `auth.uid() = user_id`로 닫는다. 그런데 이 표에는 `user_id`가
-- **없다** — 관측은 연결(connection) 단위로 나오고 사용자 칸을 둔 적이
-- 없다. 없는 칸으로 소유권 정책을 쓰면 그 정책은 아무도 통과시키지
-- 못하거나(항상 null 비교) 억지로 칸을 만들게 된다.
--
-- 지금 이 표에 쓰는 유일한 경로는 `exit-monitor`이고 그쪽은
-- `getSupabaseAdmin()`(service role)이다. 그래서 **service-only로
-- 닫는다.** 화면에서 보여 줄 일이 생기면 그때 소유권 모델을 따로
-- 설계한다 — 지금 지어내지 않는다.
--
-- `anon`·`authenticated`에게는 어떤 권한도 열지 않는다. RLS를 켜면
-- 정책이 없는 역할은 기본적으로 아무 줄도 보지 못한다.
--
-- ── ② VERIFIED_TESTNET은 TESTNET에서만 ──
--
-- 091의 제약은 `sample_origin <> 'VERIFIED…' OR env <> 'MOCK'`이라
-- **LIVE를 허용한다.** 이름이 TESTNET인 출처에 LIVE 관측이 들어가면
-- ⑤B-3의 표본이 오염된다. 더 강한 제약을 ADDITIVE로 더한다.
--
-- 091의 제약은 그대로 둔다 — 더 약할 뿐 틀리지 않았고, 지우면 그만큼
-- 되돌리기 쉬워진다.
--
-- ★ 기존 데이터를 고치지 않는다
-- ─────────────────────────────
-- `UPDATE`도 `DELETE`도 하지 않는다. 어긋난 줄이 이미 있으면 제약 추가가
-- **실패해서 배포를 막는 것이 맞다** — 조용히 고치면 "그런 줄이 있었다"는
-- 사실이 사라진다. 그때는 사람이 몇 줄인지 보고 결정한다.
-- (아래 DO 블록이 그 수를 오류 메시지에 담는다.)

ALTER TABLE public.exact100x_risk_observations
  ENABLE ROW LEVEL SECURITY;

-- 쓰기는 service role 하나뿐이다. 애플리케이션 경로는 여전히
-- INSERT만 한다 — 정책이 ALL이라고 해서 갱신·삭제를 허용한다는 뜻이
-- 아니다(그건 코드와 검사기가 막는다).
DO $$ BEGIN
  CREATE POLICY exact100x_risk_obs_service
    ON public.exact100x_risk_observations
    FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 어긋난 줄이 이미 있으면 **고치지 말고 멈춘다.**
DO $$
DECLARE bad_rows BIGINT;
BEGIN
  SELECT count(*) INTO bad_rows
    FROM public.exact100x_risk_observations
   WHERE sample_origin = 'VERIFIED_TESTNET_OBSERVATION' AND env <> 'TESTNET';
  IF bad_rows > 0 THEN
    RAISE EXCEPTION
      'VERIFIED_TESTNET_OBSERVATION인데 env가 TESTNET이 아닌 줄이 %건 있습니다. '
      '자동으로 고치지 않습니다 — 그 줄들이 어디서 왔는지 사람이 확인한 뒤 결정하십시오.',
      bad_rows;
  END IF;
END $$;

ALTER TABLE public.exact100x_risk_observations
  DROP CONSTRAINT IF EXISTS exact100x_obs_verified_testnet_only;

ALTER TABLE public.exact100x_risk_observations
  ADD CONSTRAINT exact100x_obs_verified_testnet_only
  CHECK (
    sample_origin <> 'VERIFIED_TESTNET_OBSERVATION'
    OR env = 'TESTNET'
  );

COMMENT ON CONSTRAINT exact100x_obs_verified_testnet_only
  ON public.exact100x_risk_observations IS
  'VERIFIED_TESTNET_OBSERVATION은 이름 그대로 TESTNET에서만 성립한다. LIVE 관측이 필요해지면 별도 출처를 별도로 설계한다 — 이 출처에 섞지 않는다.';

COMMENT ON POLICY exact100x_risk_obs_service
  ON public.exact100x_risk_observations IS
  '이 표에는 user_id가 없어 소유권 정책을 쓸 수 없다. 유일한 쓰기 경로가 service role(exit-monitor)이므로 service-only로 닫는다. anon·authenticated에는 아무 권한도 열지 않는다. 화면 조회가 필요해지면 소유권 모델을 따로 설계한다.';
