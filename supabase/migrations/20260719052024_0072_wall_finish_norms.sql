-- Нормы отделки стен (закон Андрея 19.07: счёт материалов из эскиза —
-- краска, грунт, текстура, шпатлёвка, шитрок-патчи) + RPC calc_wall_materials
insert into public.material_norms (org_id, work_type, item_key, name, unit, params, waste_pct, note)
select o.id, v.work_type, v.item_key, v.name, v.unit, v.params::jsonb, v.waste_pct, v.note
from public.organizations o
cross join (values
  ('wall_finish','paint','Краска','gal',
   '{"coverage_sqft_per_gal":350,"coats":2}', null, '350 sqft/галлон на слой, дефолт 2 слоя'),
  ('wall_finish','primer','Грунт (primer)','gal',
   '{"coverage_sqft_per_gal":300,"coats":1}', null, '300 sqft/галлон, 1 слой'),
  ('wall_finish','texture','Текстура','gal',
   '{"coverage_sqft_per_gal":150,"coats":1}', null, 'orange peel/knockdown, ~150 sqft/галлон'),
  ('wall_finish','sheetrock','Шитрок (drywall)','sheet',
   '{"sheet_sqft":32,"screws_per_sheet":32,"tape_lnft_per_sheet":12,"tape_roll_lnft":150}', 10,
   'Лист 4x8ft = 32 sqft; куски-патчи отмечаются на стенах эскиза'),
  ('wall_finish','joint_compound','Шпатлёвка (mud)','bucket',
   '{"bucket_gal":4.5,"coverage_sqft_per_gal":100}', null, '~1 галлон на 100 sqft драйвола'),
  ('wall_finish','drywall_screws','Саморезы драйвол','pc',
   '{"per_sheet":32,"pack_pc":100}', null, null),
  ('wall_finish','drywall_tape','Лента для швов','roll',
   '{"lnft_per_sheet":12,"roll_lnft":150}', null, null)
) as v(work_type,item_key,name,unit,params,waste_pct,note)
on conflict (org_id, work_type, item_key) do nothing;

create or replace function public.calc_wall_materials(
  p_paint_area_sqft numeric,               -- площадь под покраску (стены/потолок)
  p_patch_area_sqft numeric default 0,     -- площадь шитрок-кусков (замена драйвола)
  p_include_primer boolean default true,
  p_include_texture boolean default false
) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_org uuid := app.org_id();
  v_norm record;
  v_paint jsonb := '{}'; v_primer jsonb := '{}'; v_texture jsonb := '{}';
  v_rock jsonb := '{}'; v_mud jsonb := '{}'; v_screws jsonb := '{}'; v_tape jsonb := '{}';
  v_rock_waste numeric := 10;
  v_norms_found boolean := false;
  v_items jsonb := '[]'::jsonb;
  v_gal numeric; v_n int; v_sheets int;
