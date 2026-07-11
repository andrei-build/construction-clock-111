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
}

export interface Project {
  id: string
  org_id: string
  name: string
  address: string | null
  status: 'planned' | 'active' | 'paused' | 'completed' | 'archived'
  gps_radius_m: number
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
  metadata: Record<string, unknown>
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

export interface EventRow {
  id: number
  event_type: string
  entity_type: string | null
  actor_name: string | null
  data: Record<string, unknown>
  created_at: string
}

export interface ProfileRate {
  profile_id: string
  hourly_rate: number | null
}

export interface PayPeriod {
  id: string
  start_date: string
  end_date: string
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

export const isManagerRole = (r: Role) => ['supervisor', 'manager', 'admin', 'owner'].includes(r)
export const isManagerWrite = (r: Role) => ['manager', 'admin', 'owner'].includes(r)
