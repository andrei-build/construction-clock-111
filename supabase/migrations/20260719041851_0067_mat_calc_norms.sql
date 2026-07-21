-- MAT-CALC-2: обучаемые нормы расхода + расчёт плитки + история цен каталога
-- (нормы: дефолты индустрии в params, правки Андрея поверх — source='andrew')

-- 1) Таблица норм расхода (переезд справочника claude/normy_rascheta_materialov.md в базу)
create table if not exists public.material_norms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  work_type text not null,            -- 'tile' (v1), дальше 'drywall','paint',...
  item_key text not null,             -- 'tile','thinset','grout','backer_board','waterproofing','leveling_clips','silicone'
  name text not null,                 -- человеческое имя (рус)
  unit text,                          -- box/bag/sheet/gal/pc/tube
  params jsonb not null default '{}'::jsonb,  -- параметры формулы (coverage, bag_lb, waste_by_pattern...)
  waste_pct numeric,                  -- общий запас, если применимо
  source text not null default 'default' check (source in ('default','andrew')),
  note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, work_type, item_key)
);
comment on table public.material_norms is 'Нормы расхода материалов (обучаемые): дефолты индустрии + правки Андрея (source=andrew). Питает calc_tile_materials и AI-расчётчик. Spec: MAT-CALC-2';

alter table public.material_norms enable row level security;
create policy material_norms_select on public.material_norms
  for select using (org_id = app.org_id() and app.user_role() <> 'client'::user_role);
create policy material_norms_write on public.material_norms
  for all using (org_id = app.org_id() and app.is_manager_write())
  with check (org_id = app.org_id() and app.is_manager_write());

create trigger material_norms_touch before update on public.material_norms
  for each row execute function app.touch_updated_at();

-- Сид дефолтов для всех организаций (не перетирает существующее)
insert into public.material_norms (org_id, work_type, item_key, name, unit, params, waste_pct, note)
select o.id, v.work_type, v.item_key, v.name, v.unit, v.params::jsonb, v.waste_pct, v.note
from public.organizations o
cross join (values
  ('tile','tile','Плитка','box',
   '{"waste_by_pattern":{"straight":10,"offset":12,"diagonal":15,"herringbone":20},"large_format_min_in":15}', 10,
   'Запас на подрезку по схеме укладки; large format = сторона >= 15in'),
  ('tile','thinset','Клей (thinset)','bag',
   '{"bag_lb":50,"coverage_sqft_per_bag":75,"large_format_coverage_sqft_per_bag":45}', null,
   'Покрытие мешка 50lb: ~75 sqft шпатель 1/4x1/4; large format ~45 sqft (1/2x1/2)'),
  ('tile','grout','Затирка','bag',
   '{"bag_lb":25,"formula_k":1.86}', 10,
   'lbs = A*(W+H)/(W*H)*шов*глубина*1.86; глубина = толщина плитки'),
  ('tile','backer_board','Подложка (cement board)','sheet',
   '{"sheet_sqft":15,"screws_per_sheet":40,"tape_lnft_per_sheet":12,"tape_roll_lnft":150}', 10,
   'Лист 3x5ft = 15 sqft'),
  ('tile','waterproofing','Гидроизоляция','gal',
   '{"coverage_sqft_per_gal":55}', null,
   '55 sqft/галлон в 2 слоя (RedGard-класс)'),
  ('tile','leveling_clips','Клипсы выравнивания (СВП)','pc',
   '{"per_tile":2.5,"large_format_min_in":15}', null,
   'Только для large format; ~2.5 клипсы на плитку'),
  ('tile','silicone','Силикон (периметр/углы)','tube',
   '{"lnft_per_tube":25}', null,
   'Тюбик ~25 погонных футов шва')
) as v(work_type,item_key,name,unit,params,waste_pct,note)
on conflict (org_id, work_type, item_key) do nothing;

-- 2) История цен каталога + отметка свежести
alter table public.catalog_items add column if not exists price_updated_at timestamptz default now();

create table if not exists public.catalog_price_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  item_id uuid not null references public.catalog_items(id) on delete cascade,
  price numeric not null,
  source text not null default 'manual',   -- manual | auto (будущий авто-фетч)
  recorded_at timestamptz not null default now()
);
comment on table public.catalog_price_history is 'История цен позиций каталога: пишется триггером при каждой смене price. Spec: MAT-CALC-2';
create index if not exists catalog_price_history_item_idx on public.catalog_price_history(item_id, recorded_at desc);

