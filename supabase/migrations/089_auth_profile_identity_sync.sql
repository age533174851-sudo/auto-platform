-- 089_auth_profile_identity_sync.sql
-- auth.users의 이메일/표시 이름 변경을 public.profiles와 동기화한다.
--
-- 계정 설정에서 Auth 이메일을 바꿨는데 profiles.email이 예전 값으로 남으면
-- 관리자/프로필 화면이 서로 다른 로그인 아이디를 보여 준다. Auth가 정본이고,
-- 변경이 확정된 뒤 이 트리거가 프로필 사본을 맞춘다.

create or replace function public.sync_profile_identity_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set email = coalesce(new.email, email),
         display_name = coalesce(
           nullif(new.raw_user_meta_data->>'display_name',''),
           display_name
         ),
         updated_at = now()
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_identity_updated on auth.users;
create trigger on_auth_user_identity_updated
  after update of email, raw_user_meta_data on auth.users
  for each row execute function public.sync_profile_identity_from_auth();

revoke all on function public.sync_profile_identity_from_auth() from public, anon, authenticated;
grant execute on function public.sync_profile_identity_from_auth() to service_role;
