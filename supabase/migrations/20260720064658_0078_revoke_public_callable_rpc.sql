-- Ф1 ФУНДАМЕНТ: 0077 был НЕПОЛНЫМ — revoke только от anon не помогает, т.к. EXECUTE выдан PUBLIC по умолчанию
-- (anon наследует через PUBLIC). Правильно: revoke от PUBLIC, затем grant только нужным ролям.
do $$
declare r record;
begin
  -- close_pay_period (финансы), attach_checkout_video (работник): только authenticated + service_role
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('close_pay_period','attach_checkout_video')
  loop
    execute format('revoke execute on function %s from public', r.oid::regprocedure);
    execute format('revoke execute on function %s from anon', r.oid::regprocedure);
    execute format('grant execute on function %s to authenticated', r.oid::regprocedure);
    execute format('grant execute on function %s to service_role', r.oid::regprocedure);
  end loop;
  -- notify_expiring_docs, flag_stale_catalog_prices: только cron/service_role
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app' and p.proname in ('notify_expiring_docs','flag_stale_catalog_prices')
  loop
    execute format('revoke execute on function %s from public', r.oid::regprocedure);
    execute format('revoke execute on function %s from anon', r.oid::regprocedure);
    execute format('revoke execute on function %s from authenticated', r.oid::regprocedure);
    execute format('grant execute on function %s to service_role', r.oid::regprocedure);
  end loop;
end $$;
