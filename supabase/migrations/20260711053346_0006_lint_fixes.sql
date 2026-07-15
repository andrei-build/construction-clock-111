-- Фикс линтера: фиксируем search_path у триггерной функции
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  if to_jsonb(new) ? 'version' then
    new.version = coalesce((to_jsonb(old)->>'version')::int, 0) + 1;
  end if;
  return new;
end $$;