-- 0031: материальную заявку может создать ЛЮБОЙ активный член организации (требование Андрея 14.07, Бета-3);
-- прочие типы задач — по-прежнему manager+.
alter policy tasks_insert on public.tasks
  with check (
    (org_id = app.org_id())
    and (
      app.is_manager_write()
      or (
        task_type = 'material'::task_type
        and app.user_role() <> 'client'::user_role
        and created_by = (select auth.uid())
      )
    )
  );