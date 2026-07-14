export type Role =
  | 'owner' | 'admin' | 'manager' | 'supervisor'
  | 'worker' | 'driver' | 'subcontractor' | 'client' | 'sales'

export interface Profile {
  id: string
  org_id: string
  name: string
  role: Role
  language: string
  is_active: boolean
  project_access_mode: 'assigned' | 'all_active'
  require_checkout_video?: boolean | null
  pin_enabled?: boolean | null
}

export interface Project {
  id: string
  org_id: string
  name: string
  address: string | null
  notes?: string | null
  status: 'planned' | 'active' | 'paused' | 'completed' | 'archived'
  client_account_id?: string | null
  start_date?: string | null
  end_date?: string | null
  budget_amount?: number | null
  gps_radius_m: number
  archived_at?: string | null
  deleted_at?: string | null
  lat?: number | string | null
  lng?: number | string | null
  latitude?: number | string | null
  longitude?: number | string | null
  site_lat?: number | string | null
  site_lng?: number | string | null
  gps_lat?: number | string | null
  gps_lng?: number | string | null
  site_point?: unknown
  gps_point?: unknown
}

export interface ProjectProfit {
  project_id: string
  name?: string | null
  budget_amount?: number | null
  labor_hours?: number | null
  labor_cost?: number | null
  expenses_cost?: number | null
  total_cost?: number | null
  margin_pct: number | null
  profit_status: 'green' | 'amber' | 'red' | 'grey' | null
}

export type TimeEventType = 'check_in' | 'check_out' | 'break_start' | 'break_end' | 'adjustment'

export interface TimeEvent {
  id: string
  org_id: string
  profile_id: string
  project_id: string | null
  event_type: TimeEventType
  event_time: string
  gps_status: string | null
  video_status?: string | null
  video_path?: string | null
  adjusts_event_id?: string | null
  adjust_reason?: string | null
  adjusted_by?: string | null
  metadata: Record<string, unknown>
}

// Событие времени по проекту с именем работника (embed profile:profiles(name)) — вкладка «Время» хаба.
// profile_id — единственный FK в profiles; пары check_in/check_out считаем на клиенте, без денег.
export interface ProjectTimeEvent {
  id: string
  org_id: string
  profile_id: string
  project_id: string | null
  event_type: TimeEventType
  event_time: string
  gps_status: string | null
  profile?: { name: string | null } | null
}

// Единый источник правды по отработанным интервалам — с учётом корректировок менеджера (v_work_intervals)
export interface WorkInterval {
  org_id: string
  profile_id: string
  project_id: string | null
  start_event_id: string
  end_event_id: string | null
  start_at: string
  end_at: string | null
  was_adjusted: boolean
  adjust_reason: string | null
}

export interface Task {
  id: string
  org_id: string
  project_id: string | null
  task_type: 'work' | 'material' | 'delivery'
  title: string
  description?: string | null
  status: 'open' | 'in_progress' | 'done' | 'cancelled'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  assigned_to: string | null
  urgent_flag?: boolean | null
  requires_photo?: boolean
  done_at?: string | null
  // Дополнительные (необязательные) колонки для глобального экрана «Задачи» (/tasks).
  // Опциональны, чтобы не ломать существующие узкие select'ы (getOpenTasks и т.п.).
  due_date?: string | null
  created_at?: string | null
  // Материальные заявки (MAT-1): двойная отметка забора/доставки.
  picked_up_at?: string | null
  picked_up_by?: string | null
  delivered_at?: string | null
  delivered_by?: string | null
}

export interface TaskMedia {
  id: string
  preview_url: string
  storage_path: string
}

export interface ProjectPhoto {
  id: string
  url: string
  filename: string | null
  created_at: string | null
}

// Фото для экрана «Галерея» — все снимки объектов с именем проекта и категорией.
export interface GalleryPhoto {
  id: string
  url: string
  filename: string | null
  created_at: string | null
  project_id: string | null
  project_name: string | null
  category: string | null
  // Кто загрузил (media.uploaded_by) и имя из profiles — для фильтра по автору в галерее.
  uploaded_by: string | null
  uploader_name: string | null
}

// Видео галереи: те же поля, что у GalleryPhoto (media_type='video'), url — подписанная ссылка на media bucket.
export type GalleryVideo = GalleryPhoto

