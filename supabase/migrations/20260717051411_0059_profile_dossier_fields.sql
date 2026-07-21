-- TEAM-DOSSIER (закон Андрея 17.07: ЧЕЛОВЕК=ДОСЬЕ — фото, все данные). Аддитивно.
-- Фото уже есть (profiles.avatar_url + R2). Саб-контракторские реквизиты уже есть (subcontractor_details).
alter table public.profiles
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists home_address text,
  add column if not exists emergency_contact text,
  add column if not exists hire_date date,
  add column if not exists dossier_notes text;
comment on column public.profiles.emergency_contact is 'Экстренный контакт: имя + телефон';
comment on column public.profiles.dossier_notes is 'Заметки владельца о человеке (видны manager+)';
