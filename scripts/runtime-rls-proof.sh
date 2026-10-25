#!/usr/bin/env bash
# scripts/runtime-rls-proof.sh
#
# **098이 진짜 PostgreSQL에서 막는가.**
#
# 격리된 DB를 만들어 ① 044로 취약한 상태를 재현하고 ② 098을 적용한 뒤
# anon·authenticated·service_role의 SELECT·INSERT·UPDATE·DELETE 권한을
# 실측한다. 운영 DB는 건드리지 않는다 — 전용 DB를 만들고 지운다.
#
# 사용: PROOF_DB_URL=postgres://... bash scripts/runtime-rls-proof.sh
set -euo pipefail

: "${PROOF_DB_URL:?PROOF_DB_URL이 필요합니다}"
DB="runtime_rls_proof_$$"
ADMIN="${PROOF_DB_URL}"
fail=0
ok()   { echo "ok  $1  → $2"; }
bad()  { echo "FAIL $1 : $2"; fail=$((fail+1)); }

cleanup() { psql "$ADMIN" -tAqc "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql "$ADMIN" -tAqc "CREATE DATABASE $DB;" >/dev/null
URL="$(echo "$ADMIN" | sed -E "s#/[^/?]+(\?|$)#/$DB\1#")"
ok "전용 DB 생성" "$DB"

# Supabase와 같은 역할 구성 + public 기본 권한
psql "$URL" -tAqc "
create extension if not exists pgcrypto;
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant usage on schema public to anon, authenticated, service_role;
" >/dev/null

psql "$URL" -v ON_ERROR_STOP=1 -q -f supabase/migrations/044_runtime_jobs.sql >/dev/null
# **취약한 상태를 만든다.** Supabase에서 public 표는 이 권한을 물려받는다.
psql "$URL" -tAqc "grant all on public.runtime_jobs, public.runtime_leases, public.runtime_ticks to anon, authenticated;" >/dev/null

priv() { psql "$URL" -tAqc "select has_table_privilege('$1','public.$2','$3');"; }

# ── ① RED: 098 전에는 뚫려 있어야 한다 ──
red=0
for r in anon authenticated; do for t in runtime_jobs runtime_leases runtime_ticks; do
  for p in SELECT INSERT UPDATE DELETE; do
    [ "$(priv $r $t $p)" = "t" ] && red=$((red+1))
  done
done; done
if [ "$red" -eq 24 ]; then ok "RED 재현: 브라우저 역할이 24가지 전부 가능" "$red/24"
else bad "RED 재현" "기대 [24] / 실제 [$red] — 취약 상태를 만들지 못했으면 GREEN은 의미가 없습니다"; fi

# ── ② 098 적용 ──
psql "$URL" -v ON_ERROR_STOP=1 -q -f supabase/migrations/098_runtime_tables_rls.sql >/dev/null
ok "098 적용" "완료"

# ── ③ GREEN: 브라우저 역할은 전부 거부 ──
for r in anon authenticated; do for t in runtime_jobs runtime_leases runtime_ticks; do
  for p in SELECT INSERT UPDATE DELETE; do
    if [ "$(priv $r $t $p)" = "t" ]; then bad "$r 의 $t $p 차단" "여전히 가능합니다"
    else ok "$r $t $p 거부" "t"; fi
  done
done; done

# ── ④ service_role은 그대로여야 한다 (서버·워커를 끊지 않는다) ──
for t in runtime_jobs runtime_leases runtime_ticks; do
  for p in SELECT INSERT UPDATE DELETE; do
    if [ "$(priv service_role $t $p)" = "t" ]; then ok "service_role $t $p 유지" "t"
    else bad "service_role 의 $t $p" "끊겼습니다 — 서버·워커가 동작하지 않습니다"; fi
  done
done

# ── ⑤ RLS·FORCE·정책 상태 ──
psql "$URL" -v ON_ERROR_STOP=1 -q -f scripts/sql/098_runtime_rls_proof.sql 2>&1 | grep -E "NOTICE" | sed 's/^psql.*NOTICE:  //' || true

if [ "$fail" -eq 0 ]; then echo; echo "runtime_* RLS 증명 전부 통과"
else echo; echo "runtime_* RLS 증명 실패 ${fail}건"; exit 1; fi
