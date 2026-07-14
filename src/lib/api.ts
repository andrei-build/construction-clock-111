import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabase'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from './types'
import { todayStartISO, weekStartISO, workedMs } from './time'
import { notifyMessagePush } from './push'

const TIME_EVENT_SELECT = 'id, org_id, profile_id, project_id, event_type, event_time, gps_status, video_status, video_path, adjusts_event_id, adjust_reason, adjusted_by, metadata'

// Каждое значимое действие — событие в журнале (ДНК: фундамент для AI)
export async function logEvent(p: Profile, eventType: string, entityType: string, entityId: string | null, data: Record<string, unknown> = {}) {
  await supabase.from('events').insert({
    org_id: p.org_id, event_type: eventType, entity_type: entityType, entity_id: entityId,
    actor_id: p.id, actor_name: p.name, actor_role: p.role, data,
    user_agent: navigator.userAgent,
  })
}

// SET-1: store_visit_radius_m — необязательное поле (существующий /settings его не шлёт;
// owner-only экран добавляет его в payload аддитивно, не сбрасывая прочие колонки).
export type AppSettingsInput = Pick<AppSettings, 'default_language' | 'timezone' | 'overlong_shift_hours' | 'default_gps_radius_m' | 'geo_no_signal_minutes' | 'paid_gap_alert_hours'> & { store_visit_radius_m?: number }

const APP_SETTINGS_SELECT = 'org_id, default_language, timezone, overlong_shift_hours, default_gps_radius_m, geo_no_signal_minutes, paid_gap_alert_hours, store_visit_radius_m, settings, updated_by, updated_at'

export async function getAppSettings(): Promise<AppSettings | null> {
  const { data, error } = await supabase.from('app_settings')
    .select(APP_SETTINGS_SELECT)
    .maybeSingle()
  if (error) return null
  return (data as AppSettings | null) ?? null
}

export async function saveAppSettings(p: Profile, values: AppSettingsInput): Promise<AppSettings> {
  const { data, error } = await supabase.from('app_settings')
    .upsert({ org_id: p.org_id, ...values, updated_by: p.id }, { onConflict: 'org_id' })
    .select(APP_SETTINGS_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'settings.updated', 'org', p.org_id, { ...values })
  return data as AppSettings
}

export async function getProjects(): Promise<Project[]> {
  const { data } = await supabase.from('projects')
    .select('*')
    .eq('status', 'active').order('name')
  return (data as Project[]) ?? []
}

// PROJ-1b: доска /projects — проекты ВСЕХ рабочих статусов (planned/active/paused/completed),
// кроме архива/удаления, ОДНИМ запросом. Экран сам фильтрует вкладками (дефолт «активные»),
// поэтому вид по умолчанию не меняется, но появляются вкладки Все/Приостановлен/Завершён.
export async function getBoardProjects(): Promise<Project[]> {
  const { data, error } = await supabase.from('projects')
    .select('*')
    .is('archived_at', null)
    .is('deleted_at', null)
    .neq('status', 'archived')
    .order('name')
  if (error) return []
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
    .select('project_id, name, budget_amount, labor_hours, labor_cost, expenses_cost, total_cost, margin_pct, profit_status')
  if (error) return []
  return (data as ProjectProfit[]) ?? []
}

export async function getTodayEvents(profileId?: string): Promise<TimeEvent[]> {
  let q = supabase.from('time_events')
    .select(TIME_EVENT_SELECT)
    .gte('event_time', todayStartISO()).order('event_time')
  if (profileId) q = q.eq('profile_id', profileId)
  const { data } = await q
  return (data as TimeEvent[]) ?? []
}

export async function getEventsSince(sinceISO: string, profileId: string): Promise<TimeEvent[]> {
  const { data } = await supabase.from('time_events')
    .select(TIME_EVENT_SELECT)
    .eq('profile_id', profileId).gte('event_time', sinceISO).order('event_time')
  return (data as TimeEvent[]) ?? []
}

export async function getTimeEventsRange(startISO: string, endISO: string): Promise<TimeEvent[]> {
  const { data } = await supabase.from('time_events')
    .select(TIME_EVENT_SELECT)
    .gte('event_time', startISO)
    .lt('event_time', endISO)
    .order('event_time')
  return (data as TimeEvent[]) ?? []
}

// Отработанные интервалы одного работника — с учётом корректировок (v_work_intervals)
export async function getWorkerIntervals(profileId: string): Promise<WorkInterval[]> {
  const { data, error } = await supabase.from('v_work_intervals')
    .select('*')
    .eq('profile_id', profileId)
    .order('start_at', { ascending: false })
  if (error) throw error
  return (data as WorkInterval[]) ?? []
}

// Отработанные интервалы всех работников за период — для зарплаты (v_work_intervals)
export async function getIntervalsBetween(fromISO: string, toISO: string): Promise<WorkInterval[]> {
  const { data, error } = await supabase.from('v_work_intervals')
    .select('*')
    .gte('start_at', fromISO)
    .lt('start_at', toISO)
    .order('start_at', { ascending: false })
  if (error) throw error
  return (data as WorkInterval[]) ?? []
}

// Отработанные интервалы по проекту — вкладка «Время» в Project Hub (v_work_intervals, без денег)
export async function getProjectIntervals(projectId: string): Promise<WorkInterval[]> {
  const { data, error } = await supabase.from('v_work_intervals')
    .select('*').eq('project_id', projectId).order('start_at', { ascending: false }).limit(300)
  if (error) return []
  return (data as WorkInterval[]) ?? []
}

// События check_in/check_out по проекту с именем работника — вкладка «Время» в Project Hub.
// profile_id — единственный FK в profiles; при жёсткой схеме падаем на FK-квалифицированный embed.
// Пары и часы считаем на клиенте, БЕЗ ставок/денег. Порядок по event_time.
const PROJECT_TIME_EVENT_SELECT = 'id, org_id, profile_id, project_id, event_type, event_time, gps_status, profile:profiles(name)'
const PROJECT_TIME_EVENT_SELECT_FK = 'id, org_id, profile_id, project_id, event_type, event_time, gps_status, profile:profiles!time_events_profile_id_fkey(name)'

export async function getProjectTimeEvents(projectId: string): Promise<ProjectTimeEvent[]> {
  const run = (select: string) => supabase.from('time_events')
    .select(select)
    .eq('project_id', projectId)
    .in('event_type', ['check_in', 'check_out'])
    .order('event_time')
  let { data, error } = await run(PROJECT_TIME_EVENT_SELECT)
  if (error) {
    const fallback = await run(PROJECT_TIME_EVENT_SELECT_FK)
    data = fallback.data
    error = fallback.error
  }
  if (error) return []
  return (data as unknown as ProjectTimeEvent[]) ?? []
}

export async function getProjectShiftEvents(projectId: string, sinceISO: string): Promise<TimeEvent[]> {
  const { data, error } = await supabase.from('time_events')
    .select(TIME_EVENT_SELECT)
    .eq('project_id', projectId)
    .gte('event_time', sinceISO)
    .in('event_type', ['check_in', 'check_out', 'break_start', 'break_end'])
    .order('event_time')
  if (error) return []
  return (data as TimeEvent[]) ?? []
}

// F13: почему GPS не взялся (паритет с Check Time-таксономией) — ДОП. поле, статус остаётся 'good'/'off'.
export type GeoErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported'

export interface Geo { lat: number | null; lng: number | null; accuracy: number | null; status: 'good' | 'off'; errorKind?: GeoErrorKind }

// GeolocationPositionError.code → наша причина (1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT).
function geoErrorKindFromCode(code: number): GeoErrorKind {
  if (code === 1) return 'denied'
  if (code === 2) return 'unavailable'
  return 'timeout'
}

export function captureGPS(timeoutMs = 8000): Promise<Geo> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ lat: null, lng: null, accuracy: null, status: 'off', errorKind: 'unsupported' })
    const timer = setTimeout(() => resolve({ lat: null, lng: null, accuracy: null, status: 'off', errorKind: 'timeout' }), timeoutMs)
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, status: 'good' }) },
      (err) => { clearTimeout(timer); resolve({ lat: null, lng: null, accuracy: null, status: 'off', errorKind: geoErrorKindFromCode(err?.code ?? 0) }) },
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
  // F13: ДОП. метаданные для триажа менеджера — gps_status ('good'/'off') НЕ трогаем.
  // location_unverified/needs_review — когда фикс не взялся; gps_error_kind — причина (denied/…).
  const unverified = geo.status !== 'good'
  const reviewMeta: Record<string, unknown> = {}
  if (geo.errorKind) reviewMeta.gps_error_kind = geo.errorKind
  if (unverified) {
    reviewMeta.location_unverified = true
    reviewMeta.needs_review = true
  }
  const row: Record<string, unknown> = {
    org_id: p.org_id, profile_id: p.id, project_id: projectId,
    event_type: type, event_time: eventTime,
    gps_status: geo.status, gps_accuracy_m: geo.accuracy, gps_source: 'browser',
    metadata: { lat: geo.lat, lng: geo.lng, client_id: crypto.randomUUID(), ...reviewMeta, ...metadata },
  }
  if (geo.lat !== null && geo.lng !== null) row.gps_point = `SRID=4326;POINT(${geo.lng} ${geo.lat})`
  const { data, error } = await supabase.from('time_events').insert(row).select('id').single()
  if (error) throw error
  await logEvent(p, `time.${type}`, 'project', projectId, { gps: geo.status, time_event_id: data.id })
  return String(data.id)
}

// Ask the backend to notify the client that a worker is on the way. Best-effort and
// fire-and-forget: NEVER blocks or throws into the travel-start path. The edge function
// gates entirely on the project's Client-tab grants and always returns ok:true; a non-send
// response ({ sent:0, reason:'no_grants'|'no_recipient_email'|'no_provider' }) is fine and
// silently ignored. Mirrors notifyMessagePush's try/catch + swallow style.
export function notifyTravelStarted(
  projectId: string,
  opts?: { action?: 'travel' | 'checkin' | 'checkout'; eta_minutes?: number; note?: string },
): void {
  try {
    void supabase.functions
      .invoke('travel-notify', {
        body: {
          project_id: projectId,
          action: opts?.action ?? 'travel',
          ...(opts?.eta_minutes != null ? { eta_minutes: opts.eta_minutes } : {}),
          ...(opts?.note ? { note: opts.note } : {}),
        },
      })
      .then((res) => {
        const data = res?.data as { sent?: number; reason?: string } | null
        if (data && data.sent === 0) console.debug('travel-notify not sent', data.reason)
      })
      .catch((err) => {
        console.debug('travel-notify failed', err)
      })
  } catch (err) {
    console.debug('travel-notify failed', err)
  }
}

export async function startProjectTravel(p: Profile, project: Project, startedAt: string) {
  await logEvent(p, 'travel.started', 'project', project.id, {
    project_id: project.id,
    address: project.address ?? '',
    started_at: startedAt,
  })
  // travel.started recorded → best-effort notify the client (never blocks the flow above).
  notifyTravelStarted(project.id)
}

export async function getTeam(): Promise<Profile[]> {
  const { data } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video')
    .eq('is_active', true).order('name')
  return (data as Profile[]) ?? []
}

export async function getWorkerProfile(workerId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video, skills, skills_note')
    .eq('id', workerId)
    .maybeSingle()
  if (error) throw error
  return (data as Profile | null) ?? null
}

// TEAM-1: пишем ТОЛЬКО навыки для ИИ-распределения (profiles.skills — text) и заметку
// (profiles.skills_note — text). Аддитивно, чтобы не задевать остальные поля профиля.
export async function updateWorkerSkills(p: Profile, workerId: string, input: {
  skills?: string | null
  skills_note?: string | null
}) {
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  if (Object.keys(payload).length === 0) return
  const { error } = await supabase.from('profiles')
    .update(payload)
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'team.skills_updated', 'profile', workerId, payload)
}

// TEAM-1: активация/деактивация работника (profiles.is_active). Деактивированный
// перестаёт появляться в getTeam (там фильтр is_active=true), но карточка по id открывается.
export async function setWorkerActive(p: Profile, workerId: string, active: boolean) {
  const { error } = await supabase.from('profiles')
    .update({ is_active: active })
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'team.active_toggled', 'profile', workerId, { is_active: active })
}

export async function getWorkerTimeEvents(workerId: string): Promise<TimeEvent[]> {
  const { data, error } = await supabase.from('time_events')
    .select(TIME_EVENT_SELECT)
    .eq('profile_id', workerId)
    .order('event_time')
  if (error) throw error
  return (data as TimeEvent[]) ?? []
}

export async function updateWorkerProfileSettings(p: Profile, workerId: string, input: {
  name?: string
  role?: Role
  require_checkout_video?: boolean
  project_access_mode?: Profile['project_access_mode']
}) {
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  if (Object.keys(payload).length === 0) return
  const { error } = await supabase.from('profiles')
    .update(payload)
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'team.profile_updated', 'profile', workerId, payload)
}

export async function setWorkerRate(p: Profile, workerId: string, hourlyRate: number | null) {
  const { error } = await supabase.from('profile_rates')
    .insert({ org_id: p.org_id, profile_id: workerId, hourly_rate: hourlyRate, effective_from: new Date().toISOString() })
  if (error) throw error
  await logEvent(p, 'team.rate_updated', 'profile', workerId, { hourly_rate: hourlyRate })
}

export async function getWorkerPinAccess(workerId: string): Promise<{ supported: boolean; enabled: boolean | null }> {
  const { data, error } = await supabase.from('profiles')
    .select('pin_enabled')
    .eq('id', workerId)
    .maybeSingle()
  if (error) return { supported: false, enabled: null }
  return { supported: true, enabled: Boolean((data as { pin_enabled?: boolean | null } | null)?.pin_enabled) }
}

export async function setWorkerPinEnabled(p: Profile, workerId: string, enabled: boolean) {
  const { error } = await supabase.from('profiles')
    .update({ pin_enabled: enabled })
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'team.pin_access_updated', 'profile', workerId, { pin_enabled: enabled })
}

// Требование видео при уходе живёт на профиле работника; триггер БД пускает менять только менеджеров.
export async function setWorkerCheckoutVideo(p: Profile, workerId: string, value: boolean) {
  const { error } = await supabase.from('profiles')
    .update({ require_checkout_video: value })
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'team.checkout_video_toggled', 'profile', workerId, { require_checkout_video: value })
}

export async function createTimeAdjustment(p: Profile, input: {
  workerId: string
  projectId: string | null
  originalEventId: string
  adjustedCheckIn: string
  adjustedCheckOut: string
  reason: string
}) {
  const { data, error } = await supabase.from('time_events')
    .insert({
      org_id: p.org_id,
      profile_id: input.workerId,
      project_id: input.projectId,
      event_type: 'adjustment',
      event_time: new Date().toISOString(),
      gps_status: 'off',
      adjusts_event_id: input.originalEventId,
      adjust_reason: input.reason,
      adjusted_by: p.id,
      metadata: {
        adjusted_check_in: input.adjustedCheckIn,
        adjusted_check_out: input.adjustedCheckOut,
      },
    })
    .select('id')
    .single()
  if (error) throw error
  await logEvent(p, 'time.adjustment_created', 'time_event', data.id, {
    worker_id: input.workerId,
    adjusts_event_id: input.originalEventId,
    adjusted_check_in: input.adjustedCheckIn,
    adjusted_check_out: input.adjustedCheckOut,
  })
  return String(data.id)
}

const TASK_SELECT = 'id, org_id, project_id, task_type, title, description, status, priority, assigned_to, urgent_flag, requires_photo, done_at, created_at, picked_up_at, picked_up_by, delivered_at, delivered_by'

