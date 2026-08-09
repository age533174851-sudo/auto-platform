-- ═══════════════════════════════════════════════════════════════
-- TRAIGO — PHASE A · 지금 배포된 코드가 요구하는 것까지만
--
-- **Supabase 대시보드 → SQL Editor에 통째로 붙여넣고 Run** 하세요.
--
-- 이걸로 무엇이 풀리나
-- ────────────────────
-- 화면 아래의 "autotrade_schedules 표가 없습니다 — 마이그레이션 031을
-- 적용하세요". 그 표가 없으면 예약을 켜도 저장할 곳이 없어서, 화면에서
-- 무엇을 눌러도 여기서 막힙니다.
--
-- **031만 넣으면 조회가 깨집니다**
-- ────────────────────────────────
-- 지금 배포된 GET은 leverage_cap · risk_pct · interval_min · margin_pct ·
-- last_decision을 한 번에 select 합니다. 그중 margin_pct와 last_decision만
-- '없으면 빼고 재시도'하고, 나머지 셋은 없으면 **조회가 통째로 실패**해서
-- 화면이 "예약을 읽지 못했습니다"만 띄웁니다.
-- 그래서 031·034·035·036·043을 같이 넣습니다.
--
-- 여기 없는 것 — 그리고 그 이유
-- ─────────────────────────────
-- **050(strategy_id · 예약 정체 재설계)은 이 파일에 없습니다.**
-- 050은 지금의 (user_id, symbol) 유니크를 **지웁니다.** 그런데 현재
-- 배포된 코드는 아직 `onConflict: 'user_id,symbol'`로 upsert 합니다 —
-- 코드보다 먼저 050을 넣으면 **지금 잘 되는 저장 경로가 깨집니다.**
--
-- 050은 PR #112가 main에 배포된 다음에 `RUN_PHASE_B_strategy.sql`로
-- 따로 실행하세요.
--
-- 여러 번 실행해도 안전합니다
-- ───────────────────────────
-- 전부 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS 입니다.
-- ═══════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────
-- 031_autotrade_schedule.sql — 표를 만든다 — (user_id, symbol) 유니크
-- ───────────────────────────────────────────────────────────────
-- 031_autotrade_schedule.sql
--
-- **자동매매를 누구에게 무엇으로 돌릴 것인가.**
--
-- 왜 이 표가 없어서 자동매매가 한 번도 안 돌았나
-- ─────────────────────────────────────────────
-- 진입 엔진(daily-ladder)은 POST로만 실행되고, 실행하려면 누가·어느
-- 종목·어느 연결로 할지를 본문에 받아야 한다.
--
-- 그런데 **Vercel 크론은 GET만 보내고 본문을 못 싣는다.** 그래서
-- vercel.json에 등록할 수가 없었고, 실제로 등록되어 있지도 않았다.
--
-- 결과: 화면에는 자동매매 설정이 다 있는데 **한 번도 실행된 적이 없다.**
-- 테스트넷에서도 안 돌았다. 에러도 안 났다 — 아무 일도 안 일어났으니까.
--
-- 이 표가 그 빈칸이다. 크론은 GET으로 들어와서 이 표를 읽고, 켜져 있는
-- 줄마다 진입 엔진을 부른다.
--
-- 왜 사용자별로 두는가
-- ────────────────────
-- 크론에는 로그인한 사람이 없다. 누구 계좌로 주문할지를 표에서 읽어야
-- 한다. 환경변수에 사용자 id를 박으면 사용자가 늘 때마다 배포해야 하고,
-- 무엇보다 **그 값이 틀려도 아무도 모른다.**

CREATE TABLE IF NOT EXISTS autotrade_schedules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,

  symbol         TEXT NOT NULL DEFAULT 'BTCUSDT',

  -- 어느 연결로 주문할 것인가. **NULL이면 주문할 수 없다** —
  -- 진입 엔진이 connectionId 없이는 거부한다.
  connection_id  UUID,

  -- 운영 사다리: UI_DEMO · PAPER · TESTNET · SHADOW_LIVE · LIVE_SMALL · LIVE_LIMITED
  --
  -- **기본값이 TESTNET이다.** 실전은 명시적으로 올려야 한다 — 이 표에
  -- 줄을 만드는 것만으로 실제 돈이 나가면 안 된다.
  mode           TEXT NOT NULL DEFAULT 'TESTNET',

  enabled        BOOLEAN NOT NULL DEFAULT false,

  -- 마지막으로 실행한 시각과 결과. **없으면 한 번도 안 돈 것이다.**
  -- 이 칸이 계속 비어 있으면 크론이 안 도는 것이고, 그게 지금까지
  -- 아무도 몰랐던 바로 그 상태다.
  last_run_at    TIMESTAMPTZ,
  last_result    TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 같은 사람이 같은 종목을 두 줄 넣으면 하루에 두 번 진입한다.
  UNIQUE (user_id, symbol)
);

