-- 0041: QA-DIAG BUG#1 — soft-delete задачи падал 42501. Двойной фикс:
-- (1) tasks_update: явный WITH CHECK (новая строка с deleted_at проходит гейт менеджера);
-- (2) надёжный путь: RPC soft_delete_task (SECURITY DEFINER, manager+, журнал) — не зависит от RETURNING/select-политики.
alter policy tasks_update on public.tasks
  using ((org_id = app.org_id()) and (app.is_manager_write() or (assigned_to = (select auth.uid())) or ((assigned_to is null) and app.can_access_project(project_id))))
  with check ((org_id = app.org_id()) and (app.is_manager_write() or (assigned_to = (select auth.uid())) or ((assigned_to is null) and app.can_access_project(project_id))));

create or replace function public.soft_delete_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_org uuid := app.org_id();
  v_name text;
begin
  if not app.is_manager_write() then
    raise exception 'forbidden';
  end if;
  select title into v_name from public.tasks where id = p_task_id and org_id = v_org;
  if not found then
    raise exception 'task_not_found';
  end if;
  update public.tasks set deleted_at = now() where id = p_task_id and org_id = v_org and deleted_at is null;
  if found then
    insert into public.events (org_id, event_type, entity_type, entity_id, data, actor_id)
    values (v_org, 'task.deleted', 'task', p_task_id, jsonb_build_object('title', v_name), (select auth.uid()));
  end if;
end;
$$;

revoke all on function public.soft_delete_task(uuid) from public, anon;
grant execute on function public.soft_delete_task(uuid) to authenticated;