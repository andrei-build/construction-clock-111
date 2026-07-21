-- AI-3: новые действия ассистента — диспетчеризация (закон Андрея 19.07: «расписать людей на завтра голосом»).
-- Критичные действия — confirm ЖЁСТКО (кодом): назначения и рассылка плана исполняются только после явного «да».
insert into public.ai_action_policies (org_id, action_type, policy)
select o.id, v.action_type, v.policy
from public.organizations o
cross join (values
  ('assign_worker','confirm'),
  ('unassign_worker','confirm'),
  ('send_plan','confirm')
) as v(action_type, policy)
where not exists (
  select 1 from public.ai_action_policies p
  where p.org_id = o.id and p.action_type = v.action_type
);
