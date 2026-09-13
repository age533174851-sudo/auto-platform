#!/usr/bin/env bash
# scripts/paper-challenge-finalizer-concurrency.sh
#
# **마감을 동시에 두 번 시도해 본다.**
#
# `086`의 계약은 한 세션 안에서는 증명되지 않는다. "CAS로 한 번만 닫힌다"는
# 말은 **두 세션이 실제로 겹쳤을 때만** 뜻이 있다. 그래서 psql을 여러 개 띄운다.
#
# 무엇을 보는가
# ─────────────
#   ① 같은 챌린지에 finalizer 둘 → CLOSED 정확히 1회 · 전이 로그 1줄
#   ② 마감과 마지막 청산이 겹쳐도 → **포지션이 남은 채 CLOSED가 되지 않는다**
#   ③ 만료 스윕과 청산이 겹쳐도 → 사유 1개 · 불변식 유지
#   ④ 어느 판에서도 교착(40P01) 0건
#
# 잠금 순서를 지켰다는 것은 **교착이 안 났다**로만 증명된다. 순서를 뒤집은
# 판이 어떻게 되는지는 뮤테이션 쪽에서 본다.
#
# 운영에 닿지 않는다
# ──────────────────
# `PAPER_DB_URL`(또는 PG*)이 가리키는 **빈 로컬 DB**에서만 돈다. 표를 비운다.
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

