import { supabase } from '../supabase'
import { notifyMessagePush } from '../push'
import { logEvent } from './_shared'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


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
