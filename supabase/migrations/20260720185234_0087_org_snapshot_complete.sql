-- Ф2 Шаг 5 подготовка: дополняем org_snapshot до ПОЛНОГО superset старого buildSnapshot,
-- чтобы переключение ассистента ничего не обеднило. Добавляем projects, team, recent_events.
create or replace function public.org_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $$
  with tz as (select coalesce((select timezone from app_settings limit 1), 'America/Los_Angeles') as z),
       d  as (select (now() at time zone (select z from tz))::date as today,
                     ((now() at time zone (select z from tz))::date - 1) as yest)
  select jsonb_build_object(
    'as_of', now(),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('name',p.name,'status',p.status,'address',p.address,'start_date',p.start_date,'end_date',p.end_date))
                          from (select * from public.projects where deleted_at is null and status <> 'archived' order by created_at desc limit 30) p), '[]'::jsonb),
    'team', coalesce((select jsonb_agg(jsonb_build_object('name',t.name,'role',t.role))
                      from (select * from public.profiles where is_active and deleted_at is null order by name limit 60) t), '[]'::jsonb),
    'on_shift',      coalesce((select jsonb_agg(to_jsonb(s) - 'org_id') from public.v_on_shift_now s), '[]'::jsonb),
    'assignments',   coalesce((select jsonb_agg(to_jsonb(a) - 'org_id') from public.v_assignments_current a), '[]'::jsonb),
    'unassigned',    coalesce((select jsonb_agg(to_jsonb(u) - 'org_id') from public.v_workers_unassigned u), '[]'::jsonb),
    'open_tasks',    coalesce((select jsonb_agg(jsonb_build_object('title',t.title,'status',t.status,'priority',t.priority,'due_date',t.due_date,'type',t.task_type))
                              from (select * from public.tasks where deleted_at is null and status <> 'done' order by created_at desc limit 40) t), '[]'::jsonb),
    'hours_today',   coalesce((select jsonb_agg(jsonb_build_object('worker',worker_name,'project',project_name,'hours',hours))
                              from public.report_hours((select today from d),(select today from d))), '[]'::jsonb),
    'hours_yesterday',coalesce((select jsonb_agg(jsonb_build_object('worker',worker_name,'project',project_name,'hours',hours))
                              from public.report_hours((select yest from d),(select yest from d))), '[]'::jsonb),
    'risks',         coalesce((select jsonb_agg(to_jsonb(r) - 'org_id') from public.v_suspicious_shifts r where r.review_status is distinct from 'cleared'), '[]'::jsonb),
    'projects_money',coalesce((select jsonb_agg(to_jsonb(m) - 'org_id') from public.v_project_profit m), '[]'::jsonb),
    'recent_events', coalesce((select jsonb_agg(jsonb_build_object('event_type',e.event_type,'created_at',e.created_at))
                              from (select * from public.events order by created_at desc limit 15) e), '[]'::jsonb)
  );
$$;
revoke execute on function public.org_snapshot() from public;
grant execute on function public.org_snapshot() to authenticated, service_role;
