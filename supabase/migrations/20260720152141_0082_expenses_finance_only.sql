-- Решение Андрея: «финансы только через галочку». project_expenses.exp_select пускал
-- любого менеджера (OR app.is_manager()) в обход финанс-капабилити. Убираем: расходы видит
-- только owner или тот, у кого выставлена галочка finance_access (user_capabilities).
-- Корзину (deleted) по-прежнему видят менеджеры, но лишь при наличии финанс-доступа.
drop policy if exists exp_select on public.project_expenses;
create policy exp_select on public.project_expenses
  for select
  using (
    org_id = app.org_id()
    and ((deleted_at is null) or app.is_manager())
    and app.has_finance_access()
  );
