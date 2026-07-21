-- MAIL-2: отправка из приложения. SMTP-реквизиты несекретные — в mail_accounts (пароль тот же MAIL_<KEY>_PASS).
alter table public.mail_accounts
  add column smtp_host text,
  add column smtp_port int not null default 465;

update public.mail_accounts set smtp_host = 'smtp.hostinger.com' where key = 'customhomes';
update public.mail_accounts set smtp_host = 'smtp.gmail.com' where key = 'buildpro';

-- Исходящие письма живут в той же ленте: direction in/out; uid у исходящих нет.
alter table public.mail_messages
  add column direction text not null default 'in' check (direction in ('in','out')),
  alter column uid drop not null;
