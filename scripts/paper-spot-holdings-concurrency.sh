#!/usr/bin/env bash
# scripts/paper-spot-holdings-concurrency.sh
#
# **현물 분할매도를 동시에 일으켜서 본다.**
#
# `scripts/sql/088_..._proof.sql`은 한 세션 안에서 돈다. 거기서는 멱등도
# 선점도 **줄을 선 상태**로만 확인된다 — 두 번째 호출이 첫 번째가 끝난 뒤에
# 오기 때문이다. 재시도가 정말 겹쳤을 때 두 번 팔리는지는 psql을 여러 개
# 띄워야 안다.
#
# 무엇을 보는가
# ─────────────
#   ① 같은 `client_sell_id`로 8개가 동시에 들어오면 → **SOLD는 정확히 1개**,
#      나머지는 REPLAYED. 매도 사건 1줄 · 원장 2줄
#   ② 70% + 70%가 동시에 들어오면 → 판 합이 보유를 **넘지 않는다**
#   ③ 분할매도와 legacy 전량청산이 동시에 들어오면 → 그 lot은 한 번만 처분된다
#   ④ 같은 종목 매수와 매도를 서로 몰아쳐도 교착이 없다
#   모든 검사 뒤 불변식: `SUM(cashflows) = balance`
#
# 운영에 닿지 않는다
# ──────────────────
# `PGDATABASE`가 가리키는 **빈 로컬 DB**에서만 돈다.
set -uo pipefail

DB="${PAPER_DB_URL:-}"
if [ -z "$DB" ]; then
  : "${PGHOST:?PGHOST 또는 PAPER_DB_URL이 필요합니다}"
  : "${PGPORT:?PGPORT가 필요합니다}"
  : "${PGUSER:?PGUSER가 필요합니다}"
  : "${PGDATABASE:?PGDATABASE가 필요합니다}"
  DB_HOST="$PGHOST"
else
  DB_HOST="$(printf '%s' "$DB" | sed -nE 's|.*[?&]host=([^&]+).*|\1|p')"
  if [ -z "$DB_HOST" ]; then
    DB_HOST="$(printf '%s' "$DB" | sed -E 's|^[a-z]+://||; s|^[^@/]*@||; s|[:/?].*$||')"
  fi
fi

