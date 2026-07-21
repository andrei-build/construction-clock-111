-- MAIL-1: host/port/логин IMAP — несекретные, живут в mail_accounts (секрет — только пароль MAIL_<KEY>_PASS)
alter table public.mail_accounts
  add column imap_host text,
  add column imap_port int not null default 993;

update public.mail_accounts set imap_host = 'imap.hostinger.com', email = 'office@nwhomesremodel.com' where key = 'customhomes';
update public.mail_accounts set imap_host = 'imap.gmail.com', email = 'nwbuildpro@gmail.com' where key = 'buildpro';
