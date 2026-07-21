-- Тех. характеристики позиций каталога (закон Андрея 19.07: апплаенсы со спеками в визуализацию)
alter table public.catalog_items add column if not exists specs jsonb not null default '{}'::jsonb;
comment on column public.catalog_items.specs is 'Тех. характеристики (пары ключ-значение: модель, мощность, цвет, габариты...). Уходят в facts фото-рендера и тултипы эскиза. Spec: CATALOG-SKETCH-1';
