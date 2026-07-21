-- M6: чекбокс «показать заметку работнику» на корректировке времени.
-- Флаг ставится ПРИ ВСТАВКЕ adjustment-события (append-only не нарушаем: UPDATE как был запрещён, так и остаётся).
alter table public.time_events
  add column show_to_worker boolean not null default false;

comment on column public.time_events.show_to_worker is 'M6: true — работник видит adjust_reason этой корректировки в своих часах';

-- M10: «Отложить» (snooze) сообщение получателем — прочитал, вернётся позже.
alter table public.messages
  add column snoozed_until timestamptz;

comment on column public.messages.snoozed_until is 'M10: до этого времени сообщение скрыто из активной ленты получателя (кнопка «Отложить»)';
