-- 091_exact100x_risk_observations.sql
--
-- **⑤B-2 — 열린 100배 포지션의 위험을 시간에 따라 모은다. 판단하지 않는다.**
--
-- 왜 표가 필요한가
-- ────────────────
-- ⑤B-1의 측정값은 지금 감시 회차 **응답에만** 있다. 그 회차가 끝나면
-- 사라지므로 분포를 만들 수 없고, 분포가 없으면 ⑤B-3의 문턱을 **유도할
-- 수 없다** — 지어내는 수밖에 없게 된다. 이 저장소가 계속 피해 온 그
-- 자리다(`liquidationProximityRatio: 0.35`가 근거 없이 남아 있는 이유).
--
-- 왜 `live_orders`가 아닌가
-- ─────────────────────────
-- 090의 두 칸은 **진입 시점의 불변 스냅숏**이다. 여기 담는 것은 **열려
-- 있는 동안 계속 바뀌는 시계열**이다. 성격이 다르고, 무엇보다 같은 줄에
-- 쓰면 진입 당시의 값이 덮인다 — 090이 존재하는 이유가 사라진다.
--
-- 왜 `audit_events`가 아닌가
-- ──────────────────────────
-- 040은 **사람이 한 동작**을 적는 표다(`action`·`resource`·`result`).
-- 측정은 동작이 아니라서 `action` 칸이 거짓이 되고, 분당 들어오는
-- 시계열이 운영자의 감사 흔적을 덮는다. 더 결정적으로 `recordAudit`은
-- **불 지르고 잊는다**(실패해도 조용히 삼킨다) — 그건 주문 경로를
-- 지키려는 올바른 선택이지만, 백분위를 낼 표본에는 **조용히 사라진 줄**이
-- 분포를 왜곡한다.
--
-- 048(`account_equity_snapshots`)이 구조적 선례다: 환경을 섞지 않고,
-- 못 읽은 칸은 NULL로 두는 시계열 표.
--
-- ★ 이 표에는 **권한이 없다**
-- ───────────────────────────
-- 여기 무엇이 적히든 주문은 나가지 않는다. 읽는 쪽도 판단하지 않는다.
-- append-only이고, UPDATE·DELETE 경로를 만들지 않는다.
--
-- ★ 시크릿을 적지 않는다
-- ──────────────────────
-- API 키·시크릿·서명은 어떤 칸에도 들어가지 않는다. 연결은 id로만
-- 가리킨다(040의 규칙과 같다).
--
-- 환경을 섞지 않는다
-- ──────────────────
-- MOCK/TESTNET/LIVE의 장부와 자산을 합산하지 않는 저장소 규칙 그대로,
-- `env`를 칸으로 둔다. 이 표의 쓰임은 지금 TESTNET 관측이다.

