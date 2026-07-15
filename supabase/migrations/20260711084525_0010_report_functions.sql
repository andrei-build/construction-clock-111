-- Construction Clock · 0010: серверные отчёты (К1-К2)
-- SECURITY INVOKER: RLS работает как для вызывающего. Payroll/expenses дополнительно требуют финдоступ.

-- Часы по работникам×проектам за период (менеджеры)
create or replace function public.report_hours(p_from date, p_to date)
returns table (worker_name text, project_name text, hours numeric)
language sql stable security invoker set search_path = public as $$
  with iv as (
    select te.profile_id, te.project_id, te.event_time, te.event_type,
           lead(te.event_time) over w as nt, lead(te.event_type) over w as nty
    from time_events te
    window w as (partition by te.profile_id order by te.event_time)
  )
  select pr.name, coalesce(pj.name, '—'),
         round(sum(extract(epoch from (iv.nt - iv.event_time)) / 3600.0)::numeric, 2)
  from iv
  join profiles pr on pr.id = iv.profile_id
  left join projects pj on pj.id = iv.project_id
  where iv.event_type in ('check_in','break_end')
    and iv.nty in ('break_start','check_out')
    and iv.event_time >= p_from and iv.event_time < p_to + 1
  group by pr.name, pj.name
  order by pr.name, pj.name
$$;

-- Зарплатный отчёт за период (только финансовый доступ)
create or replace function public.report_payroll(p_from date, p_to date)
returns table (worker_name text, role text, hourly_rate numeric, total_hours numeric,
               regular_hours numeric, overtime_hours numeric, total_pay numeric)
language plpgsql stable security invoker set search_path = public as $$
begin
  if not app.has_finance_access() then
    raise exception 'finance access required';
  end if;
  return query
  with iv as (
    select te.profile_id, te.event_time, te.event_type,
           lead(te.event_time) over w as nt, lead(te.event_type) over w as nty,
           date_trunc('week', te.event_time) as wk
    from time_events te
    window w as (partition by te.profile_id order by te.event_time)
  ),
  weekly as (
    select profile_id, wk, sum(extract(epoch from (nt - event_time)) / 3600.0) as h
    from iv
    where event_type in ('check_in','break_end') and nty in ('break_start','check_out')
      and event_time >= p_from and event_time < p_to + 1
    group by profile_id, wk
  ),
  split as (
    select profile_id, sum(least(h, 40)) as reg, sum(greatest(h - 40, 0)) as ot
    from weekly group by profile_id
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

-- Расходы по проектам за период (только финансовый доступ)
create or replace function public.report_expenses(p_from date, p_to date)
returns table (project_name text, kind text, description text, vendor text, amount numeric, incurred_at date)
language plpgsql stable security invoker set search_path = public as $$
begin
  if not app.has_finance_access() then
    raise exception 'finance access required';
  end if;
  return query
  select pj.name, e.kind, e.description, e.vendor, e.amount, e.incurred_at
  from project_expenses e join projects pj on pj.id = e.project_id
  where e.deleted_at is null and e.incurred_at between p_from and p_to
  order by e.incurred_at desc;
end $$;

revoke execute on function public.report_hours(date,date) from anon;
revoke execute on function public.report_payroll(date,date) from anon;
revoke execute on function public.report_expenses(date,date) from anon;