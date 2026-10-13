-- BAS-1441: Directories → Team показывает роли модуля (Admin / Project Manager /
-- Schedule Manager / Lead Carpenter) вместо старых ролей Lovable из tp_user_roles
-- («Team Lead», «PM», «Super Admin»).
--
-- Directories открыт Admin модуля, а читать чужие назначения (app_user_roles) и аккаунты
-- может только админ портала. Поэтому — функция security definer: по каждой бригаде
-- (tp_teams) находит пользователя портала с тем же email и отдаёт его роли в Task Planner.
-- Вызвать её может только Admin модуля.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

create or replace function public.tp_team_roles()
returns table (team_id uuid, has_account boolean, roles text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.tp_has_module_role('admin') then
    raise exception 'Only Task Planner admins can read team roles' using errcode = '42501';
  end if;

  return query
  select
    t.id,
    u.id is not null,
    coalesce(
      array(
        select r.role_key from public.app_user_roles r
        where r.user_id = u.id and r.app_code = 'task-planner'
        order by r.role_key
      ),
      array[]::text[]
    )
  from public.tp_teams t
  left join auth.users u on t.email is not null and lower(u.email) = lower(t.email);
end $$;

revoke all on function public.tp_team_roles() from public;
grant execute on function public.tp_team_roles() to authenticated;
