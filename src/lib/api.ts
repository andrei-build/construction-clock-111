import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabase'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, Unit, FileRow, ProjectNote, AccountRating, GalleryVideo, GalleryPdf } from './types'
import { todayStartISO } from './time'

const TIME_EVENT_SELECT = 'id, org_id, profile_id, project_id, event_type, event_time, gps_status, video_status, video_path, adjusts_event_id, adjust_reason, adjusted_by, metadata'

// Каждое значимое действие — событие в журнале (ДНК: фундамент для AI)
export async function logEvent(p: Profile, eventType: string, entityType: string, entityId: string | null, data: Record<string, unknown> = {}) {
  await supabase.from('events').insert({
    org_id: p.org_id, event_type: eventType, entity_type: entityType, entity_id: entityId,
    actor_id: p.id, actor_name: p.name, actor_role: p.role, data,
    user_agent: navigator.userAgent,
  })
}

export type AppSettingsInput = Pick<AppSettings, 'default_language' | 'timezone' | 'overlong_shift_hours' | 'default_gps_radius_m'>

const APP_SETTINGS_SELECT = 'org_id, default_language, timezone, overlong_shift_hours, default_gps_radius_m, settings, updated_by, updated_at'

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
  const { data, error } = await supabase.from('time_events').insert(row).select('id').single()
  if (error) throw error
  await logEvent(p, `time.${type}`, 'project', projectId, { gps: geo.status, time_event_id: data.id })
  return String(data.id)
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
    .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video')
    .eq('is_active', true).order('name')
  return (data as Profile[]) ?? []
}

export async function getWorkerProfile(workerId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video')
    .eq('id', workerId)
    .maybeSingle()
  if (error) throw error
  return (data as Profile | null) ?? null
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
      contentType: file.type || 'image/jpeg',
      upsert: false,
    })

  if (uploadError) throw uploadError
  const mediaId = await insertTaskMediaRow(p, task, storagePath, file)
  return { id: mediaId, storage_path: storagePath, preview_url: URL.createObjectURL(file) }
}

const MEDIA_SIGN_TIMEOUT_MS = 9000

export async function mediaUrl(storagePath: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const signPromise = supabase.storage.from(TASK_MEDIA_BUCKET).createSignedUrl(storagePath, 3600)
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MEDIA_SIGN_TIMEOUT_MS)
  })
  try {
    const signed = await Promise.race([signPromise, timeoutPromise])
    if (signed && !signed.error && signed.data?.signedUrl) return signed.data.signedUrl
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return supabase.storage.from(TASK_MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl
}

export async function uploadCheckoutVideo(p: Profile, eventId: string, file: File) {
  validateUpload(file, 'video')
  const storagePath = `videos/${p.org_id}/${eventId}.mp4`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || 'video/mp4',
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

const ACCOUNT_SELECT = 'id, org_id, name, account_type, email, phone, address, notes, is_taxable, insurance_status, metadata, created_by, updated_by, version, created_at, updated_at, deleted_at, archived_at'
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
}

// Восстановление из корзины: очищаем deleted_at и пишем событие ${entity}.restored в журнал.
export async function restoreEntity(p: Profile, table: ArchiveTable, id: string) {
  const { error } = await supabase.from(table).update({ deleted_at: null }).eq('id', id)
  if (error) throw error
  const entityType = RESTORE_ENTITY_TYPE[table]
  await logEvent(p, `${entityType}.restored`, entityType, id, {})
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
      contentType: file.type || 'image/jpeg',
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
      contentType: input.file.type || 'application/octet-stream',
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
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
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

// Один проект по id — для «Хаба проекта». Без фильтра по статусу (RLS держит org-скоуп).
export async function getProjectById(projectId: string): Promise<Project | null> {
  const { data, error } = await supabase.from('projects')
    .select('*')
    .eq('id', projectId)
    .maybeSingle()
  if (error) throw error
  return (data as Project | null) ?? null
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
export async function getProjectClientRatings(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('accounts')
    .select('id, client_rating')
    .not('client_rating', 'is', null)
  const out = new Map<string, string>()
  if (error) return out
  for (const row of (data ?? []) as Array<{ id: string; client_rating: string | null }>) {
    if (row.client_rating) out.set(row.id, row.client_rating)
  }
  return out
}

// Заметки проекта (project_notes): закреплённые сверху, потом новейшие. Мягко удалённые прячем.
// author тянем embed-ом author:profiles(name) — author_id единственный FK в profiles.
const PROJECT_NOTE_SELECT = 'id, org_id, project_id, author_id, body, pinned, created_at, updated_at, author:profiles(name)'

export async function getProjectNotes(projectId: string): Promise<ProjectNote[]> {
  const { data, error } = await supabase.from('project_notes')
    .select(PROJECT_NOTE_SELECT)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as unknown as ProjectNote[]) ?? []
}

// Автор пишет заметку: RLS требует org_id=app.org_id() и author_id=auth.uid() (= profile.id).
// created_at/updated_at ставит БД (defaults), их не пишем. Возвращаем строку с именем автора.
export async function createProjectNote(p: Profile, projectId: string, body: string, pinned = false): Promise<ProjectNote> {
  const { data, error } = await supabase.from('project_notes')
    .insert({ org_id: p.org_id, project_id: projectId, author_id: p.id, body: body.trim(), pinned })
    .select(PROJECT_NOTE_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'project.note_added', 'project', projectId, { note_id: data.id, pinned })
  return data as unknown as ProjectNote
}

// Закрепить/открепить заметку. RLS UPDATE: автор ИЛИ менеджер.
export async function toggleProjectNotePinned(id: string, pinned: boolean): Promise<void> {
  const { error } = await supabase.from('project_notes')
    .update({ pinned })
    .eq('id', id)
  if (error) throw error
}

// Мягкое удаление заметки: deleted_at = now(). RLS UPDATE: автор ИЛИ менеджер.
export async function softDeleteProjectNote(id: string): Promise<void> {
  const { error } = await supabase.from('project_notes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
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
