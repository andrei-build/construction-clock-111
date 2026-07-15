-- 0038: фикс 0037 — старый статус это enum, coalesce с '' ронял триггер
create or replace function app.guard_task_photo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'done' and old.status is distinct from new.status
     and coalesce(new.requires_photo, false)
     and not exists (
       select 1 from media m
       where m.task_id = new.id and m.deleted_at is null
     )
  then
    raise exception 'photo_required: task % requires a photo before it can be marked done', new.id
      using errcode = 'P0001';
  end if;
  return new;
end $function$;