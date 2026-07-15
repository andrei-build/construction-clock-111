-- F82/F23: enable Supabase Realtime postgres_changes for messages (bell/chat) and events (feeds).
-- Additive + reversible. Both tables already have RLS enabled with SELECT policies that gate
-- visibility to recipient/actor/manager, so realtime respects the same authorization as reads.
-- Mirrors the already-working `tasks` config (replica identity default; INSERT carries the full new row).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;