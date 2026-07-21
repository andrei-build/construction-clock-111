-- Ф1 аудит, проход 3: pin_hash — это хэш учётных данных. Ни один легитимный REST-читатель
-- его не читает (проверено: 0 политик ссылаются, 0 вью выбирают, единственная функция —
-- триггер-защита записи app.protect_profile_privileged_cols, SECURITY DEFINER, на грантующие права не смотрит;
-- проверка PIN идёт в edge-функции на service_role, которая обходит колоночные гранты).
-- До этой миграции любой авторизованный член организации мог прочитать pin_hash коллег через RLS (строчная, не колоночная).
-- Закрываем прямой доступ к колонке credential-хэша у anon и authenticated полностью.
revoke select (pin_hash) on public.profiles from anon, authenticated;
revoke insert (pin_hash) on public.profiles from anon, authenticated;
revoke update (pin_hash) on public.profiles from anon, authenticated;
revoke references (pin_hash) on public.profiles from anon, authenticated;
-- service_role сохраняет полный доступ (edge-функции set-worker-pin / pin-login работают на нём).