CREATE INDEX IF NOT EXISTS autotrade_schedules_enabled_idx
  ON autotrade_schedules (enabled) WHERE enabled = true;

ALTER TABLE autotrade_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autotrade_schedules_service ON autotrade_schedules;
CREATE POLICY autotrade_schedules_service ON autotrade_schedules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS autotrade_schedules_owner ON autotrade_schedules;
CREATE POLICY autotrade_schedules_owner ON autotrade_schedules
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ───────────────────────────────────────────────────────────────
-- 034_autotrade_sizing.sql — leverage_cap · risk_pct
-- ───────────────────────────────────────────────────────────────
-- 034_autotrade_sizing.sql
--
-- **자동매매의 크기와 배율을 화면에서 정한다.**
--
-- 왜 필요한가
-- ───────────
-- 지금 배율은 `riskManager`가 **손절 거리에서 역산**한다. 그래서 "100배로
-- 하겠다"고 지정할 방법이 없다. 프로필 주석에도 이렇게 적혀 있다:
--
--   "100배를 쓰려면 손절이 0.26% 안쪽이어야 하는데, 이는 BTC 노이즈
--    수준이라 진입 직후 손절될 가능성이 높다. 즉 100배는 사실상
--    선택되지 않는다."
--
-- 역산 자체는 맞는 순서다 — 배율을 먼저 정하면 손절이 청산가 밖으로
-- 밀린다. 다만 **상한을 사용자가 정할 수 있어야** 한다. 지금은 코드에
-- 박힌 값이라 화면에서 손댈 수 없다.
--
-- 왜 '상한'이지 '배율'이 아닌가
-- ─────────────────────────────
-- 여기에 `leverage = 100`을 저장하고 그대로 쓰면, 손절이 2%인 자리에도
-- 100배가 나간다. 그건 진입 직후 청산이다. 상한으로 두면 역산 결과가
-- 그보다 작을 때는 작은 쪽이 나간다 — 안전한 쪽으로 틀린다.

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS leverage_cap INTEGER;

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS risk_pct NUMERIC;

-- 아는 값만 들어가게 한다. NULL은 '정하지 않음'이고, 그때는 코드 기본값을
-- 쓴다 — 0으로 채우면 '배율 0'이 되어 주문이 통째로 막힌다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_lev_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_lev_chk
  CHECK (leverage_cap IS NULL OR (leverage_cap >= 1 AND leverage_cap <= 125));

-- 1회 위험 비율(%). 10슬롯 방식이면 10이다.
-- 100을 넘으면 계좌보다 큰 위험을 지겠다는 뜻이라 받지 않는다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_risk_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_risk_chk
  CHECK (risk_pct IS NULL OR (risk_pct > 0 AND risk_pct <= 100));

-- ───────────────────────────────────────────────────────────────
-- 035_autotrade_interval.sql — interval_min
-- ───────────────────────────────────────────────────────────────
-- 035_autotrade_interval.sql
--
-- **얼마나 자주 진입을 볼 것인가.**
--
-- 왜 필요한가
-- ───────────
-- Vercel 무료 플랜은 크론을 **하루 1회**만 허용한다. 그래서 자동매매가
-- 하루 한 번 진입 여부를 본다. 단타를 하려면 그 주기로는 안 된다.
--
-- 그런데 진입 엔진을 분 단위로 부르면, 조건이 맞는 동안 **매 분 진입**한다.
-- 그건 자동매매가 아니라 사고다. 그래서 "얼마나 자주 볼 것인가"를 줄마다
-- 저장하고, 그보다 자주 부르면 건너뛴다.
--
-- 기본값이 1440(하루)인 이유
-- ──────────────────────────
-- 지금 돌고 있는 예약의 동작을 바꾸지 않기 위해서다. 이 칸이 생겼다는
-- 이유만으로 하루 한 번 돌던 것이 분 단위가 되면, 아무도 고르지 않은
-- 변화가 실계좌에서 일어난다.

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS interval_min INTEGER NOT NULL DEFAULT 1440;

-- 1분보다 자주 보게 두지 않는다. 거래소 레이트리밋과 수수료 양쪽에서
-- 의미가 없고, 그보다 잦은 진입은 사람이 확인할 수 없다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_interval_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_interval_chk
  CHECK (interval_min >= 1 AND interval_min <= 10080);

