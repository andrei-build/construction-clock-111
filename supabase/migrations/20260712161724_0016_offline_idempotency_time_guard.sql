-- 0016: идемпотентность офлайн-очереди + контроль разрыва времени. Spec: DNA §2.1, Г-контроль

-- Один и тот же client_id не может вставиться дважды (защита от дублей при повторном flush)
create unique index if not exists time_events_client_id_uniq
  on public.time_events (profile_id, ((metadata->>'client_id')))
  where (metadata->>'client_id') is not null;

-- Контроль: событие из будущего не принимаем; разрыв клиент/сервер фиксируем в metadata
create or replace function app.guard_time_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.event_time > now() + interval '5 minutes' then
    raise exception 'event_time is in the future';
  end if;
  new.metadata = coalesce(new.metadata, '{}'::jsonb)
    || jsonb_build_object('time_gap_s', floor(extract(epoch from (now() - new.event_time))));
  return new;
end $$;

drop trigger if exists guard_time_event on public.time_events;
create trigger guard_time_event before insert on public.time_events
  for each row execute function app.guard_time_event();