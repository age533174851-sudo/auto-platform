-- 093_exact100x_exit_escape_observations.sql
--
-- **⑤B-3A-1 — 닫는 데 실제로 얼마나 걸렸는가. 아직 "언제 닫을지"가 아니다.**
--
-- 왜 또 다른 표인가
-- ─────────────────
-- 091(`exact100x_risk_observations`)은 **감시 회차마다 찍는 위험 스냅숏
-- 시계열**이다. 여기 담는 것은 **종료 실행 한 번당 한 줄**이다 — 결이
-- 다르다. 같은 표에 붙이면 `liquidation_sources`·`status` 같은 칸이
-- 대부분 NULL인 줄이 섞여 분포가 망가지고, 반대로 `submit_elapsed_ms`가
-- 대부분 NULL인 줄이 섞인다.
--
-- 기존 표를 먼저 봤다
-- ───────────────────
--   058 `exit_monitor_runs`   **회차**당 1줄. source·next_expected_at이
--                             이미 있어 wake 정보는 그쪽이 정본이다.
--                             종료 실행별 구간 시간을 담을 자리는 없다.
--   040 `audit_events`        사람이 한 **동작**을 적는 표. 불 지르고
--                             잊으므로 조용히 사라진 줄이 분포를 왜곡한다.
--   026 `safety_events`       차단 사유 전용. 수치 칸이 없다.
--   live_orders               진입 장부. 시계열·실행 계측을 섞지 않는다.
--
-- ★ 권한이 없다
-- ─────────────
-- 여기 무엇이 적히든 주문은 나가지 않는다. append-only이고 애플리케이션에
-- UPDATE·DELETE 경로를 만들지 않는다.
--
-- ★ service_role은 RLS를 우회한다 — 그 사실을 숨기지 않는다
-- ─────────────────────────────────────────────────────────
-- 아래 정책은 `service_role`에게 전부 연다. Postgres에서 service role은
-- 애초에 RLS를 우회하는 역할이므로, 이 정책은 "그 역할에게 권한을 준다"
-- 기보다 **다른 역할에게는 아무 정책도 없다**는 사실을 분명히 하는 쪽에
-- 가깝다. 실제 보호는 `anon`·`authenticated`에 정책을 **하나도 만들지
-- 않는 것**에서 온다. 092와 같은 모양이다.
--
-- ★ 시크릿을 적지 않는다
-- ──────────────────────
-- API 키·서명·raw 응답 payload는 어떤 칸에도 들어가지 않는다. 거래소
-- 응답에서 꺼내는 것은 평균가·주문번호·체결수량 세 칸뿐이다.

