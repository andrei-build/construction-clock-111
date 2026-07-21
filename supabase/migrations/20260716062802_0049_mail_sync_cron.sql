-- MAIL-1: автосинк почты каждые 10 минут (тот же паттерн, что evening-digest)
select cron.schedule(
  'mail-sync',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://gzjfjszfdnmaazursppx.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mail-token', (select settings->>'mail_sync_token' from app_settings limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
