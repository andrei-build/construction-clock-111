-- 0019: корректировки смен ДОЛЖНЫ влиять на часы и зарплату (ДНК §2.1).
-- Единый источник интервалов работы с учётом adjustment-событий; report_hours,
-- report_payroll и v_project_profit пересаживаются на него.

create or replace view public.v_work_intervals
with (security_invoker = true) as
with base as (
  select te.id, te.org_id, te.profile_id, te.project_id, te.event_time, te.event_type,
         lead(te.id) over w as next_id,
         lead(te.event_time) over w as next_time,
         lead(te.event_type) over w as next_type
  from public.time_events te
  where te.event_type <> 'adjustment'          -- корректировки не участвуют в цепочке пар
  window w as (partition by te.profile_id order by te.event_time)
),
seg as (
  select * from base
  where event_type in ('check_in','break_end')
    and next_type in ('break_start','check_out')
),
adj_start as (  -- последняя корректировка, целящая в начало интервала
  select s.id, (a.metadata->>'adjusted_check_in')::timestamptz as t, a.adjust_reason
  from seg s
  join lateral (
    select a.* from public.time_events a
    where a.event_type = 'adjustment'
      and a.adjusts_event_id in (s.id, s.next_id)
      and a.metadata ? 'adjusted_check_in'
    order by a.event_time desc limit 1
  ) a on s.event_type = 'check_in'
),
adj_end as (   -- последняя корректировка, целящая в конец интервала
  select s.id, (a.metadata->>'adjusted_check_out')::timestamptz as t, a.adjust_reason
  from seg s
  join lateral (
    select a.* from public.time_events a
    where a.event_type = 'adjustment'
      and a.adjusts_event_id in (s.id, s.next_id)
      and a.metadata ? 'adjusted_check_out'
    order by a.event_time desc limit 1
  ) a on s.next_type = 'check_out'
)
select
  s.org_id, s.profile_id, s.project_id,
  s.id as start_event_id, s.next_id as end_event_id,
  coalesce(ast.t, s.event_time) as start_at,
  coalesce(aen.t, s.next_time) as end_at,
  (ast.id is not null or aen.id is not null) as was_adjusted,
  coalesce(ast.adjust_reason, aen.adjust_reason) as adjust_reason
from seg s
left join adj_start ast on ast.id = s.id
left join adj_end aen on aen.id = s.id
where coalesce(aen.t, s.next_time) > coalesce(ast.t, s.event_time);

create or replace function public.report_hours(p_from date, p_to date)
returns table(worker_name text, project_name text, hours numeric)
language sql stable set search_path to 'public' as $$
  select pr.name, coalesce(pj.name, '—'),
         round(sum(extract(epoch from (w.end_at - w.start_at)) / 3600.0)::numeric, 2)
  from v_work_intervals w
  join profiles pr on pr.id = w.profile_id
  left join projects pj on pj.id = w.project_id
  where w.start_at >= p_from and w.start_at < p_to + 1
  group by pr.name, pj.name
  order by pr.name, pj.name
$$;

create or replace function public.report_payroll(p_from date, p_to date)
returns table(worker_name text, role text, hourly_rate numeric, total_hours numeric, regular_hours numeric, overtime_hours numeric, total_pay numeric)
language plpgsql stable set search_path to 'public' as $$
begin
  if not app.has_finance_access() then
    raise exception 'finance access required';
  end if;
  return query
  with weekly as (
    select w.profile_id, date_trunc('week', w.start_at) as wk,
           sum(extract(epoch from (w.end_at - w.start_at)) / 3600.0) as h
    from v_work_intervals w
    where w.start_at >= p_from and w.start_at < p_to + 1
    group by w.profile_id, date_trunc('week', w.start_at)
  ),
  split as (
    select weekly.profile_id, sum(least(weekly.h, 40)) as reg, sum(greatest(weekly.h - 40, 0)) as ot
    from weekly group by weekly.profile_id
  )
  select pr.name, pr.role::text, r.hourly_rate,
         round((s.reg + s.ot)::numeric, 2),
         round(s.reg::numeric, 2), round(s.ot::numeric, 2),
         round((s.reg * coalesce(r.hourly_rate,0) + s.ot * coalesce(r.hourly_rate,0) * 1.5)::numeric, 2)
  from split s
  join profiles pr on pr.id = s.profile_id
  left join lateral (
    select pr2.hourly_rate from profile_rates pr2
    where pr2.profile_id = s.profile_id order by pr2.effective_from desc limit 1
  ) r on true
  order by pr.name;
end $$;

create or replace view public.v_project_profit as
with labor as (
  select w.org_id, w.project_id,
         sum(extract(epoch from (w.end_at - w.start_at)) / 3600.0 * coalesce(r.hourly_rate, 0::numeric)) as labor_cost,
         sum(extract(epoch from (w.end_at - w.start_at)) / 3600.0) as labor_hours
  from public.v_work_intervals w
  left join lateral (
    select pr.hourly_rate from public.profile_rates pr
    where pr.profile_id = w.profile_id order by pr.effective_from desc limit 1
  ) r on true
  where w.project_id is not null
  group by w.org_id, w.project_id
),
exp as (
  select project_expenses.project_id, sum(project_expenses.amount) as expenses_cost
  from public.project_expenses
  where project_expenses.deleted_at is null
  group by project_expenses.project_id
)
select p.id as project_id, p.org_id, p.name, p.status, p.budget_amount,
  round(coalesce(l.labor_hours, 0::numeric), 1) as labor_hours,
  round(coalesce(l.labor_cost, 0::numeric), 2) as labor_cost,
  round(coalesce(e.expenses_cost, 0::numeric), 2) as expenses_cost,
  round(coalesce(l.labor_cost, 0::numeric) + coalesce(e.expenses_cost, 0::numeric), 2) as total_cost,
  case
    when p.budget_amount is null or p.budget_amount = 0::numeric then null::numeric
    else round((p.budget_amount - coalesce(l.labor_cost, 0::numeric) - coalesce(e.expenses_cost, 0::numeric)) / p.budget_amount * 100::numeric, 1)
  end as margin_pct,
  case
    when p.budget_amount is null or p.budget_amount = 0::numeric then 'grey'::text
    when (coalesce(l.labor_cost, 0::numeric) + coalesce(e.expenses_cost, 0::numeric)) > p.budget_amount then 'red'::text
    when (coalesce(l.labor_cost, 0::numeric) + coalesce(e.expenses_cost, 0::numeric)) > (p.budget_amount * 0.75) then 'amber'::text
    else 'green'::text
  end as profit_status
from public.projects p
left join labor l on l.project_id = p.id
left join exp e on e.project_id = p.id
where p.deleted_at is null;