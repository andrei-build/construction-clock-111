-- Ф2 Шаг 4 (аддитивно, потребители НЕ трогаются). Всё invoker → читается от лица вызывающего под RLS.

-- «Кто свободен»: активные worker/driver/supervisor не в текущих назначениях
create or replace view public.v_workers_unassigned
with (security_invoker = on) as
select p.org_id, p.id as profile_id, p.name, p.role
from public.profiles p
where p.deleted_at is null and p.is_active
  and p.role in ('worker','driver','supervisor')
  and not exists (select 1 from public.v_assignments_current a where a.profile_id = p.id);

grant select on public.v_workers_unassigned to authenticated;

-- ЕДИНЫЙ СНИМОК «состояние бизнеса на сейчас». security invoker → RLS вызывающего,
-- поэтому ассистент, вызвав его ОТ ЛИЦА пользователя, увидит ровно то же, что экран (закрывает шов №1).
-- Производные берём из канон-вью/RPC (report_hours), НЕ пересчитываем.
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
    'projects_money',coalesce((select jsonb_agg(to_jsonb(m) - 'org_id') from public.v_project_profit m), '[]'::jsonb)
  );
$$;

-- EXECUTE по умолчанию идёт PUBLIC — как в 0078, отзываем и выдаём точечно
revoke execute on function public.org_snapshot() from public;
grant execute on function public.org_snapshot() to authenticated, service_role;
