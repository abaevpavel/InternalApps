-- 0010 — приём приглашений (invitations) на стороне БД.
--
-- Проблема: «Add User» писал строку в `invitations` и на этом всё заканчивалось.
-- Профиль, роли и `accepted_at` не проставлял никто: ни фронт (нет ни одного места,
-- где пишется accepted_at), ни edge-функции. Приглашение висело «Invited» вечно,
-- а UI рисовал его `role_ids` как настоящую роль — при том что в `profiles`/`user_roles`
-- по этому email не было ничего. Любой другой клиент той же БД (Lovable) видел ноль апок.
--
-- Решение — принимать приглашение в БД, чтобы это работало для ЛЮБОГО клиента:
--   1) `accept_invitation_for(uid, email)` — вся логика, security definer (обходит RLS);
--   2) триггер на `auth.users` — новый Google-аккаунт принимает приглашение сам;
--   3) RPC `accept_my_invitation()` — для тех, чей auth-аккаунт уже существовал
--      ДО приглашения (триггер на INSERT для них не сработает никогда);
--   4) backfill — закрыть уже висящие приглашения, у которых аккаунт уже есть.
--
-- Схема живой БД (Lovable): profiles(id, user_id, email, first_name, last_name),
-- user_roles(user_id, role_id), invitations(email, role_ids, expires_at, accepted_at).

-- ---------------- 1. Ядро ----------------

create or replace function public.accept_invitation_for(p_user_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email      text := lower(trim(coalesce(p_email, '')));
  v_invite     record;
  v_profile_id uuid;
  v_role_id    uuid;
begin
  if p_user_id is null or v_email = '' then
    return false;
  end if;

  -- Самое свежее не принятое и не истёкшее приглашение на этот email.
  select * into v_invite
  from public.invitations
  where lower(email) = v_email
    and accepted_at is null
    and (expires_at is null or expires_at > now())
  order by created_at desc
  limit 1;

  if not found then
    return false;
  end if;

  -- Профиль: либо уже есть строка по email (тогда только линкуем), либо создаём.
  select id into v_profile_id
  from public.profiles
  where lower(email) = v_email
  order by user_id nulls last
  limit 1;

  if v_profile_id is null then
    insert into public.profiles (user_id, email)
    values (p_user_id, v_email)
    returning id into v_profile_id;
  else
    update public.profiles
    set user_id = p_user_id
    where id = v_profile_id and user_id is null;
  end if;

  -- Роли из приглашения. `to_jsonb` — чтобы работало и с uuid[], и с jsonb в role_ids.
  for v_role_id in
    select (value #>> '{}')::uuid
    from jsonb_array_elements(to_jsonb(coalesce(v_invite.role_ids, '[]'::jsonb))) as value
  loop
    if not exists (
      select 1 from public.user_roles
      where user_id = p_user_id and role_id = v_role_id
    ) then
      insert into public.user_roles (user_id, role_id) values (p_user_id, v_role_id);
    end if;
  end loop;

  update public.invitations set accepted_at = now() where id = v_invite.id;

  return true;
end;
$$;

-- ---------------- 2. Триггер на новый auth-аккаунт ----------------

create or replace function public.handle_new_user_invitation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Приглашения нет — ничего не делаем: whitelist остаётся закрытым.
  perform public.accept_invitation_for(new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_accept_invitation on auth.users;
create trigger on_auth_user_created_accept_invitation
  after insert on auth.users
  for each row execute function public.handle_new_user_invitation();

-- ---------------- 3. RPC для уже существующих аккаунтов ----------------

create or replace function public.accept_my_invitation()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.accept_invitation_for(auth.uid(), auth.jwt() ->> 'email');
end;
$$;

revoke all on function public.accept_my_invitation() from public;
grant execute on function public.accept_my_invitation() to authenticated;

-- Ядро зовут только accept_my_invitation() и триггер — обе security definer с owner
-- postgres, так что их собственных прав хватает. Клиентам доступ не нужен.
revoke all on function public.accept_invitation_for(uuid, text) from public, anon, authenticated;

-- ВАЖНО: у триггерной функции права НЕ отзываем. Триггер на auth.users выполняется
-- под ролью GoTrue (`supabase_auth_admin`), и EXECUTE проверяется по НЕЙ. Если отобрать
-- право у public, вставка в auth.users падает с «permission denied for function» —
-- а это ломает регистрацию: любой новый Google-аккаунт получает «Database error saving
-- new user» вместо входа. Функция возвращает trigger, напрямую её вызвать нельзя.
grant execute on function public.handle_new_user_invitation() to supabase_auth_admin;

-- ---------------- 4. Backfill ----------------
-- Приглашения, чей Google-аккаунт уже заведён (человек логинился до/после приглашения):
-- принять их сейчас, иначе они так и будут висеть «Invited».

do $$
declare
  r record;
begin
  for r in
    select u.id as user_id, u.email
    from public.invitations i
    join auth.users u on lower(u.email) = lower(i.email)
    where i.accepted_at is null
      and (i.expires_at is null or i.expires_at > now())
  loop
    perform public.accept_invitation_for(r.user_id, r.email);
  end loop;
end;
$$;
