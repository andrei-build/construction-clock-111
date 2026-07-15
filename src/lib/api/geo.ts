import { supabase } from '../supabase'
import { logEvent } from './_shared'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


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

// Ask the backend to notify the client that a worker is on the way. Best-effort and
// fire-and-forget: NEVER blocks or throws into the travel-start path. The edge function
// gates entirely on the project's Client-tab grants and always returns ok:true; a non-send
// response ({ sent:0, reason:'no_grants'|'no_recipient_email'|'no_provider' }) is fine and
// silently ignored. Mirrors notifyMessagePush's try/catch + swallow style.
export function notifyTravelStarted(
  projectId: string,
  opts?: { action?: 'travel' | 'checkin' | 'checkout'; eta_minutes?: number; note?: string; traveler_profile_id?: string },
): void {
  try {
    void supabase.functions
      .invoke('travel-notify', {
        body: {
          project_id: projectId,
          action: opts?.action ?? 'travel',
          ...(opts?.eta_minutes != null ? { eta_minutes: opts.eta_minutes } : {}),
          ...(opts?.traveler_profile_id ? { traveler_profile_id: opts.traveler_profile_id } : {}),
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

export async function startProjectTravel(
  p: Profile,
  project: Project,
  startedAt: string,
  opts?: { eta_minutes?: number; traveler_profile_id?: string },
) {
  await logEvent(p, 'travel.started', 'project', project.id, {
    project_id: project.id,
    address: project.address ?? '',
    started_at: startedAt,
  })
  // travel.started recorded → best-effort notify the client (never blocks the flow above).
  notifyTravelStarted(project.id, opts)
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