export async function getOpenTasks(): Promise<Task[]> {
  const { data } = await supabase.from('tasks')
    .select(TASK_SELECT)
    .in('status', ['open', 'in_progress']).order('priority', { ascending: false })
  return (data as Task[]) ?? []
}

// Кросс-проектный список задач для глобального экрана «Задачи» (/tasks).
// Тот же источник, что getOpenTasks, но: (1) без фильтра по status — экран сам фильтрует
// по всем статусам, (2) более широкий select (due_date/description/assigned_to/created_at)
// для колонок и сортировки. RLS tasks_select уже держит org-скоуп, прячет deleted_at,
// не пускает client и ограничивает driver только доставками. Сортировка приоритет→срок.
const ALL_TASK_SELECT = 'id, org_id, project_id, task_type, title, description, status, priority, assigned_to, urgent_flag, requires_photo, due_date, done_at, done_by, created_at, metadata'
export async function getAllTasks(): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks')
    .select(ALL_TASK_SELECT)
    .order('priority', { ascending: false })
    .order('due_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data as Task[]) ?? []
}

export interface NewTaskInput {
  // null → «Общая задача» (без проекта). tasks.project_id nullable в живой схеме.
  project_id: string | null
  title: string
  task_type: Task['task_type']
  priority: Task['priority']
  assigned_to?: string | null
  due_date?: string | null
  description?: string | null
  requires_photo?: boolean
}

// Создать задачу. org_id=p.org_id + created_by=p.id удовлетворяют RLS check tasks_insert
// (org_id совпадает и app.is_manager_write()). Не-менеджеру insert отклонит RLS — гейтим в UI.
// Пишем только те колонки, что задаёт форма; остальное берёт server-side defaults
// (status='open', metadata, version, created_at и т.д.). Зеркалит форму задач старого Check Time.
export async function createTask(p: Profile, input: NewTaskInput): Promise<string> {
  const row: Record<string, unknown> = {
    org_id: p.org_id,
    created_by: p.id,
    // null допустимо: «Общая задача» без проекта (project_id nullable).
    project_id: input.project_id ?? null,
    title: input.title,
    task_type: input.task_type,
    priority: input.priority,
  }
  if (input.assigned_to) row.assigned_to = input.assigned_to
  if (input.due_date) row.due_date = input.due_date
  const description = input.description?.trim()
  if (description) row.description = description
  if (input.requires_photo !== undefined) row.requires_photo = input.requires_photo
  const { data, error } = await supabase.from('tasks').insert(row).select('id').single()
  if (error) throw error
  await logEvent(p, 'task.created', 'task', data.id, { title: input.title, task_type: input.task_type })
  return String(data.id)
}

// Смена статуса задачи из дропдауна карточки (ожидает/в работе/готово) глобального экрана.
// Прямой UPDATE — RLS tasks_update пускает менеджера, назначенного исполнителя, либо
// (задача без исполнителя И доступ к проекту). При переводе в done проставляем done_at/done_by
// (проставит «Доказательства выполнения»), при возврате из done — очищаем.
export async function updateTaskStatus(p: Profile, task: Task, status: Task['status']): Promise<void> {
  const patch: Record<string, unknown> = { status, updated_by: p.id }
  if (status === 'done') {
    patch.done_at = new Date().toISOString()
    patch.done_by = p.id
  } else if (task.status === 'done') {
    patch.done_at = null
    patch.done_by = null
  }
  const { error } = await supabase.from('tasks').update(patch).eq('id', task.id)
  if (error) throw error
  await logEvent(p, 'task.status_changed', 'task', task.id, { status, from: task.status })
}

// Отметка «Прочитано»: пишем metadata.read_by[profile_id] = iso в jsonb (без новой колонки).
// Сначала читаем актуальный metadata (чтобы не затереть чужие ключи), затем мержим и обновляем.
// Идемпотентно: если запись уже есть — ничего не пишем. Ошибка не критична (best-effort).
export async function markTaskRead(p: Profile, taskId: string): Promise<void> {
  const { data, error } = await supabase.from('tasks').select('metadata').eq('id', taskId).maybeSingle()
  if (error) throw error
  const metadata = ((data as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? {}) as Record<string, unknown>
  const readBy = { ...((metadata.read_by as Record<string, string> | undefined) ?? {}) }
  if (readBy[p.id]) return // уже отмечено
  readBy[p.id] = new Date().toISOString()
  const { error: upErr } = await supabase.from('tasks')
    .update({ metadata: { ...metadata, read_by: readBy } })
    .eq('id', taskId)
  if (upErr) throw upErr
}

// Мягкое удаление задачи: deleted_at = now(). RLS tasks_update (менеджер/исполнитель) —
// в UI гейтим на менеджера. tasks_select уже прячет deleted_at IS NOT NULL из выборок.
export async function softDeleteTask(p: Profile, taskId: string): Promise<void> {
  const { error } = await supabase.from('tasks')
    .update({ deleted_at: new Date().toISOString(), updated_by: p.id })
    .eq('id', taskId)
  if (error) throw error
  await logEvent(p, 'task.deleted', 'task', taskId, {})
}

// Тип медиа по MIME/имени для строки media (media_type — свободный text в живой схеме).
function inferMediaType(file: { type?: string | null; name?: string | null }): 'photo' | 'video' | 'file' {
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'photo'
  if (type.startsWith('video/')) return 'video'
  const name = file.name || ''
  const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : ''
  if (FILE_IMAGE_EXTS.includes(ext)) return 'photo'
  return 'file'
}

// Универсальное вложение задачи (Галерея/Камера/Файлы) — те же bucket и строка media,
// что uploadTaskPhoto, но с произвольным типом. RLS media_insert: uploaded_by=self ИЛИ менеджер.
// category='task_attachment' (для «Доказательства выполнения» используем те же вложения).
export async function uploadTaskAttachment(p: Profile, task: Task, file: File): Promise<TaskAttachment> {
  validateUpload(file, 'file')
  const mediaType = inferMediaType(file)
  const ext = safeFileName(file.name, file.type).split('.').pop() || 'bin'
  const storagePath = `tasks/${p.org_id}/${task.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, { contentType: inferUploadContentType(file), upsert: false })
  if (uploadError) throw uploadError
  const { data, error } = await supabase.from('media').insert({
    org_id: p.org_id,
    project_id: task.project_id ?? null,
    task_id: task.id,
    uploaded_by: p.id,
    media_type: mediaType,
    category: 'task_attachment',
    storage_path: storagePath,
    filename: safeFileName(file.name, file.type),
    mime: file.type || null,
    size_bytes: file.size,
  }).select('id, storage_path, media_type, category, filename, created_at').single()
  if (error) throw error
  return data as unknown as TaskAttachment
}

// Вложения задачи для карточки. error → [] (карточка деградирует без вложений, не падает).
export async function getTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, media_type, category, filename, created_at')
    .eq('task_id', taskId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as TaskAttachment[]) ?? []
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

export type MaterialStatusAction = 'picked_up' | 'undo_picked_up' | 'delivered'

export async function markMaterialStatus(taskId: string, action: MaterialStatusAction): Promise<void> {
  const { error } = await supabase.rpc('mark_material_status', { p_task_id: taskId, p_action: action })
  if (error) throw error
}

// Активные (неудалённые) водители организации — для мгновенного пуша по новой заявке.
// error → [] (пуши best-effort, не должны ронять создание заявки).
export async function listActiveDrivers(orgId: string): Promise<Array<{ id: string; name: string; language: string | null }>> {
  const { data, error } = await supabase.from('profiles')
    .select('id, name, language')
    .eq('org_id', orgId)
    .eq('role', 'driver')
    .eq('is_active', true)
    .is('deleted_at', null)
  if (error) return []
  return (data as Array<{ id: string; name: string; language: string | null }>) ?? []
}

// Короткие локализованные строки для пушей по материалам (api.ts вне React-контекста,
// поэтому держим собственные карты, как push.ts). Ключ — язык получателя.
type MaterialPushLang = 'ru' | 'en' | 'es'
const MATERIAL_PUSH: Record<MaterialPushLang, { newMaterial: string; created: string }> = {
  ru: { newMaterial: 'Новый материал', created: 'Заявка создана, водители уведомлены' },
  en: { newMaterial: 'New material', created: 'Request created, drivers notified' },
  es: { newMaterial: 'Nuevo material', created: 'Solicitud creada, conductores notificados' },
}
function materialPushLang(l?: string | null): MaterialPushLang {
  return l === 'en' || l === 'es' ? l : 'ru'
}

export async function createMaterialRequest(p: Profile, input: {
  projectId: string
  title: string
  description: string | null
}): Promise<Task> {
  const { data, error } = await supabase.from('tasks')
    .insert({
      org_id: p.org_id,
      project_id: input.projectId,
      task_type: 'material',
      title: input.title,
      description: input.description,
      status: 'open',
      priority: 'urgent',
      urgent_flag: true,
    })
    .select(TASK_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'task.material_requested', 'task', (data as Task).id, {
    project_id: input.projectId,
    title: input.title,
  })

  // Мгновенный пуш всем активным водителям + подтверждение создателю. Best-effort:
  // любая ошибка здесь НЕ должна ронять возврат созданной заявки (Realtime /route
  // подхватит заявку и без пуша).
  try {
    let projectName: string | null = null
    try {
      const { data: proj } = await supabase.from('projects')
        .select('name')
        .eq('id', input.projectId)
        .maybeSingle()
      projectName = (proj as { name?: string | null } | null)?.name ?? null
    } catch {
      projectName = null
    }

    const drivers = await listActiveDrivers(p.org_id)
    for (const d of drivers) {
      if (d.id === p.id) continue // не дублируем пуш, если создатель сам водитель
      const label = MATERIAL_PUSH[materialPushLang(d.language)].newMaterial
      const body = projectName
        ? `${label}: ${input.title} — ${projectName}`
        : `${label}: ${input.title}`
      notifyMessagePush(d.id, p.name, body, d.language, '/route')
    }

    // Подтверждение создателю.
    notifyMessagePush(p.id, p.name, MATERIAL_PUSH[materialPushLang(p.language)].created, p.language)
  } catch (pushErr) {
    console.error('material push notify failed', pushErr)
  }

  return data as Task
}

export function subscribeToTaskChanges(orgId: string, onChange: () => void, channelName = 'tasks') {
  const channel = supabase
    .channel(`${channelName}:${orgId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tasks', filter: `org_id=eq.${orgId}` },
      () => onChange(),
    )
    .subscribe()
  return () => { void supabase.removeChannel(channel) }
}

export function subscribeToMyMessages(profileId: string, onChange: () => void, channelName = 'messages') {
  const channel = supabase
    .channel(`${channelName}:${profileId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${profileId}` },
      () => onChange(),
    )
    .subscribe()
  return () => { void supabase.removeChannel(channel) }
}

export function subscribeToOrgEvents(orgId: string, onChange: () => void, channelName = 'events') {
  const channel = supabase
    .channel(`${channelName}:${orgId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'events', filter: `org_id=eq.${orgId}` },
      () => onChange(),
    )
    .subscribe()
  return () => { void supabase.removeChannel(channel) }
}

// ── GEO-1: live geolocation ───────────────────────────────────────────────────
// Ping из открытой смены (worker/driver с активным GPS-согласием). Пишем свою строку в
// live_locations (RLS ll_insert пускает свой worker_id). ВНИМАНИЕ: WKT-порядок координат —
// сначала долгота, потом широта: POINT(lng lat). recorded_at ставит БД (default now());
// ретенция ленты 48ч — чистит бэкенд, мы только вставляем.
export async function insertLiveLocation(p: Profile, lat: number, lng: number, accuracyM: number | null) {
  const { error } = await supabase.from('live_locations').insert({
    org_id: p.org_id,
    worker_id: p.id,
    gps_point: `POINT(${lng} ${lat})`,
    accuracy_m: accuracyM,
  })
  if (error) throw error
}

// Последние live-точки (view v_live_last_location, security_invoker, окно 12ч). Менеджер видит
// всю орг., работник — только себя (RLS у базовой таблицы). Порядок — свежие сверху.
export async function getLiveLastLocations(): Promise<LiveLastLocation[]> {
  const { data, error } = await supabase.from('v_live_last_location')
    .select('worker_id, name, role, lat, lng, accuracy_m, recorded_at, minutes_ago')
    .order('recorded_at', { ascending: false })
  if (error) return []
  return ((data ?? []) as LiveLastLocation[]).filter(
    (row) => row.worker_id && Number.isFinite(row.lat) && Number.isFinite(row.lng),
  )
}

// Realtime: новые точки live_locations по орг. → обновляем «Сейчас на объектах» вживую.
// Тот же контракт канала/очистки, что и subscribeToOrgEvents/subscribeToTaskChanges.
export function subscribeToLiveLocations(orgId: string, onChange: () => void, channelName = 'live-locations') {
  const channel = supabase
    .channel(`${channelName}:${orgId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'live_locations', filter: `org_id=eq.${orgId}` },
      () => onChange(),
    )
    .subscribe()
  return () => { void supabase.removeChannel(channel) }
}

// Неразрешённые гео-риски смен (shift_geo_events, resolved_at IS NULL). Менеджер+ (RLS sge_select).
// Колонки берём '*' — набор фиксирован миграцией 0028, но имена в select не хардкодим.
export async function getOpenGeoEvents(): Promise<ShiftGeoEvent[]> {
  const { data, error } = await supabase.from('shift_geo_events')
    .select('*')
    .is('resolved_at', null)
  if (error) return []
  return (data as ShiftGeoEvent[]) ?? []
}

