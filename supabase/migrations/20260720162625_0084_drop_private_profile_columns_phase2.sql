-- Ф1 ФАЗА-2: фронт перецеплен на profile_contact/profile_dossier (merge d8f1938, сборка зелёная).
-- Закрываем последнюю утечку на чтение — убираем приватные колонки из profiles.
-- Свип зависимостей (pg_get_functiondef по всем функциям+вью) чист: единственная ссылка — триггер защиты, пересобираем ниже.

-- 1) гарантируем строку в новых костях для КАЖДОГО профиля (на случай созданных после 0083)
insert into public.profile_contact (profile_id, org_id, phone, email, home_address, emergency_contact)
select id, org_id, phone, email, home_address, emergency_contact from public.profiles
on conflict (profile_id) do nothing;
insert into public.profile_dossier (profile_id, org_id, hire_date, dossier_notes)
select id, org_id, hire_date, dossier_notes from public.profiles
on conflict (profile_id) do nothing;

-- 2) добор пропусков БЕЗ затирания свежих записей нового фронта (coalesce: своё значение в приоритете)
update public.profile_contact pc set
  phone             = coalesce(pc.phone, p.phone),
  email             = coalesce(pc.email, p.email),
  home_address      = coalesce(pc.home_address, p.home_address),
  emergency_contact = coalesce(pc.emergency_contact, p.emergency_contact)
from public.profiles p
where p.id = pc.profile_id
  and (pc.phone is null or pc.email is null or pc.home_address is null or pc.emergency_contact is null);
update public.profile_dossier pd set
  hire_date     = coalesce(pd.hire_date, p.hire_date),
  dossier_notes = coalesce(pd.dossier_notes, p.dossier_notes)
from public.profiles p
where p.id = pd.profile_id
  and (pd.hire_date is null or pd.dossier_notes is null);

-- 3) пересобрать триггер защиты БЕЗ ссылок на hire_date/dossier_notes (они уехали в profile_dossier)
create or replace function app.protect_profile_privileged_cols()
  returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not app.is_manager_write() then
    new.role := old.role;
    new.pin_hash := old.pin_hash;
    new.org_id := old.org_id;
    new.is_active := old.is_active;
    new.project_access_mode := old.project_access_mode;
    new.require_checkout_video := old.require_checkout_video;
    new.pin_enabled := old.pin_enabled;
  end if;
  return new;
end $$;

-- 4) дроп приватных колонок из ростера
alter table public.profiles
  drop column phone,
  drop column email,
  drop column home_address,
  drop column emergency_contact,
  drop column hire_date,
  drop column dossier_notes;
