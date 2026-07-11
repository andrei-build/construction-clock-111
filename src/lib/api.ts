import { supabase } from './supabase'
import type { Profile, Project, TimeEvent, Task, EventRow, TimeEventType } from './types'
import { todayStartISO } from './time'

// Каждое значимое действие — событие в журнале (ДНК: фундамент для AI)
export async function logEvent(p: Profile, eventType: string, entityType: string, entityId: string | null, data: Record<string, unknown> = {}) {
  await supabase.from('events').insert({
    org_id: p.org_id, event_type: eventType, entity_type: entityType, entity_id: entityId,
    actor_id: p.id, actor_name: p.name, actor_role: p.role, data,
    user_agent: navigator.userAgent,
  })
}

export async function getProjects(): Promise<Project[]> {
  const { data } = await supabase.from('projects')
    .select('id, org_id, name, address, status, gps_radius_m')
    .eq('status', 'active').order('name')
  return (data as Project[]) ?? []
}

export async function getTodayEvents(profileId?: string): Promise<TimeEvent[]> {
  let q = supabase.from('time_events')
    .select('id, org_id, profile_id, project_id, event_type, event_time, gps_status, metadata')
    .gte('event_time', todayStartISO()).order('event_time')
  if (profileId) q = q.eq('profile_id', profileId)
  const { data } = await q
  return (data as TimeEvent[]) ?? []
}

export async function getEventsSince(sinceISO: string, profileId: string): Promise<TimeEvent[]> {
  const { data } = await supabase.from('time_events')
    .select('id, org_id, profile_id, project_id, event_type, event_time, gps_status, metadata')
    .eq('profile_id', profileId).gte('event_time', sinceISO).order('event_time')
  return (data as TimeEvent[]) ?? []
}

export interface Geo { lat: number | null; lng: number | null; accuracy: number | null; status: 'good' | 'off' }

export function captureGPS(timeoutMs = 8000): Promise<Geo> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ lat: null, lng: null, accuracy: null, status: 'off' })
    const timer = setTimeout(() => resolve({ lat: null, lng: null, accuracy: null, status: 'off' }), timeoutMs)
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, status: 'good' }) },
      () => { clearTimeout(timer); resolve({ lat: null, lng: null, accuracy: null, status: 'off' }) },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    )
  })
}

// Отметка: GPS не взялся — отметка всё равно проходит (ДНК §2 п.1)
export async function addTimeEvent(p: Profile, type: TimeEventType, projectId: string | null, geo: Geo) {
  const row: Record<string, unknown> = {
    org_id: p.org_id, profile_id: p.id, project_id: projectId,
    event_type: type, event_time: new Date().toISOString(),
    gps_status: geo.status, gps_accuracy_m: geo.accuracy, gps_source: 'browser',
    metadata: { lat: geo.lat, lng: geo.lng },
  }
  if (geo.lat !== null && geo.lng !== null) row.gps_point = `SRID=4326;POINT(${geo.lng} ${geo.lat})`
  const { error } = await supabase.from('time_events').insert(row)
  if (error) throw error
  await logEvent(p, `time.${type}`, 'project', projectId, { gps: geo.status })
}

export async function getTeam(): Promise<Profile[]> {
  const { data } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode')
    .eq('is_active', true).order('name')
  return (data as Profile[]) ?? []
}

export async function getOpenTasks(): Promise<Task[]> {
  const { data } = await supabase.from('tasks')
    .select('id, org_id, project_id, task_type, title, status, priority, assigned_to')
    .in('status', ['open', 'in_progress']).order('priority', { ascending: false })
  return (data as Task[]) ?? []
}

export async function markTaskDone(p: Profile, task: Task) {
  await supabase.from('tasks').update({ status: 'done', done_at: new Date().toISOString(), done_by: p.id }).eq('id', task.id)
  await logEvent(p, 'task.done', 'task', task.id, { title: task.title })
}

export async function getRecentActivity(): Promise<EventRow[]> {
  const { data } = await supabase.from('events')
    .select('id, event_type, entity_type, actor_name, data, created_at')
    .order('created_at', { ascending: false }).limit(20)
  return (data as EventRow[]) ?? []
}

export async function createWorker(name: string, pin: string, role: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('create-worker', { body: { name, pin, role } })
  if (error) {
    return { ok: false, error: 'error' }
  }
  if (data?.error) return { ok: false, error: data.error === 'pin_taken' ? 'pin_taken' : 'error' }
  return { ok: true }
}

export async function createProject(p: Profile, name: string, address: string, lat?: number, lng?: number) {
  const row: Record<string, unknown> = { org_id: p.org_id, name, address, created_by: p.id }
  if (lat !== undefined && lng !== undefined && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    row.site_point = `SRID=4326;POINT(${lng} ${lat})`
  }
  const { data, error } = await supabase.from('projects').insert(row).select('id').single()
  if (error) throw error
  await logEvent(p, 'project.created', 'project', data.id, { name })
}
