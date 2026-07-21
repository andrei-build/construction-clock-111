-- DRIVER-STATS-1 бэкенд: статистика водителей (закон Андрея 17.07)
-- Видит ТОЛЬКО владелец; водителям не показывается нигде (фронт: owner-секция в Отчётах).
create or replace function public.report_driver_visits(p_from date, p_to date)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_result jsonb;
begin
  if not app.is_owner() then
    raise exception 'owner access required';
  end if;

  select coalesce((select a.timezone from app_settings a limit 1), 'America/Los_Angeles') into v_tz;
  v_from := (p_from::timestamp at time zone v_tz);
  v_to := ((p_to + 1)::timestamp at time zone v_tz);

  with drivers as (
    select id, name, is_active
    from profiles
    where org_id = app.org_id() and role = 'driver' and deleted_at is null
  ),
  -- заезды на проекты: рабочие интервалы, начатые check_in
  pv as (
    select w.profile_id, w.project_id, count(*) as n
    from v_work_intervals w
    join time_events te on te.id = w.start_event_id and te.event_type = 'check_in'
    where w.profile_id in (select id from drivers)
      and w.start_at >= v_from and w.start_at < v_to
    group by w.profile_id, w.project_id
  ),
  pv_agg as (
    select pv.profile_id,
           sum(pv.n)::int as total,
           jsonb_agg(jsonb_build_object(
             'project_id', pv.project_id,
             'project', coalesce(pr.name, '—'),
             'visits', pv.n) order by pv.n desc, pr.name) as projects
    from pv left join projects pr on pr.id = pv.project_id
    group by pv.profile_id
  ),
  -- визиты в магазины (автодетект store_visits)
  sv as (
    select s.worker_id as profile_id, s.store_id, count(*) as n
    from store_visits s
    where s.worker_id in (select id from drivers)
      and s.entered_at >= v_from and s.entered_at < v_to
    group by s.worker_id, s.store_id
  ),
  sv_agg as (
    select sv.profile_id,
           sum(sv.n)::int as total,
           jsonb_agg(jsonb_build_object(
             'store_id', sv.store_id,
             'store', coalesce(st.name, '—'),
             'visits', sv.n) order by sv.n desc, st.name) as stores
    from sv left join supply_stores st on st.id = sv.store_id
    group by sv.profile_id
  ),
  -- время в пути: паттерн report_travel_hours (same-day check_out→check_in), только водители
  iv as (
    select w.profile_id, w.start_at,
           te_s.event_type::text as start_type,
           lag(w.end_at) over (partition by w.profile_id order by w.start_at) as prev_end,
           lag(te_e.event_type::text) over (partition by w.profile_id order by w.start_at) as prev_end_type
    from v_work_intervals w
    left join time_events te_s on te_s.id = w.start_event_id
    left join time_events te_e on te_e.id = w.end_event_id
    where w.profile_id in (select id from drivers)
      and w.start_at >= v_from and w.start_at < v_to
  ),
  travel as (
    select iv.profile_id,
           round((sum(extract(epoch from (iv.start_at - iv.prev_end)) / 3600.0))::numeric, 2) as hours
    from iv
    where iv.prev_end is not null
      and iv.start_at > iv.prev_end
      and (iv.prev_end at time zone v_tz)::date = (iv.start_at at time zone v_tz)::date
      and iv.prev_end_type = 'check_out'
      and iv.start_type = 'check_in'
    group by iv.profile_id
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'timezone', v_tz,
    'drivers', coalesce(jsonb_agg(jsonb_build_object(
      'driver_id', d.id,
      'name', d.name,
      'is_active', d.is_active,
      'project_visits', coalesce(pa.total, 0),
      'projects', coalesce(pa.projects, '[]'::jsonb),
      'store_visits', coalesce(sa.total, 0),
      'stores', coalesce(sa.stores, '[]'::jsonb),
      'travel_hours', coalesce(t.hours, 0)
    ) order by d.name), '[]'::jsonb))
  into v_result
  from drivers d
  left join pv_agg pa on pa.profile_id = d.id
  left join sv_agg sa on sa.profile_id = d.id
  left join travel t on t.profile_id = d.id;

  return v_result;
end $$;

comment on function public.report_driver_visits(date, date) is 'Статистика водителей за период: заезды на проекты, визиты в магазины, время в пути. ТОЛЬКО owner. Spec: DRIVER-STATS-1 (закон Андрея 17.07)';

revoke execute on function public.report_driver_visits(date, date) from public, anon;
grant execute on function public.report_driver_visits(date, date) to authenticated, service_role;
