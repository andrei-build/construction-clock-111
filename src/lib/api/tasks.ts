import { supabase } from '../supabase'
import { notifyMessagePush } from '../push'
import { logEvent, warnReadError } from './_shared'
import { inferMediaType, TASK_MEDIA_BUCKET, safeFileName, inferUploadContentType, validateUpload, taskWantsClientReport } from './storage'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


export const TASK_SELECT = 'id, org_id, project_id, task_type, title, description, status, priority, assigned_to, urgent_flag, requires_photo, done_at, created_at, picked_up_at, picked_up_by, delivered_at, delivered_by'

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
  // CLIENT-MEDIA-1: jsonb-мешок задачи. Форма «Назначить задачу» кладёт сюда { client_report: true }
  // при отметке «Отчёт для клиента»; прочие ключи БД заполняет server-side default ({}).
  metadata?: Record<string, unknown>
}

// Создать задачу. org_id=p.org_id + created_by=p.id удовлетворяют RLS check tasks_insert
// (org_id совпадает и app.is_manager_write()). Не-менеджеру insert отклонит RLS — гейтим в UI.
// Пишем только те колонки, что задаёт форма; остальное берёт server-side defaults
// (status='open', metadata, version, created_at и т.д.). Зеркалит форму задач старого Check Time.
export async function createTask(p: Profile, input: NewTaskInput, clientId?: string): Promise<string> {
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
  // CLIENT-MEDIA-1: задаём metadata только когда форма что-то в него положила (client_report),
  // иначе оставляем server-side default ({}) — не затираем чужие будущие ключи пустым объектом.
  if (input.metadata && Object.keys(input.metadata).length > 0) row.metadata = input.metadata
  // Offline replay: carry the queued clientId as the partial-unique client_id so a duplicate
  // replay raises 23505 (treated as success) instead of inserting a second row. Online callers
  // pass nothing → client_id stays absent (NULL, ignored by the partial unique index).
  if (clientId) row.client_id = clientId
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
  // CLIENT-MEDIA-1: фото И видео улики задачи «Отчёт для клиента» → сразу видно клиенту
  // (владелец потом может скрыть вручную). Файлы-документы не палим. Флаг читаем из БД по task.id,
  // т.к. вызывающий Task metadata может не нести.
  const clientVisible = (mediaType === 'photo' || mediaType === 'video') && await taskWantsClientReport(task.id)
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
    client_visible: clientVisible,
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
  if (error) { warnReadError('getTaskAttachments', error); return [] }
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

export async function markTaskDone(p: Profile, task: Task, mediaId: string | null = null) {
  if (task.task_type === 'material' || task.task_type === 'delivery') {
    throw new Error('material_status_rpc_required')
  }
  await supabase.from('tasks').update({ status: 'done', done_at: new Date().toISOString(), done_by: p.id }).eq('id', task.id)
  await logEvent(p, 'task.completed', 'task', task.id, { title: task.title, media_id: mediaId })
}

// CC-2 «Командный центр» → виджет «Статус раздачи задач»: МОИ раздачи (created_by = я) с
// операционным следом — кто ПРОЧИТАЛ (metadata.read_by), кто ВЗЯЛ (picked_up_by/in_progress),
// кто ЗАКРЫЛ (done_by/done_at). Отдельный select с created_by + picked_up_*: узкие select'ы
// (getOpenTasks/getAllTasks) этих колонок не тянут. RLS tasks_select держит org-скоуп и
// прячет deleted_at. Свежие сверху.
const DISPATCH_TASK_SELECT = 'id, org_id, project_id, task_type, title, description, status, priority, assigned_to, urgent_flag, requires_photo, due_date, done_at, done_by, created_at, created_by, metadata, picked_up_at, picked_up_by, delivered_at, delivered_by'
export async function getTasksCreatedBy(profileId: string): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks')
    .select(DISPATCH_TASK_SELECT)
    .eq('created_by', profileId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data as Task[]) ?? []
}

export async function getArchivedTasks(): Promise<ArchivedTask[]> {
  const { data, error } = await supabase.from('tasks')
    .select('id, title, project_id, status, deleted_at, project:projects(name)')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
  if (error) return []
  return (data as unknown as ArchivedTask[]) ?? []
}
