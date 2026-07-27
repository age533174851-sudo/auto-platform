-- ═══════════════════════════════════════════════════════════════════════
-- TRAIGO — Supabase SQL Schema  (v1.0)
-- 실행 방법: Supabase Dashboard → SQL Editor → New Query → 전체 붙여넣기 → Run
-- ═══════════════════════════════════════════════════════════════════════

-- ── Extensions ──────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ── updated_at 자동 갱신 trigger 함수 ──────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- ════════════════════════════════════════════════════════════════════════
-- 1. PROFILES  (auth.users 확장)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists profiles (
  id             uuid        primary key references auth.users(id) on delete cascade,
  email          text        unique not null,
  display_name   text,
  avatar_url     text,

  -- 역할: 계층 순서 user < vip < lifetime < founder < admin < developer < super_admin
  role           text        not null default 'user'
                               check (role in (
                                 'user','vip','lifetime','founder',
                                 'admin','developer','super_admin'
                               )),

  -- 구독 플랜
  plan           text        not null default 'free'
                               check (plan in (
                                 'free','pro','premium','lifetime','founder','admin'
                               )),

  -- 계정 상태
  status         text        not null default 'active'
                               check (status in ('active','banned','suspended','pending')),

  badges         text[]      not null default '{}',
  expires_at     timestamptz,          -- null = 만료 없음 (평생회원/관리자)
  granted_by     uuid        references profiles(id),
  invite_code    text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger trg_profiles_updated
  before update on profiles
  for each row execute function set_updated_at();

-- 회원가입 시 profiles 자동 생성
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'display_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end; $$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- RLS
alter table profiles enable row level security;

create policy "본인 프로필 읽기"
  on profiles for select
  using (auth.uid() = id);

create policy "관리자 전체 프로필 읽기"
  on profiles for select
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('admin','developer','super_admin')
    )
  );

create policy "본인 프로필 수정 (역할/플랜 변경 불가)"
  on profiles for update
  using (auth.uid() = id)
  with check (
    role = (select role from profiles where id = auth.uid()) and
    plan = (select plan from profiles where id = auth.uid())
  );

create policy "관리자 모든 프로필 수정"
  on profiles for update
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('admin','developer','super_admin')
    )
  );

-- ════════════════════════════════════════════════════════════════════════
-- 2. INVITE CODES  (초대 코드)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists invite_codes (
  id          uuid        primary key default gen_random_uuid(),
  code        text        unique not null,
  plan        text        not null default 'pro'
                            check (plan in ('free','pro','premium','lifetime','founder','admin')),
  role        text        not null default 'user'
                            check (role in ('user','vip','lifetime','founder','admin','developer','super_admin')),
  uses_max    int,          -- null = 무제한
  uses_count  int         not null default 0,
  active      boolean     not null default true,
  created_by  uuid        references profiles(id),
  expires_at  timestamptz,
  note        text,
  created_at  timestamptz not null default now()
);

alter table invite_codes enable row level security;

create policy "관리자만 코드 관리"
  on invite_codes for all
  using (
    exists (
      select 1 from profiles where id = auth.uid()
        and role in ('admin','developer','super_admin')
    )
  );

create policy "활성 코드 조회 (리딤용)"
  on invite_codes for select
  using (active = true);

-- 기본 초대 코드 시드
insert into invite_codes (code, plan, role, uses_max, note) values
  ('FOUNDER-2026',    'founder',  'founder',  10,   '창업멤버 초대 코드'),
  ('FRIEND-LIFETIME', 'lifetime', 'lifetime', null, '지인 평생회원 (무제한)'),
  ('DEV-ACCESS-2025', 'lifetime', 'developer', 5,   '개발자 테스트 접근'),
  ('PRO-FRIEND-XYZ',  'pro',      'user',     null, '친구 Pro 초대 (무제한)')
on conflict (code) do nothing;

