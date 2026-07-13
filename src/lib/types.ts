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
  status: 'planned' | 'active' | 'paused' | 'completed' | 'archived'
  gps_radius_m: number
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
  status: 'open' | 'in_progress' | 'done' | 'cancelled'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  assigned_to: string | null
  requires_photo?: boolean
  done_at?: string | null
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

// Исключение проекта (project_exclusions): при project_access_mode='all_active' скрывает
// конкретный проект от работника. Имя проекта подтягиваем join-ом для показа в списке.
export interface ProjectExclusion {
  project_id: string
  project?: { name: string | null } | null
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
  title: string
  stage: DealStage
  expected_amount: number | null
  next_action: string | null
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

export const isManagerRole = (r: Role) => ['supervisor', 'manager', 'admin', 'owner'].includes(r)
export const isManagerWrite = (r: Role) => ['manager', 'admin', 'owner'].includes(r)
