-- PAY-FIX-1, SQL-часть (аудит 17.07, критическое): перерывы больше НЕ считаются травелом;
-- границы дат — в поясе организации; недельная нарезка OT — по локальным неделям с клипом к периоду;
-- ставка выбирается детерминированно (effective_from desc, created_at desc).

-- 1) Часы по проектам: границы в орг-поясе + клип интервала к периоду
create or replace function public.report_hours(p_from date, p_to date)
 returns table(worker_name text, project_name text, hours numeric)
 language sql stable
 set search_path to 'public'
as $function$
  with tzv as (
    select coalesce((select a.timezone from app_settings a limit 1), 'America/Los_Angeles') as z
  ),
  b as (
    select (p_from::timestamp at time zone tzv.z) as f, ((p_to + 1)::timestamp at time zone tzv.z) as t, tzv.z from tzv
  )
  select pr.name, coalesce(pj.name, '—'),
         round(sum(extract(epoch from (least(w.end_at, b.t) - greatest(w.start_at, b.f))) / 3600.0)::numeric, 2)
  from v_work_intervals w
  cross join b
  join profiles pr on pr.id = w.profile_id
  left join projects pj on pj.id = w.project_id
  where w.end_at > b.f and w.start_at < b.t
  group by pr.name, pj.name
  order by pr.name, pj.name
$function$;

-- 2) Травел: только разрывы check_out → check_in в один локальный день (перерывы break_start→break_end исключены)
create or replace function public.report_travel_hours(p_from date, p_to date)
 returns table(worker_name text, travel_hours numeric)
 language sql stable
 set search_path to 'public'
as $function$
  with tzv as (
    select coalesce((select a.timezone from app_settings a limit 1), 'America/Los_Angeles') as z
  ),
  b as (
    select (p_from::timestamp at time zone tzv.z) as f, ((p_to + 1)::timestamp at time zone tzv.z) as t, tzv.z from tzv
  ),
  iv as (
    select w.profile_id, w.start_at,
           te_s.event_type::text as start_type,
           lag(w.end_at) over (partition by w.profile_id order by w.start_at) as prev_end,
           lag(te_e.event_type::text) over (partition by w.profile_id order by w.start_at) as prev_end_type
    from v_work_intervals w
    cross join b
    left join time_events te_s on te_s.id = w.start_event_id
    left join time_events te_e on te_e.id = w.end_event_id
    where w.start_at >= b.f and w.start_at < b.t
  )
  select pr.name,
         round((sum(extract(epoch from (iv.start_at - iv.prev_end)) / 3600.0))::numeric, 2)
  from iv
  cross join b
  join profiles pr on pr.id = iv.profile_id
  where iv.prev_end is not null
    and iv.start_at > iv.prev_end
    and (iv.prev_end at time zone b.z)::date = (iv.start_at at time zone b.z)::date
    and iv.prev_end_type = 'check_out'
    and iv.start_type = 'check_in'
  group by pr.name
  order by pr.name
$function$;

-- 3) Зарплатный отчёт: те же правила + недельная нарезка в орг-поясе + детерминированная ставка
create or replace function public.report_payroll(p_from date, p_to date)
 returns table(worker_name text, role text, hourly_rate numeric, total_hours numeric, regular_hours numeric, overtime_hours numeric, travel_hours numeric, total_pay numeric)
 language plpgsql stable
 set search_path to 'public'
as $function$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
begin
  if not app.has_finance_access() then
    raise exception 'finance access required';
  end if;
  select coalesce((select a.timezone from app_settings a limit 1), 'America/Los_Angeles') into v_tz;
  v_from := (p_from::timestamp at time zone v_tz);
  v_to := ((p_to + 1)::timestamp at time zone v_tz);
  return query
  with iv as (
    select w.profile_id,
           greatest(w.start_at, v_from) as s,
           least(w.end_at, v_to) as e
    from v_work_intervals w
    where w.end_at > v_from and w.start_at < v_to
  ),
  seg as (
    select iv.profile_id, wk.wk_local,
           greatest(iv.s, (wk.wk_local at time zone v_tz)) as ss,
           least(iv.e, ((wk.wk_local + interval '7 days') at time zone v_tz)) as ee
    from iv
    join lateral generate_series(
           date_trunc('week', iv.s at time zone v_tz),
           date_trunc('week', (iv.e - interval '1 microsecond') at time zone v_tz),
           interval '7 days') wk(wk_local) on true
  ),
  weekly as (
    select seg.profile_id, seg.wk_local,
           sum(extract(epoch from (seg.ee - seg.ss)) / 3600.0) as h
    from seg
    where seg.ee > seg.ss
    group by seg.profile_id, seg.wk_local
  ),
  split as (
    select weekly.profile_id, sum(least(weekly.h, 40)) as reg, sum(greatest(weekly.h - 40, 0)) as ot
    from weekly group by weekly.profile_id
  ),
  tiv as (
    select w.profile_id, w.start_at,
           te_s.event_type::text as start_type,
           lag(w.end_at) over (partition by w.profile_id order by w.start_at) as prev_end,
           lag(te_e.event_type::text) over (partition by w.profile_id order by w.start_at) as prev_end_type
    from v_work_intervals w
    left join time_events te_s on te_s.id = w.start_event_id
    left join time_events te_e on te_e.id = w.end_event_id
    where w.start_at >= v_from and w.start_at < v_to
  ),
  travel as (
    select tiv.profile_id,
           sum(extract(epoch from (tiv.start_at - tiv.prev_end)) / 3600.0) as th
    from tiv
    where tiv.prev_end is not null
      and tiv.start_at > tiv.prev_end
      and (tiv.prev_end at time zone v_tz)::date = (tiv.start_at at time zone v_tz)::date
      and tiv.prev_end_type = 'check_out'
      and tiv.start_type = 'check_in'
    group by tiv.profile_id
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
    where pr2.profile_id = s.profile_id
    order by pr2.effective_from desc, pr2.created_at desc
    limit 1
  ) r on true
  order by pr.name;
end $function$;
