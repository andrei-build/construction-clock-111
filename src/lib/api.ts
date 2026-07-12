import { supabase } from './supabase'
import type { Profile, Project, ProjectProfit, ProjectPhoto, TimeEvent, Task, TaskMedia, EventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, CalendarEvent, Deal, DealStage, ReportKind, ReportRow } from './types'
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

export type WorkerLocation = { profile_id: string; lat: number; lng: number; server_time: string }

export async function getWorkerLastLocations(): Promise<Map<string, WorkerLocation>> {
  const { data, error } = await supabase.from('v_worker_last_location')
    .select('profile_id, lat, lng, server_time')
  const out = new Map<string, WorkerLocation>()
  if (error) return out
  for (const row of (data ?? []) as WorkerLocation[]) {
    if (row.profile_id && Number.isFinite(row.lat) && Number.isFinite(row.lng)) out.set(row.profile_id, row)
  }
  return out
}

export async function getMapProjects(): Promise<Project[]> {
  const { data, error } = await supabase.from('projects')
    .select('*')
    .eq('status', 'active')
    .order('name')
  if (error) return []
  return (data as Project[]) ?? []
}

export async function getProjectProfit(): Promise<ProjectProfit[]> {
  const { data, error } = await supabase.from('v_project_profit')
    .select('project_id, margin_pct, profit_status')
  if (error) return []
  return (data as ProjectProfit[]) ?? []
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

export async function getTimeEventsRange(startISO: string, endISO: string): Promise<TimeEvent[]> {
  const { data } = await supabase.from('time_events')
    .select('id, org_id, profile_id, project_id, event_type, event_time, gps_status, metadata')
    .gte('event_time', startISO)
    .lt('event_time', endISO)
    .order('event_time')
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
export async function addTimeEvent(
  p: Profile,
  type: TimeEventType,
  projectId: string | null,
  geo: Geo,
  eventTime = new Date().toISOString(),
  metadata: Record<string, unknown> = {},
) {
  const row: Record<string, unknown> = {
    org_id: p.org_id, profile_id: p.id, project_id: projectId,
    event_type: type, event_time: eventTime,
    gps_status: geo.status, gps_accuracy_m: geo.accuracy, gps_source: 'browser',
    metadata: { lat: geo.lat, lng: geo.lng, client_id: crypto.randomUUID(), ...metadata },
  }
  if (geo.lat !== null && geo.lng !== null) row.gps_point = `SRID=4326;POINT(${geo.lng} ${geo.lat})`
  const { error } = await supabase.from('time_events').insert(row)
  if (error) throw error
  await logEvent(p, `time.${type}`, 'project', projectId, { gps: geo.status })
}

export async function startProjectTravel(p: Profile, project: Project, startedAt: string) {
  await logEvent(p, 'travel.started', 'project', project.id, {
    project_id: project.id,
    address: project.address ?? '',
    started_at: startedAt,
  })
}

export async function getTeam(): Promise<Profile[]> {
  const { data } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode')
    .eq('is_active', true).order('name')
  return (data as Profile[]) ?? []
}

export async function getOpenTasks(): Promise<Task[]> {
  const { data } = await supabase.from('tasks')
    .select('id, org_id, project_id, task_type, title, status, priority, assigned_to, requires_photo')
    .in('status', ['open', 'in_progress']).order('priority', { ascending: false })
  return (data as Task[]) ?? []
}

export async function getDonePhotoTasks(): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks')
    .select('id, org_id, project_id, task_type, title, status, priority, assigned_to, requires_photo, done_at')
    .eq('status', 'done')
    .eq('requires_photo', true)
    .order('done_at', { ascending: false, nullsFirst: false })
    .limit(20)
  if (error) return []
  return (data as Task[]) ?? []
}

export async function getTaskPhotoIds(taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set()
  const { data, error } = await supabase.from('media')
    .select('task_id')
    .in('task_id', taskIds)
    .is('deleted_at', null)
  if (error) return new Set()
  const ids = new Set<string>()
  for (const row of (data ?? []) as Array<{ task_id?: string | null }>) {
    if (row.task_id) ids.add(row.task_id)
  }
  return ids
}

const TASK_MEDIA_BUCKET = 'media'

function safeFileName(name: string) {
  const fallback = 'photo.jpg'
  return (name || fallback).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || fallback
}

async function insertTaskMediaRow(p: Profile, task: Task, storagePath: string, file: File) {
  const { data, error } = await supabase.from('media').insert({
    org_id: p.org_id,
    project_id: task.project_id ?? null,
    task_id: task.id,
    uploaded_by: p.id,
    media_type: 'photo',
    category: 'task_photo',
    storage_path: storagePath,
    filename: safeFileName(file.name),
    mime: file.type || 'image/jpeg',
    size_bytes: file.size,
  }).select('id').single()
  if (error) throw error
  return String(data.id)
}

export async function uploadTaskPhoto(p: Profile, task: Task, file: File): Promise<TaskMedia> {
  const ext = safeFileName(file.name).split('.').pop() || 'jpg'
  const storagePath = `tasks/${p.org_id}/${task.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || 'image/jpeg',
      upsert: false,
    })

  if (uploadError) throw uploadError
  const mediaId = await insertTaskMediaRow(p, task, storagePath, file)
  return { id: mediaId, storage_path: storagePath, preview_url: URL.createObjectURL(file) }
}

async function mediaUrl(storagePath: string) {
  const signed = await supabase.storage.from(TASK_MEDIA_BUCKET).createSignedUrl(storagePath, 3600)
  if (!signed.error && signed.data?.signedUrl) return signed.data.signedUrl
  return supabase.storage.from(TASK_MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl
}

export async function getVisibleProfileRates(): Promise<ProfileRate[]> {
  const { data, error } = await supabase.from('profile_rates')
    .select('profile_id, hourly_rate')
  if (error) return []
  return (data as ProfileRate[]) ?? []
}

export async function getProjectAssignments(projectIds: string[]): Promise<ProjectAssignment[]> {
  if (projectIds.length === 0) return []
  const { data, error } = await supabase.from('project_assignments')
    .select('id, project_id, profile_id')
    .in('project_id', projectIds)
  if (error) return []
  return (data as ProjectAssignment[]) ?? []
}

export async function assignWorkerToProject(p: Profile, projectId: string, workerId: string) {
  const { error } = await supabase.from('project_assignments')
    .insert({ org_id: p.org_id, project_id: projectId, profile_id: workerId })
  if (error) throw error
  await logEvent(p, 'dispatch.assigned', 'project', projectId, { worker_id: workerId })
}

export async function unassignWorkerFromProject(p: Profile, projectId: string, workerId: string) {
  const { error } = await supabase.from('project_assignments')
    .delete()
    .eq('project_id', projectId)
    .eq('profile_id', workerId)
  if (error) throw error
  await logEvent(p, 'dispatch.unassigned', 'project', projectId, { worker_id: workerId })
}

type DispatchLang = 'ru' | 'en' | 'es'

const dispatchLocales: Record<DispatchLang, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
}

const dispatchCopy: Record<DispatchLang, { date: string; where: string; address: string; tasks: string; noTasks: string }> = {
  ru: { date: 'Дата', where: 'Куда', address: 'Адрес', tasks: 'Задачи', noTasks: 'Задач нет' },
  en: { date: 'Date', where: 'Where', address: 'Address', tasks: 'Tasks', noTasks: 'No tasks' },
  es: { date: 'Fecha', where: 'Dónde', address: 'Dirección', tasks: 'Tareas', noTasks: 'Sin tareas' },
}

function dispatchLang(language: string | null | undefined): DispatchLang {
  return language === 'ru' || language === 'es' ? language : 'en'
}

function dispatchPlanBody(project: Project, tasks: Task[], planDate: string, lang: DispatchLang) {
  const copy = dispatchCopy[lang]
  const date = new Date(`${planDate}T12:00:00`).toLocaleDateString(dispatchLocales[lang], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  const taskText = tasks.length > 0 ? tasks.map((task) => `• ${task.title}`).join('\n') : copy.noTasks
  return `${copy.date}: ${date}\n${copy.where}: ${project.name}\n${copy.address}: ${project.address ?? ''}\n\n${copy.tasks}:\n${taskText}`.trim()
}

export async function sendDispatchPlan(p: Profile, project: Project, workers: Profile[], tasks: Task[], planDate: string) {
  const rows = workers.map((worker) => {
    const lang = dispatchLang(worker.language)
    return {
      org_id: p.org_id,
      sender_id: p.id,
      recipient_id: worker.id,
      priority: 'task',
      body: dispatchPlanBody(project, tasks, planDate, lang),
    }
  })
  if (rows.length === 0) return
  const { error } = await supabase.from('messages').insert(rows)
  if (error) throw error
  await logEvent(p, 'dispatch.plan_sent', 'project', project.id, { workers: workers.length, tasks: tasks.length })
}

export async function markTaskDone(p: Profile, task: Task, mediaId: string | null = null) {
  await supabase.from('tasks').update({ status: 'done', done_at: new Date().toISOString(), done_by: p.id }).eq('id', task.id)
  await logEvent(p, 'task.completed', 'task', task.id, { title: task.title, media_id: mediaId })
}

export async function getRecentActivity(): Promise<EventRow[]> {
  const { data } = await supabase.from('events')
    .select('id, event_type, entity_type, actor_name, data, created_at')
    .order('created_at', { ascending: false }).limit(20)
  return (data as EventRow[]) ?? []
}

export async function getRecentActivityForActor(profileId: string, actorName: string): Promise<EventRow[]> {
  const byId = await supabase.from('events')
    .select('id, event_type, entity_type, actor_name, data, created_at')
    .eq('actor_id', profileId)
    .order('created_at', { ascending: false })
    .limit(8)
  if (!byId.error) return (byId.data as EventRow[]) ?? []

  const byName = await supabase.from('events')
    .select('id, event_type, entity_type, actor_name, data, created_at')
    .eq('actor_name', actorName)
    .order('created_at', { ascending: false })
    .limit(8)
  if (byName.error) return []
  return (byName.data as EventRow[]) ?? []
}

export async function getProjectRecentPhotos(projectId: string): Promise<ProjectPhoto[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at')
    .eq('project_id', projectId)
    .eq('media_type', 'photo')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(6)
  if (error) return []

  const photos = await Promise.all(((data ?? []) as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    return {
      id: row.id,
      url: await mediaUrl(row.storage_path),
      filename: row.filename ?? null,
      created_at: row.created_at ?? null,
    }
  }))

  return photos.filter((photo): photo is ProjectPhoto => photo !== null)
}

export async function getCurrentPayPeriod(): Promise<PayPeriod | null> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase.from('pay_periods')
    .select('id, start_date, end_date, status')
    .lte('start_date', today)
    .gte('end_date', today)
    .order('start_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data as PayPeriod | null) ?? null
}

export async function getMessages(profileId: string): Promise<MessageRow[]> {
  const { data } = await supabase.from('messages')
    .select('id, sender_id, recipient_id, priority, body, read_at, done_at, created_at')
    .or(`sender_id.eq.${profileId},recipient_id.eq.${profileId}`)
    .order('created_at', { ascending: false })
  return (data as MessageRow[]) ?? []
}

export async function sendMessage(p: Profile, recipientId: string, body: string, priority: MessageRow['priority']) {
  const { data, error } = await supabase.from('messages')
    .insert({
      org_id: p.org_id,
      sender_id: p.id,
      recipient_id: recipientId,
      body,
      priority,
    })
    .select('id')
    .single()
  if (error) throw error
  await logEvent(p, 'message.sent', 'message', data.id, { recipient_id: recipientId, priority })
}

export async function markMessageRead(p: Profile, messageId: string) {
  const { error } = await supabase.from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('id', messageId)
    .eq('recipient_id', p.id)
  if (error) throw error
  await logEvent(p, 'message.read', 'message', messageId)
}

export async function getCalendarEvents(startISO: string, endISO: string): Promise<CalendarEvent[]> {
  const { data, error } = await supabase.from('calendar_events')
    .select('id, org_id, title, event_type, starts_at, permit_number, inspection_status')
    .gte('starts_at', startISO)
    .lt('starts_at', endISO)
    .order('starts_at')
  if (error) return []
  return (data as CalendarEvent[]) ?? []
}

export async function createCalendarEvent(p: Profile, input: {
  title: string
  event_type: CalendarEvent['event_type']
  starts_at: string
  permit_number: string | null
  inspection_status: string | null
}) {
  const { data, error } = await supabase.from('calendar_events')
    .insert({ org_id: p.org_id, created_by: p.id, ...input })
    .select('id')
    .single()
  if (error) throw error
  await logEvent(p, 'calendar.created', 'calendar_event', data.id, { title: input.title, event_type: input.event_type })
}

export async function getDeals(): Promise<Deal[]> {
  const { data, error } = await supabase.from('deals')
    .select('id, org_id, title, stage, expected_amount, next_action')
    .order('expected_amount', { ascending: false })
  if (error) return []
  return (data as Deal[]) ?? []
}

export async function updateDealStage(p: Profile, deal: Deal, stage: DealStage) {
  const { error } = await supabase.from('deals')
    .update({ stage })
    .eq('id', deal.id)
  if (error) throw error
  await logEvent(p, 'sales.stage_changed', 'deal', deal.id, { from: deal.stage, to: stage, title: deal.title })
}

const reportRpc: Record<ReportKind, string> = {
  hours: 'report_hours',
  payroll: 'report_payroll',
  expenses: 'report_expenses',
}

export async function getReportRows(kind: ReportKind, from: string, to: string): Promise<ReportRow[]> {
  const { data, error } = await supabase.rpc(reportRpc[kind], { p_from: from, p_to: to })
  if (error) throw error
  return ((data ?? []) as ReportRow[])
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
