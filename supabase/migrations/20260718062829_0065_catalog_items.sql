-- КАТАЛОГ АНДРЕЯ (закон 17.07): реальные позиции — душевые, вэнити, кабинеты, светильники —
-- с настоящими габаритами для расстановки в 3D и цен в смету.
create table if not exists public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  category text not null check (category in ('shower','vanity','cabinet','light','fan','appliance','other')),
  name text not null,
  brand text,
  model text,
  width_in numeric,
  depth_in numeric,
  height_in numeric,
  photo_path text,
  price numeric,
  url text,
  note text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.catalog_items is 'Каталог владельца: габариты в дюймах — для точной расстановки в 3D-эскизе; цена — в смету';
create index if not exists catalog_items_org_cat_idx on public.catalog_items (org_id, category) where is_active;

alter table public.catalog_items enable row level security;
drop policy if exists catalog_items_select on public.catalog_items;
create policy catalog_items_select on public.catalog_items
  for select using ((org_id = app.org_id()) and (app.user_role() <> 'client'::user_role));
drop policy if exists catalog_items_write on public.catalog_items;
create policy catalog_items_write on public.catalog_items
  for all using ((org_id = app.org_id()) and app.is_manager_write())
  with check ((org_id = app.org_id()) and app.is_manager_write());

drop trigger if exists trg_catalog_items_touch on public.catalog_items;
create trigger trg_catalog_items_touch before update on public.catalog_items
  for each row execute function app.touch_updated_at();