// Realtime: INSERT (новый риск) + UPDATE (разрешение — проставлен resolved_at) держат список рисков свежим.
export function subscribeToGeoEvents(orgId: string, onChange: () => void, channelName = 'geo-events') {
  const channel = supabase
    .channel(`${channelName}:${orgId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'shift_geo_events', filter: `org_id=eq.${orgId}` },
      () => onChange(),
    )
    .subscribe()
  return () => { void supabase.removeChannel(channel) }
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

// ── Лимиты медиа и MIME-whitelist (паритет со старым STORAGE_LIMITS_MB) ─────────
// Единый клиентский гейт: считаем перед КАЖДОЙ загрузкой, чтобы не жечь storage/R2.
// Валидация только на клиенте — RLS/storage-политики не трогаем.
export const STORAGE_LIMITS = {
  photo: 20 * 1024 * 1024,   // 20 MB
  video: 500 * 1024 * 1024,  // 500 MB
  pdf: 50 * 1024 * 1024,     // 50 MB
} as const

const DEFAULT_FILE_LIMIT = 50 * 1024 * 1024 // дефолт для произвольных документов

const MIME_WHITELIST: Record<'photo' | 'video' | 'pdf', readonly string[]> = {
  photo: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  pdf: ['application/pdf'],
}

// Расширенный whitelist для «Файлы и документы» (Files.tsx): pdf + любые image/* + офис-типы.
const FILE_OFFICE_MIME: readonly string[] = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'text/csv',
  'text/plain',
]

const FILE_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif']

// Бросает Error с message-кодом 'file_too_large' | 'file_type_not_allowed'.
// Экраны показывают эти коды через t(...). Вызывать ПЕРВОЙ строкой (до сети).
export function validateUpload(
  file: { size: number; type?: string; name?: string },
  kind: 'photo' | 'video' | 'pdf' | 'file',
): void {
  const type = (file.type || '').toLowerCase()

  if (kind === 'file') {
    // Лимит по факту типа: pdf→pdf, картинка→photo, иначе дефолт 50MB.
    const name = file.name || ''
    const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : ''
    let limit = DEFAULT_FILE_LIMIT
    if (type === 'application/pdf' || ext === 'pdf') limit = STORAGE_LIMITS.pdf
    else if (type.startsWith('image/') || FILE_IMAGE_EXTS.includes(ext)) limit = STORAGE_LIMITS.photo
    if (file.size > limit) throw new Error('file_too_large')

    // Пустой type (браузер не отдал mime) — по MIME не блокируем, размер уже проверен.
    if (!type) return
    const allowed = type.startsWith('image/') || type === 'application/pdf' || FILE_OFFICE_MIME.includes(type)
    if (!allowed) throw new Error('file_type_not_allowed')
    return
  }

  if (file.size > STORAGE_LIMITS[kind]) throw new Error('file_too_large')
  // Пустой type — некоторые браузеры не отдают mime; лимит уже применён.
  if (!type) return
  if (!MIME_WHITELIST[kind].includes(type)) throw new Error('file_type_not_allowed')
}

// Если ошибка — это код валидации загрузки, вернуть его (экраны показывают через t()),
// иначе null → экран применит своё прежнее поведение (сеть/доступ).
export function uploadErrorCode(err: unknown): 'file_too_large' | 'file_type_not_allowed' | null {
  const m = err instanceof Error ? err.message : ''
  return m === 'file_too_large' || m === 'file_type_not_allowed' ? m : null
}

// iOS-паритет (Check Time media-extension.ts): фото/видео-пикеры iOS иногда отдают File
// с пустым или бесрасширенным именем (HEIC/MOV). Выводим настоящее расширение из MIME,
// чтобы storage_path нёс корректный суффикс. '' — если MIME неизвестен.
function extensionFromMime(mime: string): string {
  switch ((mime || '').toLowerCase()) {
    // image
    case 'image/jpeg': return 'jpg'
    case 'image/png': return 'png'
    case 'image/heic': return 'heic'
    case 'image/heif': return 'heif'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    // video
    case 'video/mp4': return 'mp4'
    case 'video/quicktime': return 'mov'
    case 'video/webm': return 'webm'
    case 'video/x-matroska': return 'mkv'
    case 'video/3gpp': return '3gp'
    // doc
    case 'application/pdf': return 'pdf'
    case 'application/msword': return 'doc'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx'
    case 'application/vnd.ms-excel': return 'xls'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx'
    case 'text/csv':
    case 'application/csv': return 'csv'
    case 'text/plain': return 'txt'
    default: return ''
  }
}

// Слугификация имени файла. Если имя пустое ИЛИ без пригодного расширения — дописываем
// расширение, выведенное из MIME (mime). Для имён с валидным расширением поведение
// прежнее (байт-в-байт). mime необязателен: без него поведение как раньше.
function safeFileName(name: string, mime?: string) {
  const fallback = 'photo.jpg'
  const slugged = (name || '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
  // Уже есть пригодное расширение → прежний результат без изменений.
  if (slugged && /\.[a-z0-9]{1,5}$/i.test(slugged)) return slugged
  const ext = extensionFromMime(mime ?? '')
  if (slugged) return ext ? `${slugged}.${ext}` : slugged
  return ext ? `photo.${ext}` : fallback
}

// Паритет Check Time (upload-limits.ts inferUploadContentType): часть браузеров отдаёт File
// с пустым type или общим 'application/octet-stream' (нередко для PDF, office-докам и
// .webm/.mov на ряде платформ). Прежний `file.type || 'image/jpeg'` в таком случае метил
// не-картинки как JPEG → ломался inline-preview и content-type скачивания для pdf/office/webm.
// Здесь выводим content-type из расширения имени. Неизвестное расширение → 'application/octet-stream'
// (НЕ image/jpeg). Только клиентский content-type для storage PUT — БД/insert-колонки не трогаем.
const EXT_CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  gif: 'image/gif',
}

export function inferUploadContentType(file: { name?: string | null; type?: string | null }): string {
  const type = (file.type || '').trim().toLowerCase()
  // Конкретный MIME от браузера — доверяем ему как есть.
  if (type && type !== 'application/octet-stream') return type
  // Пустой или общий octet-stream → выводим по расширению имени файла.
  const name = file.name || ''
  const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : ''
  return EXT_CONTENT_TYPE[ext] || 'application/octet-stream'
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
    filename: safeFileName(file.name, file.type),
    mime: file.type || 'image/jpeg',
    size_bytes: file.size,
  }).select('id').single()
  if (error) throw error
  return String(data.id)
}

export async function uploadTaskPhoto(p: Profile, task: Task, file: File): Promise<TaskMedia> {
  validateUpload(file, 'photo')
  const ext = safeFileName(file.name, file.type).split('.').pop() || 'jpg'
  const storagePath = `tasks/${p.org_id}/${task.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, {
      contentType: inferUploadContentType(file),
      upsert: false,
    })

  if (uploadError) throw uploadError
  const mediaId = await insertTaskMediaRow(p, task, storagePath, file)
  return { id: mediaId, storage_path: storagePath, preview_url: URL.createObjectURL(file) }
}

const MEDIA_SIGN_TIMEOUT_MS = 9000

// Паритет Check Time (normalizeStoragePath): в легаси-строках storage_path иногда лежит с
// ведущим '/' или с префиксом bucket ('media/...'), из-за чего createSignedUrl падает с
// "Bucket not found"/404 — ключ должен быть относительным к bucket и без ведущего слэша.
// Для корректных путей (напр. 'videos/<org>/<id>.mp4') это чистый no-op.
function normalizeStoragePath(path: string): string {
  if (!path) return ''
  let key = path.replace(/^\/+/, '')
  if (key.startsWith(`${TASK_MEDIA_BUCKET}/`)) key = key.slice(TASK_MEDIA_BUCKET.length + 1)
  return key
}

export async function mediaUrl(storagePath: string) {
  const key = normalizeStoragePath(storagePath)
  let timer: ReturnType<typeof setTimeout> | undefined
  const signPromise = supabase.storage.from(TASK_MEDIA_BUCKET).createSignedUrl(key, 3600)
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MEDIA_SIGN_TIMEOUT_MS)
  })
  try {
    const signed = await Promise.race([signPromise, timeoutPromise])
    if (signed && !signed.error && signed.data?.signedUrl) return signed.data.signedUrl
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return supabase.storage.from(TASK_MEDIA_BUCKET).getPublicUrl(key).data.publicUrl
}

export async function uploadCheckoutVideo(p: Profile, eventId: string, file: File) {
  validateUpload(file, 'video')
  const storagePath = `videos/${p.org_id}/${eventId}.mp4`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, {
      contentType: inferUploadContentType(file),
      upsert: true,
    })
  if (uploadError) throw uploadError

  const { error } = await supabase.from('time_events')
    .update({ video_status: 'uploaded', video_path: storagePath })
    .eq('id', eventId)
  if (error) throw error
  await logEvent(p, 'time.checkout_video_uploaded', 'time_event', eventId, { video_path: storagePath })
  return storagePath
}

export async function uploadSafetySignature(p: Profile, projectId: string, eventId: string, signature: Blob) {
  const storagePath = `signatures/${p.org_id}/${eventId}.png`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, signature, {
      contentType: 'image/png',
      upsert: true,
    })
  if (uploadError) throw uploadError

  const { error } = await supabase.from('safety_acknowledgements').insert({
    org_id: p.org_id,
    worker_id: p.id,
    project_id: projectId,
    time_event_id: eventId,
    signature_path: storagePath,
    doc_version: 'v1',
  })
  if (error) throw error
  await logEvent(p, 'safety.acknowledged', 'project', projectId, { time_event_id: eventId, signature_path: storagePath })
  return storagePath
}

// GPS-согласие работника (закон штата WA): активная запись — это неотозванное согласие (revoked_at IS NULL)
export async function getActiveLocationConsent(workerId: string): Promise<{ id: string } | null> {
  const { data, error } = await supabase.from('worker_location_consents')
    .select('id')
    .eq('worker_id', workerId)
    .is('revoked_at', null)
    .limit(1)
  if (error) throw error
  return ((data ?? [])[0] as { id: string } | undefined) ?? null
}

// Подпись согласия на GPS: PNG в bucket media (signatures/consents/...) + строка worker_location_consents
export async function signLocationConsent(p: Profile, signature: Blob) {
  const storagePath = `signatures/consents/${p.org_id}/${p.id}/${Date.now()}.png`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, signature, {
      contentType: 'image/png',
      upsert: true,
    })
  if (uploadError) throw uploadError

  const { error } = await supabase.from('worker_location_consents').insert({
    org_id: p.org_id,
    worker_id: p.id,
    consent_version: 'v1',
    signature_path: storagePath,
    user_agent: navigator.userAgent,
  })
  if (error) throw error
  await logEvent(p, 'consent.gps_signed', 'profile', p.id, { signature_path: storagePath })
  return storagePath
}

// Работники и водители для экрана «Согласия»: активные, не удалённые, по алфавиту
export async function getConsentWorkers(): Promise<Profile[]> {
  const { data, error } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video')
    .in('role', ['worker', 'driver'])
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('name')
  if (error) return []
  return (data as Profile[]) ?? []
}

// Все активные (неотозванные) GPS-согласия для набора работников — одним запросом (без N+1)
export async function getActiveWorkerConsents(workerIds: string[]): Promise<WorkerConsentRow[]> {
  if (workerIds.length === 0) return []
  const { data, error } = await supabase.from('worker_location_consents')
    .select('worker_id, signed_at, created_at')
    .in('worker_id', workerIds)
    .is('revoked_at', null)
  if (error) return []
  return (data as WorkerConsentRow[]) ?? []
}

// Подписи ТБ для набора работников — одним запросом; самую свежую на работника считаем в JS
export async function getSafetyAcknowledgements(workerIds: string[]): Promise<SafetyAckRow[]> {
  if (workerIds.length === 0) return []
  const { data, error } = await supabase.from('safety_acknowledgements')
    .select('worker_id, signed_at')
    .in('worker_id', workerIds)
  if (error) return []
  return (data as SafetyAckRow[]) ?? []
}

// === Досье работника /team/:id → «Документы и согласия» (WF-1). Только чтение; RLS уже гейтит:
// wlc/sa — org + (worker_id=uid ИЛИ менеджер); files — org + видимость. Подписи и файлы — bucket media.

// GPS-согласия ОДНОГО работника (полный набор колонок, новейшие сверху). signature_url — подписанный
// URL превью подписи из media (mediaUrl сам чистит ведущий '/' и префикс 'media/'). status считаем в UI
// по revoked_at (null → активно).
export interface WorkerLocationConsentRow {
  id: string
  consent_version: string | null
  signed_at: string | null
  created_at: string
  revoked_at: string | null
  signature_url: string | null
}
export async function getWorkerLocationConsents(workerId: string): Promise<WorkerLocationConsentRow[]> {
  const { data, error } = await supabase.from('worker_location_consents')
    .select('id, consent_version, signature_path, signed_at, created_at, revoked_at')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false })
  if (error) return []
  return Promise.all(((data ?? []) as Array<{
    id: string
    consent_version: string | null
    signature_path: string | null
    signed_at: string | null
    created_at: string
    revoked_at: string | null
  }>).map(async (row) => ({
    id: row.id,
    consent_version: row.consent_version ?? null,
    signed_at: row.signed_at ?? null,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? null,
    signature_url: row.signature_path ? await mediaUrl(row.signature_path) : null,
  })))
}

// Подписи ТБ (safety_acknowledgements) ОДНОГО работника, новейшие сверху, с превью подписи.
export interface WorkerSafetyAckRow {
  id: string
  doc_version: string | null
  signed_at: string | null
  signature_url: string | null
}
export async function getWorkerSafetyAcks(workerId: string): Promise<WorkerSafetyAckRow[]> {
  const { data, error } = await supabase.from('safety_acknowledgements')
    .select('id, doc_version, signature_path, signed_at')
    .eq('worker_id', workerId)
    .order('signed_at', { ascending: false })
  if (error) return []
  return Promise.all(((data ?? []) as Array<{
    id: string
    doc_version: string | null
    signature_path: string | null
    signed_at: string | null
  }>).map(async (row) => ({
    id: row.id,
    doc_version: row.doc_version ?? null,
    signed_at: row.signed_at ?? null,
    signature_url: row.signature_path ? await mediaUrl(row.signature_path) : null,
  })))
}

// Личные файлы работника (files scope='profile', profile_id=workerId, не удалённые), новейшие сверху.
// storage_path — в bucket media (scope!=='project'), поэтому URL для скачивания через mediaUrl, НЕ r2-sign.
export interface WorkerProfileFileRow extends FileRow {
  url: string | null
}
export async function getWorkerProfileFiles(workerId: string): Promise<WorkerProfileFileRow[]> {
  const { data, error } = await supabase.from('files')
    .select(FILE_SELECT)
    .eq('scope', 'profile')
    .eq('profile_id', workerId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return Promise.all(((data ?? []) as FileRow[]).map(async (row) => ({
    ...row,
    url: row.storage_path ? await mediaUrl(row.storage_path) : null,
  })))
}

// Закрытые смены с подозрением (слишком долго / без GPS / разрыв во времени) — очередь на проверку
export async function getSuspiciousShifts(): Promise<SuspiciousShift[]> {
  const { data, error } = await supabase.from('v_suspicious_shifts')
    .select('*')
    .order('started_at', { ascending: false })
  if (error) return []
  return (data as SuspiciousShift[]) ?? []
}

// Менеджер подтверждает проверку смены; повторное подтверждение не создаёт дубль (onConflict)
export async function approveShiftReview(p: Profile, checkoutEventId: string) {
  const { error } = await supabase.from('shift_reviews')
    .upsert(
      { org_id: p.org_id, checkout_event_id: checkoutEventId, status: 'approved', reviewed_by: p.id },
      { onConflict: 'checkout_event_id' },
    )
  if (error) throw error
  await logEvent(p, 'shift.review_approved', 'time_event', checkoutEventId, {})
}

export async function getVisibleProfileRates(): Promise<ProfileRate[]> {
  const { data, error } = await supabase.from('profile_rates')
    .select('profile_id, hourly_rate')
  if (error) return []
  return (data as ProfileRate[]) ?? []
}

const DOCUMENT_SELECT = 'id, org_id, account_id, project_id, doc_type, status, number, title, source_document_id, issue_date, due_date, subtotal, tax_rate, tax_amount, total, amount_paid, balance, retainage_pct, margin_pct, client_visible, notes, metadata, created_by, updated_by, version, created_at, updated_at, deleted_at, account:accounts(name), project:projects(name)'

export interface DocumentLineInput {
  description: string
  qty: number
  unit_id: string | null
  unit_price: number
  markup_pct: number
  total: number
}

export async function getDocumentAccounts(): Promise<Account[]> {
  const { data, error } = await supabase.from('accounts')
    .select('id, org_id, name')
    .order('name')
  if (error) return []
  return (data as Account[]) ?? []
}

export async function getDocumentProjects(): Promise<DocumentProjectOption[]> {
  const { data, error } = await supabase.from('projects')
    .select('id, name, client_account_id')
    .order('name')
  if (error) return []
  return (data as DocumentProjectOption[]) ?? []
}

export async function getDocumentUnits(): Promise<Unit[]> {
  const { data, error } = await supabase.from('units')
    .select('id, org_id, name, abbreviation')
    .order('name')
  if (error) return []
  return (data as Unit[]) ?? []
}

export async function getDocuments(): Promise<DocumentRow[]> {
  const { data, error } = await supabase.from('documents')
    .select(DOCUMENT_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as unknown as DocumentRow[]) ?? []
}

// Документы одного проекта — вкладка «Финансы» в Project Hub (RLS скоупит финансовую видимость)
export async function getProjectDocuments(projectId: string): Promise<DocumentRow[]> {
  const { data, error } = await supabase.from('documents')
    .select(DOCUMENT_SELECT).eq('project_id', projectId).is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as unknown as DocumentRow[]) ?? []
}

