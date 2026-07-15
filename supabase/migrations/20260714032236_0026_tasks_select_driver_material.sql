-- MAT-2 unblock: drivers must see material tasks (not only delivery) so the
-- /route pickup list is populated. Aligns with product spec: material pickup is
-- available to any active org member. Broaden driver visibility to delivery+material.
alter policy tasks_select on public.tasks
using (
  (org_id = app.org_id())
  and (deleted_at is null)
  and (app.user_role() <> 'client'::user_role)
  and ((app.user_role() <> 'driver'::user_role) or (task_type in ('delivery'::task_type, 'material'::task_type)))
);