// PDF-документ галереи (из таблицы files, mime pdf). URL резолвим по клику через getGalleryPdfUrl:
// scope='project' — R2 (r2Sign download), иначе — media bucket (mediaUrl).
export interface GalleryPdf {
  id: string
  name: string
  storage_path: string
  scope: string
  created_at: string | null
  project_id: string | null
  project_name: string | null
  // Кто загрузил (files.uploaded_by) и имя из profiles — для фильтра по автору в галерее.
  uploaded_by: string | null
  uploader_name: string | null
}

// Комментарий к медиа (media_comments): текст под фото. author тянем embed-ом из profiles(name).
export interface MediaComment {
  id: string
  media_id: string
  author_id: string
  body: string | null
  created_at: string
  author?: { name: string | null } | null
}

// Флаг «на проверку» для медиа (media_flags): любой может поставить, менеджер снимает (resolved_at).
export interface MediaFlag {
  id: string
  media_id: string
  reason: string | null
  flagged_by: string
  created_at: string
}

export interface EventRow {
  id: number
  event_type: string
  entity_type: string | null
  actor_name: string | null
  data: Record<string, unknown>
  created_at: string
}

export interface TimelineEventRow {
  id: string | number
  org_id: string
  event_type: string
  entity_type: string | null
  entity_id: string | null
  data: Record<string, unknown> | null
  actor_id: string | null
  actor_name: string | null
  actor_role: string | null
  created_at: string
}

export interface ProfileRate {
  profile_id: string
  hourly_rate: number | null
}

export interface PayPeriod {
  id: string
  period_start: string
  period_end: string
  status: string | null
}

export interface MessageRow {
  id: string
  sender_id: string
  recipient_id: string
  priority: 'urgent' | 'info' | 'good' | 'task'
  body: string
  read_at: string | null
  done_at: string | null
  created_at: string
}

export interface ProjectAssignment {
  id: string
  project_id: string
  profile_id: string
}

// Назначение с датой и именем проекта — для экрана «Расписание». assigned_at служит
// днём, с которого назначение действует (project_assignments не датируется по дням).
export interface ScheduleAssignment {
  id: string
  project_id: string
  profile_id: string
  assigned_at: string | null
  project?: { name: string | null } | null
}

// Исключение проекта (project_exclusions): при project_access_mode='all_active' скрывает
// конкретный проект от работника. Имя проекта подтягиваем join-ом для показа в списке.
export interface ProjectExclusion {
  project_id: string
  project?: { name: string | null } | null
}

export type AccountType = 'client' | 'gc' | 'supplier' | 'other'

export interface Account {
  id: string
  org_id: string
  name: string
  account_type: AccountType | string | null
  email: string | null
  phone: string | null
  address: string | null
  notes: string | null
  is_taxable: boolean | null
  insurance_status: string | null
  client_rating?: 'green' | 'amber' | 'red' | null
  rating_note?: string | null
  metadata: Record<string, unknown> | null
  created_by: string | null
  updated_by: string | null
  version: number | null
  created_at: string
  updated_at: string | null
  deleted_at: string | null
  archived_at: string | null
}

export interface AccountInput {
  name: string
  account_type: AccountType
  email: string | null
  phone: string | null
  address: string | null
  notes: string | null
}

export interface Contact {
  id: string
  org_id: string
  account_id: string
  name: string
  title: string | null
  email: string | null
  phone: string | null
  is_primary: boolean | null
  notes: string | null
  created_at: string
  updated_at: string | null
  deleted_at: string | null
}

export interface ContactInput {
  name: string
  title: string | null
  email: string | null
  phone: string | null
  is_primary: boolean
  notes: string | null
}

// Грант видимости присутствия клиента (client_visibility_grants) — вкладка «Клиент» Хаба.
// «Активный» грант = revoked_at IS NULL; отзыв = UPDATE revoked_at = now() (DELETE-политики нет).
export interface ClientGrant {
  id: string
  org_id: string
  account_id: string
  project_id: string | null
  can_see_presence: boolean
  notify_travel: boolean
  notify_checkin: boolean
  notify_checkout: boolean
  channel: string
  note: string | null
  created_by: string | null
  created_at: string
  revoked_at: string | null
}