// Расходы одного проекта — вкладка «Финансы» в Project Hub (RLS скоупит финансовую видимость; удалённые прячем)
const PROJECT_EXPENSE_SELECT = 'id, org_id, project_id, kind, description, amount, vendor, source, incurred_at, created_by, created_at, deleted_at'

export async function getProjectExpenses(projectId: string): Promise<ProjectExpense[]> {
  const { data, error } = await supabase.from('project_expenses')
    .select(PROJECT_EXPENSE_SELECT).eq('project_id', projectId).is('deleted_at', null)
    .order('incurred_at', { ascending: false, nullsFirst: false })
  if (error) return []
  return (data as ProjectExpense[]) ?? []
}

// NAV-2: лёгкая сумма расходов на материалы по всей орге — тайл «Материалы $» на «Обзоре»
// (finance-gated в UI). Один запрос; RLS скоупит финансовую видимость, при отказе → 0. kind
// свободный, поэтому материалы ловим по подстроке; нет совпадений → 0 (расходов ещё нет).
export async function getMaterialsSpendTotal(): Promise<number> {
  const { data, error } = await supabase.from('project_expenses')
    .select('kind, amount').is('deleted_at', null)
  if (error || !data) return 0
  return (data as { kind: string | null; amount: number | null }[]).reduce((acc, row) => {
    const kind = (row.kind ?? '').toLowerCase()
    const isMaterial = kind.includes('material') || kind.includes('материал')
    return isMaterial ? acc + (Number(row.amount) || 0) : acc
  }, 0)
}

export async function getDocumentItems(documentId: string): Promise<DocumentItem[]> {
  const { data, error } = await supabase.from('document_items')
    .select('id, document_id, cost_code_id, description, qty, unit_id, unit_price, markup_pct, is_client_material, total, sort_order, metadata, unit:units(abbreviation, name), cost_code:cost_codes(code, name)')
    .eq('document_id', documentId)
    .order('sort_order')
  if (error) return []
  return (data as unknown as DocumentItem[]) ?? []
}

function documentItemRows(documentId: string, items: DocumentLineInput[]) {
  return items.map((item, index) => ({
    document_id: documentId,
    description: item.description,
    qty: item.qty,
    unit_id: item.unit_id,
    unit_price: item.unit_price,
    markup_pct: item.markup_pct,
    is_client_material: false,
    total: item.total,
    sort_order: index + 1,
  }))
}

function numeric(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export async function createEstimateDocument(p: Profile, input: {
  number: string
  title: string
  accountId: string
  projectId: string | null
  issueDate: string
  taxRate: number
  notes: string | null
  subtotal: number
  taxAmount: number
  total: number
  items: DocumentLineInput[]
}): Promise<string> {
  const { data, error } = await supabase.from('documents')
    .insert({
      org_id: p.org_id,
      account_id: input.accountId,
      project_id: input.projectId,
      doc_type: 'estimate',
      status: 'draft',
      number: input.number,
      title: input.title,
      issue_date: input.issueDate,
      subtotal: input.subtotal,
      tax_rate: input.taxRate,
      tax_amount: input.taxAmount,
      total: input.total,
      amount_paid: 0,
      balance: input.total,
      notes: input.notes,
      created_by: p.id,
    })
    .select('id')
    .single()
  if (error) throw error

  const documentId = String(data.id)
  if (input.items.length > 0) {
    const { error: itemError } = await supabase.from('document_items')
      .insert(documentItemRows(documentId, input.items))
      .select('id')
    if (itemError) throw itemError
  }

  await logEvent(p, 'document.created', 'document', documentId, { doc_type: 'estimate', total: input.total })
  return documentId
}

export async function convertEstimateToInvoice(p: Profile, estimate: DocumentRow, items: DocumentItem[], input: {
  number: string
  issueDate: string
  dueDate: string
}): Promise<string> {
  const { data, error } = await supabase.from('documents')
    .insert({
      org_id: p.org_id,
      account_id: estimate.account_id,
      project_id: estimate.project_id,
      doc_type: 'invoice',
      status: 'draft',
      number: input.number,
      title: estimate.title,
      source_document_id: estimate.id,
      issue_date: input.issueDate,
      due_date: input.dueDate,
      subtotal: numeric(estimate.subtotal),
      tax_rate: numeric(estimate.tax_rate),
      tax_amount: numeric(estimate.tax_amount),
      total: numeric(estimate.total),
      amount_paid: 0,
      balance: numeric(estimate.total),
      notes: estimate.notes,
      created_by: p.id,
    })
    .select('id')
    .single()
  if (error) throw error

  const invoiceId = String(data.id)
  if (items.length > 0) {
    const rows = items.map((item, index) => ({
      document_id: invoiceId,
      cost_code_id: item.cost_code_id,
      description: item.description,
      qty: numeric(item.qty),
      unit_id: item.unit_id,
      unit_price: numeric(item.unit_price),
      markup_pct: numeric(item.markup_pct),
      is_client_material: Boolean(item.is_client_material),
      total: numeric(item.total),
      sort_order: item.sort_order ?? index + 1,
      metadata: item.metadata,
    }))
    const { error: itemError } = await supabase.from('document_items')
      .insert(rows)
      .select('id')
    if (itemError) throw itemError
  }

  await logEvent(p, 'document.invoiced', 'document', invoiceId, {
    source_document_id: estimate.id,
    total: numeric(estimate.total),
  })
  return invoiceId
}

export async function markDocumentPaid(p: Profile, invoice: DocumentRow): Promise<void> {
  const total = numeric(invoice.total)
  const { error } = await supabase.from('documents')
    .update({
      status: 'paid',
      amount_paid: total,
      balance: 0,
      updated_by: p.id,
    })
    .eq('id', invoice.id)
    .select('id')
    .single()
  if (error) throw error
  await logEvent(p, 'document.paid', 'document', invoice.id, { total })
}

export async function getProjectAssignments(projectIds: string[]): Promise<ProjectAssignment[]> {
  if (projectIds.length === 0) return []
  const { data, error } = await supabase.from('project_assignments')
    .select('id, project_id, profile_id')
    .in('project_id', projectIds)
  if (error) return []
  return (data as ProjectAssignment[]) ?? []
}

// PROJ-1b: БРИГАДА на карточках /projects — число назначенных работников по проектам ОДНИМ
// запросом (reuse getProjectAssignments). Считаем уникальных работников на проект (Set), без N+1.
export async function getProjectCrewCounts(projectIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const rows = await getProjectAssignments(projectIds)
  const byProject = new Map<string, Set<string>>()
  for (const row of rows) {
    const set = byProject.get(row.project_id) ?? new Set<string>()
    set.add(row.profile_id)
    byProject.set(row.project_id, set)
  }
  for (const [projectId, set] of byProject) out.set(projectId, set.size)
  return out
}

// PROJ-1b: НЕДЕЛЯ на карточках /projects — отработанные мс за текущую неделю по проектам ОДНИМ
// запросом (без N+1). Пары check_in→check_out считаем на клиенте по (проект, работник); открытая
// смена — до «сейчас» (workedMs). Ставок/денег не касаемся, паритет с TimeTab/Schedule.
export async function getProjectWeekHours(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const { data, error } = await supabase.from('time_events')
    .select('project_id, profile_id, event_type, event_time')
    .gte('event_time', weekStartISO())
    .in('event_type', ['check_in', 'check_out', 'break_start', 'break_end'])
    .order('event_time')
  if (error) return out
  const byKey = new Map<string, TimeEvent[]>()
  for (const r of (data ?? []) as Array<Pick<TimeEvent, 'project_id' | 'profile_id' | 'event_type' | 'event_time'>>) {
    if (!r.project_id) continue
    const key = `${r.project_id} ${r.profile_id}`
    const list = byKey.get(key)
    if (list) list.push(r as TimeEvent)
    else byKey.set(key, [r as TimeEvent])
  }
  for (const [key, events] of byKey) {
    const projectId = key.slice(0, key.indexOf(' '))
    out.set(projectId, (out.get(projectId) ?? 0) + workedMs(events))
  }
  return out
}

// Назначения для экрана «Расписание»: имя проекта тянем embed-ом project:projects(name)
// (единственный FK project_assignments.project_id). RLS держит org-скоуп; работнику видны
// только свои строки, поэтому при необходимости сужаем по profile_id.
export async function getScheduleAssignments(profileId?: string): Promise<ScheduleAssignment[]> {
  let q = supabase.from('project_assignments')
    .select('id, project_id, profile_id, assigned_at, project:projects(name)')
  if (profileId) q = q.eq('profile_id', profileId)
  const { data, error } = await q
  if (error) return []
  return (data as unknown as ScheduleAssignment[]) ?? []
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

// Режим доступа к проектам живёт на профиле работника: 'assigned' — только назначенные,
// 'all_active' — все активные (минус исключения). Менять пускают менеджеров (RLS profiles).
export async function setProjectAccessMode(p: Profile, workerId: string, mode: 'assigned' | 'all_active') {
  const { error } = await supabase.from('profiles')
    .update({ project_access_mode: mode })
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'worker.project_access_mode', 'profile', workerId, { mode })
}

// Исключения проектов (project_exclusions): в режиме 'all_active' скрывают конкретные проекты.
// SELECT — org-скоуп; insert/delete — менеджер+ (RLS). Имя проекта тянем join-ом для списка.
export async function getProjectExclusions(workerId: string): Promise<ProjectExclusion[]> {
  const { data, error } = await supabase.from('project_exclusions')
    .select('project_id, project:projects(name)')
    .eq('profile_id', workerId)
  if (error) return []
  return (data as unknown as ProjectExclusion[]) ?? []
}

export async function addProjectExclusion(p: Profile, workerId: string, projectId: string) {
  const { error } = await supabase.from('project_exclusions')
    .insert({ org_id: p.org_id, profile_id: workerId, project_id: projectId })
  if (error) throw error
  await logEvent(p, 'worker.project_excluded', 'profile', workerId, { project_id: projectId })
}

export async function removeProjectExclusion(p: Profile, workerId: string, projectId: string) {
  const { error } = await supabase.from('project_exclusions')
    .delete()
    .eq('profile_id', workerId)
    .eq('project_id', projectId)
    .eq('org_id', p.org_id)
  if (error) throw error
  await logEvent(p, 'worker.project_included', 'profile', workerId, { project_id: projectId })
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
  // Fire-and-forget web push per recipient — same invoke as a direct message, localized
  // to each worker. The plan body is trimmed to 100 chars inside notifyMessagePush.
  for (const worker of workers) {
    const lang = dispatchLang(worker.language)
    notifyMessagePush(worker.id, p.name, dispatchPlanBody(project, tasks, planDate, lang), worker.language)
  }
}

// DISP-1: бейдж «отправлено кому/когда» в конструкторе плана. Берём из ленты событий
// последние рассылки плана (событие dispatch.plan_sent пишет sendDispatchPlan выше).
// entity_id = проект; data.workers = сколько получателей. error → [] (бейдж не критичен).
export interface DispatchPlanSend {
  id: string
  project_id: string
  workers: number
  created_at: string
  actor_name: string | null
}

export async function getRecentDispatchPlanSends(): Promise<DispatchPlanSend[]> {
  const { data, error } = await supabase.from('events')
    .select('id, entity_id, actor_name, data, created_at')
    .eq('event_type', 'dispatch.plan_sent')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return []
  return ((data ?? []) as Array<{ id: string; entity_id: string | null; actor_name: string | null; data: { workers?: number } | null; created_at: string }>)
    .filter((row) => row.entity_id)
    .map((row) => ({
      id: row.id,
      project_id: row.entity_id as string,
      workers: Number(row.data?.workers) || 0,
      created_at: row.created_at,
      actor_name: row.actor_name,
    }))
}

export async function markTaskDone(p: Profile, task: Task, mediaId: string | null = null) {
  if (task.task_type === 'material' || task.task_type === 'delivery') {
    throw new Error('material_status_rpc_required')
  }
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

export async function getTimelineEvents(limit: number, eventTypePrefix: string | null = null): Promise<TimelineEventRow[]> {
  const safeLimit = Math.max(1, Math.floor(limit))
  let query = supabase.from('events')
    .select('id, org_id, event_type, entity_type, entity_id, data, actor_id, actor_name, actor_role, created_at')

  if (eventTypePrefix) query = query.like('event_type', `${eventTypePrefix}%`)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(0, safeLimit - 1)
  if (error) throw error
  return (data as TimelineEventRow[]) ?? []
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

// Все фото ОДНОГО проекта для вкладки «Файлы и медиа» хаба — как getGalleryPhotos,
// но со скоупом project_id. Подписанные URL берём пачкой, свежие — первыми.
export async function getProjectPhotos(projectId: string): Promise<GalleryPhoto[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at, project_id, category, project:projects(name)')
    .eq('project_id', projectId)
    .eq('media_type', 'photo')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return []

  const photos = await Promise.all(((data ?? []) as unknown as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
    project_id?: string | null
    category?: string | null
    project?: { name: string | null } | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    return {
      id: row.id,
      url: await mediaUrl(row.storage_path),
      filename: row.filename ?? null,
      created_at: row.created_at ?? null,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      category: row.category ?? null,
      // Автор загрузки для этого экрана не нужен — держим поля контракта заполненными.
      uploaded_by: null as string | null,
      uploader_name: null as string | null,
    }
  }))

  return photos.filter((photo): photo is GalleryPhoto => photo !== null)
}

// Все видео ОДНОГО проекта для вкладки «Файлы и медиа» хаба — как getProjectPhotos,
// но media_type='video'. Тот же select и контракт GalleryVideo, что и getGalleryVideos.
export async function getProjectVideos(projectId: string): Promise<GalleryVideo[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at, project_id, category, project:projects(name)')
    .eq('project_id', projectId)
    .eq('media_type', 'video')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return []

  const videos = await Promise.all(((data ?? []) as unknown as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
    project_id?: string | null
    category?: string | null
    project?: { name: string | null } | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    return {
      id: row.id,
      url: await mediaUrl(row.storage_path),
      filename: row.filename ?? null,
      created_at: row.created_at ?? null,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      category: row.category ?? null,
      // Автор загрузки для этого экрана не нужен — держим поля контракта заполненными.
      uploaded_by: null as string | null,
      uploader_name: null as string | null,
    }
  }))

  return videos.filter((video): video is GalleryVideo => video !== null)
}

// «Галерея»: все фото объектов (media_type='photo', не удалённые) с именем проекта.
// Подписанные URL берём пачкой, порядок — сначала свежие. Лимит держит галерею лёгкой.
// Размер страницы галереи по умолчанию — сохраняет прежний потолок в 200 для существующих вызовов.
export const GALLERY_PAGE_SIZE = 200

export async function getGalleryPhotos(offset = 0, limit = GALLERY_PAGE_SIZE): Promise<GalleryPhoto[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at, project_id, category, uploaded_by, project:projects(name), uploader:profiles!media_uploaded_by_fkey(name)')
    .eq('media_type', 'photo')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) return []

  const photos = await Promise.all(((data ?? []) as unknown as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
    project_id?: string | null
    category?: string | null
    uploaded_by?: string | null
    project?: { name: string | null } | null
    uploader?: { name: string | null } | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    return {
      id: row.id,
      url: await mediaUrl(row.storage_path),
      filename: row.filename ?? null,
      created_at: row.created_at ?? null,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      category: row.category ?? null,
      uploaded_by: row.uploaded_by ?? null,
      uploader_name: row.uploader?.name ?? null,
    }
  }))

  return photos.filter((photo): photo is GalleryPhoto => photo !== null)
}

