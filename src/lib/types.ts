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

export type ReportKind = 'hours' | 'payroll' | 'expenses'
export type ReportCell = string | number | boolean | null
export type ReportRow = Record<string, ReportCell>

export const isManagerRole = (r: Role) => ['supervisor', 'manager', 'admin', 'owner'].includes(r)
export const isManagerWrite = (r: Role) => ['manager', 'admin', 'owner'].includes(r)
