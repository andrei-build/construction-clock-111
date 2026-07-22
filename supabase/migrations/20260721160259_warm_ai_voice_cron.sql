-- 0090: подогрев голосового конвейера (Бета-7, 21.07.2026). Применено в прод через MCP 21.07 ~16:03Z.
-- Холодный старт edge-изолятов ai-assistant/ai-tts-stream добавлял ~1с к первому ответу голоса.
-- Пинг каждые 4 минуты держит изоляты тёплыми. ai-assistant v22: заголовок x-warmup:1 -> ранний return 200 (до auth).
-- ai-tts-stream: пинг с anon-JWT проходит verify_jwt, своя авторизация вернёт 403 - изолят прогрет. anon-ключ публичный.
select cron.schedule(
  'warm-ai-voice',
  '*/4 * * * *',
  $cron$
  select net.http_post(
    url := 'https://gzjfjszfdnmaazursppx.supabase.co/functions/v1/ai-assistant',
    headers := jsonb_build_object('Content-Type','application/json','x-warmup','1'),
    body := '{}'::jsonb
  ),
  net.http_post(
    url := 'https://gzjfjszfdnmaazursppx.supabase.co/functions/v1/ai-tts-stream',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd6amZqc3pmZG5tYWF6dXJzcHB4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3NDY4OTcsImV4cCI6MjA5OTMyMjg5N30.RTWuDw_em42y-TpOMovcGY-qn3UUGCJvlwQvFlBskxY',
      'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd6amZqc3pmZG5tYWF6dXJzcHB4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3NDY4OTcsImV4cCI6MjA5OTMyMjg5N30.RTWuDw_em42y-TpOMovcGY-qn3UUGCJvlwQvFlBskxY'
    ),
    body := '{}'::jsonb
  )
  $cron$
);