case "$DB_HOST" in
  /*|localhost|127.0.0.1|::1|db|postgres) ;;
  *) echo "거부: 접속 대상이 로컬이 아닙니다 ($DB_HOST) — 이 검사는 표를 비웁니다" >&2; exit 1 ;;
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

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

reset_all() {
  q "DELETE FROM public.paper_challenge_cashflows;
     DELETE FROM public.paper_challenge_transitions;
     DELETE FROM public.paper_challenges;
     DELETE FROM public.paper_positions;
     DELETE FROM public.paper_accounts;" >/dev/null
}

# 출발선. 제어 세션이 배타 advisory 잠금 77을 쥐고, 일꾼은 같은 번호의 **공유**
# 잠금을 기다린다. 풀면 한꺼번에 깨어난다 — 그 지점부터가 진짜 동시다.
BARRIER=77
start_barrier() {
  PSQL -At -v ON_ERROR_STOP=1 -c \
    "SELECT pg_advisory_lock($BARRIER); SELECT pg_sleep(30);" >/dev/null 2>&1 &
  CTRL_PID=$!
  sleep 1
}
release_barrier() {
  kill "$CTRL_PID" 2>/dev/null
  wait "$CTRL_PID" 2>/dev/null
}
waiters() { q "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=$BARRIER AND NOT granted"; }

# ══════════════ 준비 도우미 ══════════════
# 만료돼 CLOSING이 된 챌린지 하나를 만든다. 포지션 수는 인자로 정한다.
make_closing() {
  local uid="$1" positions="$2"
  q "INSERT INTO auth.users (id, email) VALUES ('$uid', '$uid@conc') ON CONFLICT DO NOTHING;" >/dev/null
  q "SELECT challenge_id || ' ' || paper_account_id FROM public.paper_challenge_create(
       '$uid', 1000, 1200, 800,
       clock_timestamp() - interval '2 hours',
       clock_timestamp() - public.paper_event_max_lag() - interval '1 minute',
       clock_timestamp() - interval '2 hours')"
}

echo "── ① 같은 챌린지에 finalizer 둘 ──"
reset_all
U1="dd000000-0000-0000-0000-000000000001"
read -r CH1 ACC1 <<<"$(make_closing "$U1" 0)"
q "SELECT count(*) FROM public.paper_challenge_sweep_due()" >/dev/null
want "  만료로 CLOSING이 됐다" "CLOSING" "$(q "SELECT status FROM public.paper_challenges WHERE id='$CH1'")"

start_barrier
for i in 1 2; do
  ( PSQL -At -v ON_ERROR_STOP=1 -c \
      "SELECT pg_advisory_lock_shared($BARRIER);
       SELECT code FROM public.paper_challenge_finalize('$CH1');" \
      > "$OUT/fin.$i" 2>&1 ) &
done
sleep 2
want "  둘이 출발선에 모였다" "2" "$(waiters)"
release_barrier
wait

CLOSED_N=$(cat "$OUT"/fin.* 2>/dev/null | grep -c '^CLOSED$' || true)
want "★ CLOSED를 돌려받은 것은 하나뿐" "1" "$CLOSED_N"
want "  상태는 CLOSED" "CLOSED" "$(q "SELECT status FROM public.paper_challenges WHERE id='$CH1'")"
want "  최종 상태 = 동결된 사유" "EXPIRED" "$(q "SELECT terminal_status FROM public.paper_challenges WHERE id='$CH1'")"
want "  CLOSED 전이 로그는 한 줄" "1" \
  "$(q "SELECT count(*) FROM public.paper_challenge_transitions WHERE challenge_id='$CH1' AND to_status='CLOSED'")"
want "  교착 0건" "0" "$(grep -lc '40P01\|deadlock' "$OUT"/fin.* 2>/dev/null | wc -l | tr -d ' ')"

echo ""
echo "── ② 마감과 마지막 청산이 겹친다 ──"
reset_all
U2="dd000000-0000-0000-0000-000000000002"
read -r CH2 ACC2 <<<"$(make_closing "$U2" 1)"
POS2=$(q "SELECT position_id FROM public.paper_open_position(
  p_user_id => '$U2', p_signal_id => 'conc-2', p_strategy_id => 's', p_bucket => NULL,
  p_symbol => 'BTCUSDT', p_market => 'USDM', p_side => 'LONG', p_entry_price => 100,
  p_fill_price => 100, p_quantity => 1, p_notional => 100, p_leverage => 1, p_margin => 100,
  p_stop_loss => NULL, p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 1,
  p_margin_mode => 'ISOLATED', p_event_effective_at => clock_timestamp(),
  p_paper_account_id => '$ACC2')")
q "SELECT count(*) FROM public.paper_challenge_sweep_due()" >/dev/null
want "  CLOSING이고 포지션이 하나 남았다" "1" \
  "$(q "SELECT count(*) FROM public.paper_positions WHERE paper_account_id='$ACC2' AND status='open'")"

start_barrier
( PSQL -At -v ON_ERROR_STOP=1 -c \
    "SELECT pg_advisory_lock_shared($BARRIER);
     SELECT settled FROM public.paper_settle_close('$POS2', 110, 'MANUAL', 1, 10, 8, 8, clock_timestamp());" \
    > "$OUT/close.2" 2>&1 ) &
( PSQL -At -v ON_ERROR_STOP=1 -c \
    "SELECT pg_advisory_lock_shared($BARRIER);
     SELECT code FROM public.paper_challenge_finalize('$CH2');" \
    > "$OUT/fin.2" 2>&1 ) &
sleep 2
want "  둘이 출발선에 모였다" "2" "$(waiters)"
release_barrier
wait

FIN2="$(tail -1 "$OUT/fin.2")"
case "$FIN2" in
  CLOSED|POSITIONS_OPEN) ok "★ 마감 결과가 계약 안이다" "$FIN2" ;;
  *) bad "★ 마감 결과가 계약 안이다" "CLOSED 또는 POSITIONS_OPEN" "$FIN2" ;;
esac
# **포지션이 남은 채로 CLOSED가 되는 일은 없어야 한다.**
want "★ 포지션이 남은 채 CLOSED가 되지 않았다" "0" \
  "$(q "SELECT count(*) FROM public.paper_challenges c
         WHERE c.id='$CH2' AND c.status='CLOSED'
           AND EXISTS (SELECT 1 FROM public.paper_positions pp
                        WHERE pp.paper_account_id=c.paper_account_id AND pp.status='open')")"
want "  불변식 SUM(원장) = 잔고" "true" \
  "$(q "SELECT (COALESCE((SELECT SUM(f.amount) FROM public.paper_challenge_cashflows f WHERE f.challenge_id='$CH2'),0)
              = (SELECT a.balance FROM public.paper_accounts a WHERE a.id='$ACC2'))::text")"
want "  교착 0건" "0" "$(grep -lc '40P01\|deadlock' "$OUT/close.2" "$OUT/fin.2" 2>/dev/null | wc -l | tr -d ' ')"

echo ""
echo "── ③ 만료 스윕과 청산이 겹친다 ──"
reset_all
U3="dd000000-0000-0000-0000-000000000003"
read -r CH3 ACC3 <<<"$(make_closing "$U3" 1)"
POS3=$(q "SELECT position_id FROM public.paper_open_position(
  p_user_id => '$U3', p_signal_id => 'conc-3', p_strategy_id => 's', p_bucket => NULL,
  p_symbol => 'BTCUSDT', p_market => 'USDM', p_side => 'LONG', p_entry_price => 100,
  p_fill_price => 100, p_quantity => 1, p_notional => 100, p_leverage => 1, p_margin => 100,
  p_stop_loss => NULL, p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 1,
  p_margin_mode => 'ISOLATED', p_event_effective_at => clock_timestamp(),
  p_paper_account_id => '$ACC3')")

start_barrier
( PSQL -At -v ON_ERROR_STOP=1 -c \
    "SELECT pg_advisory_lock_shared($BARRIER);
     SELECT count(*) FROM public.paper_challenge_sweep_due();" > "$OUT/sweep.3" 2>&1 ) &
( PSQL -At -v ON_ERROR_STOP=1 -c \
    "SELECT pg_advisory_lock_shared($BARRIER);
     SELECT settled FROM public.paper_settle_close('$POS3', 400, 'TP', 1, 300, 298, 298, clock_timestamp());" \
    > "$OUT/close.3" 2>&1 ) &
sleep 2
want "  둘이 출발선에 모였다" "2" "$(waiters)"
release_barrier
wait

want "★ 사유는 하나만 정해졌다" "1" \
  "$(q "SELECT count(*) FROM public.paper_challenge_transitions
         WHERE challenge_id='$CH3' AND transition_key='INTENT:$CH3'")"
want "  사유가 비어 있지 않다" "false" \
  "$(q "SELECT (close_intent IS NULL)::text FROM public.paper_challenges WHERE id='$CH3'")"
want "  불변식 SUM(원장) = 잔고" "true" \
  "$(q "SELECT (COALESCE((SELECT SUM(f.amount) FROM public.paper_challenge_cashflows f WHERE f.challenge_id='$CH3'),0)
              = (SELECT a.balance FROM public.paper_accounts a WHERE a.id='$ACC3'))::text")"
want "  교착 0건" "0" "$(grep -lc '40P01\|deadlock' "$OUT/sweep.3" "$OUT/close.3" 2>/dev/null | wc -l | tr -d ' ')"

echo ""
if [ "$fails" -ne 0 ]; then
  echo "챌린지 마감 동시성 실패 ${fails}건"
  exit 1
fi
echo "챌린지 마감 동시성 전부 통과"
