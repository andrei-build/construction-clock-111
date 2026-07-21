-- DELIVERY-2 (закон Андрея 17.07): доставка = накладная со списком позиций (до 20+ на проект).
-- Водители отмечают по каждой позиции: нужно / купил / есть у меня (завезу) / привезено — и видят отметки друг друга.
create table if not exists public.delivery_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  task_id uuid not null references public.tasks(id) on delete cascade,
  position int not null default 0,
  title text not null,
  details text,
  status text not null default 'needed' check (status in ('needed','bought','have','delivered')),
  claimed_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.delivery_items is 'Позиции заявки на доставку (MAT/DELIVERY): статус по каждой позиции, claimed_by = кто взял на себя («есть у меня — завезу»)';
create index if not exists delivery_items_task_idx on public.delivery_items (task_id, position);

alter table public.delivery_items enable row level security;

-- читать/писать: любой активный член организации, кроме клиентов (паттерн 0031: заявка любым активным)
drop policy if exists delivery_items_members on public.delivery_items;
create policy delivery_items_members on public.delivery_items
  for all using (
    org_id = app.org_id()
    and app.user_role() not in ('client')
  )
  with check (
    org_id = app.org_id()
    and app.user_role() not in ('client')
  );

drop trigger if exists trg_delivery_items_touch on public.delivery_items;
create trigger trg_delivery_items_touch before update on public.delivery_items
  for each row execute function app.touch_updated_at();

-- realtime: водители видят отметки друг друга сразу
do $$ begin
  alter publication supabase_realtime add table public.delivery_items;
exception when duplicate_object then null; end $$;
