-- 0030: навыки работника для ИИ-распределения (паритет карточки Check Time) + орг-радиус автодетекта магазинов
alter table public.profiles
  add column if not exists skills text,
  add column if not exists skills_note text;
comment on column public.profiles.skills is 'Навыки для ИИ-распределения (через запятую), видны manager+; читает AI-помощник при подсказке кого ставить на задачу';
comment on column public.profiles.skills_note is 'Заметка по способностям работника (свободный текст для AI-подсказок)';

alter table public.app_settings
  add column if not exists store_visit_radius_m integer not null default 75;
comment on column public.app_settings.store_visit_radius_m is 'Радиус автодетекта визита в магазин, метры (50-150, default 75) — настройка владельца';