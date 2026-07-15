-- 0013: storage bucket for media + tightened policies (spec: DNA §2.8 — receipts finance-only)
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- Re-create select policy: everyone authenticated reads media EXCEPT receipts/ prefix (finance only)
drop policy if exists storage_media_select on storage.objects;
create policy storage_media_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'media'
    and (name not like 'receipts/%' or app.has_finance_access())
  );

-- Insert: authenticated users upload into media bucket under known prefixes, owner recorded
drop policy if exists storage_media_insert on storage.objects;
create policy storage_media_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and (name like 'tasks/%' or name like 'projects/%' or (name like 'receipts/%' and app.has_finance_access()))
  );