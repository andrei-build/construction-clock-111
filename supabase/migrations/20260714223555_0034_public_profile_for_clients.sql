-- 0034: публичный профиль работника для клиентских уведомлений (закон Андрея 14.07 ~22:15):
-- клиент видит ФОТО + ОПИСАНИЕ (кто он, что умеет), КОНТАКТЫ работника клиенту НЕ уходят НИКОГДА (контакты — только владельцу).

alter table public.profiles
  add column if not exists avatar_url text,
  add column if not exists public_bio text;

comment on column public.profiles.avatar_url is 'Фото работника (публичный bucket avatars) — показывается клиенту в уведомлениях «Поехали». БЕЗ контактов.';
comment on column public.profiles.public_bio is 'Публичное описание для клиента (кто он, специализация). Внутренние заметки для ИИ — в skills_note, они клиенту НЕ уходят.';

-- Публичный бакет для аватаров (фото по ссылке в письмах клиентам)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Загрузка/замена аватаров — manager+; чтение публичное (bucket public)
create policy avatars_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and app.is_manager_write());

create policy avatars_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and app.is_manager_write());

create policy avatars_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and app.is_manager_write());