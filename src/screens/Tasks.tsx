import { Fragment, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getAllTasks, getProjects, getTeam, createTask, createMaterialRequest,
  updateTaskStatus, softDeleteTask, markTaskRead,
  uploadTaskAttachment, getTaskAttachments, mediaUrl,
  validateUpload, uploadErrorCode, getDeliveryProgress,
} from '../lib/api'
import { isManagerRole, isManagerWrite } from '../lib/types'
import type { Profile, Project, Task, TaskAttachment } from '../lib/types'
import VoiceMic from '../components/VoiceMic'
import { useImageLightbox, type LightboxImage } from '../components/ImageLightbox'
import DeliveryInvoice from '../components/DeliveryInvoice'

// DELIVERY-2: доставка = задача task_type 'delivery' | 'material' (накладная с позициями).
// «Задачи» и «Доставки» — РАЗНЫЕ вкладки (закон Андрея): Задачи = work; Доставки = delivery+material.
const isDeliveryTask = (task: Task) => task.task_type === 'delivery' || task.task_type === 'material'

// Глобальный экран «Задачи» — паритет с «Доской задач организации» Check Time (TASKS-2):
// создание с голосовым вводом + вложения, дропдаун статуса, доказательства выполнения,
// отметка «Прочитано», фильтры, полноширинная таблица (десктоп) / карточки (мобайл).

const TASK_TYPES: Task['task_type'][] = ['work', 'material', 'delivery']
// Дропдаун статуса карточки: ожидает/в работе/готово (паритет Check Time).
const STATUS_OPTIONS: Task['status'][] = ['open', 'in_progress', 'done']
const FILTER_STATUSES: Task['status'][] = ['open', 'in_progress', 'done', 'cancelled']
const TASK_PRIORITIES: Task['priority'][] = ['low', 'medium', 'high', 'urgent']

// Ранг приоритета для сортировки: срочный → низкий. Зеркалит порядок enum task_priority.
const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 }

type Attachment = TaskAttachment & { url?: string }

function typeIcon(type: Task['task_type']) {
  if (type === 'delivery') return '🚚'
  if (type === 'material') return '📦'
  return '🔨'
}

function priorityTone(priority: Task['priority']) {
  return priority === 'urgent' ? 'red' : priority === 'high' ? 'amber' : priority === 'medium' ? 'blue' : 'grey'
}

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}

function readByEntries(task: Task): Array<{ id: string; ts: string }> {
  const meta = (task.metadata ?? {}) as Record<string, unknown>
  const readBy = (meta.read_by as Record<string, string> | undefined) ?? {}
  return Object.entries(readBy).map(([id, ts]) => ({ id, ts }))
}

interface FilterState {
  project: string
  type: string
  status: string
  assignee: string
  hideDone: boolean
}

const EMPTY_FILTERS: FilterState = { project: 'all', type: 'all', status: 'all', assignee: 'all', hideDone: false }