// «Галерея» → вкладка Видео: все видео объектов (media_type='video', не удалённые) с именем проекта.
// Строго по образцу getGalleryPhotos, только media_type='video'. Подписанные URL берём пачкой.
export async function getGalleryVideos(offset = 0, limit = GALLERY_PAGE_SIZE): Promise<GalleryVideo[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at, project_id, category, uploaded_by, project:projects(name), uploader:profiles!media_uploaded_by_fkey(name)')
    .eq('media_type', 'video')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) return []

  const videos = await Promise.all(((data ?? []) as unknown as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
    project_id?: string | null
    category?: string | null
    uploaded_by?: string | null
    project?: { name: string | null } | null
    uploader?: { name: string | null } | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    return {
      id: row.id,
      url: await mediaUrl(row.storage_path),
      filename: row.filename ?? null,
      created_at: row.created_at ?? null,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      category: row.category ?? null,
      uploaded_by: row.uploaded_by ?? null,
      uploader_name: row.uploader?.name ?? null,
    }
  }))

  return videos.filter((video): video is GalleryVideo => video !== null)
}

// «Галерея» → вкладка PDF: PDF-документы из таблицы files (mime pdf, не удалённые) с именем проекта.
// URL не резолвим здесь (зависит от scope) — открываем по клику через getGalleryPdfUrl.
// RLS files сама ограничивает org и видимость (менеджер видит всё, приватные — владелец/менеджер).
export async function getGalleryPdfs(offset = 0, limit = GALLERY_PAGE_SIZE): Promise<GalleryPdf[]> {
  const { data, error } = await supabase.from('files')
    .select('id, name, storage_path, scope, created_at, project_id, uploaded_by, project:projects(name), uploader:profiles!files_uploaded_by_fkey(name)')
    .ilike('mime', 'application/pdf')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) return []

  return ((data ?? []) as unknown as Array<{
    id: string
    name: string
    storage_path: string
    scope: string
    created_at?: string | null
    project_id?: string | null
    uploaded_by?: string | null
    project?: { name: string | null } | null
    uploader?: { name: string | null } | null
  }>).map((row) => ({
    id: row.id,
    name: row.name,
    storage_path: row.storage_path,
    scope: row.scope,
    created_at: row.created_at ?? null,
    project_id: row.project_id ?? null,
    project_name: row.project?.name ?? null,
    uploaded_by: row.uploaded_by ?? null,
    uploader_name: row.uploader?.name ?? null,
  }))
}

// Ссылка на PDF галереи: scope='project' — R2 (r2Sign download, как getProjectFileDownloadUrl),
// иначе — media bucket (mediaUrl, как экран «Файлы»). Переиспользуем имеющуюся логику скачивания.
export async function getGalleryPdfUrl(pdf: { scope: string; storage_path: string }): Promise<string> {
  if (pdf.scope === 'project') {
    const signed = await r2Sign('download', pdf.storage_path)
    return signed.url
  }
  return mediaUrl(pdf.storage_path)
}

// Открытые флаги «на проверку» (resolved_at IS NULL) — для бейджа на фото в галерее.
// RLS сам ограничивает org и видимость (свои флаги видит любой, все — менеджер).
export async function getOpenMediaFlags(): Promise<MediaFlag[]> {
  const { data, error } = await supabase.from('media_flags')
    .select('id, media_id, reason, flagged_by, created_at')
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data ?? []) as unknown as MediaFlag[]
}

// Поставить флаг «на проверку» на фото — доступно любому пользователю (RLS: flagged_by = auth.uid()).
export async function flagMedia(p: Profile, mediaId: string, reason: string): Promise<void> {
  const { error } = await supabase.from('media_flags').insert({
    org_id: p.org_id,
    media_id: mediaId,
    flagged_by: p.id,
    reason,
  })
  if (error) throw error
  await logEvent(p, 'media.flagged', 'media', mediaId, { reason })
}

// Снять флаг (проверено) — только менеджер (RLS: app.is_manager_write()).
export async function resolveMediaFlag(p: Profile, flagId: string): Promise<void> {
  const { data, error } = await supabase.from('media_flags')
    .update({ resolved_by: p.id, resolved_at: new Date().toISOString() })
    .eq('id', flagId)
    .select('media_id')
    .maybeSingle()
  if (error) throw error
  await logEvent(p, 'media.flag_resolved', 'media', (data as { media_id?: string } | null)?.media_id ?? null, {})
}

// Комментарии к медиа (media_comments): текст под фото, по возрастанию времени.
// Имя автора тянем embed-ом author:profiles(name) — FK author_id -> profiles единственный.
// RLS отдаёт комментарии, если строка media видна; на ошибке возвращаем [].
export async function getMediaComments(mediaId: string): Promise<MediaComment[]> {
  const { data, error } = await supabase.from('media_comments')
    .select('id, media_id, author_id, body, created_at, author:profiles(name)')
    .eq('media_id', mediaId)
    .order('created_at', { ascending: true })
  if (error) return []
  return (data as unknown as MediaComment[]) ?? []
}

// Добавить текстовый комментарий к медиа. RLS: author_id = auth.uid() (= profile.id),
// media_id должен указывать на существующую строку media. voice_path в v1 не пишем.
// Пустой текст игнорируем; возвращаем вставленную строку с именем автора для дозаписи в UI.
export async function addMediaComment(p: Profile, mediaId: string, body: string): Promise<MediaComment | null> {
  const text = body.trim()
  if (!text) return null
  const { data, error } = await supabase.from('media_comments')
    .insert({ media_id: mediaId, author_id: p.id, body: text })
    .select('id, media_id, author_id, body, created_at, author:profiles(name)')
    .single()
  if (error) throw error
  await logEvent(p, 'media.commented', 'media', mediaId, {})
  return (data as unknown as MediaComment) ?? null
}

export async function getCurrentPayPeriod(): Promise<PayPeriod | null> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase.from('pay_periods')
    .select('id, period_start, period_end, status')
    .lte('period_start', today)
    .gte('period_end', today)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data as PayPeriod | null) ?? null
}

// Строка снапшота зарплаты — считается на клиенте из уже рассчитанных строк таблицы (rows)
export interface PayPeriodItemInput {
  profile_id: string
  regular_hours: number
  overtime_hours: number
  hourly_rate: number | null
  total: number
}

// Закрыть период: draft → approved. Апсертит pay_periods и переснимает pay_period_items из строк таблицы.
export async function closePayPeriod(p: Profile, input: {
  payPeriodId: string | null
  periodStart: string
  periodEnd: string
  label: string
  items: PayPeriodItemInput[]
  totalPay: number
}): Promise<string> {
  const now = new Date().toISOString()
  let payPeriodId = input.payPeriodId

  if (payPeriodId) {
    const { error } = await supabase.from('pay_periods')
      .update({ status: 'approved', approved_by: p.id, approved_at: now })
      .eq('id', payPeriodId)
    if (error) throw error
  } else {
    const { data, error } = await supabase.from('pay_periods')
      .insert({
        org_id: p.org_id,
        label: input.label,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        status: 'approved',
        approved_by: p.id,
        approved_at: now,
      })
      .select('id')
      .single()
    if (error) throw error
    payPeriodId = String(data.id)
  }

  const { error: delError } = await supabase.from('pay_period_items')
    .delete()
    .eq('pay_period_id', payPeriodId)
  if (delError) throw delError

  if (input.items.length > 0) {
    const rows = input.items.map((item) => ({
      pay_period_id: payPeriodId,
      profile_id: item.profile_id,
      regular_hours: item.regular_hours,
      overtime_hours: item.overtime_hours,
      overtime_multiplier: 1.5,
      hourly_rate: item.hourly_rate,
      bonus: 0,
      reimbursement: 0,
      deduction: 0,
      total: item.total,
    }))
    const { error: insError } = await supabase.from('pay_period_items').insert(rows)
    if (insError) throw insError
  }

  await logEvent(p, 'payroll.period_closed', 'pay_period', payPeriodId, {
    period_start: input.periodStart,
    period_end: input.periodEnd,
    workers: input.items.length,
    total: input.totalPay,
  })
  return payPeriodId
}

// Отметить период оплаченным: approved → paid.
export async function markPayPeriodPaid(p: Profile, payPeriodId: string, meta: {
  periodStart: string
  periodEnd: string
  workers: number
  totalPay: number
}): Promise<void> {
  const { error } = await supabase.from('pay_periods')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', payPeriodId)
  if (error) throw error
  await logEvent(p, 'payroll.period_paid', 'pay_period', payPeriodId, {
    period_start: meta.periodStart,
    period_end: meta.periodEnd,
    workers: meta.workers,
    total: meta.totalPay,
  })
}

// PAY-1: найти уже существующий период по ТОЧНЫМ датам окна (period_start/period_end).
// Черновик из пресета переиспользует этот id (обновляет период вместо вставки дубля),
// чтобы не задваивать деньги в Архиве/отчётах. Нет совпадения → null (будет новый черновик).
export async function getPayPeriodByExactDates(periodStart: string, periodEnd: string): Promise<PayPeriod | null> {
  const { data, error } = await supabase.from('pay_periods')
    .select('id, period_start, period_end, status')
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data as PayPeriod | null) ?? null
}

