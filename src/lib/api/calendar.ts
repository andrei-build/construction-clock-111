import { supabase } from '../supabase'
import { logEvent } from './_shared'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


export async function getCalendarEvents(startISO: string, endISO: string): Promise<CalendarEvent[]> {
  const { data, error } = await supabase.from('calendar_events')
    .select('id, org_id, title, event_type, starts_at, permit_number, inspection_status')
    .gte('starts_at', startISO)
    .lt('starts_at', endISO)
    .order('starts_at')
  if (error) return []
  return (data as CalendarEvent[]) ?? []
}

// REP-1: события календаря ОДНОГО проекта (calendar_events.project_id существует) — секция
// «События проекта» на вкладке «Обзор» хаба. Узкий select + фильтр по project_id; org-wide
// /calendar и getCalendarEvents не трогаем. error → [] (мягкая деградация). Порядок по дате.
export async function getProjectCalendarEvents(projectId: string): Promise<CalendarEvent[]> {
  const { data, error } = await supabase.from('calendar_events')
    .select('id, org_id, title, event_type, starts_at, ends_at, location, project_id, permit_number, inspection_status, notes')
    .eq('project_id', projectId)
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
