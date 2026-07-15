-- 0025: материальные заявки — двойная отметка «взял» / «доставил» (требование Андрея 14.07)
alter table public.tasks add column if not exists picked_up_at timestamptz;
alter table public.tasks add column if not exists picked_up_by uuid references public.profiles(id);
alter table public.tasks add column if not exists delivered_at timestamptz;
alter table public.tasks add column if not exists delivered_by uuid references public.profiles(id);
comment on column public.tasks.picked_up_at is 'Материал: когда позицию ЗАБРАЛИ (закупка). Любой активный член команды. Вторая отметка — delivered_at.';
comment on column public.tasks.delivered_at is 'Материал: когда позицию ДОСТАВИЛИ на объект.';

-- RPC: любой активный член организации может отметить взял/доставил на материальной задаче своей организации
create or replace function public.mark_material_status(p_task_id uuid, p_action text)
returns json language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile record;
  v_task record;
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  select id, org_id, is_active into v_profile from profiles where id = v_uid;
  if v_profile.id is null or not v_profile.is_active then raise exception 'no_active_profile'; end if;
  select id, org_id, task_type, picked_up_at, delivered_at into v_task from tasks
    where id = p_task_id and deleted_at is null;
  if v_task.id is null or v_task.org_id <> v_profile.org_id then raise exception 'task_not_found'; end if;
  if v_task.task_type not in ('material','delivery') then raise exception 'not_material_task'; end if;

  if p_action = 'picked_up' then
    if v_task.picked_up_at is not null then raise exception 'already_picked_up'; end if;
    update tasks set picked_up_at = now(), picked_up_by = v_uid, updated_by = v_uid where id = p_task_id;
  elsif p_action = 'undo_picked_up' then
    if v_task.delivered_at is not null then raise exception 'already_delivered'; end if;
    update tasks set picked_up_at = null, picked_up_by = null, updated_by = v_uid
      where id = p_task_id and picked_up_by = v_uid;
  elsif p_action = 'delivered' then
    if v_task.picked_up_at is null then raise exception 'not_picked_up_yet'; end if;
    if v_task.delivered_at is not null then raise exception 'already_delivered'; end if;
    update tasks set delivered_at = now(), delivered_by = v_uid, updated_by = v_uid where id = p_task_id;
  else
    raise exception 'bad_action';
  end if;

  insert into events (org_id, event_type, actor_id, actor_name, entity_type, entity_id, data)
  select v_task.org_id, 'material.' || p_action, v_uid, (select name from profiles where id = v_uid), 'task', p_task_id,
         jsonb_build_object('action', p_action);
  return json_build_object('ok', true);
end $$;

revoke execute on function public.mark_material_status(uuid, text) from public, anon;
grant execute on function public.mark_material_status(uuid, text) to authenticated;

-- realtime: чтобы менеджер видел галочки в реальном времени
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;