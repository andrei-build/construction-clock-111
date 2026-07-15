-- 0023: П1 автозакрытие зависших смен (паритет Check Time: cron close-overlong-shifts) + RLS для push_subscriptions
create extension if not exists pg_cron;

create or replace function app.close_overlong_open_shifts() returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer := 0;
  v_threshold numeric;
  r record;
begin
  for r in
    select ci.id, ci.org_id, ci.profile_id, ci.project_id, ci.event_time
    from time_events ci
    where ci.event_type = 'check_in'
      and ci.adjusts_event_id is null
      and not exists (
        select 1 from time_events co
        where co.profile_id = ci.profile_id
          and co.event_type = 'check_out'
          and co.event_time >= ci.event_time
      )
  loop
    select coalesce(
      (select overlong_shift_hours from app_settings where org_id = r.org_id), 11
    ) into v_threshold;

    if r.event_time < now() - (v_threshold * interval '1 hour') then
      insert into time_events (org_id, profile_id, project_id, event_type, event_time, server_time, gps_status, notes, metadata)
      values (
        r.org_id, r.profile_id, r.project_id, 'check_out',
        r.event_time + (v_threshold * interval '1 hour'), now(), 'none',
        'Смена закрыта автоматически: превышен порог ' || v_threshold || 'ч',
        jsonb_build_object('auto_closed', true, 'source', 'auto_close_job', 'open_event_id', r.id, 'client_id', 'autoclose-' || r.id)
      )
      on conflict do nothing;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

revoke execute on function app.close_overlong_open_shifts() from public, anon, authenticated;

select cron.schedule('close-overlong-shifts', '17 * * * *', $$select app.close_overlong_open_shifts()$$);

-- push_subscriptions: политики (подписка своя: создать/читать/отозвать)
drop policy if exists push_ins on public.push_subscriptions;
create policy push_ins on public.push_subscriptions for insert
  with check (profile_id = (select auth.uid()));
drop policy if exists push_sel on public.push_subscriptions;
create policy push_sel on public.push_subscriptions for select
  using (profile_id = (select auth.uid()) or app.is_manager());
drop policy if exists push_upd on public.push_subscriptions;
create policy push_upd on public.push_subscriptions for update
  using (profile_id = (select auth.uid()));