alter table public.catalog_price_history enable row level security;
create policy catalog_price_history_select on public.catalog_price_history
  for select using (org_id = app.org_id() and app.user_role() <> 'client'::user_role);
create policy catalog_price_history_write on public.catalog_price_history
  for insert with check (org_id = app.org_id() and app.is_manager_write());

create or replace function app.log_catalog_price()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.price is not null then
      new.price_updated_at := now();
      insert into catalog_price_history (org_id, item_id, price) values (new.org_id, new.id, new.price);
    end if;
  elsif tg_op = 'UPDATE' and new.price is distinct from old.price then
    new.price_updated_at := now();
    if new.price is not null then
      insert into catalog_price_history (org_id, item_id, price) values (new.org_id, new.id, new.price);
    end if;
  end if;
  return new;
end $$;

-- history пишем ПОСЛЕ вставки строки (fk), отметку свежести — до
create or replace function app.stamp_catalog_price_fresh()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.price is not null then new.price_updated_at := now(); end if;
  elsif new.price is distinct from old.price then
    new.price_updated_at := now();
  end if;
  return new;
end $$;

create or replace function app.log_catalog_price_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.price is not null and (tg_op = 'INSERT' or new.price is distinct from old.price) then
    insert into catalog_price_history (org_id, item_id, price) values (new.org_id, new.id, new.price);
  end if;
  return new;
end $$;

drop function if exists app.log_catalog_price() cascade;

create trigger catalog_items_price_fresh before insert or update on public.catalog_items
  for each row execute function app.stamp_catalog_price_fresh();
create trigger catalog_items_price_history after insert or update on public.catalog_items
  for each row execute function app.log_catalog_price_after();

-- 3) Расчёт плитки по нормам (чистая функция, без side effects)
create or replace function public.calc_tile_materials(
  p_area_sqft numeric,
  p_tile_w_in numeric default 12,
  p_tile_h_in numeric default 24,
  p_joint_in numeric default 0.125,
  p_tile_thickness_in numeric default 0.3125,
  p_pattern text default 'straight',          -- straight|offset|diagonal|herringbone
  p_box_sqft numeric default null,
  p_price_per_box numeric default null,
  p_catalog_item_id uuid default null,        -- цена из каталога, если задан
  p_perimeter_lnft numeric default null,
  p_include_substrate boolean default false,
  p_include_waterproofing boolean default false
) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_org uuid := app.org_id();
  v_norm record;
  v_tile_params jsonb := '{}'; v_thinset jsonb := '{}'; v_grout jsonb := '{}';
  v_backer jsonb := '{}'; v_wp jsonb := '{}'; v_clips jsonb := '{}'; v_sil jsonb := '{}';
  v_tile_waste numeric; v_grout_waste numeric := 10; v_backer_waste numeric := 10;
  v_norms_found boolean := false;
  v_large boolean;
  v_tile_sqft numeric; v_need_sqft numeric; v_tiles int; v_boxes int;
  v_price numeric := p_price_per_box; v_tile_total numeric;
  v_coverage numeric; v_thinset_bags int;
  v_grout_lbs numeric; v_grout_bags int; v_grout_bag_lb numeric;
  v_sheets int; v_screws int; v_tape_rolls int;
  v_wp_gal int; v_clips_n int; v_sil_tubes int;
  v_items jsonb := '[]'::jsonb;
  v_total numeric := 0; v_total_complete boolean := true;
