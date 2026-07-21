-- 0046: закон Андрея 16.07 — «тестовых/ненастоящих людей можно удалить ПОЛНОСТЬЮ, безвозвратно».
-- RPC public.purge_profile: только owner, только из корзины (deleted_at), не себя.
-- ЖЕЛЕЗНЫЙ ГЕЙТ ДЕНЕГ: если человек фигурирует в approved/paid периодах или в payroll_closures — полное удаление ЗАПРЕЩЕНО.
-- Управляемая лазейка для append-only времени: guard_time_event_immutable разрешает DELETE только внутри purge_profile (app.purge_mode).

create or replace function app.guard_time_event_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.purge_mode', true), '') = 'on' then
      return old; -- ТОЛЬКО из purge_profile (полное удаление тестового человека владельцем)
    end if;
    raise exception 'time_events are append-only: DELETE is forbidden (use adjustment events)';
  end if;
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.profile_id is distinct from old.profile_id
     or new.project_id is distinct from old.project_id
     or new.event_type is distinct from old.event_type
     or new.event_time is distinct from old.event_time
     or new.server_time is distinct from old.server_time
     or new.gps_point::text is distinct from old.gps_point::text
     or new.gps_accuracy_m is distinct from old.gps_accuracy_m
     or new.gps_source is distinct from old.gps_source
     or new.gps_status is distinct from old.gps_status
     or new.distance_to_site_m is distinct from old.distance_to_site_m
     or new.adjusts_event_id is distinct from old.adjusts_event_id
     or new.adjust_reason is distinct from old.adjust_reason
     or new.adjusted_by is distinct from old.adjusted_by
     or new.notes is distinct from old.notes
     or new.created_at is distinct from old.created_at
  then
    raise exception 'time_events history is immutable: only checkout video attachment is allowed';
  end if;
  if old.video_path is not null and new.video_path is distinct from old.video_path then
    raise exception 'checkout video is write-once';
  end if;
  return new;
end $$;

create or replace function public.purge_profile(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_org uuid := app.org_id();
  v_target record;
  r record;
begin
  if app.user_role() <> 'owner' then
    raise exception 'only_owner_can_purge';
  end if;
  if v_org is null then
    raise exception 'no_profile';
  end if;
  if p_profile_id = (select auth.uid()) then
    raise exception 'cannot_purge_self';
  end if;

  select id, name, role, deleted_at into v_target
    from public.profiles where id = p_profile_id and org_id = v_org;
  if not found then raise exception 'member_not_found'; end if;
  if v_target.deleted_at is null then raise exception 'not_in_trash'; end if;

  -- деньги неприкосновенны: оплаченная/утверждённая история блокирует полное удаление
  if exists (select 1 from public.pay_period_items i join public.pay_periods p on p.id = i.pay_period_id
             where i.profile_id = p_profile_id and p.status in ('approved','paid'))
     or exists (select 1 from public.payroll_closures where profile_id = p_profile_id) then
    raise exception 'purge_blocked_paid_history';
  end if;

  perform set_config('app.purge_mode', 'on', true);

  -- медиа человека: отвязать/удалить вторичные ссылки, затем сами строки
  update public.project_expenses set media_id = null
    where media_id in (select id from public.media where uploaded_by = p_profile_id and org_id = v_org);
  delete from public.media_flags
    where media_id in (select id from public.media where uploaded_by = p_profile_id and org_id = v_org);

  -- динамический каскад по всем FK на profiles: NOT NULL → удалить строки, nullable → отвязать
  for r in
    select c.conrelid::regclass::text as child, a.attname as col, a.attnotnull as not_null, c.confdeltype
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
    order by (not a.attnotnull) -- сначала удаления, потом отвязки
  loop
    if r.confdeltype = 'c' then
      continue; -- каскад сработает при удалении профиля
    elsif r.not_null then
      execute format('delete from %s where %I = $1', r.child, r.col) using p_profile_id;
    else
      execute format('update %s set %I = null where %I = $1', r.child, r.col, r.col) using p_profile_id;
    end if;
  end loop;

  delete from public.profiles where id = p_profile_id;
  delete from auth.users where id = p_profile_id;

  perform set_config('app.purge_mode', 'off', true);

  insert into public.events (org_id, event_type, entity_type, entity_id, data, actor_id)
  values (v_org, 'profile.purged', 'profile', p_profile_id,
          jsonb_build_object('name', v_target.name, 'role', v_target.role), (select auth.uid()));

exception
  when foreign_key_violation then
    raise exception 'purge_blocked_by_references';
end $$;

revoke all on function public.purge_profile(uuid) from public, anon;
grant execute on function public.purge_profile(uuid) to authenticated;
