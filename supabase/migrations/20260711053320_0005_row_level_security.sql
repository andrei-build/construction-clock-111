-- Construction Clock · Миграция 0005: RLS для всех таблиц (ДНК §1, §2; карта блок 23)

-- Хелпер: клиентские аккаунты текущего пользователя (портал)
create or replace function app.client_account_ids() returns setof uuid
language sql stable security definer set search_path = public as
$$ select account_id from public.client_users where profile_id = (select auth.uid()) $$;

-- Хелпер: доступ к проекту (назначение или all_active минус исключения, менеджеры — всё)
create or replace function app.can_access_project(p_project_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.is_manager()
    or exists (select 1 from public.project_assignments pa
               where pa.project_id = p_project_id and pa.profile_id = (select auth.uid()))
    or exists (select 1 from public.profiles p
               join public.projects pr on pr.id = p_project_id
               where p.id = (select auth.uid())
                 and p.project_access_mode = 'all_active'
                 and pr.status = 'active' and pr.deleted_at is null
                 and not exists (select 1 from public.project_exclusions pe
                                 where pe.project_id = p_project_id and pe.profile_id = p.id))
$$;

revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.user_capabilities enable row level security;
alter table public.events enable row level security;
alter table public.projects enable row level security;
alter table public.project_assignments enable row level security;
alter table public.project_exclusions enable row level security;
alter table public.time_events enable row level security;
alter table public.safety_acknowledgements enable row level security;
alter table public.location_consents enable row level security;
alter table public.live_locations enable row level security;
alter table public.shift_geo_events enable row level security;
alter table public.supply_stores enable row level security;
alter table public.store_visits enable row level security;
alter table public.tasks enable row level security;
alter table public.messages enable row level security;
alter table public.media enable row level security;
alter table public.media_comments enable row level security;
alter table public.files enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.pin_login_rate_limits enable row level security; -- политик нет намеренно: только service_role
alter table public.accounts enable row level security;
alter table public.contacts enable row level security;
alter table public.client_users enable row level security;
alter table public.subcontractor_details enable row level security;
alter table public.cost_codes enable row level security;
alter table public.units enable row level security;
alter table public.documents enable row level security;
alter table public.document_items enable row level security;
alter table public.profile_rates enable row level security;
alter table public.pay_periods enable row level security;
alter table public.pay_period_items enable row level security;
alter table public.payroll_closures enable row level security;

-- ОРГАНИЗАЦИЯ
create policy org_select on public.organizations for select to authenticated
  using (id = app.org_id());
create policy org_update on public.organizations for update to authenticated
  using (id = app.org_id() and app.is_owner());

-- ПРОФИЛИ: клиент видит только менеджеров и себя; остальные — всю оргу
create policy profiles_select on public.profiles for select to authenticated
  using (org_id = app.org_id() and deleted_at is null
         and (app.user_role() <> 'client' or id = (select auth.uid()) or role in ('owner','admin','manager')));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (org_id = app.org_id() and app.is_manager_write());
create policy profiles_update on public.profiles for update to authenticated
  using ((org_id = app.org_id() and app.is_manager_write()) or id = (select auth.uid()));

-- КАПАБИЛИТИ (ДНК §1: finance_access — только owner/admin)
create policy caps_select on public.user_capabilities for select to authenticated
  using (user_id = (select auth.uid())
         or (app.is_manager() and exists (select 1 from public.profiles t where t.id = user_id and t.org_id = app.org_id())));
create policy caps_write on public.user_capabilities for all to authenticated
  using (exists (select 1 from public.profiles t where t.id = user_id and t.org_id = app.org_id())
         and ((capability = 'finance_access' and app.is_owner())
           or (capability <> 'finance_access' and app.is_manager_write())))
  with check (exists (select 1 from public.profiles t where t.id = user_id and t.org_id = app.org_id())
         and ((capability = 'finance_access' and app.is_owner())
           or (capability <> 'finance_access' and app.is_manager_write())));

-- СОБЫТИЯ: пишут все про себя, читают менеджеры (+свои действия каждый)
create policy events_insert on public.events for insert to authenticated
  with check (org_id = app.org_id() and (actor_id = (select auth.uid()) or actor_id is null));
create policy events_select on public.events for select to authenticated
  using (org_id = app.org_id() and (app.is_manager() or actor_id = (select auth.uid())));

-- ПРОЕКТЫ: клиент видит только свои; остальные — по оргe
create policy projects_select on public.projects for select to authenticated
  using (org_id = app.org_id() and deleted_at is null
         and (app.user_role() <> 'client' or client_account_id in (select app.client_account_ids())));
create policy projects_write on public.projects for insert to authenticated
  with check (org_id = app.org_id() and app.is_manager_write());
create policy projects_update on public.projects for update to authenticated
  using (org_id = app.org_id() and app.is_manager_write());

create policy pa_select on public.project_assignments for select to authenticated
  using (org_id = app.org_id());
create policy pa_write on public.project_assignments for all to authenticated
  using (org_id = app.org_id() and app.is_manager_write())
  with check (org_id = app.org_id() and app.is_manager_write());

create policy pe_select on public.project_exclusions for select to authenticated
  using (org_id = app.org_id());
create policy pe_write on public.project_exclusions for all to authenticated
  using (org_id = app.org_id() and app.is_manager_write())
  with check (org_id = app.org_id() and app.is_manager_write());

-- ВРЕМЯ: работник видит и пишет своё (приход/уход/перерыв), корректировки — только менеджерская запись
create policy te_select on public.time_events for select to authenticated
  using (org_id = app.org_id() and (app.is_manager() or profile_id = (select auth.uid())));
create policy te_insert on public.time_events for insert to authenticated
  with check (org_id = app.org_id()
    and ((profile_id = (select auth.uid()) and event_type <> 'adjustment')
         or (app.is_manager_write())));

-- ТБ и согласия
create policy sa_insert on public.safety_acknowledgements for insert to authenticated
  with check (org_id = app.org_id() and worker_id = (select auth.uid()));
create policy sa_select on public.safety_acknowledgements for select to authenticated
  using ((org_id = app.org_id() and app.is_manager()) or worker_id = (select auth.uid()));

create policy lc_insert on public.location_consents for insert to authenticated
  with check (org_id = app.org_id() and worker_id = (select auth.uid()));
create policy lc_select on public.location_consents for select to authenticated
  using (org_id = app.org_id() and (app.is_manager() or worker_id = (select auth.uid())));

-- ЖИВАЯ КАРТА и ГЕО-КОНТРОЛЬ
create policy ll_insert on public.live_locations for insert to authenticated
  with check (org_id = app.org_id() and (worker_id = (select auth.uid()) or app.is_manager_write()));
create policy ll_select on public.live_locations for select to authenticated
  using (org_id = app.org_id() and (app.is_manager() or worker_id = (select auth.uid())));

create policy sge_select on public.shift_geo_events for select to authenticated
  using (org_id = app.org_id() and app.is_manager());

create policy ss_select on public.supply_stores for select to authenticated
  using (org_id is null or org_id = app.org_id());
create policy ss_write on public.supply_stores for all to authenticated
  using (app.is_manager_write()) with check (app.is_manager_write());

create policy sv_insert on public.store_visits for insert to authenticated
  with check (org_id = app.org_id() and (worker_id = (select auth.uid()) or app.is_manager_write()));
create policy sv_select on public.store_visits for select to authenticated
  using (org_id = app.org_id() and (app.is_manager() or worker_id = (select auth.uid())));
create policy sv_update on public.store_visits for update to authenticated
  using (org_id = app.org_id() and (worker_id = (select auth.uid()) or app.is_manager_write()));

-- ЗАДАЧИ: водитель видит только доставки; клиент — ничего (карта блок 23)
create policy tasks_select on public.tasks for select to authenticated
  using (org_id = app.org_id() and deleted_at is null
         and app.user_role() <> 'client'
         and (app.user_role() <> 'driver' or task_type = 'delivery'));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (org_id = app.org_id() and app.is_manager_write());
create policy tasks_update on public.tasks for update to authenticated
  using (org_id = app.org_id()
         and (app.is_manager_write()
              or assigned_to = (select auth.uid())
              or (assigned_to is null and app.can_access_project(project_id))));

-- СООБЩЕНИЯ
create policy msg_insert on public.messages for insert to authenticated
  with check (org_id = app.org_id() and sender_id = (select auth.uid()));
create policy msg_select on public.messages for select to authenticated
  using (org_id = app.org_id()
         and (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()) or app.is_manager()));
