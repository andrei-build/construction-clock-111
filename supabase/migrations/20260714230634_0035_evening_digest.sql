-- 0035: вечерний дайджест «что завтра» (закон ДНК §8, DIGEST-1)
-- Час дайджеста настраивается владельцем; cron ежечасно зовёт edge evening-digest,
-- edge сам проверяет совпадение org-local часа с digest_hour и шлёт пуши owner/admin/manager.

alter table public.app_settings
  add column if not exists digest_hour integer not null default 18;

comment on column public.app_settings.digest_hour is 'Час (0-23, org-local) вечернего пуш-дайджеста «что завтра» менеджерам/владельцу. DIGEST-1.';

-- Секрет-токен для вызова edge из cron (edge сверяет с этим значением через service-клиент)
update public.app_settings
set settings = settings || jsonb_build_object('digest_token', encode(gen_random_bytes(24), 'hex'))
where settings->>'digest_token' is null;

-- Ежечасный вызов edge (edge сам решает, чей час настал)
select cron.schedule(
  'evening-digest',
  '5 * * * *',
  $$
  select net.http_post(
    url := 'https://gzjfjszfdnmaazursppx.supabase.co/functions/v1/evening-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-digest-token', (select settings->>'digest_token' from app_settings limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);