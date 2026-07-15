-- 0028: живая геолокация — сканер геозон, ретеншен фида, realtime, настройка порога
-- Таблицы live_locations / shift_geo_events / RLS уже существуют (парити-миграции).

-- 1) Порог потери сигнала (минуты), настраивается на /settings
alter table public.app_settings
  add column if not exists geo_no_signal_minutes numeric not null default 15;

-- 2) Индекс под карту: последние точки по организации
create index if not exists live_locations_org_recorded_idx
  on public.live_locations (org_id, recorded_at desc);

-- 3) Вью «последняя живая точка работника» (security_invoker => действует RLS live_locations)
create or replace view public.v_live_last_location
with (security_invoker = true) as
select distinct on (ll.worker_id)
  ll.worker_id,
  p.name,
  p.role,
  ll.org_id,
  st_y(ll.gps_point::geometry) as lat,
  st_x(ll.gps_point::geometry) as lng,
  ll.accuracy_m,
  ll.recorded_at,
  round((extract(epoch from (now() - ll.recorded_at)) / 60.0)::numeric, 1) as minutes_ago
from public.live_locations ll
join public.profiles p on p.id = ll.worker_id
where ll.recorded_at > now() - interval '12 hours'
order by ll.worker_id, ll.recorded_at desc;

-- 4) Сканер: открытые смены -> нет сигнала / вне геозоны; авторезолв; ретеншен 48ч
create or replace function app.scan_shift_geo()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_last record;
  v_threshold numeric;
  v_radius numeric;
  v_dist numeric;
  v_minutes numeric;
  v_new_no_signal int := 0;
  v_new_out_of_zone int := 0;
  v_resolved int := 0;
  v_purged int := 0;
  v_cnt int;
begin
  -- Открытые смены: последний check_in без последующего check_out (паттерн close_overlong_open_shifts)
  for r in
    select distinct on (ci.profile_id)
      ci.profile_id, ci.org_id, ci.project_id, ci.event_time,
      pr.site_point, pr.gps_radius_m
    from time_events ci
    left join projects pr on pr.id = ci.project_id
    where ci.event_type = 'check_in'
      and ci.adjusts_event_id is null
      and not exists (
        select 1 from time_events co
        where co.profile_id = ci.profile_id
          and co.event_type = 'check_out'
          and co.event_time >= ci.event_time
      )
    order by ci.profile_id, ci.event_time desc
  loop
    select coalesce(
      (select geo_no_signal_minutes from app_settings where org_id = r.org_id), 15
    ) into v_threshold;

    -- Последняя живая точка ЭТОЙ смены
    select ll.gps_point, ll.accuracy_m, ll.recorded_at
      into v_last
    from live_locations ll
    where ll.worker_id = r.profile_id
      and ll.recorded_at >= r.event_time
    order by ll.recorded_at desc
    limit 1;

    -- Точек в эту смену не было вовсе -> не шумим (фронт-фид ещё не везде включён)
    if v_last.recorded_at is null then
      continue;
    end if;

    v_minutes := round((extract(epoch from (now() - v_last.recorded_at)) / 60.0)::numeric, 1);

    if v_minutes > v_threshold then
      -- СИГНАЛ БЫЛ И ПРОПАЛ
      update shift_geo_events e
         set minutes_since_signal = v_minutes
       where e.worker_id = r.profile_id
         and e.status = 'no_signal'
         and e.resolved_at is null;
      get diagnostics v_cnt = row_count;
      if v_cnt = 0 then
        insert into shift_geo_events (org_id, worker_id, project_id, status, minutes_since_signal, metadata)
        values (r.org_id, r.profile_id, r.project_id, 'no_signal', v_minutes,
                jsonb_build_object('source','scan_shift_geo','last_signal_at', v_last.recorded_at));
        v_new_no_signal := v_new_no_signal + 1;
      end if;
    else
      -- Сигнал свежий: закрыть no_signal
      update shift_geo_events e
         set resolved_at = now()
       where e.worker_id = r.profile_id
         and e.status = 'no_signal'
         and e.resolved_at is null;
      get diagnostics v_cnt = row_count;
      v_resolved := v_resolved + v_cnt;

      -- Проверка геозоны (только если у проекта есть точка)
      if r.site_point is not null then
        v_radius := coalesce(
          r.gps_radius_m::numeric,
          (select default_gps_radius_m from app_settings where org_id = r.org_id)::numeric,
          150
        );
        v_dist := round(st_distance(v_last.gps_point, r.site_point)::numeric, 0);

        if v_dist > v_radius + coalesce(v_last.accuracy_m, 0) then
          update shift_geo_events e
             set distance_m = v_dist,
                 minutes_since_signal = v_minutes
           where e.worker_id = r.profile_id
             and e.status = 'out_of_zone'
             and e.resolved_at is null;
          get diagnostics v_cnt = row_count;
          if v_cnt = 0 then
            insert into shift_geo_events (org_id, worker_id, project_id, status, distance_m, minutes_since_signal, metadata)
            values (r.org_id, r.profile_id, r.project_id, 'out_of_zone', v_dist, v_minutes,
                    jsonb_build_object('source','scan_shift_geo','radius_m', v_radius));
            v_new_out_of_zone := v_new_out_of_zone + 1;
          end if;
        else
          update shift_geo_events e
             set resolved_at = now()
           where e.worker_id = r.profile_id
             and e.status = 'out_of_zone'
             and e.resolved_at is null;
          get diagnostics v_cnt = row_count;
          v_resolved := v_resolved + v_cnt;
        end if;
      end if;
    end if;
  end loop;

  -- Висящие события работников БЕЗ открытой смены -> закрыть
  update shift_geo_events e
     set resolved_at = now()
   where e.resolved_at is null
     and not exists (
       select 1 from time_events ci
       where ci.profile_id = e.worker_id
         and ci.event_type = 'check_in'
         and ci.adjusts_event_id is null
         and not exists (
           select 1 from time_events co
           where co.profile_id = ci.profile_id
             and co.event_type = 'check_out'
             and co.event_time >= ci.event_time
         )
     );
  get diagnostics v_cnt = row_count;
  v_resolved := v_resolved + v_cnt;

  -- Ретеншен живого фида: 48 часов
  delete from live_locations where recorded_at < now() - interval '48 hours';
  get diagnostics v_purged = row_count;

  return jsonb_build_object(
    'new_no_signal', v_new_no_signal,
    'new_out_of_zone', v_new_out_of_zone,
    'resolved', v_resolved,
    'purged_points', v_purged
  );
end $function$;

revoke all on function app.scan_shift_geo() from public, anon, authenticated;

-- 5) Realtime: живой фид на карту + события геозон в РИСКИ (SELECT RLS обеих таблиц гейтит видимость)
alter publication supabase_realtime add table public.live_locations;
alter publication supabase_realtime add table public.shift_geo_events;

-- 6) Скан каждые 5 минут (cron.schedule по имени — upsert)
select cron.schedule('scan-shift-geo', '*/5 * * * *', 'select app.scan_shift_geo()');