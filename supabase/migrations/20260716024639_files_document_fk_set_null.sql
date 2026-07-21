-- 0044: files.document_id → ON DELETE SET NULL (пурж документа не блокируется вложениями; файл остаётся в хранилище компании/проекта).
drop function if exists app.detach_document_refs(uuid, uuid);
alter table public.files drop constraint if exists files_document_id_fkey;
alter table public.files add constraint files_document_id_fkey foreign key (document_id) references public.documents(id) on delete set null;
