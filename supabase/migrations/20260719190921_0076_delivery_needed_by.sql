-- MAT→DELIVERY: дата «нужно к числу» по каждой позиции (закон Андрея 19.07:
-- «это на такое число, это на такое» — поштучные сроки доставки материалов)
alter table public.delivery_items add column if not exists needed_by date;
comment on column public.delivery_items.needed_by is 'Срок «нужно к числу» по конкретной позиции доставки (владелец задаёт при переводе материала в доставку). Spec: SKETCH-MAT-FLOW-1';

alter table public.project_materials add column if not exists needed_by date;
comment on column public.project_materials.needed_by is 'Желаемая дата по позиции спецификации (переносится в delivery_items.needed_by при переводе в доставку).';
