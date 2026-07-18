import { supabase } from '../supabase'
import { todayStartISO } from '../time'
import { logEvent, warnReadError } from './_shared'
import { mediaUrl, safeFileName, validateUpload, inferUploadContentType, TASK_MEDIA_BUCKET, AVATARS_BUCKET, FILE_SELECT } from './storage'
import type { Geo } from './geo'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, SubcontractorDetails, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'

// M6: show_to_worker добавлен аддитивно — worker-side (MyTime) показывает комментарий менеджера
// к корректировке, когда флаг true. adjust_reason уже здесь. Прочие вызовы select не задеты.
const TIME_EVENT_SELECT = 'id, org_id, profile_id, project_id, event_type, event_time, gps_status, video_status, video_path, adjusts_event_id, adjust_reason, adjusted_by, show_to_worker, metadata'

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

// PAY-FIX-1: v_work_intervals отдаёт только id событий-концов (start_event_id/end_event_id), но НЕ их
// типы. Для травела важен именно ТИП: гэп между сменами оплачивается лишь между check_out→check_in
// (перерыв break_start→break_end — не переезд, см. computeTravelGaps). Дотягиваем event_type для
// собранных id одним READ-запросом (id,event_type) и прокидываем в start_type/end_type. Best-effort:
// если типы не прочитались, интервалы всё равно возвращаются (травел тогда просто не начислится) —
// часы (сумма длительностей интервалов) от этого запроса не зависят.
async function attachIntervalEventTypes(intervals: WorkInterval[]): Promise<WorkInterval[]> {
  const ids = new Set<string>()
  for (const iv of intervals) {
    if (iv.start_event_id) ids.add(iv.start_event_id)
    if (iv.end_event_id) ids.add(iv.end_event_id)
  }
  if (ids.size === 0) return intervals
  const { data, error } = await supabase.from('time_events')
    .select('id, event_type')
    .in('id', [...ids])
  if (error || !data) return intervals
  const typeById = new Map<string, TimeEventType>()
  for (const row of data as Array<{ id: string; event_type: TimeEventType }>) typeById.set(row.id, row.event_type)
  return intervals.map((iv) => ({
    ...iv,
    start_type: iv.start_event_id ? typeById.get(iv.start_event_id) ?? null : null,
    end_type: iv.end_event_id ? typeById.get(iv.end_event_id) ?? null : null,
  }))
}

// Отработанные интервалы одного работника — с учётом корректировок (v_work_intervals)
export async function getWorkerIntervals(profileId: string): Promise<WorkInterval[]> {
  const { data, error } = await supabase.from('v_work_intervals')
    .select('*')
    .eq('profile_id', profileId)
    .order('start_at', { ascending: false })
  if (error) throw error
  // PAY-FIX-1: дотягиваем типы концов интервала, чтобы травел на карточке работника считался как в SQL.
  return attachIntervalEventTypes((data as WorkInterval[]) ?? [])
}

// UI-FIX-PACK-1 (е): отработанные интервалы ОДНОГО работника с момента sinceISO — для экрана
// «Мои часы». v_work_intervals уже применяет корректировки менеджера, поэтому плитки часов
// совпадают с зарплатой (а не считаются по сырым событиям). OVERLAP-фильтр как в
// getIntervalsBetween: смена, начавшаяся до окна, но идущая внутрь, не теряется; открытая
// смена (end_at null) включается. Типы концов не тянем — для суммы часов они не нужны.
export async function getWorkerIntervalsSince(profileId: string, sinceISO: string): Promise<WorkInterval[]> {
  const { data, error } = await supabase.from('v_work_intervals')
    .select('*')
    .eq('profile_id', profileId)
    .or(`end_at.gt.${sinceISO},end_at.is.null`)
    .order('start_at', { ascending: false })
  if (error) return []
  return (data as WorkInterval[]) ?? []
}