// PAY-1: годовой отчёт (per-worker) — часы и оплачено $ по закрытым/оплаченным периодам
// (status approved|paid), чьё period_start попадает в окно года [fromDate, toDate] (YYYY-MM-DD).
// Тот же источник и та же нотация «закрыто/оплачено», что у Архива (getArchivePayPeriods):
// pay_periods + pay_period_items, без RPC. Деньги гейтит UI (finance-only). Три запроса,
// сборка на клиенте — без embed, чтобы не зависеть от строгих FK.
export async function getYearlyPayrollReport(fromDate: string, toDate: string): Promise<YearlyPayReportRow[]> {
  const { data: periodRows, error } = await supabase.from('pay_periods')
    .select('id, period_start, status')
    .in('status', ['approved', 'paid'])
    .gte('period_start', fromDate)
    .lte('period_start', toDate)
  if (error || !periodRows) return []
  const periods = periodRows as Array<{ id: string; period_start: string; status: string | null }>
  if (periods.length === 0) return []

  const periodIds = periods.map((p) => p.id)
  const { data: itemRows } = await supabase.from('pay_period_items')
    .select('pay_period_id, profile_id, regular_hours, overtime_hours, total')
    .in('pay_period_id', periodIds)
  const items = (itemRows ?? []) as Array<{ pay_period_id: string; profile_id: string; regular_hours: number | null; overtime_hours: number | null; total: number | null }>
  if (items.length === 0) return []

  const workerIds = [...new Set(items.map((i) => i.profile_id))]
  const workerById = new Map<string, { name: string | null; role: string | null }>()
  if (workerIds.length > 0) {
    const { data: profRows } = await supabase.from('profiles').select('id, name, role').in('id', workerIds)
    for (const row of (profRows ?? []) as Array<{ id: string; name: string | null; role: string | null }>) {
      workerById.set(row.id, { name: row.name, role: row.role })
    }
  }

  const byWorker = new Map<string, YearlyPayReportRow>()
  const periodsByWorker = new Map<string, Set<string>>()
  for (const it of items) {
    const prof = workerById.get(it.profile_id)
    const row = byWorker.get(it.profile_id) ?? {
      profile_id: it.profile_id,
      worker_name: prof?.name ?? null,
      worker_role: prof?.role ?? null,
      regular_hours: 0,
      overtime_hours: 0,
      total_hours: 0,
      paid: 0,
      periods: 0,
    }
    const reg = Number(it.regular_hours) || 0
    const ot = Number(it.overtime_hours) || 0
    row.regular_hours += reg
    row.overtime_hours += ot
    row.total_hours += reg + ot
    row.paid += Number(it.total) || 0
    byWorker.set(it.profile_id, row)
    const set = periodsByWorker.get(it.profile_id) ?? new Set<string>()
    set.add(it.pay_period_id)
    periodsByWorker.set(it.profile_id, set)
  }
  for (const [id, set] of periodsByWorker) {
    const row = byWorker.get(id)
    if (row) row.periods = set.size
  }

  return [...byWorker.values()].sort((a, b) => (a.worker_name ?? '').localeCompare(b.worker_name ?? ''))
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
  // Fire-and-forget web push to the recipient. Never blocks/throws into the send path.
  notifyMessagePush(recipientId, p.name, body, p.language)
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

// CAL-1b: события календаря для «Календаря команды». Тот же источник, что getCalendarEvents,
// но более широкий select (project_id/ends_at/assigned_to/notes/location) — нужен для сплита по
// ролям (assigned_to) и привязки к проекту. Отдельный хелпер, чтобы не менять узкий select
// /calendar. RLS calendar_events держит org-скоуп. error → [] (мягкая деградация UI).
export async function getTeamCalendarEvents(startISO: string, endISO: string): Promise<CalendarEvent[]> {
  const { data, error } = await supabase.from('calendar_events')
    .select('id, org_id, title, event_type, starts_at, ends_at, location, project_id, assigned_to, permit_number, inspection_status, notes')
    .gte('starts_at', startISO)
    .lt('starts_at', endISO)
    .order('starts_at')
  if (error) return []
  return (data as CalendarEvent[]) ?? []
}

// CAL-1b: доп. опциональные колонки (project_id/assigned_to/ends_at/notes) — additive, узкий
// вызов из /calendar (Calendar.tsx) их не передаёт и работает как прежде. Пропускаем в insert
// только заданные ключи (spread не включает отсутствующие).
export async function createCalendarEvent(p: Profile, input: {
  title: string
  event_type: CalendarEvent['event_type']
  starts_at: string
  permit_number: string | null
  inspection_status: string | null
  ends_at?: string | null
  project_id?: string | null
  assigned_to?: string | null
  notes?: string | null
}) {
  const { data, error } = await supabase.from('calendar_events')
    .insert({ org_id: p.org_id, created_by: p.id, ...input })
    .select('id')
    .single()
  if (error) throw error
  await logEvent(p, 'calendar.created', 'calendar_event', data.id, { title: input.title, event_type: input.event_type })
}

const ACCOUNT_SELECT = 'id, org_id, name, account_type, email, phone, address, notes, is_taxable, insurance_status, client_rating, rating_note, metadata, created_by, updated_by, version, created_at, updated_at, deleted_at, archived_at'
const CONTACT_SELECT = 'id, org_id, account_id, name, title, email, phone, is_primary, notes, created_at, updated_at, deleted_at'
const CLIENT_PROJECT_SELECT = 'id, name, status, client_account_id'
const CLIENT_DOCUMENT_SELECT = 'id, org_id, account_id, project_id, doc_type, status, number, title, total, balance, issue_date'

export async function getClientAccounts(): Promise<Account[]> {
  const { data, error } = await supabase.from('accounts')
    .select(ACCOUNT_SELECT)
    .is('deleted_at', null)
    .order('name')
  if (error) return []
  return (data as Account[]) ?? []
}

export async function createAccount(p: Profile, input: AccountInput): Promise<Account> {
  const { data, error } = await supabase.from('accounts')
    .insert({ org_id: p.org_id, created_by: p.id, ...input })
    .select(ACCOUNT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'account.created', 'account', data.id, {})
  return data as Account
}

export async function updateAccount(p: Profile, accountId: string, input: AccountInput): Promise<Account> {
  const { data, error } = await supabase.from('accounts')
    .update({ ...input, updated_by: p.id })
    .eq('id', accountId)
    .select(ACCOUNT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'account.updated', 'account', accountId, {})
  return data as Account
}

export async function getAccountContacts(accountId: string): Promise<Contact[]> {
  const { data, error } = await supabase.from('contacts')
    .select(CONTACT_SELECT)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('is_primary', { ascending: false })
    .order('name')
  if (error) return []
  return (data as Contact[]) ?? []
}

export async function createContact(p: Profile, accountId: string, input: ContactInput): Promise<Contact> {
  const { data, error } = await supabase.from('contacts')
    .insert({ org_id: p.org_id, account_id: accountId, ...input })
    .select(CONTACT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'contact.created', 'contact', data.id, { account_id: accountId })
  return data as Contact
}

export async function getClientProjectSummaries(accountId?: string): Promise<ClientProjectSummary[]> {
  let query = supabase.from('projects')
    .select(CLIENT_PROJECT_SELECT)
    .is('deleted_at', null)
  query = accountId ? query.eq('client_account_id', accountId) : query.not('client_account_id', 'is', null)
  const { data, error } = await query.order('name')
  if (error) return []
  return (data as ClientProjectSummary[]) ?? []
}

export async function getClientDeals(accountId: string): Promise<Deal[]> {
  const { data, error } = await supabase.from('deals')
    .select('id, org_id, account_id, contact_id, title, stage, expected_amount, next_action, next_action_at')
    .eq('account_id', accountId)
    .order('next_action_at', { ascending: true, nullsFirst: false })
  if (error) return []
  return (data as Deal[]) ?? []
}

export async function getClientDocuments(accountId: string): Promise<DocumentRow[]> {
  const { data, error } = await supabase.from('documents')
    .select(CLIENT_DOCUMENT_SELECT)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('issue_date', { ascending: false, nullsFirst: false })
  if (error) return []
  return (data as DocumentRow[]) ?? []
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

// «Архив и Корзина»: мягко удалённые сущности (deleted_at IS NOT NULL), org-скоуп через RLS.
// Если RLS прячет удалённые строки, эти запросы вернут пусто — экран покажет пустые списки.
export async function getArchivedProjects(): Promise<ArchivedProject[]> {
  const { data, error } = await supabase.from('projects')
    .select('id, name, status, deleted_at')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
  if (error) return []
  return (data as ArchivedProject[]) ?? []
}

export async function getArchivedTasks(): Promise<ArchivedTask[]> {
  const { data, error } = await supabase.from('tasks')
    .select('id, title, project_id, status, deleted_at, project:projects(name)')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
  if (error) return []
  return (data as unknown as ArchivedTask[]) ?? []
}

export async function getArchivedMedia(): Promise<ArchivedMedia[]> {
  const { data, error } = await supabase.from('media')
    .select('id, filename, project_id, media_type, category, deleted_at, project:projects(name)')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
  if (error) return []
  return (data as unknown as ArchivedMedia[]) ?? []
}

const RESTORE_ENTITY_TYPE: Record<ArchiveTable, string> = {
  projects: 'project',
  tasks: 'task',
  media: 'media',
  profiles: 'profile',
  project_expenses: 'expense',
}

// Восстановление из корзины: очищаем deleted_at и пишем событие ${entity}.restored в журнал.
// Аддитивный UPDATE; для profiles/project_expenses при запрете RLS запрос упадёт — UI покажет restore_failed.
export async function restoreEntity(p: Profile, table: ArchiveTable, id: string) {
  const { error } = await supabase.from(table).update({ deleted_at: null }).eq('id', id)
  if (error) throw error
  const entityType = RESTORE_ENTITY_TYPE[table]
  await logEvent(p, `${entityType}.restored`, entityType, id, {})
}

// ARCH-1 «Корзина»: мягко удалённые сущности (deleted_at IS NOT NULL) одним списком для восстановления.
// projects/profiles/tasks/project_expenses — RLS держит org-скоуп; если RLS прячет удалённые строки,
// соответствующий запрос вернёт пусто, и экран покажет пустую корзину (не падаем).
export async function getTrashItems(): Promise<TrashItem[]> {
  const [projectsRes, profilesRes, tasksRes, receiptsRes] = await Promise.all([
    supabase.from('projects').select('id, name, deleted_at').not('deleted_at', 'is', null),
    supabase.from('profiles').select('id, name, deleted_at').not('deleted_at', 'is', null),
    supabase.from('tasks').select('id, title, deleted_at').not('deleted_at', 'is', null),
    supabase.from('project_expenses').select('id, description, vendor, deleted_at').not('deleted_at', 'is', null),
  ])
  const items: TrashItem[] = []
  for (const row of (projectsRes.data ?? []) as Array<{ id: string; name: string | null; deleted_at: string }>) {
    items.push({ id: row.id, kind: 'project', table: 'projects', name: row.name ?? '—', deleted_at: row.deleted_at })
  }
  for (const row of (profilesRes.data ?? []) as Array<{ id: string; name: string | null; deleted_at: string }>) {
    items.push({ id: row.id, kind: 'profile', table: 'profiles', name: row.name ?? '—', deleted_at: row.deleted_at })
  }
  for (const row of (tasksRes.data ?? []) as Array<{ id: string; title: string | null; deleted_at: string }>) {
    items.push({ id: row.id, kind: 'task', table: 'tasks', name: row.title ?? '—', deleted_at: row.deleted_at })
  }
  for (const row of (receiptsRes.data ?? []) as Array<{ id: string; description: string | null; vendor: string | null; deleted_at: string }>) {
    const label = [row.vendor, row.description].filter(Boolean).join(' — ') || '—'
    items.push({ id: row.id, kind: 'receipt', table: 'project_expenses', name: label, deleted_at: row.deleted_at })
  }
  items.sort((a, b) => new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime())
  return items
}

// BACKEND REQUEST: жёсткое удаление (purge) из корзины не реализовано на фронте — во всём приложении
// действует только мягкое удаление (deleted_at). Для «Удалить навсегда» нужен серверный путь:
// RPC/edge-функция purge_entity(table, id) под owner-гейтом (RLS DELETE на projects/profiles/tasks/
// project_expenses сейчас не гарантирован). До его появления кнопка «Удалить навсегда» отключена
// (owner-only, disabled) — см. src/screens/Trash.tsx. Ничего не подделываем: реального DELETE тут нет.

// ARCH-1 «Архив» → вкладка «Проекты»: архивные проекты (archived_at IS NOT NULL, не удалённые) со
// связанной историей — задачи/файлы(медиа)/часы/рабочие. Счётчики собираем на клиенте из связанных
// строк одним пакетом запросов (in(project_id)). Финансов тут нет — только сохранённая история.
export async function getArchiveProjectsSummary(): Promise<ArchiveProjectSummary[]> {
  const { data: projRows, error } = await supabase.from('projects')
    .select('id, name, address, status, archived_at')
    .not('archived_at', 'is', null)
    .is('deleted_at', null)
    .order('archived_at', { ascending: false })
  if (error || !projRows) return []
  const projects = projRows as Array<{ id: string; name: string; address: string | null; status: string | null; archived_at: string | null }>
  const ids = projects.map((p) => p.id)
  if (ids.length === 0) return []

  const [tasksRes, mediaRes, intervalsRes] = await Promise.all([
    supabase.from('tasks').select('project_id, status').in('project_id', ids).is('deleted_at', null),
    supabase.from('media').select('project_id').in('project_id', ids).is('deleted_at', null),
    supabase.from('v_work_intervals').select('project_id, profile_id, start_at, end_at').in('project_id', ids),
  ])

  const taskAgg = new Map<string, { total: number; done: number }>()
  for (const row of (tasksRes.data ?? []) as Array<{ project_id: string | null; status: string | null }>) {
    if (!row.project_id) continue
    const agg = taskAgg.get(row.project_id) ?? { total: 0, done: 0 }
    agg.total += 1
    if (row.status === 'done') agg.done += 1
    taskAgg.set(row.project_id, agg)
  }
  const mediaAgg = new Map<string, number>()
  for (const row of (mediaRes.data ?? []) as Array<{ project_id: string | null }>) {
    if (!row.project_id) continue
    mediaAgg.set(row.project_id, (mediaAgg.get(row.project_id) ?? 0) + 1)
  }
  const hoursAgg = new Map<string, number>()
  const workerAgg = new Map<string, Set<string>>()
  for (const row of (intervalsRes.data ?? []) as Array<{ project_id: string | null; profile_id: string; start_at: string; end_at: string | null }>) {
    if (!row.project_id || !row.end_at) continue
    const ms = new Date(row.end_at).getTime() - new Date(row.start_at).getTime()
    if (ms > 0) hoursAgg.set(row.project_id, (hoursAgg.get(row.project_id) ?? 0) + ms / 3_600_000)
    const set = workerAgg.get(row.project_id) ?? new Set<string>()
    set.add(row.profile_id)
    workerAgg.set(row.project_id, set)
  }

  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    address: p.address,
    status: p.status,
    archived_at: p.archived_at,
    taskCount: taskAgg.get(p.id)?.total ?? 0,
    completedTaskCount: taskAgg.get(p.id)?.done ?? 0,
    mediaCount: mediaAgg.get(p.id) ?? 0,
    hours: hoursAgg.get(p.id) ?? 0,
    workerCount: workerAgg.get(p.id)?.size ?? 0,
  }))
}

// ARCH-1 «Архив» → вкладка «Зарплата / Рабочие»: закрытые/оплаченные периоды (status approved|paid) со
// строками сотрудников. Три запроса (периоды → строки → имена/роли), сборка на клиенте — без embed,
// чтобы не зависеть от строгих FK. Денежные суммы гейтит UI (finance-only), тут только читаем.
export async function getArchivePayPeriods(): Promise<ArchivePayPeriod[]> {
  const { data: periodRows, error } = await supabase.from('pay_periods')
    .select('id, label, period_start, period_end, status, paid_at')
    .in('status', ['approved', 'paid'])
    .order('period_start', { ascending: false })
  if (error || !periodRows) return []
  const periods = periodRows as Array<{ id: string; label: string | null; period_start: string; period_end: string; status: string | null; paid_at: string | null }>
  if (periods.length === 0) return []

  const periodIds = periods.map((p) => p.id)
  const { data: itemRows } = await supabase.from('pay_period_items')
    .select('pay_period_id, profile_id, regular_hours, overtime_hours, total')
    .in('pay_period_id', periodIds)
  const items = (itemRows ?? []) as Array<{ pay_period_id: string; profile_id: string; regular_hours: number | null; overtime_hours: number | null; total: number | null }>

  const workerIds = [...new Set(items.map((i) => i.profile_id))]
  const workerById = new Map<string, { name: string | null; role: string | null }>()
  if (workerIds.length > 0) {
    const { data: profRows } = await supabase.from('profiles').select('id, name, role').in('id', workerIds)
    for (const row of (profRows ?? []) as Array<{ id: string; name: string | null; role: string | null }>) {
      workerById.set(row.id, { name: row.name, role: row.role })
    }
  }

  const itemsByPeriod = new Map<string, ArchivePayItem[]>()
  for (const it of items) {
    const list = itemsByPeriod.get(it.pay_period_id) ?? []
    const prof = workerById.get(it.profile_id)
    list.push({
      profile_id: it.profile_id,
      worker_name: prof?.name ?? null,
      worker_role: prof?.role ?? null,
      regular_hours: Number(it.regular_hours) || 0,
      overtime_hours: Number(it.overtime_hours) || 0,
      total: Number(it.total) || 0,
    })
    itemsByPeriod.set(it.pay_period_id, list)
  }

  return periods.map((p) => ({
    id: p.id,
    label: p.label,
    period_start: p.period_start,
    period_end: p.period_end,
    status: p.status,
    paid_at: p.paid_at,
    items: itemsByPeriod.get(p.id) ?? [],
  }))
}

// ARCH-1 «Архив» → вкладка «Зарплата / Рабочие»: деактивированные работники (is_active=false, не удалены —
// удалённые живут в корзине). RLS profiles отдаёт менеджеру org-скоуп.
export async function getDeactivatedWorkers(): Promise<DeactivatedWorker[]> {
  const { data, error } = await supabase.from('profiles')
    .select('id, name, role, is_active, deleted_at')
    .eq('is_active', false)
    .is('deleted_at', null)
    .order('name')
  if (error) return []
  return ((data ?? []) as Array<{ id: string; name: string; role: string }>)
    .map((row) => ({ id: row.id, name: row.name, role: row.role }))
}

// «Магазины поставок»: справочник supply_stores. NB: point — PostGIS geography, никогда не селектим (hex EWKB).
export async function getSupplyStores(): Promise<SupplyStore[]> {
  const { data, error } = await supabase.from('supply_stores')
    .select('id, org_id, name, address, radius_m, is_active, created_at')
    .order('name')
  if (error) return []
  return (data as SupplyStore[]) ?? []
}

export async function createSupplyStore(
  p: Profile,
  { name, address, radius_m, lat, lng }: { name: string; address?: string; radius_m?: number; lat?: number; lng?: number },
): Promise<SupplyStore | null> {
  const row: Record<string, unknown> = { org_id: p.org_id, name, address, radius_m: radius_m ?? 120 }
  // X Y = lon lat: сначала долгота, потом широта. Обе координаты должны быть конечными числами.
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    row.point = `SRID=4326;POINT(${lng} ${lat})`
  }
  const { data, error } = await supabase.from('supply_stores').insert(row)
    .select('id, org_id, name, address, radius_m, is_active, created_at').single()
  if (error) throw error
  await logEvent(p, 'supply_store.created', 'supply_store', data.id, {})
  return data as SupplyStore
}

export async function setSupplyStoreActive(p: Profile, id: string, is_active: boolean) {
  const { error } = await supabase.from('supply_stores').update({ is_active }).eq('id', id)
  if (error) throw error
  await logEvent(p, 'supply_store.updated', 'supply_store', id, { is_active })
}

// Заезды store_visits: строки пишет бэкенд edge-function, экран только читает (может быть пусто).
export async function getStoreVisits(): Promise<StoreVisit[]> {
  const { data, error } = await supabase.from('store_visits')
    .select('id, worker_id, store_id, project_id, entered_at, exited_at, is_paid, note, worker:profiles(name), store:supply_stores(name), project:projects(name)')
    .order('entered_at', { ascending: false })
    .limit(50)
  if (error) return []
  return (data as unknown as StoreVisit[]) ?? []
}

// Гибкие права (user_capabilities): выдаёт только owner/admin. RLS включён. PK (user_id, capability).
export async function getUserCapabilities(userId: string): Promise<UserCapability[]> {
  const { data, error } = await supabase.from('user_capabilities')
    .select('user_id, capability, granted, granted_by, granted_at, note')
    .eq('user_id', userId)
  if (error) return []
  return (data as UserCapability[]) ?? []
}

export async function setUserCapability(p: Profile, userId: string, capability: string, granted: boolean): Promise<void> {
  const { error } = await supabase.from('user_capabilities')
    .upsert({ user_id: userId, capability, granted, granted_by: p.id }, { onConflict: 'user_id,capability' })
  if (error) throw error
  await logEvent(p, 'capability.updated', 'profile', userId, { capability, granted })
}

// Дневные рапорты (daily_reports). RLS отдаёт менеджеру все рапорты, автору — только свои.
// point/geometry тут нет; мягко удалённые (deleted_at) скрываем на клиенте.
const DAILY_REPORT_SELECT = 'id, org_id, project_id, author_id, report_date, body, media_ids, created_at, project:projects(name), author:profiles(name)'

