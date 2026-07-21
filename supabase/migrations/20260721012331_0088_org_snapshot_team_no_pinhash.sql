-- HOTFIX (supervisor): org_snapshot() is SECURITY INVOKER but its team subquery did
-- `select * from public.profiles`, which pulls the locked-down `pin_hash` column.
-- `authenticated` (browser role) has column-level SELECT on all profiles columns EXCEPT
-- pin_hash (locked by 0080), so `select *` => 42501 permission denied for table profiles,
-- making every browser org_snapshot() call throw. Overview/Dispatch/PlanConstructor all
-- broke ("Не всё загрузилось" / "Свободных работников нет"); the assistant worked only
-- because it calls via edge as service_role. Fix: select just the used columns (name, role).
-- No scoping/grant/security change; JSON output identical.
CREATE OR REPLACE FUNCTION public.org_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with tz as (select coalesce((select timezone from app_settings limit 1), 'America/Los_Angeles') as z),
       d  as (select (now() at time zone (select z from tz))::date as today,
                     ((now() at time zone (select z from tz))::date - 1) as yest)
  select jsonb_build_object(
    'as_of', now(),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('name',p.name,'status',p.status,'address',p.address,'start_date',p.start_date,'end_date',p.end_date))
                          from (select * from public.projects where deleted_at is null and status <> 'archived' order by created_at desc limit 30) p), '[]'::jsonb),
    'team', coalesce((select jsonb_agg(jsonb_build_object('name',t.name,'role',t.role))
                      from (select name, role from public.profiles where is_active and deleted_at is null order by name limit 60) t), '[]'::jsonb),
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
$function$;