create policy msg_update on public.messages for update to authenticated
  using (org_id = app.org_id() and (recipient_id = (select auth.uid()) or app.is_manager_write()));

-- МЕДИА: чеки — только финансы+автор; клиент — только client_visible своих проектов (ДНК §2 п.8)
create policy media_select on public.media for select to authenticated
  using (org_id = app.org_id() and deleted_at is null
    and case
      when category = 'receipt' then (app.has_finance_access() or uploaded_by = (select auth.uid()))
      when app.user_role() = 'client' then (client_visible and exists (
        select 1 from public.projects pr where pr.id = media.project_id
          and pr.client_account_id in (select app.client_account_ids())))
      else (app.is_manager() or uploaded_by = (select auth.uid()) or app.can_access_project(project_id))
    end);
create policy media_insert on public.media for insert to authenticated
  with check (org_id = app.org_id() and (uploaded_by = (select auth.uid()) or app.is_manager_write()));
create policy media_update on public.media for update to authenticated
  using (org_id = app.org_id() and (uploaded_by = (select auth.uid()) or app.is_manager_write()));
-- Окончательное удаление медиа — только владелец (блок 23): DELETE-политики нет, снос делает owner через service-роль/функцию

create policy mc_select on public.media_comments for select to authenticated
  using (exists (select 1 from public.media m where m.id = media_id)); -- видимость медиа уже отфильтрована RLS media
