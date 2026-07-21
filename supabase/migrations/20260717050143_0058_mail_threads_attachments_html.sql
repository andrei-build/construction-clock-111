-- MAIL-5 бэкенд, шаг 1 (закон Андрея 17.07: полноценная почта = треды + вложения/фото + HTML).
-- Аддитивно: колонки тредов/HTML в mail_messages + таблица вложений. mail-sync v5 заполнит.

alter table public.mail_messages
  add column if not exists in_reply_to text,
  add column if not exists references_hdr text,
  add column if not exists thread_key text,
  add column if not exists body_html text,
  add column if not exists has_attachments boolean not null default false;

comment on column public.mail_messages.in_reply_to is 'IMAP In-Reply-To (message_id родителя)';
comment on column public.mail_messages.references_hdr is 'IMAP References (цепочка message_id через пробел)';
comment on column public.mail_messages.thread_key is 'Ключ треда = message_id корневого письма цепочки (вычисляет mail-sync); NULL = одиночное письмо';
comment on column public.mail_messages.body_html is 'HTML-тело письма (рендерить только с санитизацией на фронте)';

create index if not exists mail_messages_thread_key_idx on public.mail_messages (org_id, thread_key) where thread_key is not null;

create table if not exists public.mail_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  message_id uuid not null references public.mail_messages(id) on delete cascade,
  filename text not null,
  mime text,
  size_bytes bigint,
  r2_key text,
  is_inline boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.mail_attachments is 'Вложения писем (MAIL-5). Контент — в R2 по r2_key (кладёт mail-sync v5); r2_key NULL = метаданные есть, файл ещё не выкачан.';

create index if not exists mail_attachments_message_idx on public.mail_attachments (message_id);

alter table public.mail_attachments enable row level security;

drop policy if exists mail_attachments_owner_select on public.mail_attachments;
create policy mail_attachments_owner_select on public.mail_attachments
  for select using ((org_id = app.org_id()) and app.is_owner());
