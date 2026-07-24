-- 0094: subcontractor_details под финансы (хвост 6, Бета-8, 24.07). Решение Андрея от 20.07:
-- payment_terms (и реквизиты саба в целом) — только финансовый доступ. UI и так показывает
-- секцию лишь владельцу; теперь и RLS совпадает. Саб видит свою строку (read-only, как раньше).
-- app.notify_expiring_docs() — security definer, страховочные алерты не задеты.

drop policy if exists sub_select on subcontractor_details;
create policy sub_select on subcontractor_details for select to authenticated
  using (
    org_id = app.org_id()
    and (app.has_finance_access() or profile_id = (select auth.uid()))
  );

drop policy if exists sub_write on subcontractor_details;
create policy sub_write on subcontractor_details for all to authenticated
  using (org_id = app.org_id() and app.has_finance_access())
  with check (org_id = app.org_id() and app.has_finance_access());
