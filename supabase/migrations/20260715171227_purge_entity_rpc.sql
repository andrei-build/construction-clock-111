-- 0040: purge_entity — owner-only hard delete from Trash (Корзина), with journal.
-- Law: only rows ALREADY in trash (deleted_at is not null) can be purged; only role 'owner' (not admin).
-- projects/profiles/accounts intentionally UNSUPPORTED (immutable time history lives under projects).
create or replace function public.purge_entity(p_entity_type text, p_entity_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_org uuid := app.org_id();
  v_snapshot jsonb;
begin
  if app.user_role() <> 'owner' then
    raise exception 'only_owner_can_purge';
  end if;
  if v_org is null then
    raise exception 'no_profile';
  end if;

  if p_entity_type = 'task' then
    select to_jsonb(t) into v_snapshot from public.tasks t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    update public.tasks set parent_task_id = null where parent_task_id = p_entity_id and org_id = v_org;
    update public.messages set task_id = null where task_id = p_entity_id and org_id = v_org;
    update public.project_materials set task_id = null where task_id = p_entity_id and org_id = v_org;
    update public.media set task_id = null where task_id = p_entity_id and org_id = v_org;
    delete from public.tasks where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'project_note' then
    select to_jsonb(t) into v_snapshot from public.project_notes t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    delete from public.project_notes where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'document' then
    select to_jsonb(t) into v_snapshot from public.documents t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    update public.documents set source_document_id = null where source_document_id = p_entity_id and org_id = v_org;
    delete from public.documents where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'file' then
    select to_jsonb(t) into v_snapshot from public.files t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    delete from public.files where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'calendar_event' then
    select to_jsonb(t) into v_snapshot from public.calendar_events t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    delete from public.calendar_events where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'project_material' then
    select to_jsonb(t) into v_snapshot from public.project_materials t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    delete from public.project_materials where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'project_expense' then
    select to_jsonb(t) into v_snapshot from public.project_expenses t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    delete from public.project_expenses where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'message' then
    select to_jsonb(t) into v_snapshot from public.messages t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    delete from public.messages where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'contact' then
    select to_jsonb(t) into v_snapshot from public.contacts t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    update public.documents set approved_by_contact = null where approved_by_contact = p_entity_id and org_id = v_org;
    update public.deals set contact_id = null where contact_id = p_entity_id and org_id = v_org;
    delete from public.contacts where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'deal' then
    select to_jsonb(t) into v_snapshot from public.deals t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    update public.calendar_events set deal_id = null where deal_id = p_entity_id and org_id = v_org;
    delete from public.deals where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'daily_report' then
    select to_jsonb(t) into v_snapshot from public.daily_reports t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    delete from public.daily_reports where id = p_entity_id and org_id = v_org;

  elsif p_entity_type = 'media' then
    select to_jsonb(t) into v_snapshot from public.media t
      where t.id = p_entity_id and t.org_id = v_org and t.deleted_at is not null;
    if v_snapshot is null then raise exception 'not_in_trash'; end if;
    update public.project_expenses set media_id = null where media_id = p_entity_id and org_id = v_org;
    delete from public.media_flags where media_id = p_entity_id and org_id = v_org;
    delete from public.media where id = p_entity_id and org_id = v_org;

  else
    raise exception 'unsupported_entity_type';
  end if;

  insert into public.events (org_id, event_type, entity_type, entity_id, data, actor_id)
  values (v_org, 'entity.purged', p_entity_type, p_entity_id,
          jsonb_build_object('snapshot', v_snapshot), (select auth.uid()));

exception
  when foreign_key_violation then
    raise exception 'purge_blocked_by_references';
end;
$$;

revoke all on function public.purge_entity(text, uuid) from public, anon;
grant execute on function public.purge_entity(text, uuid) to authenticated;