CREATE TABLE IF NOT EXISTS public.exact100x_exit_escape_observations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  env           TEXT NOT NULL,
  connection_id UUID,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL,

  execution_profile_id       TEXT,
  execution_preset_id        TEXT,
  execution_contract_version INTEGER,

  -- ── 누가 깨웠는가 ──
  --
  -- `x-traigo-source` 헤더 그대로다(058이 쓰는 것과 같은 정본).
  -- 추측하지 않는다 — 없으면 'manual'로 들어온다.
  wake_source   TEXT,
  /*
   * 예정 시각보다 얼마나 늦게 깨어났는가(ms).
   *
   * ★ **모르면 NULL이다.** 5분이라고 가정해서 빼지 않는다 — worker
   *   간격은 env로 바뀌고, GitHub/Vercel은 예정 시각이 다르다.
   */
  wake_delay_ms DOUBLE PRECISION,
  /** worker가 실제로 쓰고 있는 간격(ms). 모르면 NULL */
  configured_interval_ms DOUBLE PRECISION,

  -- ── 구간 시간 (전부 단조 시계 duration, epoch 아님) ──
  mark_read_elapsed_ms          DOUBLE PRECISION,
  bracket_read_elapsed_ms       DOUBLE PRECISION,
  position_risk_elapsed_ms      DOUBLE PRECISION,
  risk_measurement_elapsed_ms   DOUBLE PRECISION,
  lease_check_elapsed_ms        DOUBLE PRECISION,
  prepare_close_elapsed_ms      DOUBLE PRECISION,
  fence_revalidation_elapsed_ms DOUBLE PRECISION,
  /* 재검증 직후 → 전송 시작 직전. 왕복 0이라고 0으로 적지 않는다 */
  critical_window_elapsed_ms    DOUBLE PRECISION,
  /* 전송 시작 → 거래소 응답. timeout 8000은 정책 상한이지 실측이 아니다 */
  submit_elapsed_ms             DOUBLE PRECISION,
  /* 거래소 응답 → **첫** 재조회. 실제 flat까지가 아니다 */
  submit_accepted_to_first_read_after_ms DOUBLE PRECISION,

  -- ── 결과 ──
  run_code          TEXT NOT NULL,
  attempted_write   BOOLEAN,
  accepted          BOOLEAN,
  flat_verified     BOOLEAN,
  /*
   * 첫 재조회에서 잔여 0을 봤는가.
   *
   * ★ `actual_time_to_flat_ms` 칸을 **만들지 않았다.** 재조회는 한 번
   *   뿐이라, 그때 포지션이 남아 있으면 실제 flat 시각은 UNKNOWN이다.
   *   반복 조회를 새로 넣는 것은 실행 의미를 바꾸는 다른 단계다.
   */
  flat_observed_at_first_read BOOLEAN,
  /* 보낸 수량이다. **체결 수량이 아니다** */
  requested_quantity DOUBLE PRECISION,

  -- ── 거래소 응답에서 보존한 것 ──
  reported_avg_price DOUBLE PRECISION,
  exchange_order_id  TEXT,
  /* 거래소가 적어 준 체결 수량. requested_quantity와 다른 값이다 */
  executed_qty       DOUBLE PRECISION,

  -- ── 슬리피지 ──
  --
  -- 전송 시점 마크가와 평균가. 둘 중 하나라도 없으면 아래 %는 NULL이다.
  mark_at_submit            DOUBLE PRECISION,
  /* 불리한 쪽이면 양수. 계산식은 순수 helper 한 곳에 있다 */
  adverse_close_slippage_pct DOUBLE PRECISION,

  sample_origin TEXT NOT NULL,

  CONSTRAINT exact100x_esc_sample_origin_known
    CHECK (sample_origin IN ('VERIFIED_TESTNET_OBSERVATION', 'SYNTHETIC_TEST_ONLY')),
  CONSTRAINT exact100x_esc_env_known
    CHECK (env IN ('LIVE', 'TESTNET', 'MOCK')),
  CONSTRAINT exact100x_esc_verified_testnet_only
    CHECK (sample_origin <> 'VERIFIED_TESTNET_OBSERVATION' OR env = 'TESTNET')
);

CREATE INDEX IF NOT EXISTS exact100x_esc_symbol_time_idx
  ON public.exact100x_exit_escape_observations (symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS exact100x_esc_origin_time_idx
  ON public.exact100x_exit_escape_observations (sample_origin, env, observed_at DESC);

ALTER TABLE public.exact100x_exit_escape_observations
  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY exact100x_esc_service
    ON public.exact100x_exit_escape_observations
    FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE public.exact100x_exit_escape_observations IS
  '⑤B-3A-1 종료 실행 한 번당 한 줄. 각 구간에 실제로 걸린 시간과 거래소가 돌려준 체결 정보를 모은다. append-only이고 주문 권한이 없다. 시크릿·raw payload를 적지 않는다. service_role은 RLS를 우회하며, 보호는 anon·authenticated에 정책을 두지 않는 데서 온다.';

COMMENT ON COLUMN public.exact100x_exit_escape_observations.critical_window_elapsed_ms IS
  '울타리 재검증 직후부터 전송 시작 직전까지. 네트워크 왕복이 0이라고 해서 0으로 적지 않는다 — 실제로 잰다.';

COMMENT ON COLUMN public.exact100x_exit_escape_observations.submit_accepted_to_first_read_after_ms IS
  '거래소 응답부터 첫 재조회까지. 실제 flat까지 걸린 시간이 아니다 — 재조회는 한 번뿐이다.';

COMMENT ON COLUMN public.exact100x_exit_escape_observations.reported_avg_price IS
  '거래소 응답의 avgPrice를 그대로 보존한 값. 우리가 "체결가"라는 해석을 얹은 값이 아니다. 0은 "안 줬다"이므로 NULL로 눕힌다.';

COMMENT ON COLUMN public.exact100x_exit_escape_observations.wake_delay_ms IS
  '예정 시각 대비 지연. 모르면 NULL이다 — worker 간격은 env로 바뀌고 GitHub/Vercel은 예정이 다르므로 5분이라고 가정해 빼지 않는다.';
