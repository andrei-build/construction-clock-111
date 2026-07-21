-- 0043: законы Андрея 16.07 — (1) рейтинг/сложность клиента, (2) реальные файлы-вложения у смет/инвойсов.
-- (1) Рейтинг клиента: 1-5 звёзд + метка сложности (видно при выборе клиента; финансовой инфы не несёт — доступно менеджерам).
alter table public.accounts add column if not exists rating smallint check (rating between 1 and 5);
alter table public.accounts add column if not exists difficulty text check (difficulty in ('easy','normal','hard'));

-- (2) Вложения к документам (сметы/инвойсы): files.document_id → documents.
alter table public.files add column if not exists document_id uuid references public.documents(id);
create index if not exists files_document_id_idx on public.files (document_id) where document_id is not null;

-- purge_entity: при пурже документа отвязать его файлы (иначе FK заблокирует).
create or replace function app.detach_document_refs(p_doc_id uuid, p_org uuid)
returns void language sql security definer set search_path to 'public' as $$
  update public.files set document_id = null where document_id = p_doc_id and org_id = p_org;
  update public.documents set source_document_id = null where source_document_id = p_doc_id and org_id = p_org;
$$;
