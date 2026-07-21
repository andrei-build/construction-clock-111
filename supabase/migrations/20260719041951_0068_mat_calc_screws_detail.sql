-- косметика: деталь саморезов без длинной дроби
create or replace function public.calc_tile_materials(
  p_area_sqft numeric,
  p_tile_w_in numeric default 12,
  p_tile_h_in numeric default 24,
  p_joint_in numeric default 0.125,
  p_tile_thickness_in numeric default 0.3125,
  p_pattern text default 'straight',
  p_box_sqft numeric default null,
  p_price_per_box numeric default null,
  p_catalog_item_id uuid default null,
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

  v_coverage := case when v_large
    then coalesce((v_thinset->>'large_format_coverage_sqft_per_bag')::numeric, 45)
    else coalesce((v_thinset->>'coverage_sqft_per_bag')::numeric, 75) end;
  v_thinset_bags := ceil(p_area_sqft / v_coverage);
  v_items := v_items || jsonb_build_object('key','thinset','name','Клей (thinset)',
    'qty', v_thinset_bags, 'unit', 'bag',
    'detail', coalesce((v_thinset->>'bag_lb')::numeric,50) || 'lb, покрытие ~' || v_coverage || ' sqft/мешок' || case when v_large then ' (large format)' else '' end);
  v_total_complete := false;

  v_grout_bag_lb := coalesce((v_grout->>'bag_lb')::numeric, 25);
  v_grout_lbs := round(p_area_sqft * (p_tile_w_in + p_tile_h_in) / (p_tile_w_in * p_tile_h_in)
                 * p_joint_in * p_tile_thickness_in * coalesce((v_grout->>'formula_k')::numeric, 1.86)
                 * (1 + v_grout_waste/100.0), 1);
  v_grout_bags := greatest(1, ceil(v_grout_lbs / v_grout_bag_lb));
  v_items := v_items || jsonb_build_object('key','grout','name','Затирка',
    'qty', v_grout_bags, 'unit', 'bag',
    'detail', v_grout_lbs || ' lb (шов ' || p_joint_in || 'in), мешок ' || v_grout_bag_lb || 'lb');

  if p_include_substrate then
    v_sheets := ceil(p_area_sqft * (1 + v_backer_waste/100.0) / coalesce((v_backer->>'sheet_sqft')::numeric, 15));
    v_screws := v_sheets * coalesce((v_backer->>'screws_per_sheet')::int, 40);
    v_tape_rolls := greatest(1, ceil(v_sheets * coalesce((v_backer->>'tape_lnft_per_sheet')::numeric, 12)
                    / coalesce((v_backer->>'tape_roll_lnft')::numeric, 150)));
    v_items := v_items
      || jsonb_build_object('key','backer_board','name','Подложка (cement board)','qty',v_sheets,'unit','sheet','detail','лист 3x5ft')
      || jsonb_build_object('key','backer_screws','name','Саморезы для подложки','qty',v_screws,'unit','pc','detail', ceil(v_screws/100.0) || ' упак. по 100 шт')
      || jsonb_build_object('key','backer_tape','name','Лента для швов','qty',v_tape_rolls,'unit','roll','detail','рулон 150ft');
  end if;

  if p_include_waterproofing then
    v_wp_gal := greatest(1, ceil(p_area_sqft / coalesce((v_wp->>'coverage_sqft_per_gal')::numeric, 55)));
    v_items := v_items || jsonb_build_object('key','waterproofing','name','Гидроизоляция','qty',v_wp_gal,'unit','gal','detail','2 слоя, ~55 sqft/gal');
  end if;

  if v_large then
    v_clips_n := ceil(v_tiles * coalesce((v_clips->>'per_tile')::numeric, 2.5));
    v_items := v_items || jsonb_build_object('key','leveling_clips','name','Клипсы выравнивания (СВП)','qty',v_clips_n,'unit','pc','detail','large format, ~2.5/плитку');
  end if;

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
