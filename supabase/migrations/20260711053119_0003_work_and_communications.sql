-- Construction Clock · Миграция 0003: задачи, сообщения, медиа, файлы, пуши (карта блоки 6, 7, 11, 12, 17, 19)

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  project_id uuid references public.projects(id),
  parent_task_id uuid references public.tasks(id),
  task_type public.task_type not null default 'work',
  title text not null,
  description text,
  status public.task_status not null default 'open',
  priority public.task_priority not null default 'medium',
  assigned_to uuid references public.profiles(id), -- null = общая задача для всех на проекте
  due_date date,
  requires_photo boolean not null default true, -- Нет фото — задача не подтверждена (ДНК-правило №3)
  is_template boolean not null default false,
  urgent_flag boolean not null default false,
  delivery_from text, -- для task_type=delivery: откуда забрать
  delivery_to text,   -- куда привезти
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles(id),
  done_at timestamptz,
  done_by uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  metadata jsonb not null default '{}',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.tasks is 'Задачи: рабочие, материалы, доставки (водитель видит только delivery). Шаблоны через is_template. Карта блоки 6, 12.';
create index tasks_org_status_idx on public.tasks(org_id, status) where deleted_at is null;
create index tasks_assignee_idx on public.tasks(assigned_to) where deleted_at is null;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  sender_id uuid not null references public.profiles(id),
  recipient_id uuid references public.profiles(id), -- null = broadcast по проекту/орге
  project_id uuid references public.projects(id),
  task_id uuid references public.tasks(id),
  priority public.message_priority not null default 'info',
  body text not null,
  read_at timestamptz,
  done_at timestamptz, -- ответ работника «готово»
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.messages is 'Сообщения менеджер↔работник: срочно/инфо/хорошо/задача, статусы прочтения и «готово» (карта блок 7).';
create index messages_recipient_idx on public.messages(recipient_id, created_at desc);

create table public.media (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  project_id uuid references public.projects(id),
  task_id uuid references public.tasks(id),
  time_event_id uuid references public.time_events(id),
  uploaded_by uuid not null references public.profiles(id),
  media_type text not null, -- photo / video / pdf / doc / voice
  category text not null default 'general', -- general / progress / receipt / delivery_proof / checkout_video
  storage_path text not null,
  filename text,
  mime text,
  size_bytes bigint,
  caption text,
  client_visible boolean not null default false, -- прогресс-фото для клиентского портала (блок 14)
  quick_comment text, -- Done / Needs Attention / In Progress / Next Fix
  metadata jsonb not null default '{}',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);
comment on table public.media is 'Медиа: фото/видео/доки/голосовые. Чеки (category=receipt) — только финансы (ДНК §2 п.8). Мягкое удаление, окончательное — только владелец (блок 18, 23).';
create index media_org_project_idx on public.media(org_id, project_id) where deleted_at is null;

create table public.media_comments (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references public.media(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  body text,
  voice_path text,
  created_at timestamptz not null default now()
);
comment on table public.media_comments is 'Комментарии и голосовые к медиа (карта блок 11).';

create table public.files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  scope text not null default 'project' check (scope in ('org','project','worker','client','subcontractor')),
  project_id uuid references public.projects(id),
  profile_id uuid references public.profiles(id),
  account_id uuid, -- FK в 0004
  folder text not null default '/',
  name text not null,
  storage_path text not null,
  mime text,
  size_bytes bigint,
  doc_kind text, -- contract / insurance / license / permit / other
  expires_at date, -- для страховок и лицензий
  is_private boolean not null default false,
  uploaded_by uuid references public.profiles(id),
  metadata jsonb not null default '{}',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.files is 'Документы/файлы: контракты, страховки, лицензии, папки, личное/общее (карта блоки 13, 17).';
create index files_org_scope_idx on public.files(org_id, scope) where deleted_at is null;

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
comment on table public.push_subscriptions is 'Web-push подписки (карта блок 19).';

create table public.pin_login_rate_limits (
  key_hash text primary key,
  fail_count integer not null default 0,
  first_fail_at timestamptz,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.pin_login_rate_limits is 'Анти-перебор PIN (ДНК §2 п.12). Доступ только service_role — политик нет намеренно.';

create trigger tasks_touch before update on public.tasks
  for each row execute function app.touch_updated_at();
create trigger media_touch before update on public.media
  for each row execute function app.touch_updated_at();
create trigger files_touch before update on public.files
  for each row execute function app.touch_updated_at();