export default function Tasks() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  // LIGHTBOX-1: фото задач открываем В ПРИЛОЖЕНИИ через общий лайтбокс, не в отдельной вкладке.
  const lb = useImageLightbox()
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  // DELIVERY-2: верхний переключатель «Задачи / Доставки» — два разных списка.
  const [view, setView] = useState<'tasks' | 'deliveries'>('tasks')
  // Прогресс позиций доставок «N/M» по task_id (delivered/total). Живёт для delivery/material задач.
  const [progress, setProgress] = useState<Record<string, { total: number; delivered: number }>>({})
  // Открытая накладная (модал позиций) — null, когда закрыта.
  const [invoiceTask, setInvoiceTask] = useState<Task | null>(null)

  // Форма создания (только менеджер — RLS tasks_insert требует is_manager_write).
  const canCreate = profile ? isManagerWrite(profile.role) : false
  const isManager = profile ? isManagerRole(profile.role) : false
  // «+ материал» доступен всем ролям, кроме клиента (RLS tasks_insert: material + role<>client).
  const canRequestMaterial = profile ? profile.role !== 'client' : false

  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState(false)
  const [fProject, setFProject] = useState('') // '' → «Общая задача» (без проекта)
  const [fTitle, setFTitle] = useState('')
  const [fType, setFType] = useState<Task['task_type']>('work')
  const [fPriority, setFPriority] = useState<Task['priority']>('medium')
  const [fAssignee, setFAssignee] = useState('')
  const [fDue, setFDue] = useState('')
  const [fDescription, setFDescription] = useState('')
  const [fRequiresPhoto, setFRequiresPhoto] = useState(false)
  const [fFiles, setFFiles] = useState<File[]>([])

  // Быстрая заявка на материал (упрощённый вариант для работника/водителя: позиция, кол-во, проект).
  const [matOpen, setMatOpen] = useState(false)
  const [matProject, setMatProject] = useState('')
  const [matName, setMatName] = useState('')
  const [matQty, setMatQty] = useState('')
  const [matBusy, setMatBusy] = useState(false)
  const [matError, setMatError] = useState(false)
  const [matNotice, setMatNotice] = useState(false)

  // Разворот карточки + подгруженные вложения.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({})
  const [attachBusy, setAttachBusy] = useState<string | null>(null)
  const [statusBusy, setStatusBusy] = useState<string | null>(null)
  const [cardError, setCardError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [taskRows, projectRows, teamRows] = await Promise.all([getAllTasks(), getProjects(), getTeam()])
      setTasks(taskRows)
      setProjects(projectRows)
      setTeam(teamRows)
      // Прогресс позиций только для доставок/материалов (у остальных задач позиций нет).
      const deliveryIds = taskRows.filter(isDeliveryTask).map((tk) => tk.id)
      try { setProgress(await getDeliveryProgress(deliveryIds)) } catch { /* карточка деградирует без прогресса */ }
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  // Живой прогресс из открытой накладной — обновляем плитку «N/M» без перезагрузки.
  const handleProgressChange = (taskId: string, p: { total: number; delivered: number }) => {
    setProgress((cur) => ({ ...cur, [taskId]: p }))
  }

  const progressBadge = (task: Task) => {
    if (!isDeliveryTask(task)) return null
    const p = progress[task.id]
    if (!p || p.total === 0) return null
    return <span className="badge blue" style={{ marginLeft: 6 }}>{p.delivered}/{p.total} {t('delivery_positions')}</span>
  }

  // Явный бейдж-заголовок «🚚 ДОСТАВКА» для задач-накладных (delivery/material) — их отличие
  // от обычных задач видно сразу в списке (закон Андрея: доставки — отдельная вещь).
  const deliveryBadge = (task: Task) =>
    isDeliveryTask(task) ? <span className="badge delivery-badge" style={{ marginLeft: 6 }}>🚚 {t('delivery_badge')}</span> : null

  const invoiceButton = (task: Task) =>
    isDeliveryTask(task) ? (
      <button className="btn ghost small delivery-open-btn" onClick={(e) => { e.stopPropagation(); setInvoiceTask(task) }}>
        🚚 {t('delivery_open')}
      </button>
    ) : null

  useEffect(() => { load() }, [profile?.id])

  const projectName = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projects) map.set(p.id, p.name)
    return map
  }, [projects])

  const personName = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of team) map.set(p.id, p.name)
    return map
  }, [team])

  // Роль-гейт (паритет со списками поля): менеджер/супервайзер видят все задачи,
  // работник — только назначенные ему. RLS уже держит org-скоуп и прячет чужие орг-данные.
  const visibleTasks = useMemo(() => {
    // DELIVERY-2: базовое расщепление по вкладке — Задачи=work, Доставки=delivery+material.
    const byView = tasks.filter((task) => (view === 'deliveries' ? isDeliveryTask(task) : task.task_type === 'work'))
    if (isManager) return byView
    if (!profile) return []
    return byView.filter((task) => task.assigned_to === profile.id)
  }, [tasks, isManager, profile, view])

  // Счётчики для табов — сколько задач/доставок доступно роли (без учёта прочих фильтров).
  const viewCounts = useMemo(() => {
    const base = isManager ? tasks : (profile ? tasks.filter((tk) => tk.assigned_to === profile.id) : [])
    return {
      tasks: base.filter((tk) => tk.task_type === 'work').length,
      deliveries: base.filter(isDeliveryTask).length,
    }
  }, [tasks, isManager, profile])

  const filtered = useMemo(() => {
    const rows = visibleTasks.filter((task) => {
      if (filters.hideDone && (task.status === 'done' || task.status === 'cancelled')) return false
      if (filters.project !== 'all') {
        if (filters.project === 'none' ? task.project_id !== null : task.project_id !== filters.project) return false
      }
      if (filters.type !== 'all' && task.task_type !== filters.type) return false
      if (filters.status !== 'all' && task.status !== filters.status) return false
      if (filters.assignee !== 'all') {
        if (filters.assignee === 'unassigned' ? task.assigned_to !== null : task.assigned_to !== filters.assignee) return false
      }
      return true
    })
    // Сортировка: приоритет (срочный→низкий), затем срок (ближайший первым, без срока — в конец).
    return rows.slice().sort((a, b) => {
      const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      if (pr !== 0) return pr
      const da = a.due_date ?? ''
      const db = b.due_date ?? ''
      if (da && db) return da < db ? -1 : da > db ? 1 : 0
      if (da) return -1
      if (db) return 1
      return 0
    })
  }, [visibleTasks, filters])

  const resetCreateForm = () => {
    setFProject(''); setFTitle(''); setFType('work'); setFPriority('medium')
    setFAssignee(''); setFDue(''); setFDescription(''); setFRequiresPhoto(false); setFFiles([])
    setAdding(false); setCreateError(false)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !fTitle.trim()) return
    setBusy(true)
    setCreateError(false)
    try {
      const taskId = await createTask(profile, {
        project_id: fProject || null,
        title: fTitle.trim(),
        task_type: fType,
        priority: fPriority,
        assigned_to: fAssignee || null,
        due_date: fDue || null,
        description: fDescription,
        requires_photo: fRequiresPhoto,
      })
      // Вложения на этапе создания: грузим к только что созданной задаче.
      for (const file of fFiles) {
        try {
          await uploadTaskAttachment(profile, { id: taskId, project_id: fProject || null } as Task, file)
        } catch { /* одно вложение не должно ронять всё создание */ }
      }
      resetCreateForm()
      await load()
    } catch {
      setCreateError(true)
    } finally {
      setBusy(false)
    }
  }

  const submitMaterial = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !matName.trim() || !matProject) return
    setMatBusy(true)
    setMatError(false)
    setMatNotice(false)
    try {
      const qty = matQty.trim()
      await createMaterialRequest(profile, {
        projectId: matProject,
        title: matName.trim(),
        description: qty ? `${t('mat_qty')}: ${qty}` : null,
      })
      setMatName(''); setMatQty(''); setMatProject(''); setMatOpen(false)
      setMatNotice(true)
      await load()
    } catch {
      setMatError(true)
    } finally {
      setMatBusy(false)
    }
  }

  const addFilesToCreate = (files: FileList | null) => {
    if (!files) return
    setFFiles((cur) => [...cur, ...Array.from(files)])
  }

  const loadAttachments = async (taskId: string): Promise<Attachment[]> => {
    try {
      const rows = await getTaskAttachments(taskId)
      const withUrls = await Promise.all(rows.map(async (r) => {
        try { return { ...r, url: (await mediaUrl(r.storage_path)) ?? undefined } } catch { return { ...r } }
      }))
      setAttachments((cur) => ({ ...cur, [taskId]: withUrls }))
      return withUrls
    } catch {
      setAttachments((cur) => ({ ...cur, [taskId]: [] }))
      return []
    }
  }

  const toggleExpand = async (task: Task) => {
    const next = expandedId === task.id ? null : task.id
    setExpandedId(next)
    setCardError(null)
    if (next) {
      if (!attachments[task.id]) await loadAttachments(task.id)
      // Отметка «Прочитано»: если открывает назначенный исполнитель и ещё не отмечено.
      if (profile && task.assigned_to === profile.id) {
        const already = readByEntries(task).some((e) => e.id === profile.id)
        if (!already) {
          try {
            await markTaskRead(profile, task.id)
            const ts = new Date().toISOString()
            setTasks((rows) => rows.map((r) => {
              if (r.id !== task.id) return r
              const meta = (r.metadata ?? {}) as Record<string, unknown>
              const readBy = { ...((meta.read_by as Record<string, string> | undefined) ?? {}), [profile.id]: ts }
              return { ...r, metadata: { ...meta, read_by: readBy } }
            }))
          } catch { /* best-effort */ }
        }
      }
    }
  }

  const changeStatus = async (task: Task, status: Task['status']) => {
    if (!profile || status === task.status) return
    // Закон Андрея: фото нужно для закрытия задачи ТОЛЬКО когда requires_photo === true.
    // При requires_photo=false путь остаётся прежним (никаких предупреждений).
    if (status === 'done' && task.requires_photo) {
      const list = attachments[task.id] ?? await loadAttachments(task.id)
      if (!list.some((a) => a.media_type === 'photo')) {
        setCardError('task_done_needs_photo')
        return
      }
    }
    setStatusBusy(task.id)
    setCardError(null)
    try {
      await updateTaskStatus(profile, task, status)
      const done = status === 'done'
      const ts = new Date().toISOString()
      setTasks((rows) => rows.map((r) => r.id === task.id
        ? { ...r, status, done_at: done ? ts : null, done_by: done ? profile.id : null }
        : r))
    } catch {
      setCardError('tasks_status_error')
    } finally {
      setStatusBusy(null)
    }
  }

  const attach = async (task: Task, file: File | undefined) => {
    if (!profile || !file || attachBusy) return
    try {
      validateUpload(file, 'file')
    } catch (err) {
      setCardError(uploadErrorCode(err) ?? 'tasks_attach_error')
      return
    }
    setAttachBusy(task.id)
    setCardError(null)
    try {
      const row = await uploadTaskAttachment(profile, task, file)
      const url = (await mediaUrl(row.storage_path).catch(() => undefined)) ?? undefined
      setAttachments((cur) => ({ ...cur, [task.id]: [{ ...row, url }, ...(cur[task.id] ?? [])] }))
    } catch (err) {
      setCardError(uploadErrorCode(err) ?? 'tasks_attach_error')
    } finally {
      setAttachBusy(null)
    }
  }

  const removeTask = async (task: Task) => {
    if (!profile) return
    setStatusBusy(task.id)
    setCardError(null)
    try {
      await softDeleteTask(profile, task.id)
      setTasks((rows) => rows.filter((r) => r.id !== task.id))
      setConfirmDeleteId(null)
      setExpandedId(null)
    } catch {
      setCardError('tasks_delete_error')
    } finally {
      setStatusBusy(null)
    }
  }

  const filtersActive = filters.project !== 'all' || filters.type !== 'all' || filters.status !== 'all'
    || filters.assignee !== 'all' || filters.hideDone

  // Детали карточки (вложения + доказательства + прочитано + удаление) — общий блок для
  // развёрнутой строки таблицы (десктоп) и карточки (мобайл).
  const renderDetail = (task: Task) => {
    const list = attachments[task.id] ?? []
    const photos = list.filter((a) => a.media_type === 'photo')
    const files = list.filter((a) => a.media_type !== 'photo')
    const uploading = attachBusy === task.id
    const readers = readByEntries(task)
    return (
      <div className="task-detail">
        <div className="task-attach-buttons">
          <input id={`att-gal-${task.id}`} className="photo-input" type="file" accept="image/*" disabled={uploading}
            onChange={(e) => { attach(task, e.target.files?.[0]); e.currentTarget.value = '' }} />
          <label className="btn ghost small" htmlFor={`att-gal-${task.id}`}>🖼️ {t('tasks_gallery')}</label>

          <input id={`att-cam-${task.id}`} className="photo-input" type="file" accept="image/*" capture="environment" disabled={uploading}
            onChange={(e) => { attach(task, e.target.files?.[0]); e.currentTarget.value = '' }} />
          <label className="btn ghost small" htmlFor={`att-cam-${task.id}`}>📷 {t('tasks_camera')}</label>

          <input id={`att-file-${task.id}`} className="photo-input" type="file" disabled={uploading}
            onChange={(e) => { attach(task, e.target.files?.[0]); e.currentTarget.value = '' }} />
          <label className="btn ghost small" htmlFor={`att-file-${task.id}`}>📎 {t('tasks_files')}</label>
          {uploading && <span className="muted">{t('photo_uploading')}</span>}
        </div>

        {photos.length > 0 && (
          <div className="task-attach-thumbs">
            {photos.map((a) => (
              <button
                key={a.id}
                type="button"
                className="task-attach-thumb-btn"
                onClick={() => {
                  const withUrl = photos.filter((p) => p.url)
                  const idx = Math.max(0, withUrl.findIndex((p) => p.id === a.id))
                  lb.open(withUrl.map<LightboxImage>((p) => ({ id: p.id, name: p.filename ?? null, resolve: () => Promise.resolve(p.url as string) })), idx)
                }}
              >
                <img className="task-attach-thumb" src={a.url} alt={a.filename ?? ''} />
              </button>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <ul className="task-attach-files">
            {files.map((a) => (
              <li key={a.id}>📎 <a href={a.url} target="_blank" rel="noreferrer">{a.filename ?? a.storage_path.split('/').pop()}</a></li>
            ))}
          </ul>
        )}

        {(task.status === 'done' || task.requires_photo) && (
          <div className="task-proof">
            <strong>{t('tasks_proof_title')}</strong>
            {task.status === 'done' ? (
              <p className="muted">
                {t('tasks_proof_by')}: {task.done_by ? (personName.get(task.done_by) ?? '—') : '—'}
                {task.done_at ? ` · ${fmtWhen(task.done_at)}` : ''}
              </p>
            ) : (
              <p className="muted">{t('tasks_proof_hint')}</p>
            )}
            {task.requires_photo && photos.length === 0 && (
              <p className="warn-msg">{t('tasks_proof_photo_needed')}</p>
            )}
          </div>
        )}

        <div className="task-readreceipt muted">
          {readers.length === 0 ? (
            <span>{t('tasks_read_none')}</span>
          ) : (
            <span>{t('tasks_read_by')}: {readers.map((r) => `${personName.get(r.id) ?? '—'} (${fmtWhen(r.ts)})`).join(', ')}</span>
          )}
        </div>

        {isManagerWrite(profile?.role ?? 'worker') && (
          confirmDeleteId === task.id ? (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn red small" disabled={statusBusy === task.id} onClick={() => removeTask(task)}>{t('remove')}</button>
              <button className="btn ghost small" onClick={() => setConfirmDeleteId(null)}>{t('cancel')}</button>
            </div>
          ) : (
            <button className="btn ghost small task-delete-btn" onClick={() => setConfirmDeleteId(task.id)}>🗑 {t('tasks_delete')}</button>
          )
        )}
      </div>
    )
  }

  const statusSelect = (task: Task) => (
    <select
      className="task-status-select"
      value={STATUS_OPTIONS.includes(task.status) ? task.status : 'open'}
      disabled={statusBusy === task.id}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => changeStatus(task, e.target.value as Task['status'])}
    >
      {STATUS_OPTIONS.map((st) => <option key={st} value={st}>{t(`task_status_${st}`)}</option>)}
    </select>
  )

  return (
    <div className="screen tasks-screen">
      {lb.node}
      <h1>✅ {t('tasks_all_title')}</h1>

      {/* DELIVERY-2: переключатель «Задачи / Доставки» — два разных списка (закон Андрея). */}
      <div className="task-view-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === 'tasks'}
          className={`btn small ${view === 'tasks' ? '' : 'ghost'}`}
          onClick={() => { setView('tasks'); setFilters((f) => ({ ...f, type: 'all' })) }}
        >
          🔨 {t('tasks_tab_tasks')} ({viewCounts.tasks})
        </button>
        <button
          role="tab"
          aria-selected={view === 'deliveries'}
          className={`btn small ${view === 'deliveries' ? '' : 'ghost'}`}
          onClick={() => { setView('deliveries'); setFilters((f) => ({ ...f, type: 'all' })) }}
        >
          🚚 {t('tasks_tab_deliveries')} ({viewCounts.deliveries})
        </button>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {canCreate && !adding && (
          <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('tasks_new')}</button>
        )}
        {canRequestMaterial && !matOpen && (
          <button className="btn ghost small" onClick={() => setMatOpen(true)}>+ {t('tasks_material')}</button>
        )}
      </div>

      {matNotice && <p className="warn-msg">{t('material_request_created')}</p>}

      {canRequestMaterial && matOpen && (
        <form onSubmit={submitMaterial} className="card">
          <h2 style={{ marginTop: 0 }}>{t('tasks_material')}</h2>
          <label>{t('col_project')}</label>
          <select value={matProject} onChange={(e) => setMatProject(e.target.value)}>
            <option value="">{t('task_select_project')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label>{t('mat_name')}</label>
          <div className="row" style={{ gap: 8 }}>
            <input value={matName} onChange={(e) => setMatName(e.target.value)} placeholder={t('material_request_item_placeholder')} />
            <VoiceMic lang={lang} title={t('tasks_voice_hint')} onResult={(text) => setMatName((v) => v ? `${v} ${text}` : text)} />
          </div>
          <label>{t('mat_qty')}</label>
          <input value={matQty} onChange={(e) => setMatQty(e.target.value)} />
          {matError && <p className="error-msg">{t('material_request_save_failed')}</p>}
          <div className="row">
            <button className="btn" disabled={matBusy || !matName.trim() || !matProject}>{matBusy ? t('saving') : t('material_request_create')}</button>
            <button type="button" className="btn ghost small" disabled={matBusy} onClick={() => { setMatOpen(false); setMatError(false) }}>{t('cancel')}</button>
          </div>
        </form>
      )}

      {canCreate && adding && (
        <form onSubmit={submit} className="card">
          <label>{t('col_project')}</label>
          <select value={fProject} onChange={(e) => setFProject(e.target.value)}>
            <option value="">{t('tasks_general')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <label>{t('task_title_label')}</label>
          <div className="row" style={{ gap: 8 }}>
            <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} />
            <VoiceMic lang={lang} title={t('tasks_voice_hint')} onResult={(text) => setFTitle((v) => v ? `${v} ${text}` : text)} />
          </div>

          <div className="row coord-row">
            <div className="coord-field">
              <label>{t('col_type')}</label>
              <select value={fType} onChange={(e) => setFType(e.target.value as Task['task_type'])}>
                {TASK_TYPES.map((tp) => <option key={tp} value={tp}>{t(`task_type_${tp}`)}</option>)}
              </select>
            </div>
            <div className="coord-field">
              <label>{t('col_priority')}</label>
              <select value={fPriority} onChange={(e) => setFPriority(e.target.value as Task['priority'])}>
                {TASK_PRIORITIES.map((pr) => <option key={pr} value={pr}>{t(`task_priority_${pr}`)}</option>)}
              </select>
            </div>
          </div>

          <div className="row coord-row">
            <div className="coord-field">
              <label>{t('col_assignee')}</label>
              <select value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}>
                <option value="">{t('task_unassigned')}</option>
                {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div className="coord-field">
              <label>{t('col_due')}</label>
              <input type="date" value={fDue} onChange={(e) => setFDue(e.target.value)} />
            </div>
          </div>

          <label>{t('task_description_label')}</label>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <textarea value={fDescription} onChange={(e) => setFDescription(e.target.value)} rows={2} style={{ flex: 1 }} />
            <VoiceMic lang={lang} title={t('tasks_voice_hint')} onResult={(text) => setFDescription((v) => v ? `${v} ${text}` : text)} />
          </div>

          <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input type="checkbox" checked={fRequiresPhoto} onChange={(e) => setFRequiresPhoto(e.target.checked)} />
            <span>{t('task_requires_photo')}</span>
          </label>

          <label style={{ marginTop: 8 }}>{t('tasks_attachments')}</label>
          <input type="file" multiple onChange={(e) => { addFilesToCreate(e.target.files); e.currentTarget.value = '' }} />
          {fFiles.length > 0 && (
            <ul className="task-attach-files">
              {fFiles.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  📎 {f.name}{' '}
                  <button type="button" className="linklike" onClick={() => setFFiles((cur) => cur.filter((_, j) => j !== i))}>✕</button>
                </li>
              ))}
            </ul>
          )}

          {createError && <p className="error-msg">{t('tasks_create_error')}</p>}
          <p className="muted" style={{ marginTop: 4 }}>{t('tasks_create_hint')}</p>
          <div className="row">
            <button className="btn" disabled={busy || !fTitle.trim()}>{busy ? t('saving') : t('create')}</button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={resetCreateForm}>{t('cancel')}</button>
          </div>
        </form>
      )}

      <div className="card reports-filter">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{t('tasks_filters')}</strong>
          {filtersActive && (
            <button className="btn ghost small" onClick={() => setFilters(EMPTY_FILTERS)}>{t('tasks_reset_filters')}</button>
          )}
        </div>
        <div className="grid2">
          <div>
            <label>{t('col_project')}</label>
            <select value={filters.project} onChange={(e) => setFilters((f) => ({ ...f, project: e.target.value }))}>
              <option value="all">{t('filter_all')}</option>
              <option value="none">{t('tasks_general')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {view === 'deliveries' && (
            <div>
              <label>{t('col_type')}</label>
              <select value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
                <option value="all">{t('filter_all')}</option>
                {(['delivery', 'material'] as Task['task_type'][]).map((tp) => <option key={tp} value={tp}>{t(`task_type_${tp}`)}</option>)}
              </select>
            </div>
          )}
          <div>
            <label>{t('col_status')}</label>
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="all">{t('filter_all')}</option>
              {FILTER_STATUSES.map((st) => <option key={st} value={st}>{t(`task_status_${st}`)}</option>)}
            </select>
          </div>
          <div>
            <label>{t('col_assignee')}</label>
            <select value={filters.assignee} onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}>
              <option value="all">{t('filter_all')}</option>
              <option value="unassigned">{t('task_unassigned')}</option>
              {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
        <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
          <input type="checkbox" checked={filters.hideDone} onChange={(e) => setFilters((f) => ({ ...f, hideDone: e.target.checked }))} />
          <span>{t('tasks_hide_done')}</span>
        </label>
      </div>

      {cardError && <p className="error-msg">{t(cardError)}</p>}
      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('tasks_load_error')}</p>}
      {!loading && !loadError && visibleTasks.length === 0 && <div className="card muted">{t('no_tasks')}</div>}
      {!loading && !loadError && visibleTasks.length > 0 && filtered.length === 0 && (
        <div className="card muted">{t('tasks_none_match')}</div>
      )}

      {/* Десктоп: полноширинная таблица. Клик по строке разворачивает детали. */}
      {!loading && !loadError && filtered.length > 0 && (
        <div className="card tasks-table-wrap tasks-desktop">
          <table className="tasks-table">
            <thead>
              <tr>
                <th>{t('col_task')}</th>
                <th>{t('col_project')}</th>
                <th>{t('col_type')}</th>
                <th>{t('col_status')}</th>
                <th>{t('col_assignee')}</th>
                <th>{t('col_priority')}</th>
                <th>{t('col_due')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => (
                <Fragment key={task.id}>
                  <tr className="task-row" onClick={() => toggleExpand(task)}>
                    <td>
                      <span className="task-caret">{expandedId === task.id ? '▾' : '▸'}</span>{' '}
                      <span className="task-title">{task.title}</span>
                      {task.requires_photo && <span className="badge amber" style={{ marginLeft: 6 }}>📷</span>}
                      {deliveryBadge(task)}
                      {progressBadge(task)}
                      {isDeliveryTask(task) && <div style={{ marginTop: 6 }}>{invoiceButton(task)}</div>}
                    </td>
                    <td>{task.project_id ? projectName.get(task.project_id) ?? '—' : t('tasks_general')}</td>
                    <td>{typeIcon(task.task_type)} {t(`task_type_${task.task_type}`)}</td>
                    <td>{statusSelect(task)}</td>
                    <td>{task.assigned_to ? personName.get(task.assigned_to) ?? '—' : t('task_unassigned')}</td>
                    <td><span className={`badge ${priorityTone(task.priority)}`}>{t(`task_priority_${task.priority}`)}</span></td>
                    <td>{task.due_date || t('task_no_due')}</td>
                  </tr>
                  {expandedId === task.id && (
                    <tr className="task-detail-row">
                      <td colSpan={7}>{renderDetail(task)}</td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Мобайл: карточки вместо таблицы. */}
      {!loading && !loadError && filtered.length > 0 && (
        <div className="tasks-cards">
          {filtered.map((task) => (
            <div key={task.id} className="card task-card">
              <div className="row task-card-head" style={{ justifyContent: 'space-between' }}>
                <div>
                  <span className={`badge ${priorityTone(task.priority)}`}>{typeIcon(task.task_type)}</span>{' '}
                  <span className="task-title">{task.title}</span>
                  {task.requires_photo && <span className="badge amber" style={{ marginLeft: 6 }}>📷</span>}
                  {deliveryBadge(task)}
                  {progressBadge(task)}
                </div>
              </div>
              <div className="muted task-card-meta">
                {task.project_id ? projectName.get(task.project_id) ?? '—' : t('tasks_general')}
                {' · '}{task.assigned_to ? personName.get(task.assigned_to) ?? '—' : t('task_unassigned')}
                {task.due_date ? ` · ${task.due_date}` : ''}
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {statusSelect(task)}
                {invoiceButton(task)}
                <button className="btn ghost small" onClick={() => toggleExpand(task)}>
                  {expandedId === task.id ? t('tasks_hide_details') : t('tasks_details')}
                </button>
              </div>
              {expandedId === task.id && renderDetail(task)}
            </div>
          ))}
        </div>
      )}

      {invoiceTask && (
        <DeliveryInvoice
          task={invoiceTask}
          profile={profile}
          team={team}
          onClose={() => setInvoiceTask(null)}
          onProgressChange={handleProgressChange}
        />
      )}
    </div>
  )
}
