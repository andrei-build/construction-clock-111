-- 0018: Проверка закрытых смен (Г3 из Check Time). Подозрительные смены + вердикт менеджера.

create table public.shift_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  checkout_event_id uuid not null unique references public.time_events(id),
  status text not null default 'approved' check (status in ('approved','needs_review')),
  note text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz not null default now()
);
comment on table public.shift_reviews is 'Вердикт менеджера по закрытой смене. Spec: Г3';

alter table public.shift_reviews enable row level security;
create policy sr_select on public.shift_reviews
  for select to authenticated using (org_id = app.org_id() and app.is_manager());
create policy sr_write on public.shift_reviews
  for insert to authenticated with check (org_id = app.org_id() and app.is_manager_write());
create policy sr_update on public.shift_reviews
  for update to authenticated using (org_id = app.org_id() and app.is_manager_write());

-- Подозрительные закрытые смены: длиннее 11ч, без нормального GPS, или большой разрыв времени без офлайн-флага
create or replace view public.v_suspicious_shifts
with (security_invoker = true) as
select
  co.id as checkout_event_id,
  co.org_id,
  co.profile_id,
  p.name,
  co.project_id,
  pr.name as project_name,
  ci.event_time as started_at,
  co.event_time as ended_at,
  extract(epoch from (co.event_time - ci.event_time)) / 3600.0 as hours,
  (extract(epoch from (co.event_time - ci.event_time)) > 11 * 3600) as too_long,
  (coalesce(co.gps_status,'') <> 'good' or coalesce(ci.gps_status,'') <> 'good') as gps_issue,
  (coalesce((co.metadata->>'time_gap_s')::numeric, 0) > 600 and coalesce(co.metadata->>'offline_queued','') <> 'true') as time_gap_issue,
  sr.status as review_status,
  sr.reviewed_at
from public.time_events co
join lateral (
  select ci.* from public.time_events ci
  where ci.profile_id = co.profile_id
    and ci.event_type = 'check_in'
    and ci.event_time < co.event_time
  order by ci.event_time desc
  limit 1
) ci on true
join public.profiles p on p.id = co.profile_id
left join public.projects pr on pr.id = co.project_id
left join public.shift_reviews sr on sr.checkout_event_id = co.id
where co.event_type = 'check_out'
  and co.event_time > now() - interval '30 days'
  and (
    extract(epoch from (co.event_time - ci.event_time)) > 11 * 3600
    or coalesce(co.gps_status,'') <> 'good' or coalesce(ci.gps_status,'') <> 'good'
    or (coalesce((co.metadata->>'time_gap_s')::numeric, 0) > 600 and coalesce(co.metadata->>'offline_queued','') <> 'true')
  );