create policy mc_insert on public.media_comments for insert to authenticated
  with check (author_id = (select auth.uid()) and exists (select 1 from public.media m where m.id = media_id));

-- ФАЙЛЫ: приватные — автор+менеджеры; клиентские — свой аккаунт; субчик — свои
create policy files_select on public.files for select to authenticated
  using (org_id = app.org_id() and deleted_at is null
    and case
      when app.user_role() = 'client' then (scope = 'client' and account_id in (select app.client_account_ids()))
      when is_private then (uploaded_by = (select auth.uid()) or profile_id = (select auth.uid()) or app.is_manager())
      else (app.is_manager() or profile_id = (select auth.uid()) or uploaded_by = (select auth.uid())
            or (project_id is not null and app.can_access_project(project_id)))
    end);
create policy files_insert on public.files for insert to authenticated
  with check (org_id = app.org_id() and (app.is_manager_write() or uploaded_by = (select auth.uid())));
create policy files_update on public.files for update to authenticated
  using (org_id = app.org_id() and (app.is_manager_write() or uploaded_by = (select auth.uid())));

-- ПУШИ: каждый своё
create policy push_all on public.push_subscriptions for all to authenticated
  using (profile_id = (select auth.uid())) with check (profile_id = (select auth.uid()));

-- КЛИЕНТЫ и КОНТАКТЫ: менеджеры; клиент видит свой аккаунт
create policy acc_select on public.accounts for select to authenticated
  using (org_id = app.org_id()
         and (app.is_manager() or id in (select app.client_account_ids())));
create policy acc_write on public.accounts for all to authenticated
  using (org_id = app.org_id() and app.is_manager_write())
  with check (org_id = app.org_id() and app.is_manager_write());

