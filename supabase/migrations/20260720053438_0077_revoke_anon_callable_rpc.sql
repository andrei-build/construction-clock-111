-- ФУНДАМЕНТ-ХАРДНИНГ (Бета-6 как строитель): убрать anon-доступ к вызываемым RPC.
-- close_pay_period (финансы!) и attach_checkout_video внутренне гейтятся, но anon не должен даже иметь EXECUTE (defense-in-depth).
-- notify_expiring_docs / flag_stale_catalog_prices — только cron/service_role.
-- Триггер-функции (guard_*, stamp_event_actor, log_catalog_price_after) не трогаем — PostgREST их не вызывает, EXECUTE им безвреден.
do $$
declare r record;
begin
  for r in
    select p.oid from pg_proc p
    where p.pronamespace in ('public'::regnamespace,'app'::regnamespace)
      and p.proname in ('close_pay_period','attach_checkout_video','notify_expiring_docs','flag_stale_catalog_prices')
  loop
    execute format('revoke execute on function %s from anon', r.oid::regprocedure);
  end loop;
  for r in
    select p.oid from pg_proc p
    where p.pronamespace in ('public'::regnamespace,'app'::regnamespace)
      and p.proname in ('notify_expiring_docs','flag_stale_catalog_prices')
  loop
    execute format('revoke execute on function %s from authenticated', r.oid::regprocedure);
  end loop;
end $$;
