-- 0039: exactly-once offline replay for task/note creation (mirror of 0016 on time_events)
-- Front outbox already generates clientId; column + partial unique index make at-least-once replay safe (23505 = already applied).
alter table public.tasks add column if not exists client_id uuid;
alter table public.project_notes add column if not exists client_id uuid;

create unique index if not exists tasks_client_id_key
  on public.tasks (client_id) where client_id is not null;
create unique index if not exists project_notes_client_id_key
  on public.project_notes (client_id) where client_id is not null;