-- 0014: foundation for live map (brainstorm block: field control) + linter fix

-- Projects get explicit coordinates for map markers (address alone is not plottable)
alter table public.projects
  add column if not exists lat double precision,
  add column if not exists lng double precision;

comment on column public.projects.lat is 'Map latitude, set manually or by geocoding (map v1)';

-- Last known worker position: latest GPS-bearing time event per worker with an open shift today.
-- security_invoker: RLS of time_events applies to the caller (workers see self, managers see all).
create or replace view public.v_worker_last_location
with (security_invoker = true) as
select distinct on (te.profile_id)
  te.profile_id,
  p.name,
  p.role,
  te.event_type,
  te.gps_status,
  st_y(te.gps_point::geometry) as lat,
  st_x(te.gps_point::geometry) as lng,
  te.gps_accuracy_m,
  te.server_time,
  te.project_id
from public.time_events te
join public.profiles p on p.id = te.profile_id
where te.gps_point is not null
  and te.server_time > now() - interval '14 hours'
order by te.profile_id, te.server_time desc;

-- Linter: pin_login_rate_limits had RLS enabled with no policies (deny-all by default).
-- Make the deny explicit so intent is documented: table is service-role-only (pin-login edge function).
create policy pin_rate_limits_service_only on public.pin_login_rate_limits
  for select to authenticated using (false);
comment on table public.pin_login_rate_limits is 'Service-role only (pin-login edge fn). Explicit deny policy for API roles. Spec: DNA §2.12';