export interface ClientProjectSummary {
  id: string
  name: string
  status: string | null
  client_account_id: string | null
}

export interface CalendarEvent {
  id: string
  org_id: string
  title: string
  event_type: 'meeting' | 'inspection' | 'measure' | 'delivery' | 'other'
  starts_at: string
  permit_number: string | null
  inspection_status: string | null
}

export type DealStage = 'lead' | 'contacted' | 'measured' | 'quoted' | 'negotiation' | 'signed' | 'handed_off' | 'lost'

export interface Deal {
  id: string
  org_id: string
  account_id?: string | null
  contact_id?: string | null
  title: string
  stage: DealStage
  expected_amount: number | null
  next_action: string | null
  next_action_at?: string | null
}

export interface SuspiciousShift {
  checkout_event_id: string
  org_id: string
  profile_id: string
  name: string
  project_id: string | null
  project_name: string | null
  started_at: string
  ended_at: string
  hours: number
  too_long: boolean
  gps_issue: boolean
  time_gap_issue: boolean
  review_status: 'approved' | null
  reviewed_at: string | null
}

export interface WorkerConsentRow {
  worker_id: string
  signed_at: string | null
  created_at: string
}

export interface SafetyAckRow {
  worker_id: string
  signed_at: string | null
}

export interface AppSettings {
  org_id: string
  default_language: string
  timezone: string
  overlong_shift_hours: number
  default_gps_radius_m: number
  settings: Record<string, unknown>
  updated_by: string | null
  updated_at: string
}

// Мягко удалённые сущности для экрана «Архив и Корзина» (deleted_at IS NOT NULL)
export type ArchiveTable = 'projects' | 'tasks' | 'media'

export interface ArchivedProject {
  id: string
  name: string
  status: string | null
  deleted_at: string
}

export interface ArchivedTask {
  id: string
  title: string
  project_id: string | null
  status: string | null
  deleted_at: string
  project?: { name: string | null } | null
}

export interface ArchivedMedia {
  id: string
  filename: string | null
  project_id: string | null
  media_type: string | null
  category: string | null
  deleted_at: string
  project?: { name: string | null } | null
}

// Справочник «Магазины поставок» — менеджер ведёт список для авто-детекта заездов (детект — бэкенд).
export interface SupplyStore {
  id: string
  org_id: string
  name: string
  address: string | null
  radius_m: number
  is_active: boolean
  created_at: string
}

// Заезд в магазин (store_visits) — строки пишет бэкенд edge-function, экран только читает.
export interface StoreVisit {
  id: string
  worker_id: string
  store_id: string | null
  project_id: string | null
  entered_at: string
  exited_at: string | null
  is_paid: boolean
  note: string | null
  worker?: { name: string | null } | null
  store?: { name: string | null } | null
  project?: { name: string | null } | null
}

// Дневной рапорт бригадира по проекту (daily_reports): автор пишет свой, менеджер видит все (RLS).
export interface DailyReport {
  id: string
  org_id: string
  project_id: string
  author_id: string
  report_date: string
  body: string
  media_ids: string[] | null
  created_at: string
  project?: { name: string | null } | null
  author?: { name: string | null } | null
}

// Заметка по проекту (project_notes): свободный текст, закреплённые сверху. Мягкое удаление deleted_at.
// author тянем embed-ом author:profiles(name) — author_id единственный FK в profiles.
export interface ProjectNote {
  id: string
  org_id: string
  project_id: string
  author_id: string
  body: string
  pinned: boolean
  created_at: string
  updated_at: string
  deleted_at?: string | null
  author?: { name: string | null } | null
}

// Рейтинг клиента (accounts.client_rating/rating_note) для «Хаба проекта» — светофор + заметка.
export interface AccountRating {
  client_rating: 'green' | 'amber' | 'red' | null
  rating_note: string | null
}

export interface ProjectHubData {
  project: Project | null
  profit: ProjectProfit | null
  account: Account | null
}

export type ReportKind = 'hours' | 'payroll' | 'expenses'
export type ReportCell = string | number | boolean | null
export type ReportRow = Record<string, ReportCell>

