-- Бренд-чат (Cowork): общий чек-лист запуска на nwhomesremodel.com/checklist/
-- Дисциплина доступа: RLS включён, политик НЕТ (прямой доступ закрыт);
-- вход только через SECURITY DEFINER RPC с проверкой токена из brand_checklist_tokens.
-- К приложению Construction Clock таблица отношения не имеет (маркетинговый чек-лист).

create table if not exists public.brand_checklist_tokens (
  token text primary key,
  label text not null default '',
  created_at timestamptz not null default now()
);
alter table public.brand_checklist_tokens enable row level security;

create table if not exists public.brand_checklist_items (
  token text not null references public.brand_checklist_tokens(token) on delete cascade,
  item_id text not null,
  checked boolean not null default false,
  note text not null default '',
  updated_at timestamptz not null default now(),
  primary key (token, item_id)
);
alter table public.brand_checklist_items enable row level security;

insert into public.brand_checklist_tokens (token, label)
values ('nwch-a7k2m9x4q8v3', 'Чек-лист запуска NW Custom Homes (Андрей)')
on conflict (token) do nothing;

create or replace function public.brand_checklist_get(p_token text)
returns setof public.brand_checklist_items
language sql security definer set search_path = public as $$
  select i.* from public.brand_checklist_items i
  join public.brand_checklist_tokens t on t.token = i.token
  where i.token = p_token;
$$;

create or replace function public.brand_checklist_set(p_token text, p_item text, p_checked boolean, p_note text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.brand_checklist_tokens where token = p_token) then
    raise exception 'invalid token';
  end if;
  if length(coalesce(p_item,'')) > 100 or length(coalesce(p_note,'')) > 4000 then
    raise exception 'too long';
  end if;
  insert into public.brand_checklist_items(token, item_id, checked, note, updated_at)
  values (p_token, p_item, coalesce(p_checked,false), coalesce(p_note,''), now())
  on conflict (token, item_id) do update
    set checked = excluded.checked, note = excluded.note, updated_at = now();
end;
$$;

revoke all on function public.brand_checklist_get(text) from public;
revoke all on function public.brand_checklist_set(text, text, boolean, text) from public;
grant execute on function public.brand_checklist_get(text) to anon, authenticated;
grant execute on function public.brand_checklist_set(text, text, boolean, text) to anon, authenticated;