// Отработанные интервалы всех работников за период — для зарплаты (v_work_intervals).
// A4b: OVERLAP-фильтр интервала [start_at, end_at) с окном [from, to) — смена, НАЧАВШАЯСЯ до
// окна, но заканчивающаяся внутри, больше НЕ теряется. Держим строки, где start_at < to И
// (end_at > from ИЛИ end_at IS NULL). end_at = null у ОТКРЫТОЙ смены (ещё идёт): начавшаяся
// до `to` пересекается — включаем. Клип часов до окна делает weeklyHours (splitHoursByWeek).
export async function getIntervalsBetween(fromISO: string, toISO: string): Promise<WorkInterval[]> {
  const { data, error } = await supabase.from('v_work_intervals')
    .select('*')
    .lt('start_at', toISO)
    .or(`end_at.gt.${fromISO},end_at.is.null`)
    .order('start_at', { ascending: false })
  if (error) throw error
  // PAY-FIX-1: дотягиваем типы концов интервала (check_in/check_out/break_*) — зарплатный экран
  // считает травел строго между check_out→check_in, как эталонный SQL report_payroll/travel.
  return attachIntervalEventTypes((data as WorkInterval[]) ?? [])
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

// Отметка: GPS не взялся — отметка всё равно проходит (ДНК §2 п.1)
export async function addTimeEvent(
  p: Profile,
  type: TimeEventType,
  projectId: string | null,
  geo: Geo,
  eventTime = new Date().toISOString(),
  metadata: Record<string, unknown> = {},
  clientId?: string,
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
  // OFFLINE-FIX-1: стабильный client_id. Раньше он генерился ЗДЕСЬ на каждый вызов, поэтому
  // онлайн-вставка и её офлайн-фолбэк (после обрыва ответа) получали РАЗНЫЕ id → unique-констрейнт
  // не срабатывал → дубль смены. Теперь CheckIn генерит id ОДИН РАЗ до первой попытки и передаёт его
  // сюда (clientId) и в очередь; повторная вставка ловится как 23505. Реплей очереди по-прежнему
  // передаёт client_id через metadata (spread ниже имеет приоритет) — связка row.id ↔ client_id цела.
  const stableClientId = clientId ?? crypto.randomUUID()
  const row: Record<string, unknown> = {
    org_id: p.org_id, profile_id: p.id, project_id: projectId,
    event_type: type, event_time: eventTime,
    gps_status: geo.status, gps_accuracy_m: geo.accuracy, gps_source: 'browser',
    metadata: { lat: geo.lat, lng: geo.lng, client_id: stableClientId, ...reviewMeta, ...metadata },
  }
  if (geo.lat !== null && geo.lng !== null) row.gps_point = `SRID=4326;POINT(${geo.lng} ${geo.lat})`
  const { data, error } = await supabase.from('time_events').insert(row).select('id').single()
  if (error) throw error
  await logEvent(p, `time.${type}`, 'project', projectId, { gps: geo.status, time_event_id: data.id })
  return String(data.id)
}

export async function getTeam(): Promise<Profile[]> {
  const { data } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video, avatar_url')
    .eq('is_active', true).order('name')
  return (data as Profile[]) ?? []
}

export async function getWorkerProfile(workerId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles')
    .select('id, org_id, name, role, language, is_active, project_access_mode, require_checkout_video, pin_enabled, skills, skills_note, avatar_url, public_bio, phone, email, home_address, emergency_contact, hire_date, dossier_notes')
    .eq('id', workerId)
    .maybeSingle()
  if (error) throw error
  return (data as Profile | null) ?? null
}

// TEAM-DOSSIER-1: контактные/кадровые поля досье (profiles.phone/email/home_address/
// emergency_contact/hire_date/dossier_notes/language). Редактирует manager+ (RLS profiles_update:
// is_manager_write() ИЛИ сам; UI гейтит canEditProfile). Триггер protect_profile_privileged_cols
// эти колонки НЕ трогает (защищает только role/pin/org/is_active/access_mode/checkout_video), так
// что update проходит. Аддитивно к updateWorkerSkills/updateWorkerPublicProfile — не смешиваем.
export async function updateWorkerDossier(p: Profile, workerId: string, input: {
  phone?: string | null
  email?: string | null
  home_address?: string | null
  emergency_contact?: string | null
  hire_date?: string | null
  dossier_notes?: string | null
  language?: string | null
}) {
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  if (Object.keys(payload).length === 0) return
  const { error } = await supabase.from('profiles')
    .update(payload)
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'team.dossier_updated', 'profile', workerId, payload)
}