// Фото для дневного рапорта: тот же upload, что у задач (safeFileName + опции), но без task_id.
// Категория daily_photo; ссылка на рапорт живёт в daily_reports.media_ids, не на media.
export async function uploadDailyReportPhoto(p: Profile, projectId: string, file: File): Promise<string> {
  validateUpload(file, 'photo')
  const ext = safeFileName(file.name, file.type).split('.').pop() || 'jpg'
  const storagePath = `daily/${p.org_id}/${Date.now()}-${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, {
      contentType: inferUploadContentType(file),
      upsert: false,
    })
  if (uploadError) throw uploadError

  const { data, error } = await supabase.from('media').insert({
    org_id: p.org_id,
    project_id: projectId,
    uploaded_by: p.id,
    media_type: 'photo',
    category: 'daily_photo',
    storage_path: storagePath,
    filename: safeFileName(file.name, file.type),
    mime: file.type || 'image/jpeg',
    size_bytes: file.size,
  }).select('id').single()
  if (error) throw error
  return String(data.id)
}

// URL-ы фото рапорта по его media_ids — подписанные ссылки пачкой, для показа в списке.
export async function getDailyReportPhotos(mediaIds: string[]): Promise<{ id: string; url: string }[]> {
  if (mediaIds.length === 0) return []
  const { data, error } = await supabase.from('media')
    .select('id, storage_path')
    .in('id', mediaIds)
    .is('deleted_at', null)
  if (error) return []

  const photos = await Promise.all(((data ?? []) as Array<{ id: string; storage_path: string | null }>).map(async (row) => {
    if (!row.storage_path) return null
    return { id: row.id, url: await mediaUrl(row.storage_path) }
  }))
  return photos.filter((photo): photo is { id: string; url: string } => photo !== null)
}

export async function getDailyReports(): Promise<DailyReport[]> {
  const { data, error } = await supabase.from('daily_reports')
    .select(DAILY_REPORT_SELECT)
    .is('deleted_at', null)
    .order('report_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) return []
  return (data as unknown as DailyReport[]) ?? []
}

// Дневные рапорты одного проекта — вкладка «Рапорты» в Project Hub (RLS скоупит видимость: автор/менеджер)
export async function getProjectDailyReports(projectId: string): Promise<DailyReport[]> {
  const { data, error } = await supabase.from('daily_reports')
    .select(DAILY_REPORT_SELECT).eq('project_id', projectId).is('deleted_at', null)
    .order('report_date', { ascending: false }).order('created_at', { ascending: false }).limit(100)
  if (error) return []
  return (data as unknown as DailyReport[]) ?? []
}

// Автор пишет свой рапорт: RLS требует author_id = auth.uid() (= profile.id). Возвращаем строку с проектом и автором.
export async function createDailyReport(
  p: Profile,
  { projectId, reportDate, body, mediaIds }: { projectId: string; reportDate: string; body: string; mediaIds?: string[] },
): Promise<DailyReport | null> {
  const { data, error } = await supabase.from('daily_reports')
    .insert({ org_id: p.org_id, project_id: projectId, author_id: p.id, report_date: reportDate, body, media_ids: mediaIds ?? [] })
    .select(DAILY_REPORT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'daily_report.created', 'daily_report', data.id, { project_id: projectId, report_date: reportDate })
  return data as unknown as DailyReport
}

// «Файлы и документы» (files): storage_path — в тот же bucket, что и медиа задач (TASK_MEDIA_BUCKET).
// RLS: SELECT org-скоуп + видимость (менеджер видит всё, приватные — владелец/менеджер); удалённые прячем.
const FILE_SELECT = 'id, org_id, scope, project_id, profile_id, account_id, folder, name, storage_path, mime, size_bytes, doc_kind, expires_at, is_private, uploaded_by, created_at'

export async function getFiles(): Promise<FileRow[]> {
  const { data, error } = await supabase.from('files')
    .select(FILE_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as FileRow[]) ?? []
}

// Загрузка файла: blob в bucket медиа + строка files. RLS INSERT требует org_id=app.org_id()
// и (менеджер ИЛИ uploaded_by=uid) — потому всегда пишем uploaded_by=p.id и org_id=p.org_id.
export async function uploadFile(p: Profile, input: {
  file: Blob
  name: string
  scope: string
  folder: string
  is_private: boolean
  doc_kind?: string | null
  expires_at?: string | null
  project_id?: string | null
  profile_id?: string | null
  account_id?: string | null
}): Promise<FileRow> {
  validateUpload({ size: input.file.size, type: input.file.type, name: input.name }, 'file')
  const safeName = safeFileName(input.name, input.file.type)
  const storagePath = `files/${p.org_id}/${crypto.randomUUID()}-${safeName}`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, input.file, {
      contentType: inferUploadContentType(input.file),
      upsert: false,
    })
  if (uploadError) throw uploadError

  const { data, error } = await supabase.from('files').insert({
    org_id: p.org_id,
    scope: input.scope,
    folder: input.folder,
    name: input.name,
    storage_path: storagePath,
    mime: input.file.type || null,
    size_bytes: input.file.size,
    doc_kind: input.doc_kind ?? null,
    expires_at: input.expires_at ?? null,
    is_private: input.is_private,
    uploaded_by: p.id,
    project_id: input.project_id ?? null,
    profile_id: input.profile_id ?? null,
    account_id: input.account_id ?? null,
  }).select(FILE_SELECT).single()
  if (error) throw error
  await logEvent(p, 'file.uploaded', 'file', data.id, { name: input.name })
  return data as unknown as FileRow
}

// Мягкое удаление файла: deleted_at = now(). RLS UPDATE — менеджер ИЛИ владелец.
export async function softDeleteFile(p: Profile, id: string): Promise<void> {
  const { error } = await supabase.from('files')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
  await logEvent(p, 'file.deleted', 'file', id, {})
}

// === R2 (Cloudflare) файлы проекта — метаданные в files, содержимое в R2 через edge-функцию r2-sign. ===
// Файлы одного проекта (scope='project'): те же поля, что getFiles, но со скоупом project_id.
export async function getProjectFiles(projectId: string): Promise<FileRow[]> {
  const { data, error } = await supabase.from('files')
    .select(FILE_SELECT)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as FileRow[]) ?? []
}

// Файлы проекта с именем автора загрузки — для вкладки «Файлы и медиа» хаба.
// Как getProjectFiles, но embed-ом тянем uploader:profiles(name) (единственный FK files.uploaded_by,
// тот же, что в getGalleryPdfs). Только чтение; RLS files держит org-скоуп и приватность.
export async function getProjectHubFiles(projectId: string): Promise<ProjectHubFile[]> {
  const { data, error } = await supabase.from('files')
    .select(`${FILE_SELECT}, uploader:profiles!files_uploaded_by_fkey(name)`)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return ((data ?? []) as unknown as Array<FileRow & { uploader?: { name: string | null } | null }>)
    .map(({ uploader, ...row }) => ({ ...(row as FileRow), uploader_name: uploader?.name ?? null }))
}

// Подписанный запрос к edge-функции r2-sign: возвращает { url, method, key, expires_in }.
// Сервер сам добавляет org_id к ключу — возвращённый key и есть storage_path.
async function r2Sign(op: 'upload' | 'download', key: string): Promise<{ url: string; method: string; key: string; expires_in: number }> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('no session')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/r2-sign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op, key }),
  })
  if (!res.ok) throw new Error(`r2-sign ${op} failed: ${res.status}`)
  return res.json()
}

// Загрузка произвольного файла проекта в R2: подпись → PUT в R2 → строка files.
// RLS INSERT: org_id=app.org_id() и (менеджер ИЛИ uploaded_by=uid) — потому org_id=p.org_id, uploaded_by=p.id.
export async function uploadProjectFileToR2(p: Profile, projectId: string, file: File): Promise<FileRow> {
  validateUpload(file, 'file')
  const key = `files/${crypto.randomUUID()}-${safeFileName(file.name, file.type)}`
  const signed = await r2Sign('upload', key)
  const putRes = await fetch(signed.url, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': inferUploadContentType(file) },
  })
  if (!putRes.ok) throw new Error(`R2 upload failed: ${putRes.status}`)

  const { data, error } = await supabase.from('files').insert({
    org_id: p.org_id,
    scope: 'project',
    project_id: projectId,
    folder: '',
    name: file.name,
    storage_path: signed.key,
    mime: file.type || null,
    size_bytes: file.size,
    doc_kind: null,
    expires_at: null,
    is_private: false,
    uploaded_by: p.id,
    profile_id: null,
    account_id: null,
  }).select(FILE_SELECT).single()
  if (error) throw error
  await logEvent(p, 'file.uploaded', 'file', data.id, { project_id: projectId })
  return data as unknown as FileRow
}

// Подписанная ссылка на скачивание/просмотр файла из R2 (действует 1 час) — открывать в новой вкладке.
export async function getProjectFileDownloadUrl(file: FileRow): Promise<string> {
  const signed = await r2Sign('download', file.storage_path)
  return signed.url
}

const PROJECT_HUB_PROJECT_SELECT = 'id, org_id, name, address, notes, status, gps_radius_m, start_date, end_date, client_account_id, budget_amount, lat, lng, archived_at, deleted_at'
const PROJECT_HUB_ACCOUNT_SELECT = 'id, name, account_type, phone, email, client_rating, rating_note'

// Один проект по id — для «Хаба проекта». Без фильтра по статусу (RLS держит org-скоуп).
export async function getProjectById(projectId: string): Promise<Project | null> {
  const { data, error } = await supabase.from('projects')
    .select('*')
    .eq('id', projectId)
    .maybeSingle()
  if (error) throw error
  return (data as Project | null) ?? null
}

// Основной пакет данных Project Hub: проект + строка прибыли + клиентский аккаунт.
export async function getProjectHub(projectId: string): Promise<ProjectHubData> {
  const { data: projectRow, error: projectError } = await supabase.from('projects')
    .select(PROJECT_HUB_PROJECT_SELECT)
    .eq('id', projectId)
    .maybeSingle()
  if (projectError) throw projectError

  const project = (projectRow as Project | null) ?? null
  if (!project) return { project: null, profit: null, account: null }

  const profitPromise = supabase.from('v_project_profit')
    .select('project_id, name, budget_amount, labor_hours, labor_cost, expenses_cost, total_cost, margin_pct, profit_status')
    .eq('project_id', projectId)
    .maybeSingle()

  const accountPromise = project.client_account_id
    ? supabase.from('accounts')
      .select(PROJECT_HUB_ACCOUNT_SELECT)
      .eq('id', project.client_account_id)
      .maybeSingle()
    : Promise.resolve({ data: null, error: null })

  const [profitResult, accountResult] = await Promise.all([profitPromise, accountPromise])

  return {
    project,
    profit: profitResult.error ? null : ((profitResult.data as ProjectProfit | null) ?? null),
    account: accountResult.error ? null : ((accountResult.data as Account | null) ?? null),
  }
}

// Рейтинг клиента (accounts.client_rating/rating_note) для клиентского аккаунта проекта.
export async function getAccountRating(accountId: string): Promise<AccountRating | null> {
  const { data, error } = await supabase.from('accounts')
    .select('client_rating, rating_note')
    .eq('id', accountId)
    .maybeSingle()
  if (error) return null
  return (data as AccountRating | null) ?? null
}

// Рейтинги клиентов пачкой (id аккаунта -> client_rating) — для кружка в списке проектов.
export async function getProjectClientRatings(accountIds?: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set((accountIds ?? []).filter(Boolean))]
  if (accountIds && ids.length === 0) return out
  let query = supabase.from('accounts')
    .select('id, client_rating')
    .not('client_rating', 'is', null)
  if (ids.length > 0) query = query.in('id', ids)
  const { data, error } = await query
  if (error) return out
  for (const row of (data ?? []) as Array<{ id: string; client_rating: string | null }>) {
    if (row.client_rating) out.set(row.id, row.client_rating)
  }
  return out
}

// Заметки проекта (project_notes): закреплённые сверху, потом новейшие. Мягко удалённые прячем.
// author тянем embed-ом author:profiles(name); если схема требует явный FK, падаем на fallback.
const PROJECT_NOTE_SELECT = 'id, org_id, project_id, author_id, body, pinned, created_at, updated_at, deleted_at, author:profiles(name)'
const PROJECT_NOTE_SELECT_FK = 'id, org_id, project_id, author_id, body, pinned, created_at, updated_at, deleted_at, author:profiles!project_notes_author_id_fkey(name)'

export async function getProjectNotes(projectId: string): Promise<ProjectNote[]> {
  const run = (select: string) => supabase.from('project_notes')
      .select(select)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
  let { data, error } = await run(PROJECT_NOTE_SELECT)
  if (error) {
    const fallback = await run(PROJECT_NOTE_SELECT_FK)
    data = fallback.data
    error = fallback.error
  }
  if (error) return []
  return (data as unknown as ProjectNote[]) ?? []
}

// PROJ-1b: превью заметок для карточек /projects — ОДНИМ запросом счётчик + первая непустая
// строка верхней заметки по каждому проекту (закреплённые выше, потом новейшие). Без N+1;
// author не нужен, поэтому лёгкий select без embed. Тихо возвращает пустую карту при ошибке.
export async function getProjectsNotesPreview(
  projectIds: string[],
): Promise<Map<string, { count: number; firstLine: string }>> {
  const out = new Map<string, { count: number; firstLine: string }>()
  const ids = [...new Set(projectIds.filter(Boolean))]
  if (ids.length === 0) return out
  const { data, error } = await supabase.from('project_notes')
    .select('project_id, body, pinned, created_at')
    .in('project_id', ids)
    .is('deleted_at', null)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) return out
  for (const row of (data ?? []) as Array<{ project_id: string; body: string | null }>) {
    const cur = out.get(row.project_id)
    if (cur) { cur.count += 1; continue }
    const firstLine = (row.body ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? ''
    out.set(row.project_id, { count: 1, firstLine })
  }
  return out
}

// Автор пишет заметку: RLS требует org_id=app.org_id() и author_id=auth.uid() (= profile.id).
// created_at/updated_at ставит БД (defaults), их не пишем. Возвращаем строку с именем автора.
export async function createProjectNote(p: Profile, projectId: string, body: string): Promise<ProjectNote> {
  const { data, error } = await supabase.from('project_notes')
    .insert({ org_id: p.org_id, project_id: projectId, author_id: p.id, body: body.trim() })
    .select('id')
    .single()
  if (error) throw error
  await logEvent(p, 'project_note.created', 'project', projectId, {})
  const rows = await getProjectNotes(projectId)
  const created = rows.find((row) => row.id === String(data.id))
  if (created) return created
  return {
    id: String(data.id),
    org_id: p.org_id,
    project_id: projectId,
    author_id: p.id,
    body: body.trim(),
    pinned: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author: { name: p.name },
  }
}

// Закрепить/открепить заметку. RLS UPDATE: автор ИЛИ менеджер.
export async function setNotePinned(id: string, pinned: boolean): Promise<void> {
  const { error } = await supabase.from('project_notes')
    .update({ pinned })
    .eq('id', id)
  if (error) throw error
}

// Мягкое удаление заметки: deleted_at = now(). RLS UPDATE: автор ИЛИ менеджер.
export async function softDeleteNote(id: string): Promise<void> {
  const { error } = await supabase.from('project_notes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export const toggleProjectNotePinned = setNotePinned
export const softDeleteProjectNote = softDeleteNote

// --- MAT-3: Спецификация материалов (plan-BOM, project_materials) ---
// БЕЗ цен — в таблице нет ценовых колонок. RLS: SELECT участники проекта; INSERT/UPDATE менеджер+.
const PROJECT_MATERIAL_SELECT =
  'id, org_id, project_id, section, name, qty, unit, supplier, url, note, sort_order, status, task_id, created_by, created_at, updated_at, deleted_at'

// Черновая позиция для формы/импорта — только пользовательские поля.
export interface ProjectMaterialInput {
  section?: string | null
  name: string
  qty?: number | null
  unit?: string | null
  supplier?: string | null
  url?: string | null
  note?: string | null
}

function cleanMaterialRow(p: Profile, projectId: string, row: ProjectMaterialInput, sortOrder: number) {
  return {
    org_id: p.org_id,
    project_id: projectId,
    created_by: p.id,
    section: row.section?.trim() || null,
    name: row.name.trim(),
    qty: row.qty ?? null,
    unit: row.unit?.trim() || null,
    supplier: row.supplier?.trim() || null,
    url: row.url?.trim() || null,
    note: row.note?.trim() || null,
    sort_order: sortOrder,
    status: 'plan' as MaterialSpecStatus,
  }
}

// Позиции спецификации проекта: не удалённые, по sort_order затем created_at.
export async function getProjectMaterials(projectId: string): Promise<ProjectMaterial[]> {
  const { data, error } = await supabase.from('project_materials')
    .select(PROJECT_MATERIAL_SELECT)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) return []
  return (data as unknown as ProjectMaterial[]) ?? []
}

// Связанные материальные/доставочные задачи проекта — источник живого статуса позиций
// (picked_up_at/delivered_at ставит MAT-1). Читаем и open, и закрытые (доставленная задача — done).
export async function getProjectMaterialTasks(projectId: string): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks')
    .select(TASK_SELECT)
    .eq('project_id', projectId)
    .in('task_type', ['material', 'delivery'])
  if (error) return []
  return (data as unknown as Task[]) ?? []
}

// Следующий свободный sort_order (max+1) для проекта.
async function nextMaterialSortOrder(projectId: string): Promise<number> {
  const { data } = await supabase.from('project_materials')
    .select('sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const max = (data as { sort_order: number | null } | null)?.sort_order
  return (typeof max === 'number' ? max : -1) + 1
}

// Одна новая позиция. created_at/updated_at — дефолты БД. org_id/created_by из p (RLS менеджер+).
export async function createProjectMaterial(p: Profile, projectId: string, row: ProjectMaterialInput): Promise<ProjectMaterial> {
  const sortOrder = await nextMaterialSortOrder(projectId)
  const { data, error } = await supabase.from('project_materials')
    .insert(cleanMaterialRow(p, projectId, row, sortOrder))
    .select(PROJECT_MATERIAL_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'project_material.created', 'project', projectId, { name: row.name })
  return data as unknown as ProjectMaterial
}

// Пакетная вставка (импорт из Excel/CSV). Пустые name отбрасываем, sort_order последователен.
export async function bulkInsertProjectMaterials(p: Profile, projectId: string, rows: ProjectMaterialInput[]): Promise<ProjectMaterial[]> {
  const clean = rows.filter((r) => r.name && r.name.trim())
  if (clean.length === 0) return []
  const base = await nextMaterialSortOrder(projectId)
  const payload = clean.map((row, i) => cleanMaterialRow(p, projectId, row, base + i))
  const { data, error } = await supabase.from('project_materials')
    .insert(payload)
    .select(PROJECT_MATERIAL_SELECT)
    .order('sort_order', { ascending: true })
  if (error) throw error
  await logEvent(p, 'project_material.imported', 'project', projectId, { count: clean.length })
  return (data as unknown as ProjectMaterial[]) ?? []
}

// Правка позиции (менеджер). updated_at обновит touch-триггер.
export async function updateProjectMaterial(
  _p: Profile,
  id: string,
  patch: Partial<ProjectMaterialInput> & { status?: MaterialSpecStatus; task_id?: string | null },
): Promise<ProjectMaterial> {
  const { data, error } = await supabase.from('project_materials')
    .update(patch)
    .eq('id', id)
    .select(PROJECT_MATERIAL_SELECT)
    .single()
  if (error) throw error
  return data as unknown as ProjectMaterial
}

// Мягкое удаление позиции: deleted_at = now() (RLS UPDATE менеджер+).
export async function softDeleteProjectMaterial(_p: Profile, id: string): Promise<void> {
  const { error } = await supabase.from('project_materials')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// «В заявку»: создаём существующую материальную заявку (createMaterialRequest — уведомляет водителей),
// затем привязываем task_id и переводим позицию в 'requested'. Дальнейший статус (забор/доставка)
// отражается из связанной задачи, не пишется в спецификацию.
export async function requestProjectMaterial(p: Profile, material: ProjectMaterial): Promise<ProjectMaterial> {
  const descParts = [
    material.qty != null ? `${material.qty}${material.unit ? ' ' + material.unit : ''}` : (material.unit || null),
    material.supplier || null,
    material.note || null,
  ].filter(Boolean)
  const task = await createMaterialRequest(p, {
    projectId: material.project_id,
    title: material.name,
    description: descParts.length ? descParts.join(' · ') : null,
  })
  return updateProjectMaterial(p, material.id, { task_id: task.id, status: 'requested' })
}

export async function createProject(p: Profile, name: string, address: string, lat?: number, lng?: number, gpsRadiusM?: number) {
  const row: Record<string, unknown> = { org_id: p.org_id, name, address, created_by: p.id }
  if (lat !== undefined && lng !== undefined && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    row.site_point = `SRID=4326;POINT(${lng} ${lat})`
  }
  if (gpsRadiusM !== undefined && !Number.isNaN(gpsRadiusM)) {
    row.gps_radius_m = Math.round(gpsRadiusM)
  }
  const { data, error } = await supabase.from('projects').insert(row).select('id').single()
  if (error) throw error
  await logEvent(p, 'project.created', 'project', data.id, { name })
}

// Редактирование существующего проекта — зеркалит ТОЛЬКО писабельные колонки createProject:
// name, address, site_point (условно), gps_radius_m (условно). Больше НИКАКИХ колонок.
// site_point на клиенте нельзя надёжно прочитать (PostGIS hex EWKB), поэтому координаты в форме
// НЕ префилятся из site_point: перезаписываем site_point ТОЛЬКО когда менеджер ввёл/захватил
// новые lat/lng (тот же guard, что в createProject). Без новых координат ключ site_point опускаем
// — старое значение не трогаем и НЕ очищаем. RLS projects UPDATE пускает только менеджера;
// клиентский гейт — isManagerWrite в UI.
export async function updateProject(
  p: Profile,
  projectId: string,
  fields: { name: string; address: string; lat?: number; lng?: number; gpsRadiusM?: number },
) {
  const { name, address, lat, lng, gpsRadiusM } = fields
  const row: Record<string, unknown> = { name, address }
  if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
    row.site_point = `SRID=4326;POINT(${lng} ${lat})`
  }
  if (gpsRadiusM !== undefined && Number.isFinite(gpsRadiusM)) {
    row.gps_radius_m = Math.round(gpsRadiusM)
  }
  const { error } = await supabase.from('projects').update(row).eq('id', projectId)
  if (error) throw error
  await logEvent(p, 'project.updated', 'project', projectId, { name })
}

// PROJ-1b «Убрать» проект с доски /projects — мягкая архивация (archived_at=now(), status='archived'),
// НЕ жёсткое удаление. Проект исчезает и с доски (getBoardProjects), и из active-списков (getProjects).
// RLS projects UPDATE пускает только менеджера; клиентский гейт — isManagerWrite в UI.
export async function archiveProject(p: Profile, projectId: string): Promise<void> {
  const { error } = await supabase.from('projects')
    .update({ archived_at: new Date().toISOString(), status: 'archived' })
    .eq('id', projectId)
  if (error) throw error
  await logEvent(p, 'project.archived', 'project', projectId, {})
}

// PROJ-1b STEP 4: авто-геокодирование адреса → lat/lng при создании/правке проекта. Паритет с
// Check Time, который использует Google Geocoding API (maps.googleapis.com). Google требует ключ,
// поэтому на чистом фронте читаем его из окружения Vite (VITE_GOOGLE_GEOCODING_API_KEY). Ключа в
// проекте пока нет — код готов и заработает без изменений UI, как только ключ появится.
// BACKEND REQUEST: geocoding API key needed (Google Geocoding API) — задать VITE_GOOGLE_GEOCODING_API_KEY.
export type GeocodeResult = { lat: number; lng: number; formattedAddress: string | null }

export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const query = address.trim()
  if (!query) throw new Error('geocode_missing_address')
  const env = import.meta.env as unknown as Record<string, string | undefined>
  const key = env.VITE_GOOGLE_GEOCODING_API_KEY ?? ''
  if (!key) throw new Error('geocode_no_key')
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', query)
  url.searchParams.set('key', key)
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('geocode_failed')
  const payload = (await res.json()) as {
    status?: string
    results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }>
  }
  const first = payload.results?.[0]
  const lat = first?.geometry?.location?.lat
  const lng = first?.geometry?.location?.lng
  if (payload.status !== 'OK' || typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error(payload.status === 'ZERO_RESULTS' ? 'geocode_zero_results' : 'geocode_failed')
  }
  return { lat, lng, formattedAddress: first?.formatted_address ?? null }
}

// Обновление ТОЛЬКО дат графика проекта (start_date/end_date) — точка входа для
// «Календаря команды» (CAL-1a). Не трогает name/address/site_point. RLS projects UPDATE
// пускает только менеджера; клиентский гейт — isManagerWrite в UI. Пустая строка → null,
// чтобы дату можно было очистить.
export async function updateProjectDates(
  p: Profile,
  projectId: string,
  dates: { start_date: string | null; end_date: string | null },
) {
  const row = { start_date: dates.start_date || null, end_date: dates.end_date || null }
  const { error } = await supabase.from('projects').update(row).eq('id', projectId)
  if (error) throw error
  await logEvent(p, 'project.updated', 'project', projectId, { ...row })
}

// ---- Вкладка «Клиент» Хаба: гранты видимости присутствия (client_visibility_grants) ----
const CLIENT_GRANT_SELECT = 'id, org_id, account_id, project_id, can_see_presence, notify_travel, notify_checkin, notify_checkout, channel, note, created_by, created_at, revoked_at'

// Один аккаунт по id (имя/контакты клиента). RLS держит org-скоуп. error→null.
export async function getAccountById(accountId: string): Promise<Account | null> {
  const { data, error } = await supabase.from('accounts')
    .select(ACCOUNT_SELECT)
    .eq('id', accountId)
    .maybeSingle()
  if (error) return null
  return (data as Account | null) ?? null
}

// Активные гранты проекта (revoked_at IS NULL), новейшие сверху. error→[].
export async function getProjectGrants(projectId: string): Promise<ClientGrant[]> {
  const { data, error } = await supabase.from('client_visibility_grants')
    .select(CLIENT_GRANT_SELECT)
    .eq('project_id', projectId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as ClientGrant[]) ?? []
}

// Создать грант. org_id=p.org_id и created_by=p.id удовлетворяют RLS check (is_manager_write через роль).
export async function createProjectGrant(
  p: Profile,
  projectId: string,
  accountId: string,
  input: { can_see_presence: boolean; notify_travel: boolean; notify_checkin: boolean; notify_checkout: boolean; channel?: string; note?: string | null },
): Promise<ClientGrant> {
  const { data, error } = await supabase.from('client_visibility_grants')
    .insert({
      org_id: p.org_id,
      account_id: accountId,
      project_id: projectId,
      created_by: p.id,
      channel: input.channel ?? 'portal',
      note: input.note ?? null,
      can_see_presence: input.can_see_presence,
      notify_travel: input.notify_travel,
      notify_checkin: input.notify_checkin,
      notify_checkout: input.notify_checkout,
    })
    .select(CLIENT_GRANT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'grant.created', 'client_visibility_grant', data.id, { project_id: projectId, account_id: accountId })
  return data as ClientGrant
}

// Отозвать грант: UPDATE revoked_at = now() (единственный способ убрать — DELETE-политики нет).
export async function revokeProjectGrant(p: Profile, grantId: string): Promise<void> {
  const { error } = await supabase.from('client_visibility_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grantId)
  if (error) throw error
  await logEvent(p, 'grant.revoked', 'client_visibility_grant', grantId, {})
}

// «Детали дня работника» → фото. Снимки, загруженные этим работником в границах суток.
// Фильтр: uploaded_by = workerId, media_type='photo', не удалённые, created_at ∈ [dayStart, dayEnd).
// URL — через mediaUrl (подписанный), по образцу getGalleryPhotos. Только чтение.
export interface WorkerDayPhoto {
  id: string
  url: string
  created_at: string | null
  filename?: string | null
}
export async function getWorkerDayPhotos(workerId: string, dayStartISO: string, dayEndISO: string): Promise<WorkerDayPhoto[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at')
    .eq('uploaded_by', workerId)
    .eq('media_type', 'photo')
    .is('deleted_at', null)
    .gte('created_at', dayStartISO)
    .lt('created_at', dayEndISO)
    .order('created_at', { ascending: false })
  if (error) return []

  const photos = await Promise.all(((data ?? []) as unknown as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    return {
      id: row.id,
      url: await mediaUrl(row.storage_path),
      created_at: row.created_at ?? null,
      filename: row.filename ?? null,
    }
  }))

  return photos.filter((photo) => photo !== null) as WorkerDayPhoto[]
}

// «Детали дня работника» → закрытые задачи. Задачи, которые этот работник закрыл в границах суток.
// Фильтр: done_by = workerId, status='done', не удалённые, done_at ∈ [dayStart, dayEnd).
// embed project:projects(name) — единственный FK tasks.project_id. Только чтение.
export interface WorkerDayClosedTask {
  id: string
  title: string
  status: string
  done_at: string | null
  project_id: string | null
  project_name: string | null
}
export async function getWorkerDayClosedTasks(workerId: string, dayStartISO: string, dayEndISO: string): Promise<WorkerDayClosedTask[]> {
  const { data, error } = await supabase.from('tasks')
    .select('id, title, status, done_at, project_id, project:projects(name)')
    .eq('done_by', workerId)
    .eq('status', 'done')
    .is('deleted_at', null)
    .gte('done_at', dayStartISO)
    .lt('done_at', dayEndISO)
    .order('done_at', { ascending: false })
  if (error) return []

  return ((data ?? []) as unknown as Array<{
    id: string
    title: string | null
    status: string | null
    done_at?: string | null
    project_id?: string | null
    project?: { name: string | null } | null
  }>).map((row) => ({
    id: row.id,
    title: row.title ?? '',
    status: row.status ?? '',
    done_at: row.done_at ?? null,
    project_id: row.project_id ?? null,
    project_name: row.project?.name ?? null,
  }))
}

// F13: события времени работника в границах суток — для бейджа «нужна проверка» в деталях дня.
// Читаем metadata (jsonb), где лежат additive-ключи needs_review/location_unverified/gps_error_kind. Только чтение.
export async function getWorkerDayTimeEvents(workerId: string, dayStartISO: string, dayEndISO: string): Promise<TimeEvent[]> {
  const { data, error } = await supabase.from('time_events')
    .select(TIME_EVENT_SELECT)
    .eq('profile_id', workerId)
    .gte('event_time', dayStartISO)
    .lt('event_time', dayEndISO)
    .order('event_time')
  if (error) return []
  return (data as TimeEvent[]) ?? []
}
