-- Закон Андрея 18.07: программа следит за сроками страховок/лицензий (сабы и работники)
-- и СООБЩАЕТ владельцу заранее. Источники: subcontractor_details.insurance_expires + files.expires_at (документы досье).
create or replace function app.notify_expiring_docs()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count int := 0;
  r record;
  v_owner record;
  v_days int;
  v_text text;
begin
  for r in
    -- страховки сабконтракторов
    select p.org_id, p.id as profile_id, p.name, 'insurance'::text as kind,
           sd.insurance_expires as expires
    from subcontractor_details sd
    join profiles p on p.id = sd.profile_id and p.is_active and p.deleted_at is null
    where sd.insurance_expires is not null
      and sd.insurance_expires <= current_date + 30
    union all
    -- документы с датой истечения в досье (страховки/лицензии файлами)
    select f.org_id, f.profile_id, p.name,
           coalesce(f.doc_kind, 'document') as kind, f.expires_at as expires
    from files f
    join profiles p on p.id = f.profile_id and p.is_active and p.deleted_at is null
    where f.profile_id is not null and f.deleted_at is null
      and f.expires_at is not null
      and f.expires_at <= current_date + 30
  loop
    -- антидубль: не чаще раза в 6 дней на один документ
    if exists (
      select 1 from events e
      where e.org_id = r.org_id and e.event_type = 'doc.expiring'
        and e.entity_id = r.profile_id
        and e.data->>'kind' = r.kind
        and e.data->>'expires' = r.expires::text
        and e.created_at > now() - interval '6 days'
    ) then continue; end if;

    v_days := (r.expires - current_date);
    v_text := case
      when v_days < 0 then '🚨 ПРОСРОЧЕНО: у ' || r.name || ' истёк документ (' || r.kind || ') ' || to_char(r.expires, 'MM/DD/YYYY') || ' — работать нельзя до продления'
      when v_days = 0 then '🚨 СЕГОДНЯ истекает документ (' || r.kind || ') у ' || r.name
      else '⚠️ Через ' || v_days || ' дн. истекает документ (' || r.kind || ') у ' || r.name || ' — ' || to_char(r.expires, 'MM/DD/YYYY')
    end;

    insert into events (org_id, event_type, entity_type, entity_id, actor_name, data)
    values (r.org_id, 'doc.expiring', 'profile', r.profile_id, 'Система',
            jsonb_build_object('kind', r.kind, 'expires', r.expires, 'days', v_days, 'name', r.name));

    for v_owner in select id from profiles where org_id = r.org_id and role = 'owner' and is_active and deleted_at is null and name not ilike 'QA%'
    loop
      insert into messages (org_id, sender_id, recipient_id, priority, body, metadata)
      values (r.org_id, v_owner.id, v_owner.id,
              case when v_days <= 7 then 'urgent'::message_priority else 'info'::message_priority end,
              v_text, jsonb_build_object('system', true, 'kind', 'doc_expiry', 'profile_id', r.profile_id));
    end loop;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

revoke execute on function app.notify_expiring_docs() from anon, authenticated;

-- ежедневно в 15:10 UTC (= 8:10 утра по Сиэтлу)
do $$ begin
  perform cron.unschedule('notify-expiring-docs');
exception when others then null; end $$;
select cron.schedule('notify-expiring-docs', '10 15 * * *', $$select app.notify_expiring_docs()$$);
