-- Advisor WARN 0011: app.stamp_catalog_price_fresh имела role-mutable search_path.
-- Закрепляем, как у остальных функций (защита от подмены search_path). Безопасно, поведение то же.
alter function app.stamp_catalog_price_fresh() set search_path = public, app;