CREATE TABLE IF NOT EXISTS public.exact100x_risk_observations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 우리가 이 관측을 만든 시각
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- LIVE / TESTNET / MOCK. **절대 합산하지 않는다**
  env           TEXT NOT NULL,
  connection_id UUID,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL,

  -- 어느 실행 계약의 포지션인가 (089와 같은 세 칸)
  execution_profile_id       TEXT,
  execution_preset_id        TEXT,
  execution_contract_version INTEGER,

  -- ── 포지션 ──
  entry_price   DOUBLE PRECISION,
  quantity      DOUBLE PRECISION,
  leverage      DOUBLE PRECISION,
  margin_mode   TEXT,

  -- ── MARK (④ timestamped) ──
  mark_price              DOUBLE PRECISION,
  mark_exchange_time_ms   BIGINT,
  mark_received_at_ms     BIGINT,
  mark_observed_at_ms     BIGINT,
  mark_freshness_code     TEXT,

  -- ── positionRisk ──
  --
  -- `position_update_time_ms`는 거래소가 준 "update time"이다.
  -- **청산가가 계산된 시각이 아니다.** 이름을 바꾸지 않는다.
  position_risk_source               TEXT,
  position_risk_request_started_at_ms BIGINT,
  position_risk_received_at_ms        BIGINT,
  position_update_time_ms             BIGINT,
  exchange_liquidation_price          DOUBLE PRECISION,

  -- ── 지속시간 (duration) — **epoch 칸과 다른 값이다** ──
  --
  -- `*_elapsed_ms`는 단조 시계로 잰 duration이고 timestamp가 아니다.
  -- wall-clock 차(`*_wall_clock_delta_ms`)는 참고값으로만 남긴다 —
  -- NTP 보정에 오염되므로 ⑤B-3의 지연 표본으로 쓰지 않는다.
  position_risk_elapsed_ms              DOUBLE PRECISION,
  account_elapsed_ms                    DOUBLE PRECISION,
  helper_elapsed_ms                     DOUBLE PRECISION,
  position_risk_wall_clock_delta_ms     DOUBLE PRECISION,

  -- ── 내부 추정 (독립 검증자) ──
  estimated_liquidation_price DOUBLE PRECISION,
  internal_trustworthy        BOOLEAN,
  internal_code               TEXT,
  tier_index                  INTEGER,
  tier_mmr                    DOUBLE PRECISION,
  tier_maint_amount           DOUBLE PRECISION,

  -- ── 대조 — **관측만.** 평균도 선택도 문턱도 없다 ──
  exchange_headroom_pct   DOUBLE PRECISION,
  estimated_headroom_pct  DOUBLE PRECISION,
  absolute_delta          DOUBLE PRECISION,
  delta_pct               DOUBLE PRECISION,
  liquidation_sources     TEXT,

  -- ── 진입 당시 불변 스냅숏 (090에서 읽어 온 값) ──
  --
  -- 여기 적히는 것은 **사본**이다. 090의 원본을 갱신하지 않는다.
  entry_adverse_distance_pct          DOUBLE PRECISION,
  entry_liquidation_distance_pct_raw  DOUBLE PRECISION,

  -- ── 브래킷 ──
  bracket_observed_at_ms  BIGINT,
  bracket_freshness       TEXT,

  -- ── 측정 상태 ──
  --
  -- 'MEASURED' | 'RISK_DATA_UNUSABLE'. 후자는 **종료 사유가 아니다**.
  status  TEXT NOT NULL,
  reason  TEXT,

  -- ★ 이 관측이 **실제 거래소에서 나온 것인가.**
  --
  --   'VERIFIED_TESTNET_OBSERVATION' 실제 자격증명 + 실제 열린 포지션
  --   'SYNTHETIC_TEST_ONLY'          시험·검사기 주입값
  --
  --   둘을 섞으면 통계가 거짓이 된다. 기본값을 두지 않는다 — 쓰는 쪽이
  --   반드시 고르게 해서, 모르고 실측으로 적히는 길을 없앤다.
  sample_origin TEXT NOT NULL,

  CONSTRAINT exact100x_obs_sample_origin_known
    CHECK (sample_origin IN ('VERIFIED_TESTNET_OBSERVATION', 'SYNTHETIC_TEST_ONLY')),
  CONSTRAINT exact100x_obs_env_known
    CHECK (env IN ('LIVE', 'TESTNET', 'MOCK')),
  -- 실제 관측은 TESTNET/LIVE에서만 나온다. MOCK 실측이라는 것은 없다.
  CONSTRAINT exact100x_obs_verified_not_mock
    CHECK (sample_origin <> 'VERIFIED_TESTNET_OBSERVATION' OR env <> 'MOCK')
);

CREATE INDEX IF NOT EXISTS exact100x_obs_symbol_time_idx
  ON public.exact100x_risk_observations (symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS exact100x_obs_origin_time_idx
  ON public.exact100x_risk_observations (sample_origin, env, observed_at DESC);

COMMENT ON TABLE public.exact100x_risk_observations IS
  '⑤B-2 열린 Exact100X 포지션의 위험 관측 시계열. append-only이고 주문 권한이 없다. 여기 무엇이 적히든 자동 청산은 일어나지 않는다. 시크릿을 적지 않는다.';

COMMENT ON COLUMN public.exact100x_risk_observations.sample_origin IS
  '실제 거래소 관측(VERIFIED_TESTNET_OBSERVATION)인가 시험 주입값(SYNTHETIC_TEST_ONLY)인가. 기본값 없음 — 모르고 실측으로 적히는 길을 막는다. 둘을 섞어 통계를 내지 않는다.';

COMMENT ON COLUMN public.exact100x_risk_observations.position_update_time_ms IS
  '거래소가 준 포지션 update time. 청산가가 계산된 시각이 아니다 — 공식 응답에 liquidationPrice 전용 시각은 없다.';

COMMENT ON COLUMN public.exact100x_risk_observations.position_risk_elapsed_ms IS
  '단조 시계로 잰 성공한 positionRisk 왕복(ms). duration이지 timestamp가 아니다. v2 실패 후 v3면 v3 왕복이고 helper 전체는 helper_elapsed_ms다.';

COMMENT ON COLUMN public.exact100x_risk_observations.position_risk_wall_clock_delta_ms IS
  'epoch 두 시각의 차(ms). 참고값이다 — NTP 보정에 오염되므로 지연 문턱 산출에 쓰지 않는다.';