create policy con_select on public.contacts for select to authenticated
  using (org_id = app.org_id()
         and (app.is_manager() or account_id in (select app.client_account_ids())));
create policy con_write on public.contacts for all to authenticated
  using (org_id = app.org_id() and app.is_manager_write())
  with check (org_id = app.org_id() and app.is_manager_write());

create policy cu_select on public.client_users for select to authenticated
  using (profile_id = (select auth.uid()) or app.is_manager());
create policy cu_write on public.client_users for all to authenticated
  using (app.is_manager_write()) with check (app.is_manager_write());

create policy sub_select on public.subcontractor_details for select to authenticated
  using (org_id = app.org_id() and (app.is_manager() or profile_id = (select auth.uid())));
create policy sub_write on public.subcontractor_details for all to authenticated
  using (org_id = app.org_id() and app.is_manager_write())
  with check (org_id = app.org_id() and app.is_manager_write());

-- СМЕТНАЯ БАЗА
create policy cc_select on public.cost_codes for select to authenticated
  using (org_id = app.org_id() and app.user_role() <> 'client');
create policy cc_write on public.cost_codes for all to authenticated
  using (org_id = app.org_id() and app.is_manager_write())
  with check (org_id = app.org_id() and app.is_manager_write());

create policy units_select on public.units for select to authenticated
  using (org_id is null or org_id = app.org_id());
create policy units_write on public.units for all to authenticated
  using (app.is_manager_write()) with check (app.is_manager_write());

-- ДОКУМЕНТЫ (сметы/инвойсы): финансы управляют; клиент видит свои client_visible не-черновики (блок 14)
create policy docs_select on public.documents for select to authenticated
  using (org_id = app.org_id() and deleted_at is null
    and (app.has_finance_access()
         or (app.user_role() = 'client' and client_visible and status <> 'draft'
             and account_id in (select app.client_account_ids()))));
create policy docs_write on public.documents for all to authenticated
  using (org_id = app.org_id() and app.has_finance_access())
  with check (org_id = app.org_id() and app.has_finance_access());

create policy di_select on public.document_items for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id)); -- RLS documents фильтрует
create policy di_write on public.document_items for all to authenticated
  using (app.has_finance_access() and exists (select 1 from public.documents d where d.id = document_id))
  with check (app.has_finance_access() and exists (select 1 from public.documents d where d.id = document_id));

-- ЗАРПЛАТА: только финансы; работник видит свою строку и свои закрытия
create policy rates_all on public.profile_rates for all to authenticated
  using (org_id = app.org_id() and app.has_finance_access())
  with check (org_id = app.org_id() and app.has_finance_access());

create policy pp_all on public.pay_periods for all to authenticated
  using (org_id = app.org_id() and app.has_finance_access())
  with check (org_id = app.org_id() and app.has_finance_access());

create policy ppi_finance on public.pay_period_items for all to authenticated
  using (app.has_finance_access() and exists (select 1 from public.pay_periods pp where pp.id = pay_period_id and pp.org_id = app.org_id()))
  with check (app.has_finance_access() and exists (select 1 from public.pay_periods pp where pp.id = pay_period_id and pp.org_id = app.org_id()));
create policy ppi_self_select on public.pay_period_items for select to authenticated
  using (profile_id = (select auth.uid()));

create policy pc_insert on public.payroll_closures for insert to authenticated
  with check (org_id = app.org_id() and app.has_finance_access());
create policy pc_select on public.payroll_closures for select to authenticated
  using (org_id = app.org_id() and (app.has_finance_access() or profile_id = (select auth.uid())));

-- ХРАНИЛИЩЕ: приватный бакет media
insert into storage.buckets (id, name, public) values ('media','media', false)
  on conflict (id) do nothing;
create policy storage_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media');
create policy storage_media_select on storage.objects for select to authenticated
  using (bucket_id = 'media');