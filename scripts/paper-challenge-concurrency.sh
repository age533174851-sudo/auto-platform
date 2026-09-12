#!/usr/bin/env bash
# scripts/paper-challenge-concurrency.sh
#
# **동시에 일어나는 일은 동시에 일으켜서 본다.**
#
# 한 세션 안에서는 경합을 만들 수 없다. `BEGIN … ROLLBACK` 하나로 도는 검사는
# 잠금 순서도, 선점 실패도, 교착도 건드리지 못한다 — 그래서 이 파일은 psql을
# **여러 개 띄운다.**
#
# 무엇을 보는가
# ─────────────
#   ① 같은 사용자가 동시에 챌린지를 만들면 → 활성 1개 · 전용 계좌 1개 ·
#      INITIAL_DEPOSIT 1줄
#   ② 선점(CAS)이 빗나가면 → 원장 0줄 · 잔고 변경 0
#      (사전 조회와 실제 UPDATE 사이에 포지션의 계좌가 바뀌는 상황을
#       **실제로 끼워 넣어서** 만든다)
#   ③ 진입과 청산을 서로 반대로 몰아쳐도 교착이 없다
#
# 운영에 닿지 않는다
# ──────────────────
# 이 스크립트는 `PGDATABASE`가 가리키는 **빈 로컬 DB**에서만 돈다.
set -uo pipefail

# 접속 정보는 두 가지 방식을 받는다.
#
#   · `PAPER_DB_URL` — 접속 URL 하나 (CI가 Supabase CLI에서 받은 값을 넘긴다)
#   · `PGHOST`/`PGPORT`/… — 로컬에서 손으로 돌릴 때
#
# 포트·비밀번호를 이 파일에 박지 않는다. 박으면 CLI가 포트를 바꾸는 날
# 조용히 다른 DB를 보거나 아무것도 검사하지 못한다.
DB="${PAPER_DB_URL:-}"
if [ -z "$DB" ]; then
  : "${PGHOST:?PGHOST 또는 PAPER_DB_URL이 필요합니다}"
  : "${PGPORT:?PGPORT가 필요합니다}"
  : "${PGUSER:?PGUSER가 필요합니다}"
  : "${PGDATABASE:?PGDATABASE가 필요합니다}"
  DB_HOST="$PGHOST"
else
  # URL에서 host만 뽑는다. **값은 출력하지 않는다** — 비밀번호가 들어 있다.
  #
  # 유닉스 소켓은 `postgresql://user@/db?host=/tmp/sock` 모양으로 온다. 권한
  # 부분만 보면 host가 빈 문자열이 되고, 멀쩡한 로컬 접속이 거부된다.
  DB_HOST="$(printf '%s' "$DB" | sed -nE 's|.*[?&]host=([^&]+).*|\1|p')"
  if [ -z "$DB_HOST" ]; then
    DB_HOST="$(printf '%s' "$DB" | sed -E 's|^[a-z]+://||; s|^[^@/]*@||; s|[:/?].*$||')"
  fi
fi

