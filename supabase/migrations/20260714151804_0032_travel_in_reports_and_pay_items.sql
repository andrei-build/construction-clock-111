-- 0032: проезд (G1) в отчётности — BACKEND REQUEST от приёмки G1/PAY-1
-- Математика идентична клиентскому computeTravelGaps: гэп между соседними интервалами ОДНОГО работника
-- в пределах ОДНОГО org-local календарного дня; кросс-день/овэрлап отброшены; только МЕЖДУ сменами.

-- 1) Закрытые периоды: отдельная колонка проезда (аддитивно; фронт начнёт писать при закрытии — front-задача REP-1)
alter table public.pay_period_items
  add column if not exists travel_hours numeric not null default 0;

comment on column public.pay_period_items.travel_hours is 'Часы проезда (G1) внутри периода, отдельной строкой от regular/overtime; оплачиваются прямой ставкой.';

-- 2) Отчёт по проезду (для Reports; report_hours не трогаем — у проезда нет проекта)
create or replace function public.report_travel_hours(p_from date, p_to date)
returns table(worker_name text, travel_hours numeric)
language sql
stable
set search_path to 'public'
as $function$
  with tzv as (
    select coalesce((select a.timezone from app_settings a limit 1), 'America/Los_Angeles') as z
  ),
  iv as (
    select w.profile_id, w.start_at,
           lag(w.end_at) over (partition by w.profile_id order by w.start_at) as prev_end
    from v_work_intervals w
    where w.start_at >= p_from and w.start_at < p_to + 1
  )
  select pr.name,
         round((sum(extract(epoch from (iv.start_at - iv.prev_end)) / 3600.0))::numeric, 2)
  from iv
  cross join tzv
  join profiles pr on pr.id = iv.profile_id
  where iv.prev_end is not null
    and iv.start_at > iv.prev_end
    and (iv.prev_end at time zone tzv.z)::date = (iv.start_at at time zone tzv.z)::date
  group by pr.name
  order by pr.name
$function$;

-- 3) report_payroll: + travel_hours колонка, total_pay += travel * прямая ставка (закон G1)
drop function if exists public.report_payroll(date, date);
create function public.report_payroll(p_from date, p_to date)
returns table(worker_name text, role text, hourly_rate numeric, total_hours numeric, regular_hours numeric, overtime_hours numeric, travel_hours numeric, total_pay numeric)
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_tz text;
begin
  if not app.has_finance_access() then
    raise exception 'finance access required';
  end if;
  select coalesce((select a.timezone from app_settings a limit 1), 'America/Los_Angeles') into v_tz;
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
  ),
  iv as (
    select w.profile_id, w.start_at,
           lag(w.end_at) over (partition by w.profile_id order by w.start_at) as prev_end
    from v_work_intervals w
    where w.start_at >= p_from and w.start_at < p_to + 1
  ),
  travel as (
    select iv.profile_id,
           sum(extract(epoch from (iv.start_at - iv.prev_end)) / 3600.0) as th
    from iv
    where iv.prev_end is not null
      and iv.start_at > iv.prev_end
      and (iv.prev_end at time zone v_tz)::date = (iv.start_at at time zone v_tz)::date
    group by iv.profile_id
  )
  select pr.name, pr.role::text, r.hourly_rate,
         round((s.reg + s.ot)::numeric, 2),
         round(s.reg::numeric, 2),
         round(s.ot::numeric, 2),
         round(coalesce(t.th, 0)::numeric, 2),
         round((s.reg * coalesce(r.hourly_rate,0)
              + s.ot * coalesce(r.hourly_rate,0) * 1.5
              + coalesce(t.th, 0) * coalesce(r.hourly_rate,0))::numeric, 2)
  from split s
  left join travel t on t.profile_id = s.profile_id
  join profiles pr on pr.id = s.profile_id
  left join lateral (
    select pr2.hourly_rate from profile_rates pr2
    where pr2.profile_id = s.profile_id order by pr2.effective_from desc limit 1
  ) r on true
  order by pr.name;
end $function$;