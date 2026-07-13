import { supabase } from './supabase'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, SupplyStore, StoreVisit, UserCapability, DailyReport, Account, DocumentProjectOption, DocumentRow, DocumentItem, Unit } from './types'
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

export async function uploadCheckoutVideo(p: Profile, eventId: string, file: File) {
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

// «Галерея»: все фото объектов (media_type='photo', не удалённые) с именем проекта.
// Подписанные URL берём пачкой, порядок — сначала свежие. Лимит держит галерею лёгкой.
export async function getGalleryPhotos(): Promise<GalleryPhoto[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at, project_id, category, project:projects(name)')
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
    }
  }))

  return photos.filter((photo): photo is GalleryPhoto => photo !== null)
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
  const ext = safeFileName(file.name).split('.').pop() || 'jpg'
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
    filename: safeFileName(file.name),
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

export async function createProject(p: Profile, name: string, address: string, lat?: number, lng?: number) {
  const row: Record<string, unknown> = { org_id: p.org_id, name, address, created_by: p.id }
  if (lat !== undefined && lng !== undefined && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    row.site_point = `SRID=4326;POINT(${lng} ${lat})`
  }
  const { data, error } = await supabase.from('projects').insert(row).select('id').single()
  if (error) throw error
  await logEvent(p, 'project.created', 'project', data.id, { name })
}
