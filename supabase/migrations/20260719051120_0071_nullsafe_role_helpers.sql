-- Харднинг: app.user_role() возвращает NULL, если у auth-юзера нет строки в profiles
-- (удалённый профиль при живом JWT). Тогда is_owner()/is_manager*/has_finance_access()
-- отдают NULL, и plpgsql-гейты вида «if not app.has_finance_access() then raise» НЕ срабатывают
-- (not NULL = NULL). Затронуты: report_payroll, report_expenses, close_pay_period, soft_delete_task.
-- Лечим в корне: булевы хелперы никогда не возвращают NULL. Для RLS поведение не меняется
-- (NULL там и так = deny), для гейтов — закрывает обход.

create or replace function app.is_owner()
returns boolean language sql stable security definer set search_path to 'public'
as $$ select coalesce(app.user_role() in ('owner','admin'), false) $$;

create or replace function app.is_manager()
returns boolean language sql stable security definer set search_path to 'public'
as $$ select coalesce(app.user_role() in ('supervisor','manager','admin','owner'), false) $$;

create or replace function app.is_manager_write()
returns boolean language sql stable security definer set search_path to 'public'
as $$ select coalesce(app.user_role() in ('manager','admin','owner'), false) $$;

create or replace function app.has_finance_access()
returns boolean language sql stable security definer set search_path to 'public'
as $$ select coalesce(app.is_owner() or app.has_capability('finance_access'), false) $$;
