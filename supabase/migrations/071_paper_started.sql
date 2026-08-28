-- 071: 모의계좌가 **사용자가 시작한 것인지**를 남긴다
--
-- `getPaperAccount()`는 줄이 없으면 **읽기만 해도 만든다** —
-- balance 10,000 · initial_balance 10,000짜리 줄을.
--
-- 그런데 그 함수를 부르는 곳에 읽기 경로가 섞여 있다:
--
--   · `/api/paper/account` GET      — 화면을 여는 것만으로 계좌가 생긴다
--   · `/api/wallets/snapshot` MOCK  — **워커가 15분마다 전 사용자에게 만든다**
--
-- 결과: 모의투자를 시작한 적이 없는 사용자에게도 10,000 USDT짜리 계좌가
-- 있다. 지갑 MOCK 탭을 배선하는 순간 그 값이 화면에 **총자산**으로 뜬다 —
-- 사용자가 고른 적 없는 종잣돈이다. "모의투자 시작하기"는 영영 안 뜬다.
--
-- 읽기 경로에서 생성을 걷어내는 것은 코드로 한다. 이 칸은 그것만으로
-- 못 푸는 것을 푼다: **이미 만들어진 줄이 시작된 것인지 아닌지.**
--
--   started_at IS NOT NULL  → 사용자가 명시적으로 시작했다
--   started_at IS NULL      → 자동으로 생긴 빈 껍데기일 수 있다
--
-- ADDITIVE 전용이다. 기존 줄은 아래 백필이 판단한다.
ALTER TABLE public.paper_accounts
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- ── 백필: **쓴 흔적이 있는 계좌만 시작된 것으로 본다** ──
--
-- 자동 생성된 줄은 전부 기본값 그대로다(잔고 = 초기자본, 매매 0, 수수료 0).
-- 그 상태로는 "사용자가 시작했다"를 증명할 수 없다 — 증명하지 못한 것을
-- 통과로 적지 않는다. 흔적이 있는 줄만 시작 시각을 `updated_at`으로 채운다.
--
-- 흔적이 없는데 실제로는 시작했던 계좌는 화면에서 "시작하기"를 다시 보게
-- 된다. 그쪽이 안전하다 — 반대 방향은 **고른 적 없는 종잣돈을 총자산이라고
-- 적는 것**이고, 그건 조용히 틀리는 숫자다.
UPDATE public.paper_accounts
   SET started_at = updated_at
 WHERE started_at IS NULL
   AND (
     COALESCE(trade_count, 0) <> 0
     OR COALESCE(total_fees, 0) <> 0
     OR COALESCE(total_pnl, 0) <> 0
     OR COALESCE(balance, 0) <> COALESCE(initial_balance, 0)
   );

-- 열린 모의 포지션이 있는 계좌도 명백히 쓴 계좌다. 위 조건에서 새는
-- 경우(예: 수수료 0%로 진입해 잔고가 그대로인 경우)를 덮는다.
UPDATE public.paper_accounts a
   SET started_at = a.updated_at
 WHERE a.started_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.paper_positions p
      WHERE p.user_id = a.user_id AND p.status = 'open'
   );
