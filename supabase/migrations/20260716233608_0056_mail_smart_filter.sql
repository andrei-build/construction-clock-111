-- MAIL-4: «умный фильтр» (закон Андрея 16.07: письма от ЛЮДЕЙ — все и без ручного перебора; акции/ордеры/покупки — мимо).
-- Логика: allow-список (форс-пропуск) > block-список (форс-скип) > эвристика bulk-признаков (List-Unsubscribe, Precedence: bulk, no-reply и т.п.).
alter table public.mail_allowlist
  add column kind text not null default 'allow' check (kind in ('allow','block'));

alter table public.mail_accounts
  add column filter_mode text not null default 'off' check (filter_mode in ('off','allowlist','smart'));

update public.mail_accounts set filter_mode = 'smart' where key = 'buildpro';

-- Сид block-списка: подтверждённый Андреем мусор из чистки 16.07 (магазины/банки/рассылки/чеки)
insert into public.mail_allowlist (org_id, entry, note, kind)
select o.id, v.entry, v.note, 'block' from public.organizations o,
  (values
    ('service@paypal.com','чеки PayPal'),
    ('@emailinfo.bestbuy.com','Best Buy рассылка'),
    ('@welcome.americanexpress.com','AmEx рассылка'),
    ('@mail-mycredit.bankofamerica.com','BoA мониторинг'),
    ('no-reply@accounts.google.com','Google оповещения'),
    ('noreply-accounts@google.com','Google оповещения'),
    ('@godaddy.com','GoDaddy'),
    ('@mg.homedepot.com','Home Depot'),
    ('@emails.underarmour.com','Under Armour'),
    ('@innovations.samsungusa.com','Samsung'),
    ('@t.shopifyemail.com','Shopify-магазины'),
    ('@express.medallia.com','опросы Lowes'),
    ('@e.myfilingservices.com','filing services'),
    ('@emails.revolutionparts.com','автозапчасти'),
    ('@toolnut.com','Toolnut'),
    ('@pitbullclothing.com','одежда'),
    ('@saltmafiagear.com','одежда'),
    ('@hiconsumption.com','журнал'),
    ('@email.scoutmotors.com','Scout Motors'),
    ('@shop.tiktok.com','TikTok Shop'),
    ('welcome@supabase.com','сервисное'),
    ('@mail.anthropic.com','сервисное')
  ) as v(entry, note)
on conflict do nothing;