begin
  if p_area_sqft is null or p_area_sqft <= 0 then
    raise exception 'p_area_sqft must be > 0';
  end if;
  if p_tile_w_in <= 0 or p_tile_h_in <= 0 then
    raise exception 'tile dimensions must be > 0';
  end if;

  -- нормы организации (если нет — дефолты индустрии)
  for v_norm in
    select item_key, params, waste_pct from material_norms
    where org_id = v_org and work_type = 'tile' and is_active
  loop
    v_norms_found := true;
    case v_norm.item_key
      when 'tile' then v_tile_params := v_norm.params;
      when 'thinset' then v_thinset := v_norm.params;
      when 'grout' then begin v_grout := v_norm.params; v_grout_waste := coalesce(v_norm.waste_pct, 10); end;
      when 'backer_board' then begin v_backer := v_norm.params; v_backer_waste := coalesce(v_norm.waste_pct, 10); end;
      when 'waterproofing' then v_wp := v_norm.params;
      when 'leveling_clips' then v_clips := v_norm.params;
      when 'silicone' then v_sil := v_norm.params;
      else null;
    end case;
  end loop;

  v_large := greatest(p_tile_w_in, p_tile_h_in) >= coalesce((v_tile_params->>'large_format_min_in')::numeric, 15);

  -- плитка
  v_tile_waste := coalesce(
    (v_tile_params->'waste_by_pattern'->>p_pattern)::numeric,
    case p_pattern when 'diagonal' then 15 when 'herringbone' then 20 when 'offset' then 12 else 10 end);
  v_tile_sqft := p_tile_w_in * p_tile_h_in / 144.0;
  v_need_sqft := round(p_area_sqft * (1 + v_tile_waste/100.0), 1);
  v_tiles := ceil(v_need_sqft / v_tile_sqft);

  if p_catalog_item_id is not null and v_price is null then
    select price into v_price from catalog_items where id = p_catalog_item_id;
  end if;
  if p_box_sqft is not null and p_box_sqft > 0 then
    v_boxes := ceil(v_need_sqft / p_box_sqft);
  end if;
  v_tile_total := case when v_boxes is not null and v_price is not null then v_boxes * v_price end;
  if v_tile_total is not null then v_total := v_total + v_tile_total; else v_total_complete := false; end if;

  v_items := v_items || jsonb_build_object(
    'key','tile','name','Плитка',
    'qty', coalesce(v_boxes, v_tiles),
    'unit', case when v_boxes is not null then 'box' else 'pc' end,
    'detail', v_need_sqft || ' sqft с запасом ' || v_tile_waste || '% (' || p_pattern || '), ' || v_tiles || ' плиток',
    'price', v_price, 'total', v_tile_total);

  -- клей
  v_coverage := case when v_large
    then coalesce((v_thinset->>'large_format_coverage_sqft_per_bag')::numeric, 45)
    else coalesce((v_thinset->>'coverage_sqft_per_bag')::numeric, 75) end;
  v_thinset_bags := ceil(p_area_sqft / v_coverage);
  v_items := v_items || jsonb_build_object('key','thinset','name','Клей (thinset)',
    'qty', v_thinset_bags, 'unit', 'bag',
    'detail', coalesce((v_thinset->>'bag_lb')::numeric,50) || 'lb, покрытие ~' || v_coverage || ' sqft/мешок' || case when v_large then ' (large format)' else '' end);
  v_total_complete := false; -- цены сопутствующих пока не в каталоге

  -- затирка: lbs = A*(W+H)/(W*H)*шов*глубина*K
  v_grout_bag_lb := coalesce((v_grout->>'bag_lb')::numeric, 25);
  v_grout_lbs := round(p_area_sqft * (p_tile_w_in + p_tile_h_in) / (p_tile_w_in * p_tile_h_in)
                 * p_joint_in * p_tile_thickness_in * coalesce((v_grout->>'formula_k')::numeric, 1.86)
                 * (1 + v_grout_waste/100.0), 1);
  v_grout_bags := greatest(1, ceil(v_grout_lbs / v_grout_bag_lb));
  v_items := v_items || jsonb_build_object('key','grout','name','Затирка',
    'qty', v_grout_bags, 'unit', 'bag',
    'detail', v_grout_lbs || ' lb (шов ' || p_joint_in || 'in), мешок ' || v_grout_bag_lb || 'lb');

  -- подложка
  if p_include_substrate then
    v_sheets := ceil(p_area_sqft * (1 + v_backer_waste/100.0) / coalesce((v_backer->>'sheet_sqft')::numeric, 15));
    v_screws := v_sheets * coalesce((v_backer->>'screws_per_sheet')::int, 40);
    v_tape_rolls := greatest(1, ceil(v_sheets * coalesce((v_backer->>'tape_lnft_per_sheet')::numeric, 12)
                    / coalesce((v_backer->>'tape_roll_lnft')::numeric, 150)));
    v_items := v_items
      || jsonb_build_object('key','backer_board','name','Подложка (cement board)','qty',v_sheets,'unit','sheet','detail','лист 3x5ft')
      || jsonb_build_object('key','backer_screws','name','Саморезы для подложки','qty',v_screws,'unit','pc','detail', v_screws/100.0 || ' x 100pc')
      || jsonb_build_object('key','backer_tape','name','Лента для швов','qty',v_tape_rolls,'unit','roll','detail','рулон 150ft');
  end if;

  -- гидроизоляция
  if p_include_waterproofing then
    v_wp_gal := greatest(1, ceil(p_area_sqft / coalesce((v_wp->>'coverage_sqft_per_gal')::numeric, 55)));
    v_items := v_items || jsonb_build_object('key','waterproofing','name','Гидроизоляция','qty',v_wp_gal,'unit','gal','detail','2 слоя, ~55 sqft/gal');
  end if;

  -- клипсы для large format
  if v_large then
    v_clips_n := ceil(v_tiles * coalesce((v_clips->>'per_tile')::numeric, 2.5));
    v_items := v_items || jsonb_build_object('key','leveling_clips','name','Клипсы выравнивания (СВП)','qty',v_clips_n,'unit','pc','detail','large format, ~2.5/плитку');
  end if;

  -- силикон по периметру
  if p_perimeter_lnft is not null and p_perimeter_lnft > 0 then
    v_sil_tubes := greatest(1, ceil(p_perimeter_lnft / coalesce((v_sil->>'lnft_per_tube')::numeric, 25)));
    v_items := v_items || jsonb_build_object('key','silicone','name','Силикон','qty',v_sil_tubes,'unit','tube','detail', p_perimeter_lnft || ' lnft периметра');
  end if;

  return jsonb_build_object(
    'input', jsonb_build_object('area_sqft', p_area_sqft, 'tile', p_tile_w_in || 'x' || p_tile_h_in || 'in',
      'joint_in', p_joint_in, 'pattern', p_pattern, 'large_format', v_large),
    'items', v_items,
    'totals', jsonb_build_object('known_total', nullif(v_total,0), 'complete', v_total_complete),
    'norms_source', case when v_norms_found then 'org' else 'industry_defaults' end);