// Гибкие права (capabilities) поверх роли — напр. finance_access. PK (user_id, capability).
export interface UserCapability {
  user_id: string
  capability: string
  granted: boolean
  granted_by: string | null
  granted_at: string
  note: string | null
}

export interface Account {
  id: string
  org_id: string
  name: string
}

export interface DocumentProjectOption {
  id: string
  name: string
  client_account_id: string | null
}

export type DocumentType = 'estimate' | 'invoice'
export type DocumentStatus = 'draft' | 'sent' | 'approved' | 'paid' | 'void'

export interface DocumentRow {
  id: string
  org_id: string
  account_id: string | null
  project_id: string | null
  doc_type: DocumentType
  status: DocumentStatus
  number: string | null
  title: string | null
  source_document_id: string | null
  issue_date: string | null
  due_date: string | null
  subtotal: number | null
  tax_rate: number | null
  tax_amount: number | null
  total: number | null
  amount_paid: number | null
  balance: number | null
  retainage_pct: number | null
  margin_pct: number | null
  client_visible: boolean | null
  notes: string | null
  metadata: Record<string, unknown> | null
  created_by: string | null
  updated_by: string | null
  version: number | null
  created_at: string
  updated_at: string | null
  deleted_at: string | null
  account?: { name: string | null } | null
  project?: { name: string | null } | null
}

// Расход по проекту (project_expenses): свободный kind/description, сумма amount. Мягкое удаление deleted_at.
// Вкладка «Финансы» хаба показывает список и сумму (finance-gated), без правок.
export interface ProjectExpense {
  id: string
  org_id: string
  project_id: string
  kind: string | null
  description: string | null
  amount: number | null
  vendor: string | null
  source: string | null
  incurred_at: string | null
  created_by: string | null
  created_at: string
  deleted_at: string | null
}

export interface DocumentItem {
  id: string
  document_id: string
  cost_code_id: string | null
  description: string
  qty: number | null
  unit_id: string | null
  unit_price: number | null
  markup_pct: number | null
  is_client_material: boolean | null
  total: number | null
  sort_order: number | null
  metadata: Record<string, unknown> | null
  unit?: { abbreviation: string | null; name: string | null } | null
  cost_code?: { code: string | null; name: string | null } | null
}

export interface CostCode {
  id: string
  org_id: string
  code: string
  name: string
  cost_type: string | null
  is_active: boolean
}

export interface Unit {
  id: string
  org_id: string
  name: string
  abbreviation: string | null
}

// Файл/документ (files): менеджер+ видит все, автор — свои. Мягкое удаление через deleted_at.
// storage_path указывает в тот же bucket, что и медиа задач; подписанные ссылки — через mediaUrl.
export interface FileRow {
  id: string
  org_id: string
  scope: string
  project_id: string | null
  profile_id: string | null
  account_id: string | null
  folder: string
  name: string
  storage_path: string
  mime: string | null
  size_bytes: number | null
  doc_kind: string | null
  expires_at: string | null
  is_private: boolean
  uploaded_by: string | null
  created_at: string
}

// Файл проекта с именем автора загрузки (embed uploader:profiles) — вкладка «Файлы и медиа» хаба.
export interface ProjectHubFile extends FileRow {
  uploader_name: string | null
}

export const isManagerRole = (r: Role) => ['supervisor', 'manager', 'admin', 'owner'].includes(r)
export const isManagerWrite = (r: Role) => ['manager', 'admin', 'owner'].includes(r)

// Иерархия власти ролей: чем выше число, тем больше прав. Основа гейта назначения ролей (F3).
export const ROLE_POWER: Record<Role, number> = {
  owner: 100,
  admin: 90,
  manager: 70,
  supervisor: 60,
  sales: 40,
  subcontractor: 30,
  driver: 20,
  worker: 10,
  client: 5,
}

// Может ли actor назначить/создать роль target.
// owner — любую; admin — любую, кроме owner; ниже admin — только роли строго ниже admin И ниже
// собственной власти, и НИКОГДА driver/admin/owner (driver выдают только owner/admin).
export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true
  if (actor === 'admin') return target !== 'owner'
  if (target === 'owner' || target === 'admin' || target === 'driver') return false
  return ROLE_POWER[target] < ROLE_POWER[actor]
}
