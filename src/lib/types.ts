export type Role =
  | 'owner' | 'admin' | 'manager' | 'supervisor'
  | 'worker' | 'driver' | 'subcontractor' | 'client'

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
}

export interface EventRow {
  id: number
  event_type: string
  entity_type: string | null
  actor_name: string | null
  data: Record<string, unknown>
  created_at: string
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

export const isManagerRole = (r: Role) => ['supervisor', 'manager', 'admin', 'owner'].includes(r)
export const isManagerWrite = (r: Role) => ['manager', 'admin', 'owner'].includes(r)