end $$;

revoke execute on function public.calc_tile_materials(numeric,numeric,numeric,numeric,numeric,text,numeric,numeric,uuid,numeric,boolean,boolean) from public, anon;
grant execute on function public.calc_tile_materials(numeric,numeric,numeric,numeric,numeric,text,numeric,numeric,uuid,numeric,boolean,boolean) to authenticated, service_role;

-- 4) Месячный контроль устаревших цен каталога (антидубль 25 дней; уведомление владельцам)
create or replace function app.flag_stale_catalog_prices()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count int := 0; r record; v_owner record; v_text text;
begin
  for r in
    select org_id, count(*) as n, min(price_updated_at) as oldest
    from catalog_items
    where is_active and price is not null
      and price_updated_at < now() - interval '30 days'
    group by org_id
  loop
    if exists (
      select 1 from events e
      where e.org_id = r.org_id and e.event_type = 'catalog.price_stale'
        and e.created_at > now() - interval '25 days'
    ) then continue; end if;

    v_text := '🛒 Цены каталога устарели: ' || r.n || ' позиций не обновлялись больше месяца (старейшая — с '
      || to_char(r.oldest, 'MM/DD/YYYY') || '). Проверь перед следующей сметой.';

    insert into events (org_id, event_type, entity_type, actor_name, data)
    values (r.org_id, 'catalog.price_stale', 'catalog', 'Система',
            jsonb_build_object('stale_count', r.n, 'oldest', r.oldest));

    for v_owner in select id from profiles where org_id = r.org_id and role = 'owner'
                   and is_active and deleted_at is null and name not ilike 'QA%'
    loop
      insert into messages (org_id, sender_id, recipient_id, priority, body, metadata)
      values (r.org_id, v_owner.id, v_owner.id, 'info'::message_priority, v_text,
              jsonb_build_object('system', true, 'kind', 'catalog_price_stale'));
    end loop;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

select cron.schedule('stale-catalog-prices', '0 16 1 * *', 'select app.flag_stale_catalog_prices()');
