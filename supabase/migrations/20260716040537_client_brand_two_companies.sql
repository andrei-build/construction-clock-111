-- 0047: закон Андрея 16.07 — поток клиентов делится на ДВЕ компании (бренда): NW Build Pro и NW Custom Homes.
-- Бренд живёт на клиенте (accounts.brand); проекты/письма/рассылки наследуют бренд через клиента.
alter table public.accounts add column if not exists brand text not null default 'nw_build_pro'
  check (brand in ('nw_build_pro', 'nw_custom_homes'));
comment on column public.accounts.brand is 'Компания, обслуживающая клиента: nw_build_pro | nw_custom_homes (закон 16.07). Письма/рассылки идут от имени бренда клиента.';