# ── **이 스크립트는 표를 비운다.** 로컬이 아니면 아예 시작하지 않는다 ──
#
# 운영 접속 정보가 실수로 환경에 들어 있어도 여기서 멈춘다. "설마"를 믿지 않는다.
case "$DB_HOST" in
  /*|localhost|127.0.0.1|::1|db|postgres) ;;
  *) echo "거부: 접속 대상이 로컬이 아닙니다 ($DB_HOST) — 이 검사는 표를 비우므로 로컬 빈 DB에서만 돕니다" >&2; exit 1 ;;
esac
if [ -n "${SUPABASE_DB_URL:-}" ] || [ -n "${DATABASE_URL:-}" ]; then
  echo "거부: SUPABASE_DB_URL/DATABASE_URL이 설정돼 있습니다 — 운영에 닿을 수 있는 환경입니다" >&2
  exit 1
fi

fails=0
ok()   { echo "ok  $1  → $2"; }
bad()  { echo "FAIL $1 : 기대 [$2] / 실제 [$3]"; fails=$((fails+1)); }

# **읽지 못한 것을 통과로 적지 않는다.**
#
# 두 값이 "같다"는 것만 보면, 양쪽이 똑같은 오류 문구일 때도 통과가 된다.
# 실제로 그렇게 한 번 틀렸다 — 계좌 id를 못 읽어서 양쪽이 같은 ERROR 문자열이
# 됐는데 "잔고 변경 0"이 초록으로 나왔다. 그래서 값 자체를 먼저 검사한다.
want() {
  local label="$1" expect="$2" got="$3"
  case "$got" in
    ""|*ERROR*|*error:*)
      bad "$label" "$expect" "읽지 못했습니다: ${got:-빈 값}" ; return ;;
  esac
  [ "$expect" = "$got" ] && ok "$label" "$got" || bad "$label" "$expect" "$got"
}

# 한 값을 읽는다. INSERT의 명령 태그("INSERT 0 1")가 섞이지 않게 첫 줄만 쓴다.
# 접속 URL이 있으면 그것을, 없으면 PG* 환경변수를 쓴다.
PSQL() { if [ -n "$DB" ]; then psql "$DB" "$@"; else psql "$@"; fi; }

q()  { PSQL -At -v ON_ERROR_STOP=1 -c "$1" 2>&1 | head -1; }

EV="2026-03-10T00:00:00Z"
START="2026-03-01T00:00:00Z"
END="2026-03-31T00:00:00Z"

# ══════════════ 준비: 깨끗한 상태에서 시작한다 ══════════════
q "DELETE FROM public.paper_challenge_cashflows;
   DELETE FROM public.paper_challenge_transitions;
   DELETE FROM public.paper_challenges;
   DELETE FROM public.paper_positions;
   DELETE FROM public.paper_accounts;" >/dev/null

# ══════════════ ① 동시 생성 ══════════════
#
# **정말로 동시에 출발시킨다.**
#
# psql 프로세스를 N개 띄우는 것만으로는 겹치지 않는다. 프로세스 시작이 수십 ms
# 걸려서 운이 좋으면 저절로 줄을 서고, 그러면 경합이 없는데 초록이 나온다.
# 실제로 그렇게 한 번 틀렸다 — advisory 잠금을 없앤 판이 초록으로 통과했다.
#
# 그래서 **출발선을 만든다.** 제어 세션이 배타 advisory 잠금 99를 쥐고, 일꾼들은
# 같은 번호의 **공유** 잠금을 기다린다. 제어 세션이 풀면 공유 대기자들은 한꺼번에
# 깨어난다 — 그 지점부터가 진짜 동시다.
#
# 99는 제품이 쓰는 키(사용자 id 해시)와 겹치지 않는다.
U1="cc000000-0000-0000-0000-000000000001"
N=8
CTL=/tmp/cc_ctl.out
rm -f $CTL /tmp/cc_*.out

# 제어 세션을 **먼저** 띄운다.
#
# 순서가 중요하다. 일꾼을 먼저 띄우면, 제어 세션이 배타 잠금을 쥐기 전에 도착한
# 일꾼들은 공유 잠금을 그냥 얻어서 지나간다(공유끼리는 서로 막지 않는다).
# 실제로 그렇게 해서 8명 중 4명만 출발선에 모였다 — 그 상태로는 아무것도
# 증명하지 못한다.
(
  PSQL -At -v ON_ERROR_STOP=1 <<SQL
SELECT pg_advisory_lock(99);
\echo BARRIER_HELD
DO \$do\$
DECLARE n INT := 0; tries INT := 0;
BEGIN
  LOOP
    SELECT count(*) INTO n FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted;
    EXIT WHEN n >= $N OR tries > 4000;
    PERFORM pg_sleep(0.005);
    tries := tries + 1;
  END LOOP;
  RAISE NOTICE 'BARRIER_WAITERS=%', n;
END \$do\$;
SELECT pg_advisory_unlock(99);
SQL
) > $CTL 2>&1 &
CTL_PID=$!

# 배타 잠금을 정말 쥔 뒤에 일꾼을 띄운다.
for _ in $(seq 1 400); do grep -q BARRIER_HELD $CTL 2>/dev/null && break; sleep 0.01; done
if ! grep -q BARRIER_HELD $CTL 2>/dev/null; then
  echo "FAIL 출발선을 세우지 못했습니다"; fails=$((fails+1));
fi

for i in $(seq 1 $N); do
  (
    PSQL -At -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT pg_advisory_xact_lock_shared(99);   -- 출발선에서 기다린다
SELECT created FROM public.paper_challenge_create(
  '$U1'::uuid, 1000, 1200, 900,
  '$START'::timestamptz, '$END'::timestamptz, '$EV'::timestamptz);
COMMIT;
SQL
  ) > "/tmp/cc_w$i.out" 2>&1 &
done

wait $CTL_PID
wait
barrier=$(grep -oE 'BARRIER_WAITERS=[0-9]+' $CTL | head -1 | cut -d= -f2)

# 출발선에 정말 N명이 모였는가. 안 모였으면 이 검사는 경합을 만들지 못했다.
want "동시 생성: 출발선에 $N명이 동시에 모였다" "$N" "${barrier:-읽지 못함}"

created_true=$(cat /tmp/cc_w*.out 2>/dev/null | grep -c '^t$')
created_false=$(cat /tmp/cc_w*.out 2>/dev/null | grep -c '^f$')
errors=$(grep -lhi 'error' /tmp/cc_w*.out 2>/dev/null | wc -l)

want "동시 생성 $N개: 활성 챌린지는 1개" "1" "$(q "SELECT count(*) FROM public.paper_challenges WHERE user_id='$U1'")"
want "동시 생성 $N개: 전용 계좌도 1개"   "1" "$(q "SELECT count(*) FROM public.paper_accounts WHERE user_id='$U1'")"
want "동시 생성 $N개: INITIAL_DEPOSIT 1줄" "1" \
  "$(q "SELECT count(*) FROM public.paper_challenge_cashflows WHERE cashflow_type='INITIAL_DEPOSIT'")"
want "동시 생성 $N개: created=true는 1개"  "1" "$created_true"
want "동시 생성 $N개: 나머지는 created=false" "$((N-1))" "$created_false"
want "동시 생성 $N개: 오류로 끝난 세션 0"  "0" "$errors"
want "동시 생성 $N개: SUM(원장)=잔고" "t" \
  "$(q "SELECT (a.balance = (SELECT COALESCE(SUM(f.amount),0) FROM public.paper_challenge_cashflows f WHERE f.challenge_id=c.id))
        FROM public.paper_challenges c JOIN public.paper_accounts a ON a.id=c.paper_account_id WHERE c.user_id='$U1'")"
rm -f /tmp/cc_w*.out $CTL

# ══════════════ ② 선점이 빗나가면 아무것도 안 바뀐다 ══════════════
#
# `paper_settle_close`의 ①은 **잠그지 않고** 포지션을 읽어 어느 계좌인지 안다.
# 그 사이에 포지션의 계좌가 바뀌면 우리는 엉뚱한 계좌를 잠근 것이고, ④의 CAS가
# 0행이 돼야 한다 — **원장도 잔고도 건드리지 않고** 끝나야 한다.
#
# 그 틈을 실제로 만든다:
#   B: 계좌 X를 FOR UPDATE로 쥔다
#   A: paper_settle_close 호출 → ①에서 X를 읽고, ②에서 X 잠금에 막힌다
#   B: 포지션을 계좌 Y로 옮기고 COMMIT
#   A: 깨어나 X를 잠그고, ④ CAS가 `paper_account_id = X`에서 빗나간다
U2="cc000000-0000-0000-0000-000000000002"
ACC_X=$(q "INSERT INTO public.paper_accounts (user_id, is_default, balance, initial_balance)
           VALUES ('$U2'::uuid, TRUE, 1000, 1000) RETURNING id")
ACC_Y=$(q "INSERT INTO public.paper_accounts (user_id, is_default, balance, initial_balance)
           VALUES ('$U2'::uuid, FALSE, 500, 500) RETURNING id")
POS=$(q "SELECT position_id FROM public.paper_open_position(
          '$U2'::uuid, 'cas-sig', NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
          100, 100, 1, 100, 1, 100, NULL, NULL, 50, 0, 'ISOLATED',
          '$EV'::timestamptz, '$ACC_X'::uuid)")

bal_x_before=$(q "SELECT balance FROM public.paper_accounts WHERE id='$ACC_X'")
bal_y_before=$(q "SELECT balance FROM public.paper_accounts WHERE id='$ACC_Y'")

# B: 계좌 X를 쥐고, A가 막히기를 기다린 뒤 포지션을 옮긴다.
(
  PSQL -At -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT id FROM public.paper_accounts WHERE id='$ACC_X' FOR UPDATE;
-- A가 ②에서 이 잠금에 막힐 때까지 기다린다. 시간이 아니라 **상태**를 본다.
DO \$do\$
DECLARE n INT := 0; tries INT := 0;
BEGIN
  LOOP
    SELECT count(*) INTO n FROM pg_locks l
      JOIN pg_stat_activity s ON s.pid = l.pid
     WHERE NOT l.granted AND s.pid <> pg_backend_pid();
    EXIT WHEN n > 0 OR tries > 500;
    PERFORM pg_sleep(0.01);
    tries := tries + 1;
  END LOOP;
END \$do\$;
UPDATE public.paper_positions SET paper_account_id='$ACC_Y'::uuid WHERE id='$POS';
COMMIT;
SQL
) > /tmp/cas_b.out 2>&1 &
B_PID=$!

sleep 0.3
settled=$(q "SELECT settled FROM public.paper_settle_close(
              '$POS'::uuid, 110, 'TP', 1, 10, 9, 1, '$EV'::timestamptz)")
wait $B_PID

want "CAS 빗나감: settled=false" "f" "$settled"
want "CAS 빗나감: 포지션은 여전히 open" "open" "$(q "SELECT status FROM public.paper_positions WHERE id='$POS'")"
want "CAS 빗나감: 계좌 X 잔고 변경 0" "$bal_x_before" "$(q "SELECT balance FROM public.paper_accounts WHERE id='$ACC_X'")"
want "CAS 빗나감: 계좌 Y 잔고 변경 0" "$bal_y_before" "$(q "SELECT balance FROM public.paper_accounts WHERE id='$ACC_Y'")"
want "CAS 빗나감: 원장 줄 0" "0" \
  "$(q "SELECT count(*) FROM public.paper_challenge_cashflows WHERE source_event_id='$POS'")"

# ══════════════ ③ 교착이 없다 ══════════════
#
# 진입(계좌 → 챌린지 → 포지션)과 청산(계좌 → 챌린지 → 포지션)이 같은 방향이므로
# 역전이 없어야 한다. **그 말이 맞는지 몰아쳐서 본다.**
U3="cc000000-0000-0000-0000-000000000003"
read -r CH3 ACC3 <<< "$(q "SELECT challenge_id || ' ' || paper_account_id
  FROM public.paper_challenge_create('$U3'::uuid, 100000, 999999, NULL,
    '$START'::timestamptz, '$END'::timestamptz, '$EV'::timestamptz)")"

TX=80
for i in $(seq 1 $TX); do
  (
    PSQL -At -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT position_id FROM public.paper_open_position(
  '$U3'::uuid, 'stress-$i', NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
  100, 100, 1, 100, 1, 10, NULL, NULL, 50, 0.1, 'ISOLATED',
  '$EV'::timestamptz, '$ACC3'::uuid);
COMMIT;
SQL
  ) > "/tmp/st_o_$i.out" 2>&1 &
  (
    PSQL -At -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT settled FROM public.paper_settle_close(
  (SELECT id FROM public.paper_positions
    WHERE user_id='$U3'::uuid AND status='open' ORDER BY opened_at LIMIT 1),
  110, 'TP', 0.1, 1, 0.9, 1, '$EV'::timestamptz);
COMMIT;
SQL
  ) > "/tmp/st_c_$i.out" 2>&1 &
done
wait

deadlocks=$(grep -lh '40P01\|deadlock' /tmp/st_*.out 2>/dev/null | wc -l)
want "진입·청산 $((TX*2))개 동시: 교착 0건" "0" "$deadlocks"
want "몰아친 뒤에도 SUM(원장)=잔고" "t" \
  "$(q "SELECT (a.balance = (SELECT COALESCE(SUM(f.amount),0)
          FROM public.paper_challenge_cashflows f WHERE f.challenge_id='$CH3'))
        FROM public.paper_accounts a WHERE a.id='$ACC3'")"
rm -f /tmp/st_*.out /tmp/cas_b.out

echo
if [ "$fails" -ne 0 ]; then
  echo "동시성 증명 실패 ${fails}건"
  exit 1
fi
echo "동시성 증명 전부 통과"
