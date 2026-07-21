-- SHIFT-PING: cron */15 — умный пинг при тишине GPS на открытой смене
-- (30 мин тишины → пуш+сообщение работнику; максимум 2 пинга за смену, повтор не раньше 45 мин — закон Андрея «не задалбывать»)
select cron.schedule('ping-silent-shifts', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://gzjfjszfdnmaazursppx.supabase.co/functions/v1/shift-ping',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-shift-token', (select settings->>'shift_ping_token' from app_settings limit 1)
    ),
    body := '{}'::jsonb
  );
$$);
