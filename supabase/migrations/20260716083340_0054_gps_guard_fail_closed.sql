-- Ужесточение guard'ов 0053: NULL от is_owner() (нет auth) должен падать, а не проскакивать.
create or replace function app.report_gps_export(p_from timestamptz, p_to timestamptz, p_profile uuid default null)
returns table(source text, profile_id uuid, at timestamptz, lat double precision, lng double precision, accuracy_m numeric, detail text)
language plpgsql
security definer
set search_path = public, extensions, app
as $$
begin
  if coalesce(app.is_owner(), false) is distinct from true then
    raise exception 'only_owner';
  end if;
  return query
  select 'time_event'::text, te.profile_id, te.event_time,
         st_y(te.gps_point::geometry), st_x(te.gps_point::geometry), te.gps_accuracy_m,
         te.event_type::text || coalesce(' · ' || te.gps_status, '')
  from time_events te
  where te.org_id = app.org_id() and te.gps_point is not null
    and te.event_time between p_from and p_to
    and (p_profile is null or te.profile_id = p_profile)
  union all
  select 'live_location'::text, ll.worker_id, ll.recorded_at,
         st_y(ll.gps_point::geometry), st_x(ll.gps_point::geometry), ll.accuracy_m, null::text
  from live_locations ll
  where ll.org_id = app.org_id()
    and ll.recorded_at between p_from and p_to
    and (p_profile is null or ll.worker_id = p_profile)
  union all
  select 'geo_event'::text, ge.worker_id, ge.detected_at,
         null::double precision, null::double precision, ge.distance_m,
         ge.status || case when ge.resolved_at is not null then ' · resolved' else '' end
  from shift_geo_events ge
  where ge.org_id = app.org_id()
    and ge.detected_at between p_from and p_to
    and (p_profile is null or ge.worker_id = p_profile)
  order by 3;
end;
$$;

create or replace function app.purge_gps_feeds(p_before timestamptz, p_profile uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_live int;
  v_geo int;
begin
  if coalesce(app.is_owner(), false) is distinct from true then
    raise exception 'only_owner';
  end if;
  delete from live_locations
  where org_id = app.org_id() and recorded_at < p_before
    and (p_profile is null or worker_id = p_profile);
  get diagnostics v_live = row_count;
  delete from shift_geo_events
  where org_id = app.org_id() and detected_at < p_before and resolved_at is not null
    and (p_profile is null or worker_id = p_profile);
  get diagnostics v_geo = row_count;
  insert into events (org_id, type, actor_id, payload)
  values (app.org_id(), 'gps.feeds_purged', auth.uid(),
          jsonb_build_object('before', p_before, 'profile', p_profile, 'live_deleted', v_live, 'geo_deleted', v_geo));
  return jsonb_build_object('live_deleted', v_live, 'geo_deleted', v_geo);
end;
$$;
