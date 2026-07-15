-- 0037: АУДИТ-БЛОКЕРЫ на уровне БД (A3, A4, video_path) + client_errors (MON-1-лайт)

-- ============ A3: ФОТО-ГЕЙТ ПО ГАЛОЧКЕ (ядро ДНК №3 в редакции Андрея 15.07) ============
-- Задачу с requires_photo=true НЕЛЬЗЯ перевести в done без живого media, привязанного к задаче.
create or replace function app.guard_task_photo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'done' and coalesce(old.status,'') is distinct from 'done'
     and coalesce(new.requires_photo, false)
     and not exists (
       select 1 from media m
       where m.task_id = new.id and m.deleted_at is null
     )
  then
    raise exception 'photo_required: task % requires a photo before it can be marked done', new.id
      using errcode = 'P0001';
  end if;
  return new;
end $function$;

drop trigger if exists task_photo_gate on public.tasks;
create trigger task_photo_gate
  before update on public.tasks
  for each row execute function app.guard_task_photo();

-- ============ ИММУТАБЕЛЬНОСТЬ time_events (ремень к подтяжкам RLS) ============
-- RLS уже не даёт клиентам UPDATE/DELETE (политик нет). Триггер защищает и от service-role ошибок:
-- UPDATE разрешён ТОЛЬКО для video_path/video_status/metadata (видео-чекаут write-once), DELETE запрещён всем.
create or replace function app.guard_time_event_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
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
end $function$;

drop trigger if exists time_event_immutable on public.time_events;
create trigger time_event_immutable
  before update or delete on public.time_events
  for each row execute function app.guard_time_event_immutable();

-- Легальный путь записи видео-чекаута (фронт сейчас бьётся об RLS и молча теряет видео):
create or replace function public.attach_checkout_video(p_event_id uuid, p_video_path text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v record;
begin
  select te.id, te.org_id, te.profile_id, te.event_type, te.video_path
    into v from time_events te where te.id = p_event_id;
  if v.id is null then raise exception 'event_not_found'; end if;
  if v.org_id <> app.org_id() then raise exception 'forbidden'; end if;
  if v.profile_id <> auth.uid() and not app.is_manager_write() then raise exception 'forbidden'; end if;
  if v.event_type <> 'check_out' then raise exception 'video only attaches to check_out'; end if;
  if v.video_path is not null then raise exception 'checkout video is write-once'; end if;
  update time_events set video_path = p_video_path, video_status = 'uploaded' where id = p_event_id;
end $function$;

-- ============ A4: ЗАРПЛАТНЫЙ LEDGER ============
-- 1) Строки закрытого периода неизменяемы:
create or replace function app.guard_pay_period_items()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_status text;
begin
  select status into v_status from pay_periods
   where id = coalesce(new.pay_period_id, old.pay_period_id);
  if v_status in ('approved','paid') then
    raise exception 'pay period is % — its items are immutable', v_status;
  end if;
  return coalesce(new, old);
end $function$;

drop trigger if exists pay_period_items_immutable on public.pay_period_items;
create trigger pay_period_items_immutable
  before insert or update or delete on public.pay_period_items
  for each row execute function app.guard_pay_period_items();

-- 2) Статусы периода двигаются только вперёд: draft -> approved -> paid; даты закрытого не трогать:
create or replace function app.guard_pay_period_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved','paid') then
      raise exception 'closed pay period cannot be deleted';
    end if;
    return old;
  end if;
  if old.status = 'paid' and new.status is distinct from 'paid' then
    raise exception 'paid period is immutable';
  end if;
  if old.status = 'approved' and new.status not in ('approved','paid') then
    raise exception 'approved period can only move to paid';
  end if;
  if old.status in ('approved','paid')
     and (new.period_start is distinct from old.period_start
       or new.period_end is distinct from old.period_end) then
    raise exception 'closed period dates are immutable';
  end if;
  return new;
end $function$;

drop trigger if exists pay_period_status_flow on public.pay_periods;
create trigger pay_period_status_flow
  before update or delete on public.pay_periods
  for each row execute function app.guard_pay_period_status();

-- 3) Транзакционное закрытие периода (вместо delete-all -> insert отдельными запросами с фронта):
create or replace function public.close_pay_period(
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_period_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org uuid;
  v_id uuid;
  v_status text;
  it jsonb;
begin
  if not app.has_finance_access() then
    raise exception 'finance access required';
  end if;
  v_org := app.org_id();
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items required';
  end if;

  if p_period_id is not null then
    select id, status into v_id, v_status from pay_periods
     where id = p_period_id and org_id = v_org for update;
    if v_id is null then raise exception 'period_not_found'; end if;
    if v_status in ('approved','paid') then raise exception 'period already closed'; end if;
  else
    insert into pay_periods (org_id, period_start, period_end, status)
    values (v_org, p_period_start, p_period_end, 'draft')
    returning id into v_id;
  end if;

  delete from pay_period_items where pay_period_id = v_id;

  for it in select * from jsonb_array_elements(p_items) loop
    insert into pay_period_items (
      pay_period_id, profile_id,
      regular_hours, overtime_hours, overtime_multiplier, travel_hours,
      hourly_rate, bonus, reimbursement, deduction, total,
      time_event_ids, adjustments, note
    ) values (
      v_id,
      (it->>'profile_id')::uuid,
      coalesce((it->>'regular_hours')::numeric, 0),
      coalesce((it->>'overtime_hours')::numeric, 0),
      coalesce((it->>'overtime_multiplier')::numeric, 1.5),
      coalesce((it->>'travel_hours')::numeric, 0),
      (it->>'hourly_rate')::numeric,
      coalesce((it->>'bonus')::numeric, 0),
      coalesce((it->>'reimbursement')::numeric, 0),
      coalesce((it->>'deduction')::numeric, 0),
      coalesce((it->>'total')::numeric, 0),
      coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(it->'time_event_ids','[]'::jsonb)) x), '{}'::uuid[]),
      coalesce(it->'adjustments', '[]'::jsonb),
      it->>'note'
    );
  end loop;

  update pay_periods set status = 'approved' where id = v_id;
  return v_id;
end $function$;

-- ============ MON-1-лайт: журнал ошибок прода ============
create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id),
  profile_id uuid references public.profiles(id),
  message text,
  stack_hash text,
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);
alter table public.client_errors enable row level security;
create policy ce_insert on public.client_errors
  for insert to authenticated
  with check (org_id = app.org_id() and profile_id = (select auth.uid()));
create policy ce_select on public.client_errors
  for select to authenticated
  using (org_id = app.org_id() and app.is_owner());

-- ретеншен 14 дней
select cron.schedule('purge-client-errors', '15 3 * * *',
  $$delete from client_errors where created_at < now() - interval '14 days'$$);