-- Аудит advisors 17.07 (Бета-5): защита в глубину — анонимным вообще нельзя ВЫЗЫВАТЬ
-- SECURITY DEFINER RPC (внутренние проверки has_finance_access/is_owner там есть и работают,
-- но слой лишним не бывает). Приложение зовёт их только авторизованным — поведение не меняется.
revoke execute on function public.close_pay_period(date, date, jsonb, uuid) from anon;
revoke execute on function public.attach_checkout_video(uuid, text) from anon;