# **이 스크립트는 표를 비운다.** 로컬이 아니면 시작하지 않는다.
case "$DB_HOST" in
  /*|localhost|127.0.0.1|::1|db|postgres) ;;
  *) echo "거부: 접속 대상이 로컬이 아닙니다 ($DB_HOST) — 이 검사는 표를 비우므로 로컬 빈 DB에서만 돕니다" >&2; exit 1 ;;
esac
if [ -n "${SUPABASE_DB_URL:-}" ] || [ -n "${DATABASE_URL:-}" ]; then
  echo "거부: SUPABASE_DB_URL/DATABASE_URL이 설정돼 있습니다 — 운영에 닿을 수 있는 환경입니다" >&2
  exit 1
fi

fails=0
ok()  { echo "ok  $1  → $2"; }
bad() { echo "FAIL $1 : 기대 [$2] / 실제 [$3]"; fails=$((fails+1)); }

# **읽지 못한 것을 통과로 적지 않는다.**
want() {
  local label="$1" expect="$2" got="$3"
  case "$got" in
    ""|*ERROR*|*error:*) bad "$label" "$expect" "읽지 못했습니다: ${got:-빈 값}"; return ;;
  esac
  [ "$expect" = "$got" ] && ok "$label" "$got" || bad "$label" "$expect" "$got"
}

PSQL() { if [ -n "$DB" ]; then psql "$DB" "$@"; else psql "$@"; fi; }
q() { PSQL -At -v ON_ERROR_STOP=1 -c "$1" 2>&1 | head -1; }

U="cd000000-0000-0000-0000-000000000001"
V="cd000000-0000-0000-0000-000000000002"

reset_all() {
  q "DELETE FROM public.paper_sell_event_lots;
     DELETE FROM public.paper_sell_events;
     DELETE FROM public.paper_challenge_cashflows;
     DELETE FROM public.paper_challenge_transitions;
     DELETE FROM public.paper_challenges;
     DELETE FROM public.paper_positions;
     DELETE FROM public.paper_accounts;" >/dev/null
}

# 현물 lot 하나를 만들고 계좌 id를 돌려준다.
setup_holding() {           # $1 user  $2 sig  $3 symbol  $4 mark  $5 qty
  q "SELECT public.paper_challenge_create(
       '$1'::uuid, 100000, 100000000, 1,
       NOW() - INTERVAL '1 hour', NOW() + INTERVAL '10 days', NOW())" >/dev/null
  local acct
  acct="$(q "SELECT c.paper_account_id FROM public.paper_challenges c WHERE c.user_id='$1'::uuid")"
  q "SELECT public.paper_open_position(
       '$1'::uuid, '$2', NULL, NULL, '$3', 'SPOT', 'LONG',
       $4, $4*1.0005, ($5*$4)/($4*1.0005), $5*$4, 1, $5*$4,
       NULL, NULL, NULL, ($5*$4)*0.0005, 'ISOLATED', NOW(), '$acct'::uuid)" >/dev/null
  echo "$acct"
}

invariant() {               # $1 label
  local n
  n="$(q "SELECT count(*) FROM public.paper_challenges c
            JOIN public.paper_accounts a ON a.id = c.paper_account_id
           WHERE a.balance IS DISTINCT FROM
                 (SELECT COALESCE(SUM(f.amount),0) FROM public.paper_challenge_cashflows f
                   WHERE f.challenge_id = c.id)")"
  want "불변식 $1: 잔고≠원장인 챌린지 0건" "0" "$n"
}

# **출발선.** 제어 세션이 배타 advisory 잠금 99를 쥐고, 일꾼들은 같은 번호의
# 공유 잠금을 기다린다. 풀리는 순간 한꺼번에 깨어난다 — 거기부터가 진짜 동시다.
# 99는 제품이 쓰는 키(사용자 id 해시)와 겹치지 않는다.
race() {                    # $1 N  $2 SQL(각 일꾼이 실행)  $3 출력파일
  local n="$1" sql="$2" out="$3"
  : > "$out"
  PSQL -At -v ON_ERROR_STOP=1 -c "SELECT pg_advisory_lock(99)" >/dev/null 2>&1 &
  local ctl=$!
  sleep 0.3
  local i
  for i in $(seq 1 "$n"); do
    ( PSQL -At -c "SELECT pg_advisory_lock_shared(99); $sql" 2>&1 | tail -1 >> "$out" ) &
  done
  sleep 1.2
  kill "$ctl" 2>/dev/null
  wait 2>/dev/null
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ══════════════ ① 같은 식별자 8개 동시 ══════════════
reset_all
ACC="$(setup_holding "$U" 'race-1' 'BTCUSDT' 60000 0.01)"
race 8 "SELECT out_status FROM public.paper_sell_holding(
          '$U'::uuid, '$ACC'::uuid, 'SPOT', 'BTCUSDT', 25, NULL, 66000, 0.0005,
          'same-id', NOW())" "$TMP/r1"
want "① SOLD는 정확히 1개" "1" "$(grep -c '^SOLD$' "$TMP/r1")"
want "① 매도 사건 1줄" "1" "$(q "SELECT count(*) FROM public.paper_sell_events")"
want "① 그 매도의 원장 2줄" "2" \
  "$(q "SELECT count(*) FROM public.paper_challenge_cashflows f
         WHERE f.source_event_type='POSITION_SELL'")"
want "① 나머지는 전부 REPLAYED" "7" "$(grep -c '^REPLAYED$' "$TMP/r1")"
invariant "①"

# ══════════════ ② 70% + 70% 동시 ══════════════
reset_all
ACC="$(setup_holding "$U" 'race-2' 'ETHUSDT' 3000 1)"
HELD="$(q "SELECT SUM(quantity) FROM public.paper_positions WHERE status='open'")"
race 2 "SELECT out_status FROM public.paper_sell_holding(
          '$U'::uuid, '$ACC'::uuid, 'SPOT', 'ETHUSDT', 70, NULL, 3100, 0.0005,
          'race-' || md5(random()::text), NOW())" "$TMP/r2"
want "② 판 합이 보유를 넘지 않았다" "t" \
  "$(q "SELECT (COALESCE(SUM(sold_quantity),0) <= $HELD) FROM public.paper_sell_events")"
want "② 남은 수량이 음수가 아니다" "t" \
  "$(q "SELECT (COALESCE(MIN(quantity),0) >= 0) FROM public.paper_positions")"
invariant "②"

# ══════════════ ③ 분할매도 vs legacy 전량청산 ══════════════
reset_all
ACC="$(setup_holding "$U" 'race-3' 'SOLUSDT' 100 5)"
POS="$(q "SELECT id FROM public.paper_positions WHERE status='open' LIMIT 1")"
: > "$TMP/r3"
PSQL -At -v ON_ERROR_STOP=1 -c "SELECT pg_advisory_lock(99)" >/dev/null 2>&1 &
CTL=$!
sleep 0.3
( PSQL -At -c "SELECT pg_advisory_lock_shared(99);
    SELECT 'SELL:' || out_status FROM public.paper_sell_holding(
      '$U'::uuid, '$ACC'::uuid, 'SPOT', 'SOLUSDT', 100, NULL, 110, 0.0005,
      'race3-sell', NOW())" 2>&1 | tail -1 >> "$TMP/r3" ) &
( PSQL -At -c "SELECT pg_advisory_lock_shared(99);
    SELECT 'CLOSE:' || settled FROM public.paper_settle_close(
      '$POS'::uuid, 110, 'MANUAL', 1, 10, 9, 0, NOW())" 2>&1 | tail -1 >> "$TMP/r3" ) &
sleep 1.2
kill "$CTL" 2>/dev/null
wait 2>/dev/null
want "③ 그 lot은 한 번만 처분됐다 (닫힌 줄 1)" "1" \
  "$(q "SELECT count(*) FROM public.paper_positions WHERE status='closed'")"
want "③ 열린 줄이 남지 않았다" "0" \
  "$(q "SELECT count(*) FROM public.paper_positions WHERE status='open'")"
want "③ 처분 원장은 한 경로에서만 나왔다" "1" \
  "$(q "SELECT count(DISTINCT source_event_type) FROM public.paper_challenge_cashflows
         WHERE source_event_type IN ('POSITION_SELL','POSITION_CLOSE')")"
invariant "③"

# ══════════════ ④ 같은 종목 매수 vs 매도 ══════════════
reset_all
ACC="$(setup_holding "$V" 'race-4' 'ADAUSDT' 2 1000)"
: > "$TMP/r4"
PSQL -At -v ON_ERROR_STOP=1 -c "SELECT pg_advisory_lock(99)" >/dev/null 2>&1 &
CTL=$!
sleep 0.3
for i in 1 2 3 4; do
  ( PSQL -At -c "SELECT pg_advisory_lock_shared(99);
      SELECT 'SELL:' || out_status FROM public.paper_sell_holding(
        '$V'::uuid, '$ACC'::uuid, 'SPOT', 'ADAUSDT', 10, NULL, 2.2, 0.0005,
        'race4-s$i', NOW())" 2>&1 | tail -1 >> "$TMP/r4" ) &
  ( PSQL -At -c "SELECT pg_advisory_lock_shared(99);
      SELECT 'BUY:' || status FROM public.paper_open_position(
        '$V'::uuid, 'race4-b$i', NULL, NULL, 'ADAUSDT', 'SPOT', 'LONG',
        2, 2.001, 49.975, 100, 1, 100, NULL, NULL, NULL, 0.05, 'ISOLATED',
        NOW(), '$ACC'::uuid)" 2>&1 | tail -1 >> "$TMP/r4" ) &
done
sleep 2
kill "$CTL" 2>/dev/null
wait 2>/dev/null
want "④ 교착이 없었다 (deadlock 0)" "0" "$(grep -ci 'deadlock' "$TMP/r4")"
want "④ 매수 4건이 전부 들어갔다" "4" \
  "$(q "SELECT count(*) FROM public.paper_positions WHERE signal_id LIKE 'race4-b%'")"
want "④ 남은 수량이 음수가 아니다" "t" \
  "$(q "SELECT (COALESCE(MIN(quantity),0) >= 0) FROM public.paper_positions")"
invariant "④"

reset_all
echo
if [ "$fails" -gt 0 ]; then
  echo "현물 분할매도 동시성 검사 실패 ${fails}건"
  exit 1
fi
echo "현물 분할매도 동시성 검사 전부 통과"
