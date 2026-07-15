-- 0033: автодетект заездов в магазины поставок (ДНК §2 п.11) — ветка в app.scan_shift_geo()
-- Радиус: app_settings.store_visit_radius_m (слайдер владельца, default 75) → fallback supply_stores.radius_m → 75.
-- Открытые смены + свежая точка live_locations: в радиусе магазина → открыть store_visit (если нет открытого),
-- вне радиуса / сигнал пропал / смена закрыта → закрыть открытые визиты.

create or replace function app.scan_shift_geo()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_last record;
  v_store record;
  v_threshold numeric;
  v_radius numeric;
  v_store_radius numeric;
  v_dist numeric;
  v_minutes numeric;
  v_new_no_signal int := 0;
  v_new_out_of_zone int := 0;
  v_resolved int := 0;
  v_purged int := 0;
  v_visits_opened int := 0;
  v_visits_closed int := 0;
  v_cnt int;
begin
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
    select coalesce(
      (select store_visit_radius_m from app_settings where org_id = r.org_id), 75
    ) into v_store_radius;

    select ll.gps_point, ll.accuracy_m, ll.recorded_at
      into v_last
    from live_locations ll
    where ll.worker_id = r.profile_id
      and ll.recorded_at >= r.event_time
    order by ll.recorded_at desc
    limit 1;

    if v_last.recorded_at is null then
      continue; -- точек за смену не было — не шумим
    end if;

    v_minutes := round((extract(epoch from (now() - v_last.recorded_at)) / 60.0)::numeric, 1);

    if v_minutes > v_threshold then
      -- СИГНАЛ БЫЛ И ПРОПАЛ
      update shift_geo_events e
         set minutes_since_signal = v_minutes
       where e.worker_id = r.profile_id and e.status = 'no_signal' and e.resolved_at is null;
      get diagnostics v_cnt = row_count;
      if v_cnt = 0 then
        insert into shift_geo_events (org_id, worker_id, project_id, status, minutes_since_signal, metadata)
        values (r.org_id, r.profile_id, r.project_id, 'no_signal', v_minutes,
                jsonb_build_object('source','scan_shift_geo','last_signal_at', v_last.recorded_at));
        v_new_no_signal := v_new_no_signal + 1;
      end if;
      -- сигнал пропал — открытые визиты в магазины закрываем
      update store_visits sv set exited_at = now()
       where sv.worker_id = r.profile_id and sv.exited_at is null;
      get diagnostics v_cnt = row_count;
      v_visits_closed := v_visits_closed + v_cnt;
    else
      -- сигнал свежий: закрыть no_signal
      update shift_geo_events e set resolved_at = now()
       where e.worker_id = r.profile_id and e.status = 'no_signal' and e.resolved_at is null;
      get diagnostics v_cnt = row_count;
      v_resolved := v_resolved + v_cnt;

      -- геозона проекта
      if r.site_point is not null then
        v_radius := coalesce(
          r.gps_radius_m::numeric,
          (select default_gps_radius_m from app_settings where org_id = r.org_id)::numeric,
          150
        );
        v_dist := round(st_distance(v_last.gps_point, r.site_point)::numeric, 0);
        if v_dist > v_radius + coalesce(v_last.accuracy_m, 0) then
          update shift_geo_events e
             set distance_m = v_dist, minutes_since_signal = v_minutes
           where e.worker_id = r.profile_id and e.status = 'out_of_zone' and e.resolved_at is null;
          get diagnostics v_cnt = row_count;
          if v_cnt = 0 then
            insert into shift_geo_events (org_id, worker_id, project_id, status, distance_m, minutes_since_signal, metadata)
            values (r.org_id, r.profile_id, r.project_id, 'out_of_zone', v_dist, v_minutes,
                    jsonb_build_object('source','scan_shift_geo','radius_m', v_radius));
            v_new_out_of_zone := v_new_out_of_zone + 1;
          end if;
        else
          update shift_geo_events e set resolved_at = now()
           where e.worker_id = r.profile_id and e.status = 'out_of_zone' and e.resolved_at is null;
          get diagnostics v_cnt = row_count;
          v_resolved := v_resolved + v_cnt;
        end if;
      end if;

      -- ДЕТЕКТ МАГАЗИНОВ: ближайший активный магазин
      select s.id as store_id, st_distance(v_last.gps_point, s.point) as dist
        into v_store
      from supply_stores s
      where s.is_active and s.point is not null
        and (s.org_id is null or s.org_id = r.org_id)
      order by st_distance(v_last.gps_point, s.point) asc
      limit 1;

      if v_store.store_id is not null
         and v_store.dist <= v_store_radius + coalesce(v_last.accuracy_m, 0) then
        -- в магазине: закрыть визиты в ДРУГИЕ магазины, открыть этот если ещё нет
        update store_visits sv set exited_at = now()
         where sv.worker_id = r.profile_id and sv.exited_at is null
           and sv.store_id is distinct from v_store.store_id;
        get diagnostics v_cnt = row_count;
        v_visits_closed := v_visits_closed + v_cnt;
        if not exists (
          select 1 from store_visits sv
          where sv.worker_id = r.profile_id and sv.store_id = v_store.store_id and sv.exited_at is null
        ) then
          insert into store_visits (org_id, worker_id, store_id, project_id, entered_at, metadata)
          values (r.org_id, r.profile_id, v_store.store_id, r.project_id, v_last.recorded_at,
                  jsonb_build_object('source','scan_shift_geo','distance_m', round(v_store.dist::numeric,0)));
          v_visits_opened := v_visits_opened + 1;
        end if;
      else
        -- не в магазине: закрыть все открытые визиты работника
        update store_visits sv set exited_at = now()
         where sv.worker_id = r.profile_id and sv.exited_at is null;
        get diagnostics v_cnt = row_count;
        v_visits_closed := v_visits_closed + v_cnt;
      end if;
    end if;
  end loop;

  -- события и визиты работников БЕЗ открытой смены -> закрыть
  update shift_geo_events e set resolved_at = now()
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

  update store_visits sv set exited_at = now()
   where sv.exited_at is null
     and not exists (
       select 1 from time_events ci
       where ci.profile_id = sv.worker_id
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
  v_visits_closed := v_visits_closed + v_cnt;

  delete from live_locations where recorded_at < now() - interval '48 hours';
  get diagnostics v_purged = row_count;

  return jsonb_build_object(
    'new_no_signal', v_new_no_signal,
    'new_out_of_zone', v_new_out_of_zone,
    'resolved', v_resolved,
    'store_visits_opened', v_visits_opened,
    'store_visits_closed', v_visits_closed,
    'purged_points', v_purged
  );
end $function$;

revoke all on function app.scan_shift_geo() from public, anon, authenticated;