-- 0017: требование видео при уходе живёт ТОЛЬКО на работнике (profiles.require_checkout_video, из ДНК).
-- Колонка projects.require_checkout_video была добавлена в 0015 по ошибке (семантика Check Time — per-worker); фронт на неё больше не ссылается.
alter table public.projects drop column if exists require_checkout_video;