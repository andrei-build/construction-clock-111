import { supabase } from '../supabase'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


// A5: read-хелперы, глотающие ошибку в [], делают "нет доступа" неотличимым от "нет данных".
// Не меняем возвращаемое [] (чтобы не ломать вызовы), но логируем реальную ошибку и отличаем
// отказ доступа (RLS/права) от пустого результата. PostgREST/Supabase кладут код в error.code:
// 42501 — insufficient_privilege; PGRST301/PGRST116/PGRST3xx — auth/RLS/роут. Для медиа/подписей
// (приватный bucket) это важно: пустая галерея из-за отказа доступа не должна выглядеть как «пусто».
function isAccessError(error: unknown): boolean {
  const code = String((error as { code?: string | null } | null)?.code ?? '')
  return code === '42501' || code === 'PGRST301' || code === 'PGRST116' || code.startsWith('PGRST3')
}

export function warnReadError(context: string, error: unknown): void {
  const e = error as { code?: string | null; message?: string } | null
  const kind = isAccessError(e) ? 'access-denied' : 'read-error'
  console.warn(`[api:${context}] ${kind}${e?.code ? ` (code ${e.code})` : ''}:`, e?.message ?? error)
}

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
// MSG-1: digest_hour — необязательное поле (owner-only /settings шлёт его аддитивно, не сбрасывая
// прочие колонки; экраны без него — OwnerSettings — payload не трогают).
export type AppSettingsInput = Pick<AppSettings, 'default_language' | 'timezone' | 'overlong_shift_hours' | 'default_gps_radius_m' | 'geo_no_signal_minutes' | 'paid_gap_alert_hours'> & { store_visit_radius_m?: number; digest_hour?: number }

const APP_SETTINGS_SELECT = 'org_id, default_language, timezone, overlong_shift_hours, default_gps_radius_m, geo_no_signal_minutes, paid_gap_alert_hours, store_visit_radius_m, digest_hour, settings, updated_by, updated_at'

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

const RESTORE_ENTITY_TYPE: Record<ArchiveTable, string> = {
  projects: 'project',
  tasks: 'task',
  media: 'media',
  profiles: 'profile',
  project_expenses: 'expense',
}

export type PurgeEntityType =
  | 'task'
  | 'project_note'
  | 'document'
  | 'file'
  | 'calendar_event'
  | 'project_material'
  | 'project_expense'
  | 'message'
  | 'contact'
  | 'deal'
  | 'daily_report'
  | 'media'

// Восстановление из корзины: очищаем deleted_at и пишем событие ${entity}.restored в журнал.
// Аддитивный UPDATE; для profiles/project_expenses при запрете RLS запрос упадёт — UI покажет restore_failed.
export async function restoreEntity(p: Profile, table: ArchiveTable, id: string) {
  const { error } = await supabase.from(table).update({ deleted_at: null }).eq('id', id)
  if (error) throw error
  const entityType = RESTORE_ENTITY_TYPE[table]
  await logEvent(p, `${entityType}.restored`, entityType, id, {})
}

export async function purgeEntity(entityType: PurgeEntityType, id: string): Promise<void> {
  const { error } = await supabase.rpc('purge_entity', { p_entity_type: entityType, p_entity_id: id })
  if (error) throw error
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