-- ───────────────────────────────────────────────────────────────
-- 036_autotrade_margin_pct.sql — margin_pct
-- ───────────────────────────────────────────────────────────────
-- 036_autotrade_margin_pct.sql
--
-- **"100배로 10%씩 10번"을 실제로 돌리기 위한 칸.**
--
-- 왜 지금까지 100배가 안 나왔나
-- ─────────────────────────────
-- 배율은 역산된다: 포지션 명목가 ÷ 증거금 예산.
--
--   증거금 예산 = min(가용 증거금, maxMargin)
--
-- 그런데 `maxMargin`을 채우는 곳이 계단식(ladder) 하나뿐이었다. 자동매매
-- 예약에는 그 칸이 없어서 **증거금 예산 = 가용 전액**이 됐다.
--
-- 계좌 전체를 증거금으로 쓰면 배율이 낮게 나온다. 예를 들어 1회 위험 10%,
-- 손절 2%면 명목가는 자산의 약 4.65배이고, 증거금이 자산 전액이면
-- 배율은 4.65배다. 화면에 100을 적어도 4.65배가 나간다.
--
-- 100배가 나오려면 **증거금이 작아야** 한다. 같은 조건에서 증거금을
-- 자산의 4.65%로 묶으면 배율이 100배가 된다.
--
-- 그게 "10%씩 10번"의 뜻이다
-- ──────────────────────────
-- 한 번에 자산의 10%만 증거금으로 넣고, 그걸 열 번 나눠 쓴다. 각 자리가
-- 청산돼도 잃는 것은 그 10%다. 열 번을 다 잃어야 계좌가 빈다.
--
-- 이 칸이 그 10%다. NULL이면 예전처럼 동작한다(계단식이 정하거나 무제한).
ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS margin_pct NUMERIC;

-- 1회에 계좌 전부를 증거금으로 넣는 것은 '분할'이 아니다. 100%까지는
-- 받되, 0이나 음수는 받지 않는다 — 0이면 주문이 통째로 막힌다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_margin_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_margin_chk
  CHECK (margin_pct IS NULL OR (margin_pct > 0 AND margin_pct <= 100));

-- ───────────────────────────────────────────────────────────────
-- 043_autotrade_last_decision.sql — last_decision
-- ───────────────────────────────────────────────────────────────
-- 043_autotrade_last_decision.sql
--
-- **판단 결과를 문장에서 다시 읽어내고 있었다.**
--
-- 자동매매 화면의 '마지막 판단' 카드는 LONG 54 : SHORT 46과 "실제 차이
-- 8점 · 최소 필요 12점"을 보여준다. 그런데 그 숫자가 어디에도 저장돼
-- 있지 않았다. `autotrade_schedules`에는 `last_result` 문자열 한 칸뿐이라,
-- 화면이 dailyBattle이 쓴 **한국어 문장을 정규식으로 파싱**해서 숫자를
-- 뽑고 있었다:
--
--   '점수 차이 8점이 최소 우위 12점 미만 — … (LONG 54 : 46 SHORT)'
--                ↑                ↑              ↑        ↑
--
-- 이건 두 가지가 나쁘다.
--
--   1. 그 문장은 **사람에게 보여주려고** 쓴 것이다. 말을 다듬는 순간
--      화면이 조용히 숫자를 잃는다 — 오류도 없이 빈 카드가 된다
--   2. 문장에 안 들어간 값은 영영 못 쓴다. 축별 점수, veto 사유,
--      제안 손절 폭은 엔진이 이미 계산해 놓고 버리고 있다
--
-- 무엇을 담는가
-- ─────────────
-- BattleResult에서 화면이 실제로 쓰는 것만 담는다. 전체를 통째로 넣으면
-- 축 다섯 개의 rationale 문자열까지 매 실행 저장되고, 그건 이 칸의 용도가
-- 아니다(그 기록은 감사 로그가 할 일이다).
--
--   verdict      ENTERED | WATCHING | BLOCKED | ERROR
--   side         LONG | SHORT | NO_TRADE
--   longScore / shortScore / margin / minMargin
--   reason       원문 그대로 — 파싱이 놓친 것을 사람이 직접 볼 수 있게
--
-- 없는 것과 0은 다르다
-- ────────────────────
-- 이 칸이 비어 있으면 "구조화된 기록이 없다"이고, 화면은 예전처럼
-- `last_result` 문장에서 읽으려고 시도한다. 그것도 실패하면 **0:0을
-- 그리지 않고 "점수가 기록되지 않았습니다"라고 적는다.** 0:0은
-- '모름'이 아니라 '완전한 무승부'로 읽힌다.
--
-- 이 마이그레이션을 안 돌려도 화면은 그대로 돈다
-- ──────────────────────────────────────────────
-- 칸이 없으면 조회가 통째로 실패하는 대신(036에서 실제로 그랬다) 칸을
-- 빼고 다시 읽는다. 즉 이 파일은 화면을 더 정확하게 만들 뿐이고,
-- 안 돌렸다고 아무것도 안 깨진다.

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS last_decision JSONB;

COMMENT ON COLUMN autotrade_schedules.last_decision IS
  '마지막 판단의 구조화 기록. 비어 있으면 기록이 없는 것이고, 0으로 읽으면 안 된다';


-- ═══════════════════════════════════════════════════════════════
-- 확인 — 다섯 칸이 다 나오면 끝난 것입니다.
-- (strategy_id는 여기서 안 나오는 게 정상입니다. PHASE B에서 들어갑니다.)
-- ═══════════════════════════════════════════════════════════════
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'autotrade_schedules'
   AND column_name IN ('leverage_cap','risk_pct','interval_min','margin_pct','last_decision')
 ORDER BY column_name;