// TEAM-DOSSIER-1: реквизиты субподрядчика (subcontractor_details). Только чтение полей,
// видимых владельцу (RLS sub_select: менеджер ИЛИ сам). UI показывает секцию лишь owner.
export async function getSubcontractorDetails(profileId: string): Promise<SubcontractorDetails | null> {
  const { data, error } = await supabase.from('subcontractor_details')
    .select('profile_id, trade, license_number, insurance_expires, payment_terms, notes')
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error) { warnReadError('getSubcontractorDetails', error); return null }
  return (data as SubcontractorDetails | null) ?? null
}

// TEAM-DOSSIER-1: upsert реквизитов субподрядчика. PK = profile_id (onConflict). RLS sub_write:
// org_id=app.org_id() И is_manager_write() (UI гейтит owner). org_id пишем из p; metadata/
// company_account_id не трогаем (company_accounts в схеме нет — company_account_id опущен в v1).
export async function upsertSubcontractorDetails(p: Profile, profileId: string, input: {
  trade?: string | null
  license_number?: string | null
  insurance_expires?: string | null
  payment_terms?: string | null
  notes?: string | null
}) {
  const { error } = await supabase.from('subcontractor_details')
    .upsert(
      { org_id: p.org_id, profile_id: profileId, ...input },
      { onConflict: 'profile_id' },
    )
  if (error) throw error
  await logEvent(p, 'team.subcontractor_updated', 'profile', profileId, input)
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

// TEAM-2: клиент-facing аватар. Bucket 'avatars' — ПУБЛИЧНЫЙ (migration 0034), поэтому храним
// и отдаём getPublicUrl (в отличие от приватного media, где отдаём подписанный URL). Пишем URL в
// profiles.avatar_url. Аддитивно: контакты/skills/skills_note НЕ трогаем — они внутренние.
export async function uploadAvatar(p: Profile, workerId: string, file: File): Promise<string> {
  validateUpload(file, 'photo')
  const ext = safeFileName(file.name, file.type).split('.').pop() || 'jpg'
  const storagePath = `${p.org_id}/${workerId}/${Date.now()}-${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from(AVATARS_BUCKET)
    .upload(storagePath, file, { contentType: inferUploadContentType(file), upsert: false })
  if (uploadError) throw uploadError
  const { data: pub } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(storagePath)
  const publicUrl = pub.publicUrl
  const { error } = await supabase.from('profiles')
    .update({ avatar_url: publicUrl })
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'team.avatar_updated', 'profile', workerId, { avatar_url: publicUrl })
  return publicUrl
}

// TEAM-2: клиент-facing описание (profiles.public_bio). Это видит клиент — БЕЗ контактов.
// Отдельный helper, чтобы не смешивать с внутренними полями профиля.
export async function updateWorkerPublicProfile(p: Profile, workerId: string, input: {
  public_bio?: string | null
}) {
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  if (Object.keys(payload).length === 0) return
  const { error } = await supabase.from('profiles')
    .update(payload)
    .eq('id', workerId)
  if (error) throw error
  await logEvent(p, 'team.public_profile_updated', 'profile', workerId, payload)
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

// TEAM-PIN-UI: ставит/сбрасывает PIN и вкл/выкл вход по PIN через edge `set-worker-pin`
// (v1 ACTIVE, verify_jwt=false → supabase.functions.invoke() сам прикрепляет Bearer сессии).
// Колонки profiles.pin_hash/pin_enabled защищены триггером privileged-cols — писать их НАПРЯМУЮ
// нельзя, только через эту функцию (manager+ гейтит сама edge). Тело: { profile_id, pin?, pin_enabled? }.
// Занятый PIN → HTTP 409 { error: 'pin_taken' }. Коды ошибок маппим в i18n-ключи как inviteAdmin/
// setMemberPassword выше (сначала из тела data.error, иначе из context.json() при error!=null).
type SetWorkerPinResult = { ok: boolean; error?: string }
type SetWorkerPinEdgeResponse = { ok?: boolean; error?: string }

function setWorkerPinErrorCode(value?: unknown, status?: number): string {
  if (value === 'pin_taken') return 'pin_taken'
  if (value === 'bad_pin') return 'bad_pin'
  if (status === 409) return 'pin_taken'
  return 'error'
}

export async function setWorkerPin(input: {
  profileId: string
  pin?: string
  pinEnabled?: boolean
}): Promise<SetWorkerPinResult> {
  const body: Record<string, unknown> = { profile_id: input.profileId }
  if (input.pin !== undefined) body.pin = input.pin
  if (input.pinEnabled !== undefined) body.pin_enabled = input.pinEnabled
  const { data, error } = await supabase.functions.invoke<SetWorkerPinEdgeResponse>('set-worker-pin', { body })
  if (error) {
    const errorCode = data?.error ?? await getFunctionErrorCode(error)
    return { ok: false, error: setWorkerPinErrorCode(errorCode, getResponseStatus(error)) }
  }
  if (data?.error) return { ok: false, error: setWorkerPinErrorCode(data.error) }
  return { ok: true }
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
  // M6: показать ли эту заметку (adjust_reason) работнику на его экране «Мои часы».
  // Ставится ТОЛЬКО на новой adjustment-строке при INSERT; append-only цепочка не трогается.
  // Опционально: при отсутствии — false, существующие вызовы сохраняют текущее поведение.
  showToWorker?: boolean
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
      show_to_worker: input.showToWorker ?? false,
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
  const storagePath = `signatures/consents/${p.org_id}/${p.id}/${Date.now()}-${crypto.randomUUID()}.png`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, signature, {
      contentType: 'image/png',
      upsert: false, // A5: неизменяемая улика согласия
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
    .select('worker_id, signed_at, doc_version')
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
  if (error) { warnReadError('getWorkerLocationConsents', error); return [] }
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
  if (error) { warnReadError('getWorkerSafetyAcks', error); return [] }
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
  if (error) { warnReadError('getWorkerProfileFiles', error); return [] }
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

export async function createWorker(name: string, pin: string, role: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('create-worker', { body: { name, pin, role } })
  if (error) {
    return { ok: false, error: 'error' }
  }
  if (data?.error) return { ok: false, error: data.error === 'pin_taken' ? 'pin_taken' : 'error' }
  return { ok: true }
}

type InviteAdminRole = 'owner' | 'admin'
type InviteAdminResult = {
  ok: boolean
  error?: string
  invite_link?: string
  email?: string
  role?: string
  profile_id?: string
}
type InviteAdminEdgeResponse = {
  ok?: boolean
  error?: string
  invite_link?: string
  email?: string
  role?: string
  profile_id?: string
}

function inviteAdminErrorCode(value?: unknown, status?: number): string {
  if (value === 'only_owner_can_invite') return 'only_owner_can_invite'
  if (value === 'create_failed') return 'create_failed'
  if (status === 403) return 'only_owner_can_invite'
  if (status === 409) return 'create_failed'
  return 'error'
}

function getResponseStatus(error: unknown): number | undefined {
  const context = (error as { context?: { status?: unknown } } | null)?.context
  return typeof context?.status === 'number' ? context.status : undefined
}

async function getFunctionErrorCode(error: unknown): Promise<unknown> {
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context
  if (typeof context?.json !== 'function') return undefined
  try {
    const body = await context.json()
    return (body as { error?: unknown } | null)?.error
  } catch {
    return undefined
  }
}

export async function inviteAdmin(name: string, email: string, role: InviteAdminRole): Promise<InviteAdminResult> {
  const { data, error } = await supabase.functions.invoke<InviteAdminEdgeResponse>('invite-admin', {
    body: { name, email, role },
  })
  if (error) {
    const errorCode = data?.error ?? await getFunctionErrorCode(error)
    return { ok: false, error: inviteAdminErrorCode(errorCode, getResponseStatus(error)) }
  }
  if (data?.error) return { ok: false, error: inviteAdminErrorCode(data.error) }
  if (data?.ok) {
    return {
      ok: true,
      invite_link: data.invite_link,
      email: data.email,
      role: data.role,
      profile_id: data.profile_id,
    }
  }
  return { ok: false, error: 'error' }
}

// ACC-4: владелец задаёт пароль сотруднику (email-роль) через edge `set-member-password` (verify_jwt).
// Право и запрет «owner меняет свой пароль» гейтит сама функция; тут только маппим коды ошибок в i18n-ключи.
// Коды тянем тем же способом, что inviteAdmin: сначала из тела (data.error), иначе из context.json() при error!=null.
type SetMemberPasswordResult = { ok: boolean; error?: string }
type SetMemberPasswordEdgeResponse = { ok?: boolean; error?: string }

function setMemberPasswordErrorCode(value?: unknown, status?: number): string {
  if (value === 'only_owner_can_set_password') return 'only_owner_can_set_password'
  if (value === 'owner_changes_own_password') return 'owner_changes_own_password'
  if (value === 'member_not_found') return 'member_not_found'
  if (value === 'bad_input_password_min_8') return 'bad_input_password_min_8'
  if (value === 'update_failed') return 'update_failed'
  if (status === 404) return 'member_not_found'
  if (status === 400) return 'bad_input_password_min_8'
  if (status === 409) return 'update_failed'
  if (status === 403) return 'only_owner_can_set_password'
  return 'error'
}

export async function setMemberPassword(profileId: string, newPassword: string): Promise<SetMemberPasswordResult> {
  const { data, error } = await supabase.functions.invoke<SetMemberPasswordEdgeResponse>('set-member-password', {
    body: { profile_id: profileId, new_password: newPassword },
  })
  if (error) {
    const errorCode = data?.error ?? await getFunctionErrorCode(error)
    return { ok: false, error: setMemberPasswordErrorCode(errorCode, getResponseStatus(error)) }
  }
  if (data?.error) return { ok: false, error: setMemberPasswordErrorCode(data.error) }
  if (data?.ok) return { ok: true }
  return { ok: false, error: 'error' }
}

// TRASH-3: безвозвратное удаление человека — только владелец, через RPC public.purge_profile
// (SECURITY DEFINER, migration 0046). Все гарантии гейтит сама функция БД: только role=owner;
// только человек уже в корзине (deleted_at); нельзя удалить себя; ЖЕЛЕЗНЫЙ запрет при оплаченной
// истории (purge_blocked_paid_history). Тут — только маппинг текста ошибки БД (содержит код) в
// i18n-ключи, тем же кодом-мапером, что inviteAdmin/setMemberPassword выше.
type PurgeProfileResult = { ok: boolean; error?: string }

function purgeProfileErrorCode(message?: string): string {
  const m = message ?? ''
  if (m.includes('only_owner_can_purge')) return 'only_owner_can_purge'
  if (m.includes('cannot_purge_self')) return 'cannot_purge_self'
  if (m.includes('not_in_trash')) return 'not_in_trash'
  if (m.includes('purge_blocked_paid_history')) return 'purge_blocked_paid_history'
  if (m.includes('purge_blocked_by_references')) return 'purge_blocked_by_references'
  return 'error'
}

export async function purgeProfile(profileId: string): Promise<PurgeProfileResult> {
  const { error } = await supabase.rpc('purge_profile', { p_profile_id: profileId })
  if (error) return { ok: false, error: purgeProfileErrorCode(error.message) }
  return { ok: true }
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
  if (error) { warnReadError('getWorkerDayPhotos', error); return [] }

  const photos = await Promise.all(((data ?? []) as unknown as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    const url = await mediaUrl(row.storage_path)
    if (!url) return null // A5: подпись не удалась → не показываем битое превью (приватный bucket)
    return {
      id: row.id,
      url,
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

// M11: личное предпочтение «беззвучный режим» (profiles.notif_mode). Само-обновление: RLS
// разрешает менять СВОЮ строку (id = auth.uid()), а триггер приватных колонок notif_mode не
// откатывает — бэкенд-изменения не нужны. Значение трактует notifPrefs (off → полная тишина,
// default → обычный режим); notifications.tsx подхватывает новый режим после refresh() в auth.
// Без logEvent — это личная UI-настройка, не действие над чужим профилем.
export async function updateNotifMode(mode: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('not_authenticated')
  const { error } = await supabase.from('profiles')
    .update({ notif_mode: mode })
    .eq('id', user.id)
  if (error) throw error
}

// OVR-1: manager force-checkout appends a normal check_out for the worker. History stays immutable.
export async function managerCheckoutWorker(p: Profile, workerId: string, projectId: string | null): Promise<string> {
  const { data, error } = await supabase.from('time_events')
    .insert({
      org_id: p.org_id,
      profile_id: workerId,
      project_id: projectId,
      event_type: 'check_out',
      event_time: new Date().toISOString(),
      gps_status: 'off',
      metadata: {
        client_id: crypto.randomUUID(),
        manager_checkout: true,
        forced_by: p.id,
      },
    })
    .select('id')
    .single()
  if (error) throw error
  await logEvent(p, 'time.manager_checkout', 'time_event', String(data.id), { worker_id: workerId, project_id: projectId })
  return String(data.id)
}
