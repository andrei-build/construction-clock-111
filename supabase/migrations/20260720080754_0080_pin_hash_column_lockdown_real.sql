-- Ф1 проход 3, настоящая починка. 0079 был no-op: колоночный REVOKE не отменяет
-- табличный GRANT SELECT (табличный грант покрывает ВСЕ колонки). Механизм скрытия одной
-- колонки в Postgres — снять табличный SELECT и выдать поколоночный на все, КРОМЕ pin_hash.
-- Поведение остаётся идентичным для всех прочих колонок; меняется только то, что
-- credential-хэш перестаёт быть читаемым через REST для anon и authenticated.
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ')
    into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name <> 'pin_hash';

  execute 'revoke select on public.profiles from anon, authenticated';
  execute format('grant select (%s) on public.profiles to anon, authenticated', v_cols);
end $$;
-- service_role сохраняет полный табличный доступ (PIN-проверка идёт на нём в edge-функциях).
