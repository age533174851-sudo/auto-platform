-- 030_trader_signals.sql
--
-- 방송자 채널과 감지된 포지션 신호.
--
-- 사람 이름을 코드에 박지 않는다
-- ─────────────────────────────
-- 채널은 사용자가 추가·삭제한다. 코드에 이름을 넣으면 그 사람이 방송을
-- 그만두거나 이름을 바꿔도 앱에 남고, 새 사람을 넣으려면 배포를 해야 한다.
--
-- 그리고 이 표에 들어가는 것은 **공개 방송·공개 게시물에서 나온 발언**뿐이다.
-- 로그인이 필요한 곳, 멤버십 전용, 개인 메시지는 넣지 않는다.
--
-- 왜 신뢰도를 컬럼으로 두는가
-- ───────────────────────────
-- 이건 다른 사람의 포지션에 대한 **추측**이다. 추측을 사실처럼 저장하면
-- 나중에 그 데이터를 읽는 코드가 전부 사실로 다룬다. 신뢰도를 지울 수
-- 없게 표에 박아 둔다.

CREATE TABLE IF NOT EXISTS trader_channels (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,

  -- 화면에 보일 이름. 사용자가 정한다
  name         TEXT NOT NULL,
  -- 'youtube' | 'chzzk' | 'soop' | 'manual'
  platform     TEXT NOT NULL DEFAULT 'manual',
  -- 공개 채널 주소. 없어도 된다(직접 입력만 쓰는 경우)
  channel_url  TEXT,

  -- 'live_position' | 'method' | 'analysis' | 'entertainment'
  --
  -- 실시간 포지션을 보여주는 사람과 시황만 말하는 사람은 신호의 뜻이
  -- 완전히 다르다. 섞으면 성적이 무의미해진다.
  kind         TEXT NOT NULL DEFAULT 'live_position',

  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS trader_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  channel_id    UUID REFERENCES trader_channels(id) ON DELETE CASCADE,

  symbol        TEXT,
  -- 'LONG' | 'SHORT' | NULL
  --
  -- **NULL이 허용된다.** 청산 발언에는 방향이 없을 수 있고, 롱과 숏이
  -- 같이 나오면 정하지 않는다. 억지로 채우면 반대로 읽힌다.
  side          TEXT,
  -- 'ENTRY' | 'ADD' | 'PARTIAL_EXIT' | 'EXIT' | 'MODIFY'
  action        TEXT NOT NULL,

  -- 발언에서 읽은 값. **모르면 NULL이다. 0으로 채우지 않는다.**
  entry_price   NUMERIC,
  leverage      NUMERIC,
  stop_loss     NUMERIC,
  take_profit   NUMERIC,

  -- 'confirmed' | 'likely' | 'uncertain'
  --
  -- confirmed는 화면의 포지션까지 확인한 경우에만 붙는다. 말만 듣고
  -- 찍히지 않게 코드에서 경로를 나눠 뒀다(positionParse.withScreenCheck).
  confidence    TEXT NOT NULL,

  -- 근거가 된 원문. **없이 저장하지 않는다** — 나중에 "왜 이 알림이
  -- 왔지"를 되짚을 수 없으면 그 신호는 검증이 불가능하다.
  evidence      TEXT NOT NULL,
  source_url    TEXT,

  -- 채점용. 신호 당시 시장가와 청산 신호 때의 시장가.
  -- 못 구했으면 NULL로 둔다 — 지금 가격으로 대신 채우면 신호가 뜬 뒤
  -- 움직인 만큼이 통째로 성적에 들어간다.
  market_price  NUMERIC,
  exit_price    NUMERIC,
  exit_at       TIMESTAMPTZ,

  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trader_signals_user_time_idx
  ON trader_signals (user_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS trader_signals_channel_idx
  ON trader_signals (channel_id, detected_at DESC);

ALTER TABLE trader_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_signals  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trader_channels_service ON trader_channels;
CREATE POLICY trader_channels_service ON trader_channels
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS trader_channels_owner ON trader_channels;
CREATE POLICY trader_channels_owner ON trader_channels
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS trader_signals_service ON trader_signals;
CREATE POLICY trader_signals_service ON trader_signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 신호는 읽기만. 성적을 좋게 만들려고 진 신호를 지울 수 있으면
-- 이 기록의 존재 이유가 사라진다. 채널을 지우면 신호도 같이 지워진다
-- (ON DELETE CASCADE) — 그건 '이 사람을 안 보겠다'는 뜻이라 괜찮다.
DROP POLICY IF EXISTS trader_signals_owner ON trader_signals;
CREATE POLICY trader_signals_owner ON trader_signals
  FOR SELECT TO authenticated USING (user_id = auth.uid());