-- ════════════════════════════════════════════════════════════════════════
-- 3. SUBSCRIPTIONS  (구독)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists subscriptions (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null unique references profiles(id) on delete cascade,
  plan           text        not null default 'free',
  status         text        not null default 'active'
                               check (status in (
                                 'active','expired','suspended','trialing','canceled'
                               )),
  billing_cycle  text        check (billing_cycle in ('monthly','yearly','lifetime','manual')),
  amount_krw     int         default 0,
  expires_at     timestamptz,          -- null = 평생
  granted_by     uuid        references profiles(id),
  invite_code    text,
  stripe_sub_id  text,                 -- 실제 결제 연동 시 사용
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger trg_subscriptions_updated
  before update on subscriptions
  for each row execute function set_updated_at();

alter table subscriptions enable row level security;

create policy "본인 구독 읽기"
  on subscriptions for select using (auth.uid() = user_id);

create policy "관리자 구독 전체 관리"
  on subscriptions for all
  using (
    exists (
      select 1 from profiles where id = auth.uid()
        and role in ('admin','developer','super_admin')
    )
  );

-- ════════════════════════════════════════════════════════════════════════
-- 4. WATCHLISTS  (왓치리스트)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists watchlists (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references profiles(id) on delete cascade,
  name        text        not null default '기본 왓치리스트',
  -- [{id, nameKr, sym, clr, t, addedAt}]
  symbols     jsonb       not null default '[]',
  is_default  boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_watchlists_updated
  before update on watchlists
  for each row execute function set_updated_at();

create index idx_watchlists_user on watchlists(user_id);

alter table watchlists enable row level security;

create policy "본인 왓치리스트 관리"
  on watchlists for all using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- 5. PORTFOLIOS  (포트폴리오)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists portfolios (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references profiles(id) on delete cascade,
  name            text        not null default '내 포트폴리오',
  type            text        not null default 'mixed'
                                check (type in ('longterm','shortterm','auto','cash','mixed')),
  allocation_pct  int         not null default 100
                                check (allocation_pct between 0 and 100),
  total_value     numeric(18,2) default 0,
  total_invested  numeric(18,2) default 0,
  realized_pnl    numeric(18,2) default 0,
  is_paper        boolean     not null default true,   -- 항상 true (모의투자)
  currency        text        not null default 'KRW',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger trg_portfolios_updated
  before update on portfolios
  for each row execute function set_updated_at();

create index idx_portfolios_user on portfolios(user_id);

alter table portfolios enable row level security;

create policy "본인 포트폴리오 관리"
  on portfolios for all using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- 6. POSITIONS  (포지션)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists positions (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references profiles(id) on delete cascade,
  portfolio_id    uuid          references portfolios(id) on delete set null,

  asset_id        text          not null,
  asset_name_kr   text,
  symbol          text          not null,
  asset_type      text,         -- coin, stock, krstock, etf, cfd, forex, commodity

  side            text          not null default 'long'
                                  check (side in ('long','short')),
  position_type   text          not null default 'spot'
                                  check (position_type in ('spot','futures','cfd')),

  qty             numeric(24,8) not null,
  avg_price       numeric(24,8) not null,
  current_price   numeric(24,8),
  leverage        int           not null default 1 check (leverage >= 1),
  margin_mode     text          default 'isolated'
                                  check (margin_mode in ('isolated','cross')),

  take_profit     numeric(24,8),
  stop_loss       numeric(24,8),
  invested        numeric(18,2) not null,
  unrealized_pnl  numeric(18,2) default 0,
  realized_pnl    numeric(18,2) default 0,

  status          text          not null default 'open'
                                  check (status in ('open','closed','liquidated')),
  is_paper        boolean       not null default true,
  note            text,
  strategy        text,

  opened_at       timestamptz   not null default now(),
  closed_at       timestamptz,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

create trigger trg_positions_updated
  before update on positions
  for each row execute function set_updated_at();

create index idx_positions_user     on positions(user_id);
create index idx_positions_portfolio on positions(portfolio_id);
create index idx_positions_status   on positions(status);
create index idx_positions_asset    on positions(asset_id);

alter table positions enable row level security;

create policy "본인 포지션 관리"
  on positions for all using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- 7. TRADE_HISTORY  (매매 기록)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists trade_history (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references profiles(id) on delete cascade,
  portfolio_id    uuid          references portfolios(id) on delete set null,
  position_id     uuid          references positions(id) on delete set null,

  asset_id        text          not null,
  asset_name_kr   text,
  symbol          text          not null,

  side            text          not null check (side in ('buy','sell')),
  order_type      text          not null default 'market'
                                  check (order_type in ('market','limit','stop')),

  qty             numeric(24,8) not null,
  price           numeric(24,8) not null,
  amount          numeric(18,2) not null,
  leverage        int           not null default 1,
  fee             numeric(18,6) default 0,
  slippage        numeric(18,6) default 0,
  pnl             numeric(18,2),
  pnl_pct         numeric(10,4),

  status          text          not null default 'filled'
                                  check (status in ('pending','filled','cancelled','failed')),
  is_paper        boolean       not null default true,
  exchange        text,
  strategy        text,
  note            text,
  emotion         text,          -- 💡 매매 일지 감정 태그

  executed_at     timestamptz   not null default now(),
  created_at      timestamptz   not null default now()
);

create index idx_trade_history_user on trade_history(user_id);
create index idx_trade_history_date on trade_history(executed_at desc);
create index idx_trade_history_asset on trade_history(asset_id);

alter table trade_history enable row level security;

create policy "본인 매매 기록 관리"
  on trade_history for all using (auth.uid() = user_id);

create policy "관리자 매매 기록 읽기"
  on trade_history for select
  using (
    exists (
      select 1 from profiles where id = auth.uid()
        and role in ('admin','developer','super_admin')
    )
  );

-- ════════════════════════════════════════════════════════════════════════
-- 8. STRATEGIES  (자동매매 전략)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists strategies (
  id                uuid          primary key default gen_random_uuid(),
  user_id           uuid          not null references profiles(id) on delete cascade,
  name              text          not null,
  description       text,
  type              text          not null default 'manual'
                                    check (type in (
                                      'manual','dca','trend','reversal',
                                      'breakout','scalping','swing','custom'
                                    )),
  assets            text[]        default '{}',
  params            jsonb         default '{}',
  is_active         boolean       not null default false,
  is_paper          boolean       not null default true,
  max_daily_loss    numeric(18,2),
  max_position_size numeric(18,2),
  cooldown_minutes  int           default 60,
  win_count         int           default 0,
  loss_count        int           default 0,
  total_pnl         numeric(18,2) default 0,
  webhook_url       text,          -- TradingView webhook
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

create trigger trg_strategies_updated
  before update on strategies
  for each row execute function set_updated_at();

create index idx_strategies_user on strategies(user_id);

alter table strategies enable row level security;

create policy "본인 전략 관리"
  on strategies for all using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- 9. NOTIFICATIONS  (알림)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists notifications (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references profiles(id) on delete cascade,
  type        text        not null
                            check (type in (
                              'tp_hit','sl_hit','liq_warning','vol_warning',
                              'strategy','rebalance','system','promo'
                            )),
  title       text        not null,
  body        text,
  asset_id    text,
  is_read     boolean     not null default false,
  metadata    jsonb       default '{}',
  created_at  timestamptz not null default now()
);

create index idx_notifications_user   on notifications(user_id);
create index idx_notifications_unread on notifications(user_id, is_read)
  where not is_read;

alter table notifications enable row level security;

create policy "본인 알림 관리"
  on notifications for all using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- 10. CHART_DRAWINGS  (차트 그림 저장)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists chart_drawings (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references profiles(id) on delete cascade,
  asset_id    text        not null,
  timeframe   text        not null default '1h',
  shapes      jsonb       not null default '[]',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, asset_id, timeframe)
);

create trigger trg_chart_drawings_updated
  before update on chart_drawings
  for each row execute function set_updated_at();

alter table chart_drawings enable row level security;

create policy "본인 차트 드로잉 관리"
  on chart_drawings for all using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- 11. API_CONNECTIONS  (거래소 API 연결)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists api_connections (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references profiles(id) on delete cascade,
  exchange        text        not null,   -- 'binance','upbit','bithumb','gateio',...
  nickname        text,
  api_key_masked  text,                  -- 마지막 4자리만 표시
  -- ⚠️ api_secret은 절대 DB에 저장하지 않음 — Vault/서버 환경변수만 사용
  permissions     jsonb       default '{"read":true,"trading":false,"withdrawal":false}',
  group_type      text        default 'shortterm'
                                check (group_type in ('longterm','shortterm','auto','cash','custom')),
  is_active       boolean     not null default true,
  is_paper        boolean     not null default true,
  auto_trading    boolean     not null default false,
  max_daily_loss  numeric(18,2),
  last_sync_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger trg_api_connections_updated
  before update on api_connections
  for each row execute function set_updated_at();

create index idx_api_connections_user on api_connections(user_id);

alter table api_connections enable row level security;

create policy "본인 API 연결 관리"
  on api_connections for all using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- 12. CACHED_ASSETS  (글로벌 자산 검색 캐시)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists cached_assets (
  symbol      text          primary key,
  name        text          not null,
  name_kr     text,
  exchange    text,
  asset_type  text,
  currency    text          default 'USD',
  logo_url    text,
  last_price  numeric(24,8),
  change_pct  numeric(10,4),
  source      text          default 'mock',
  updated_at  timestamptz   not null default now()
);

alter table cached_assets enable row level security;

create policy "누구나 자산 캐시 읽기"
  on cached_assets for select using (true);

create policy "관리자만 자산 캐시 수정"
  on cached_assets for all
  using (
    exists (
      select 1 from profiles where id = auth.uid()
        and role in ('admin','developer','super_admin')
    )
  );

-- ════════════════════════════════════════════════════════════════════════
-- 13. AUDIT_LOGS  (관리자 감사 로그)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists audit_logs (
  id           uuid        primary key default gen_random_uuid(),
  actor_id     uuid        references profiles(id),
  actor_email  text,
  action       text        not null,
  target_id    uuid        references profiles(id),
  target_email text,
  details      text,
  metadata     jsonb       default '{}',
  ip_address   inet,
  created_at   timestamptz not null default now()
);

create index idx_audit_logs_actor on audit_logs(actor_id);
create index idx_audit_logs_date  on audit_logs(created_at desc);

alter table audit_logs enable row level security;

create policy "관리자만 감사 로그 읽기"
  on audit_logs for select
  using (
    exists (
      select 1 from profiles where id = auth.uid()
        and role in ('admin','developer','super_admin')
    )
  );

create policy "시스템 감사 로그 삽입"
  on audit_logs for insert with check (true);

-- ════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ════════════════════════════════════════════════════════════════════════

-- 평생회원 부여 (관리자 전용)
create or replace function admin_grant_lifetime(
  target_user_id uuid,
  admin_user_id  uuid,
  plan_type      text default 'lifetime'
)
returns void language plpgsql security definer as $$
declare v_admin_role text;
begin
  select role into v_admin_role from profiles where id = admin_user_id;
  if v_admin_role not in ('admin','developer','super_admin') then
    raise exception 'Insufficient permissions';
  end if;

  update profiles set
    plan       = plan_type,
    role       = case
                   when plan_type = 'founder'  then 'founder'
                   when plan_type = 'lifetime' then 'lifetime'
                   else role
                 end,
    expires_at = null,
    granted_by = admin_user_id,
    badges     = array_append(array_remove(badges, 'lifetime'), 'lifetime'),
    updated_at = now()
  where id = target_user_id;

  insert into subscriptions (user_id, plan, status, billing_cycle, expires_at, granted_by)
  values (target_user_id, plan_type, 'active', 'lifetime', null, admin_user_id)
  on conflict (user_id) do update set
    plan = excluded.plan, status = 'active',
    billing_cycle = 'lifetime', expires_at = null,
    granted_by = excluded.granted_by, updated_at = now();

  insert into audit_logs (actor_id, actor_email, action, target_id, details)
  select admin_user_id,
         (select email from profiles where id = admin_user_id),
         'GRANT_LIFETIME', target_user_id,
         'Granted ' || plan_type || ' (no expiry)';
end; $$;

-- 초대 코드 리딤
create or replace function redeem_invite_code(p_code text, p_user_id uuid)
returns jsonb language plpgsql security definer as $$
declare v_code invite_codes%rowtype;
begin
  select * into v_code from invite_codes
  where upper(code) = upper(p_code) and active = true;

  if not found then
    return jsonb_build_object('success',false,'error','유효하지 않은 코드입니다.');
  end if;

  if v_code.uses_max is not null and v_code.uses_count >= v_code.uses_max then
    return jsonb_build_object('success',false,'error','사용 횟수가 초과된 코드입니다.');
  end if;

  if v_code.expires_at is not null and v_code.expires_at < now() then
    return jsonb_build_object('success',false,'error','만료된 코드입니다.');
  end if;

  update profiles set
    plan       = v_code.plan,
    role       = case when v_code.role != 'user' then v_code.role else role end,
    expires_at = case
                   when v_code.plan in ('lifetime','founder') then null
                   else now() + interval '1 year'
                 end,
    invite_code = v_code.code,
    updated_at  = now()
  where id = p_user_id;

  update invite_codes set uses_count = uses_count + 1 where id = v_code.id;

  return jsonb_build_object('success',true,'plan',v_code.plan,'role',v_code.role);
end; $$;

-- 관리자 여부 확인 (서버 컴포넌트에서 사용)
create or replace function is_admin(p_user_id uuid)
returns boolean language sql security definer as $$
  select exists (
    select 1 from profiles
    where id = p_user_id
      and role in ('admin','developer','super_admin')
  );
$$;

-- ════════════════════════════════════════════════════════════════════════
-- INITIAL SUPER ADMIN  (첫 실행 후 SQL Editor에서 실행)
-- ════════════════════════════════════════════════════════════════════════
-- 1. Supabase Auth에서 이메일/비밀번호로 계정 생성
-- 2. 아래 쿼리에서 이메일 교체 후 실행:
--
--    update profiles
--    set role = 'super_admin', plan = 'lifetime', expires_at = null
--    where email = 'YOUR_ADMIN_EMAIL@example.com';
--
-- ════════════════════════════════════════════════════════════════════════