begin
  if coalesce(p_paint_area_sqft,0) <= 0 and coalesce(p_patch_area_sqft,0) <= 0 then
    raise exception 'nothing to calculate: both areas are zero';
  end if;

  for v_norm in
    select item_key, params, waste_pct from material_norms
    where org_id = v_org and work_type = 'wall_finish' and is_active
  loop
    v_norms_found := true;
    case v_norm.item_key
      when 'paint' then v_paint := v_norm.params;
      when 'primer' then v_primer := v_norm.params;
      when 'texture' then v_texture := v_norm.params;
      when 'sheetrock' then begin v_rock := v_norm.params; v_rock_waste := coalesce(v_norm.waste_pct, 10); end;
      when 'joint_compound' then v_mud := v_norm.params;
      when 'drywall_screws' then v_screws := v_norm.params;
      when 'drywall_tape' then v_tape := v_norm.params;
      else null;
    end case;
  end loop;

  -- шитрок-патчи
  if coalesce(p_patch_area_sqft,0) > 0 then
    v_sheets := greatest(1, ceil(p_patch_area_sqft * (1 + v_rock_waste/100.0)
                / coalesce((v_rock->>'sheet_sqft')::numeric, 32)));
    v_items := v_items
      || jsonb_build_object('key','sheetrock','name','Шитрок (drywall)','qty',v_sheets,'unit','sheet',
           'detail','лист 4x8ft, патчи ' || p_patch_area_sqft || ' sqft + ' || v_rock_waste || '%')
      || jsonb_build_object('key','drywall_screws','name','Саморезы драйвол',
           'qty', v_sheets * coalesce((v_screws->>'per_sheet')::int, 32), 'unit','pc',
           'detail', ceil(v_sheets * coalesce((v_screws->>'per_sheet')::int, 32) / coalesce((v_screws->>'pack_pc')::numeric,100)) || ' упак. по 100 шт')
      || jsonb_build_object('key','drywall_tape','name','Лента для швов',
           'qty', greatest(1, ceil(v_sheets * coalesce((v_tape->>'lnft_per_sheet')::numeric,12) / coalesce((v_tape->>'roll_lnft')::numeric,150))),
           'unit','roll','detail','рулон 150ft');
    -- шпатлёвка: патчи + вся площадь под покраску слегка (финиш)
    v_gal := (coalesce(p_patch_area_sqft,0) + coalesce(p_paint_area_sqft,0) * 0.25)
             / coalesce((v_mud->>'coverage_sqft_per_gal')::numeric, 100);
    v_n := greatest(1, ceil(v_gal / coalesce((v_mud->>'bucket_gal')::numeric, 4.5)));
    v_items := v_items || jsonb_build_object('key','joint_compound','name','Шпатлёвка (mud)','qty',v_n,'unit','bucket',
      'detail', round(v_gal,1) || ' gal, ведро ' || coalesce((v_mud->>'bucket_gal')::numeric,4.5) || ' gal');
  elsif coalesce(p_paint_area_sqft,0) > 0 then
    -- только финишная шпатлёвка под покраску
    v_gal := p_paint_area_sqft * 0.25 / coalesce((v_mud->>'coverage_sqft_per_gal')::numeric, 100);
    if v_gal >= 0.5 then
      v_n := greatest(1, ceil(v_gal / coalesce((v_mud->>'bucket_gal')::numeric, 4.5)));
      v_items := v_items || jsonb_build_object('key','joint_compound','name','Шпатлёвка (mud)','qty',v_n,'unit','bucket',
        'detail','финиш под покраску, ' || round(v_gal,1) || ' gal');
    end if;
  end if;

  if coalesce(p_paint_area_sqft,0) > 0 then
    if p_include_texture then
      v_n := greatest(1, ceil(p_paint_area_sqft * coalesce((v_texture->>'coats')::numeric,1)
             / coalesce((v_texture->>'coverage_sqft_per_gal')::numeric, 150)));
      v_items := v_items || jsonb_build_object('key','texture','name','Текстура','qty',v_n,'unit','gal',
        'detail','~' || coalesce((v_texture->>'coverage_sqft_per_gal')::numeric,150) || ' sqft/gal');
    end if;
    if p_include_primer then
      v_n := greatest(1, ceil(p_paint_area_sqft * coalesce((v_primer->>'coats')::numeric,1)
             / coalesce((v_primer->>'coverage_sqft_per_gal')::numeric, 300)));
      v_items := v_items || jsonb_build_object('key','primer','name','Грунт (primer)','qty',v_n,'unit','gal',
        'detail', coalesce((v_primer->>'coats')::numeric,1) || ' слой, ~' || coalesce((v_primer->>'coverage_sqft_per_gal')::numeric,300) || ' sqft/gal');
    end if;
    v_n := greatest(1, ceil(p_paint_area_sqft * coalesce((v_paint->>'coats')::numeric,2)
           / coalesce((v_paint->>'coverage_sqft_per_gal')::numeric, 350)));
    v_items := v_items || jsonb_build_object('key','paint','name','Краска','qty',v_n,'unit','gal',
      'detail', coalesce((v_paint->>'coats')::numeric,2) || ' слоя, ~' || coalesce((v_paint->>'coverage_sqft_per_gal')::numeric,350) || ' sqft/gal на слой');
  end if;

  return jsonb_build_object(
    'input', jsonb_build_object('paint_area_sqft', p_paint_area_sqft, 'patch_area_sqft', p_patch_area_sqft,
      'primer', p_include_primer, 'texture', p_include_texture),
    'items', v_items,
    'norms_source', case when v_norms_found then 'org' else 'industry_defaults' end);
end $$;

revoke execute on function public.calc_wall_materials(numeric,numeric,boolean,boolean) from public, anon;
grant execute on function public.calc_wall_materials(numeric,numeric,boolean,boolean) to authenticated, service_role;
