-- 0042: QA-DIAG BUG#1 (система): «deleted_at IS NULL» в select-политиках прятал удалённые строки ОТ ВСЕХ,
-- из-за чего (а) Корзина пуста для владельца, (б) сам soft-delete UPDATE падает 42501 (новая строка невидима).
-- Фикс: удалённые строки видимы менеджерам+ (Корзина/восстановление); все остальные ролевые гейты сохранены дословно.

alter policy tasks_select on public.tasks using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager()) and (app.user_role() <> 'client'::user_role)
  and ((app.user_role() <> 'driver'::user_role) or (task_type = any (array['delivery'::task_type, 'material'::task_type])))
);

alter policy pn_select on public.project_notes using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager()) and (app.is_manager() or app.can_access_project(project_id))
);

alter policy cal_select on public.calendar_events using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager())
  and (app.is_manager() or (app.user_role() = 'sales'::user_role) or (assigned_to = (select auth.uid())))
);

alter policy deals_select on public.deals using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager())
  and (app.is_manager() or (app.user_role() = 'sales'::user_role) or (owner_profile_id = (select auth.uid())))
);

alter policy docs_select on public.documents using (
  (org_id = app.org_id()) and ((deleted_at is null) or (app.is_manager() and app.has_finance_access()))
  and (app.has_finance_access() or ((app.user_role() = 'client'::user_role) and client_visible and (status <> 'draft'::doc_status)
       and (account_id in (select app.client_account_ids()))))
);

alter policy files_select on public.files using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager()) and
  case
    when (app.user_role() = 'client'::user_role) then ((scope = 'client'::text) and (account_id in (select app.client_account_ids())))
    when is_private then ((uploaded_by = (select auth.uid())) or (profile_id = (select auth.uid())) or app.is_manager())
    else (app.is_manager() or (profile_id = (select auth.uid())) or (uploaded_by = (select auth.uid())) or ((project_id is not null) and app.can_access_project(project_id)))
  end
);

alter policy media_select on public.media using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager()) and
  case
    when (category = 'receipt'::text) then (app.has_finance_access() or (uploaded_by = (select auth.uid())))
    when (app.user_role() = 'client'::user_role) then (client_visible and (exists (select 1 from projects pr
        where pr.id = media.project_id and pr.client_account_id in (select app.client_account_ids()))))
    else (app.is_manager() or (uploaded_by = (select auth.uid())) or app.can_access_project(project_id))
  end
);

alter policy profiles_select on public.profiles using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager())
  and ((app.user_role() <> 'client'::user_role) or (id = (select auth.uid())) or (role = any (array['owner'::user_role, 'admin'::user_role, 'manager'::user_role])))
);

alter policy exp_select on public.project_expenses using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager()) and (app.has_finance_access() or app.is_manager())
);

alter policy projects_select on public.projects using (
  (org_id = app.org_id()) and ((deleted_at is null) or app.is_manager())
  and ((app.user_role() <> 'client'::user_role) or (client_account_id in (select app.client_account_ids())))
);