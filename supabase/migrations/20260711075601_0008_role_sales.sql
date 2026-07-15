-- Роль отдела продаж (требование Андрея: sales-отдел с передачей в производство)
alter type public.user_role add value if not exists 'sales';