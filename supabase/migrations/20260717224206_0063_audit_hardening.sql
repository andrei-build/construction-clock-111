-- Аудит 17.07 (Бета-5, флот ревизоров): немедленные укрепления по подтверждённым находкам.

-- 1) Работник не может сам себе менять pin_enabled / hire_date / dossier_notes (триггер расширен)
create or replace function app.protect_profile_privileged_cols()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- ДНК §1/§2 п.7: не-менеджер не может менять себе роль, PIN, орг, активность, режим доступа
  -- + аудит 17.07: pin_enabled (0060), hire_date/dossier_notes (0059)
  if not app.is_manager_write() then
    new.role := old.role;
    new.pin_hash := old.pin_hash;
    new.org_id := old.org_id;
    new.is_active := old.is_active;
    new.project_access_mode := old.project_access_mode;
    new.require_checkout_video := old.require_checkout_video;
    new.pin_enabled := old.pin_enabled;
    new.hire_date := old.hire_date;
    new.dossier_notes := old.dossier_notes;
  end if;
  return new;
end $function$;

-- 2) Лента событий: клиентские вставки больше не могут быть анонимными или от чужого имени
drop policy if exists events_insert on public.events;
create policy events_insert on public.events
  for insert with check ((org_id = app.org_id()) and (actor_id = (select auth.uid())));

create or replace function app.stamp_event_actor()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_name text; v_role text;
begin
  -- Для клиентских вставок (есть auth.uid) имя/роль всегда берём из профиля — спуфинг невозможен.
  -- Сервисные вставки (edge, auth.uid() null) не трогаем.
  if (select auth.uid()) is not null then
    select name, role::text into v_name, v_role from public.profiles where id = (select auth.uid());
    if v_name is not null then
      new.actor_name := v_name;
      new.actor_role := v_role;
    end if;
  end if;
  return new;
end $function$;
drop trigger if exists trg_stamp_event_actor on public.events;
create trigger trg_stamp_event_actor before insert on public.events
  for each row execute function app.stamp_event_actor();

-- 3) Справочники: запись только в свои строки своей организации (глобальные org_id IS NULL — только сервис)
drop policy if exists ss_write on public.supply_stores;
create policy ss_write on public.supply_stores
  for all using ((org_id = app.org_id()) and app.is_manager_write())
  with check ((org_id = app.org_id()) and app.is_manager_write());
drop policy if exists units_write on public.units;
create policy units_write on public.units
  for all using ((org_id = app.org_id()) and app.is_manager_write())
  with check ((org_id = app.org_id()) and app.is_manager_write());

-- 4) Зарплатные периоды: два approved/paid периода не могут пересекаться по датам (двойная оплата тех же часов)
create extension if not exists btree_gist;
alter table public.pay_periods drop constraint if exists pay_periods_no_overlap_excl;
alter table public.pay_periods add constraint pay_periods_no_overlap_excl
  exclude using gist (
    org_id with =,
    daterange(period_start, period_end, '[]') with &&
  ) where (status in ('approved','paid'));
