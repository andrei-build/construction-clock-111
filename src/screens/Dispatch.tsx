import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getProjects,
  getTeam,
  getAllTasks,
  getTasksCreatedBy,
  getMessages,
  sendTeamMessage,
  markMessageRead,
  createTask,
  updateTaskStatus,
  softDeleteTask,
  uploadTaskAttachment,
  getTaskAttachments,
  mediaUrl,
  validateUpload,
  uploadErrorCode,
  getSuspiciousShifts,
  approveShiftReview,
  getLiveLastLocations,
  getTodayEvents,
  subscribeToTaskChanges,
  subscribeToMyMessages,
  subscribeToLiveLocations,
  subscribeToOrgEvents,
  getDeliveryProgress,
} from '../lib/api'
import { useLiveRefresh } from '../lib/useLiveRefresh'
import { shiftState, workedMs, fmtHours, fmtClock } from '../lib/time'
import { isManagerWrite } from '../lib/types'
import type {
  LiveLastLocation,
  MessageRow,
  Profile,
  Project,
  SuspiciousShift,
  Task,
  TaskAttachment,
  TimeEvent,
} from '../lib/types'
import VoiceMic from '../components/VoiceMic'
import DeliveryInvoice from '../components/DeliveryInvoice'
import { useEntityDrawer } from '../components/EntityDrawer'

// DELIVERY-2: доставка = задача task_type 'delivery' | 'material' (накладная с позициями).
const isDeliveryTask = (task: Task) => task.task_type === 'delivery' || task.task_type === 'material'
// NAV-5: план дня (конструктор бригад/задач + рассылка плана) переехал сюда из убитой «Главной».
// Самодостаточный блок (свой загрузчик, свой manager-гейт), рендерится как обычная секция ЦК.
import PlanConstructor from './dashboard/PlanConstructor'

// «Командный центр» (CC-2) — единый пульт управления командой (бывшая «Диспетчерская»).
// НИКАКИХ финансовых чисел здесь нет by design: экран операционный, поэтому финансовый гейт
// (hasFinanceAccess) удовлетворён тривиально — и финансовая, и не-финансовая роль видят одно и
// то же (нет $-утечки). Маршрут /dispatch гейтит менеджером в App.tsx.

type Attachment = TaskAttachment & { url?: string }

const CREW_ROLES = ['worker', 'driver', 'supervisor']
const PRIORITY_OPTIONS: MessageRow['priority'][] = ['urgent', 'info', 'good', 'task']
const STATUS_OPTIONS: Task['status'][] = ['open', 'in_progress', 'done']
const FILTER_STATUSES: Task['status'][] = ['open', 'in_progress', 'done', 'cancelled']
const TASK_PRIORITIES: Task['priority'][] = ['low', 'medium', 'high', 'urgent']
const GPS_STALE_MINUTES = 15

function template(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

function priorityTone(priority: Task['priority']) {
  return priority === 'urgent' ? 'red' : priority === 'high' ? 'amber' : priority === 'medium' ? 'blue' : 'grey'
}

function msgPriorityTone(p: MessageRow['priority']) {
  return p === 'urgent' ? 'red' : p === 'good' ? 'green' : p === 'task' ? 'amber' : 'blue'
}

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

function readByEntries(task: Task): Array<{ id: string; ts: string }> {
  const meta = (task.metadata ?? {}) as Record<string, unknown>
  const readBy = (meta.read_by as Record<string, string> | undefined) ?? {}
  return Object.entries(readBy).map(([id, ts]) => ({ id, ts }))
}

export default function Dispatch() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openWorker } = useEntityDrawer()

  const [projects, setProjects] = useState<Project[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [myTasks, setMyTasks] = useState<Task[]>([])
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [suspicious, setSuspicious] = useState<SuspiciousShift[]>([])
  const [live, setLive] = useState<LiveLastLocation[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const canWrite = profile ? isManagerWrite(profile.role) : false

  // ── loaders (targeted refetchers keep realtime cheap) ──────────────────────
  const loadTasks = async () => {
    if (!profile) return
    const [rows, mine] = await Promise.all([getAllTasks(), getTasksCreatedBy(profile.id)])
    setAllTasks(rows)
    setMyTasks(mine)
  }
  const loadMessages = async () => {
    if (!profile) return
    setMessages(await getMessages(profile.id))
  }
  const loadOps = async () => {
    const [ev, ll] = await Promise.all([getTodayEvents(), getLiveLastLocations()])
    setEvents(ev)
    setLive(ll)
  }

  // LIVE-REFRESH-1: silent=true — фоновый полный рефетч (60с-поллинг/возврат на вкладку) без
  // глобального спиннера, чтобы не мерцать и не рушить открытые карточки/формы доски задач.
  const load = async (silent = false) => {
    if (!profile) return
    if (!silent) setLoading(true)
    setError(false)
    try {
      const [projectRows, people, taskRows, mine, msgs, susp, ev, ll] = await Promise.all([
        getProjects(),
        getTeam(),
        getAllTasks(),
        getTasksCreatedBy(profile.id),
        getMessages(profile.id),
        getSuspiciousShifts(),
        getTodayEvents(),
        getLiveLastLocations(),
      ])
      setProjects(projectRows)
      setTeam(people)
      setAllTasks(taskRows)
      setMyTasks(mine)
      setMessages(msgs)
      setSuspicious(susp)
      setEvents(ev)
      setLive(ll)
    } catch {
      setError(true)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])

  // Live clock + periodic ops refresh (смены меняются через time_events, не через realtime).
  useEffect(() => {
    const i = setInterval(() => { setNow(Date.now()); loadOps().catch(() => {}) }, 30000)
    return () => clearInterval(i)
  }, [])

  // Realtime: задачи (раздача + доска), мои сообщения (входящие), live-точки (операции сейчас).
  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => { loadTasks().catch(() => {}) }, 'tasks:cc')
  }, [profile?.org_id])
  useEffect(() => {
    if (!profile?.id) return
    return subscribeToMyMessages(profile.id, () => { loadMessages().catch(() => {}) }, `messages:cc:${profile.id}`)
  }, [profile?.id])
  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToLiveLocations(profile.org_id, () => { loadOps().catch(() => {}) }, 'live:cc')
  }, [profile?.org_id])
  // LIVE-REFRESH-1: журнал событий (0027) — новые действия (ревью смен, раздачи, вложения) держат
  // очередь внимания владельца и «операции сейчас» свежими. Точечный рефетч, без спиннера.
  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToOrgEvents(profile.org_id, () => {
      getSuspiciousShifts().then(setSuspicious).catch(() => {})
      loadOps().catch(() => {})
    }, 'events:cc')
  }, [profile?.org_id])

  // LIVE-REFRESH-1: дашборд КЦ — мягкий 60с-поллинг (только пока вкладка видима) + рефетч на
  // возврат/фокус. Фоновый full refetch (silent) без спиннера поверх точечных realtime-подписок.
  useLiveRefresh(() => { void load(true) }, 60000)

  const peopleById = useMemo(() => new Map(team.map((p) => [p.id, p])), [team])
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const crew = useMemo(
    () => team.filter((p) => p.id !== profile?.id && CREW_ROLES.includes(p.role)),
    [team, profile?.id],
  )

  const relAge = (iso: string) => {
    const min = Math.floor((now - new Date(iso).getTime()) / 60000)
    if (!Number.isFinite(min) || min < 1) return t('cc_just_now')
    if (min < 60) return template(t('cc_min_ago'), { n: min })
    const hrs = Math.floor(min / 60)
    if (hrs < 24) return template(t('cc_hours_ago'), { n: hrs })
    return template(t('cc_days_ago'), { n: Math.floor(hrs / 24) })
  }

  return (
    <div className="screen dispatch-screen cc-screen">
      <h1>🧭 {t('command_center')}</h1>
      <p className="muted">{t('cc_subtitle')}</p>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && (
        <>
          <TeamMessageWidget
            crew={crew}
            messages={messages}
            peopleById={peopleById}
            canWrite={canWrite}
            onSent={loadMessages}
            relAge={relAge}
          />

          <KpiRow tasks={allTasks} projects={projects} onCreate={() => {
            const el = document.getElementById('cc-assign-task')
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }} />

          <DispatchStatus tasks={myTasks} peopleById={peopleById} onOpenWorker={openWorker} />

          <OwnerQueue suspicious={suspicious} onReviewed={async () => setSuspicious(await getSuspiciousShifts())} />

          <OpsNow
            team={team}
            events={events}
            live={live}
            tasks={allTasks}
            projectName={projectName}
            now={now}
            onOpenWorker={openWorker}
          />

          {/* NAV-5: «Конструктор плана» (DISP-1) — единственный уникальный живой блок бывшей
              «Главной». Ставим перед доской задач: сперва план дня по проектам, затем раздача задач. */}
          <PlanConstructor />

          <TaskBoard
            projects={projects}
            team={team}
            tasks={allTasks}
            peopleById={peopleById}
            projectName={projectName}
            canWrite={canWrite}
            onChanged={loadTasks}
          />

          <MyMessagesWidget
            messages={messages}
            peopleById={peopleById}
            meId={profile?.id ?? ''}
            onRead={loadMessages}
            relAge={relAge}
          />
        </>
      )}
    </div>
  )
}

// ── (1) Сообщения команде ─────────────────────────────────────────────────────
function TeamMessageWidget({ crew, messages, peopleById, canWrite, onSent, relAge }: {
  crew: Profile[]
  messages: MessageRow[]
  peopleById: Map<string, Profile>
  canWrite: boolean
  onSent: () => Promise<void>
  relAge: (iso: string) => string
}) {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [toAll, setToAll] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [priority, setPriority] = useState<MessageRow['priority']>('info')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentCount, setSentCount] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const toggle = (id: string) => setSelected((cur) => {
    const next = new Set(cur)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const sentFeed = useMemo(() => {
    if (!profile) return []
    return messages
      .filter((m) => m.sender_id === profile.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 8)
  }, [messages, profile])

  const send = async () => {
    if (!profile || busy || !body.trim()) return
    const recipients = toAll ? crew.map((c) => c.id) : Array.from(selected)
    if (recipients.length === 0) { setErr('cc_no_recipients'); return }
    setBusy(true)
    setErr(null)
    setSentCount(null)
    try {
      const n = await sendTeamMessage(profile, recipients, body.trim(), priority)
      setSentCount(n)
      setBody('')
      setSelected(new Set())
      await onSent()
    } catch {
      setErr('cc_send_error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card cc-card">
      <h2>📣 {t('cc_team_message')}</h2>
      {canWrite ? (
        <>
          <label className="check-row" style={{ marginBottom: 6 }}>
            <input type="checkbox" checked={toAll} onChange={(e) => setToAll(e.target.checked)} />
            <span>{template(t('cc_to_all'), { n: crew.length })}</span>
          </label>

          {!toAll && (
            <div className="cc-recipients">
              <div className="muted" style={{ marginBottom: 4 }}>{t('cc_choose_recipients')}</div>
              <div className="dispatch-workers">
                {crew.map((person) => (
                  <label key={person.id} className="check-row">
                    <input type="checkbox" checked={selected.has(person.id)} onChange={() => toggle(person.id)} />
                    <span>{person.name} <span className="muted">· {person.role}</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="row coord-row" style={{ marginTop: 8 }}>
            <div className="coord-field">
              <label>{t('cc_priority')}</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value as MessageRow['priority'])}>
                {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{t(`priority_${p}`)}</option>)}
              </select>
            </div>
          </div>

          <label>{t('cc_team_message')}</label>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder={t('cc_message_placeholder')}
              style={{ flex: 1 }}
            />
            <VoiceMic lang={lang} title={t('tasks_voice_hint')} onResult={(text) => setBody((v) => v ? `${v} ${text}` : text)} />
          </div>

          {err && <p className="error-msg">{t(err)}</p>}
          {sentCount !== null && <p className="ok-msg">{template(t('cc_sent_ok'), { n: sentCount })}</p>}
          <div className="row">
            <button className="btn" disabled={busy || !body.trim()} onClick={send}>
              {busy ? t('saving') : t('cc_send')}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">{t('cc_my_messages_hint')}</p>
      )}

      <h3 style={{ marginBottom: 4 }}>{t('cc_sent_feed')}</h3>
      {sentFeed.length === 0 ? (
        <p className="muted">{t('cc_no_sent')}</p>
      ) : (
        <div className="cc-feed">
          {sentFeed.map((m) => (
            <div key={m.id} className="cc-feed-row">
              <div>
                <span className={`badge ${msgPriorityTone(m.priority)}`}>{t(`priority_${m.priority}`)}</span>{' '}
                <b>{peopleById.get(m.recipient_id)?.name ?? t('unknown_user')}</b>
                <div className="muted cc-feed-body">{m.body}</div>
              </div>
              <div className="cc-feed-meta">
                <span className={`badge ${m.read_at ? 'green' : 'grey'}`}>{m.read_at ? t('cc_read') : t('cc_unread')}</span>
                <span className="muted">{relAge(m.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── (2) KPI задач ──────────────────────────────────────────────────────────────
function KpiRow({ tasks, projects, onCreate }: { tasks: Task[]; projects: Project[]; onCreate: () => void }) {
  const { t } = useI18n()
  const open = tasks.filter((x) => x.status === 'open' || x.status === 'in_progress')
  const urgent = open.filter((x) => x.priority === 'urgent' || x.priority === 'high')
  const unassigned = open.filter((x) => !x.assigned_to)
  const tiles = [
    { label: t('cc_kpi_open'), value: open.length, tone: open.length > 0 ? 'blue' : 'grey' },
    { label: t('cc_kpi_urgent'), value: urgent.length, tone: urgent.length > 0 ? 'amber' : 'grey' },
    { label: t('cc_kpi_unassigned'), value: unassigned.length, tone: unassigned.length > 0 ? 'red' : 'green' },
    { label: t('cc_kpi_active_projects'), value: projects.length, tone: 'blue' },
  ]
  return (
    <section className="card cc-card">
      <div className="dashboard-tiles">
        {tiles.map((tile) => (
          <div key={tile.label} className={`card metric-card ${tile.tone}`}>
            <div className="metric-value">{tile.value}</div>
            <div className="muted">{tile.label}</div>
          </div>
        ))}
      </div>
      <button className="btn ghost small" style={{ marginTop: 8 }} onClick={onCreate}>+ {t('cc_create_task_in_project')}</button>
    </section>
  )
}

// ── (3) Статус раздачи задач ────────────────────────────────────────────────────
function DispatchStatus({ tasks, peopleById, onOpenWorker }: {
  tasks: Task[]
  peopleById: Map<string, Profile>
  onOpenWorker: (p: Profile) => void
}) {
  const { t } = useI18n()
  const name = (id: string | null | undefined) => (id ? peopleById.get(id)?.name ?? t('unknown_user') : null)
  // «Ждут моей реакции»: мои раздачи, закрытые исполнителем (done) — нужен взгляд владельца.
  const awaiting = tasks.filter((x) => x.status === 'done').length
  // Показываем активные раздачи (не закрытые/не отменённые) + недавно закрытые — первые 8.
  const cards = tasks.slice(0, 8)

  return (
    <section className="card cc-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>🛰️ {t('cc_dispatch_status')}</h2>
        <span className={`badge ${awaiting > 0 ? 'amber' : 'grey'}`}>{t('cc_awaiting_reaction')}: {awaiting}</span>
      </div>
      {cards.length === 0 ? (
        <p className="muted">{t('cc_no_dispatched')}</p>
      ) : (
        <div className="cc-dispatch-grid">
          {cards.map((task) => {
            const readers = readByEntries(task)
            const took = task.picked_up_by ?? (task.status === 'in_progress' ? task.assigned_to : null)
            const tookAt = task.picked_up_at
            return (
              <div key={task.id} className="cc-dispatch-card">
                <div className="item-title">{task.title}</div>
                <div className="cc-trail">
                  <div>
                    <span className="muted">{t('cc_read_by')}:</span>{' '}
                    {readers.length === 0 ? <span className="muted">{t('cc_nobody_yet')}</span> : readers.map((r, i) => (
                      <Fragment key={r.id}>
                        {i > 0 && ', '}
                        <button className="inline-link" onClick={() => { const w = peopleById.get(r.id); if (w) onOpenWorker(w) }}>{name(r.id)}</button>
                      </Fragment>
                    ))}
                  </div>
                  <div>
                    <span className="muted">{t('cc_taken_by')}:</span>{' '}
                    {took ? (
                      <>
                        <button className="inline-link" onClick={() => { const w = peopleById.get(took); if (w) onOpenWorker(w) }}>{name(took)}</button>
                        {tookAt ? <span className="muted"> · {fmtWhen(tookAt)}</span> : null}
                      </>
                    ) : <span className="muted">{t('cc_nobody_yet')}</span>}
                  </div>
                  <div>
                    <span className={`badge ${task.status === 'done' ? 'green' : 'grey'}`}>{t('cc_closed_by')}</span>{' '}
                    {task.status === 'done' && task.done_by ? (
                      <>
                        <button className="inline-link" onClick={() => { const w = peopleById.get(task.done_by!); if (w) onOpenWorker(w) }}>{name(task.done_by)}</button>
                        {task.done_at ? <span className="muted"> · {fmtWhen(task.done_at)}</span> : null}
                      </>
                    ) : <span className="muted">{t('cc_nobody_yet')}</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ── (4) Очередь внимания владельца ──────────────────────────────────────────────
function OwnerQueue({ suspicious, onReviewed }: { suspicious: SuspiciousShift[]; onReviewed: () => Promise<void> }) {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const pending = suspicious.filter((s) => s.review_status !== 'approved')
  const shown = showAll ? suspicious : suspicious.slice(0, 3)

  const approve = async (s: SuspiciousShift) => {
    if (!profile || busy) return
    setBusy(s.checkout_event_id)
    try {
      await approveShiftReview(profile, s.checkout_event_id)
      await onReviewed()
    } catch { /* поллинг догонит */ } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card cc-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>⚠️ {t('cc_owner_queue')}</h2>
        <span className={`badge ${pending.length > 0 ? 'red' : 'green'}`}>{pending.length}</span>
      </div>
      {suspicious.length === 0 ? (
        <p className="muted">{t('suspicious_none')}</p>
      ) : (
        <>
          {shown.map((s) => (
            <div key={s.checkout_event_id} className="review-row">
              <div className="review-main">
                <div className="item-title">{s.name}</div>
                <div className="muted">{s.project_name ?? t('unknown_project')}</div>
                <div className="muted">
                  {new Date(s.started_at).toLocaleDateString()} · {fmtClock(s.started_at)}–{fmtClock(s.ended_at)}
                </div>
                <div className="review-chips">
                  {s.too_long && <span className="badge amber">{t('chip_too_long')}</span>}
                  {s.gps_issue && <span className="badge red">{t('chip_no_gps')}</span>}
                  {s.time_gap_issue && <span className="badge red">{t('chip_time_gap')}</span>}
                </div>
              </div>
              <div className="review-action">
                {s.review_status === 'approved' ? (
                  <span className="badge green">{t('chip_reviewed')}</span>
                ) : (
                  <button className="btn small" disabled={busy === s.checkout_event_id} onClick={() => approve(s)}>{t('mark_reviewed')}</button>
                )}
              </div>
            </div>
          ))}
          {suspicious.length > 3 && (
            <button className="btn ghost small" onClick={() => setShowAll((v) => !v)}>
              {showAll ? t('cc_show_less') : `${t('cc_show_all')} (${suspicious.length})`}
            </button>
          )}
        </>
      )}
    </section>
  )
}

// ── (5) Операции сейчас ─────────────────────────────────────────────────────────
function OpsNow({ team, events, live, tasks, projectName, now, onOpenWorker }: {
  team: Profile[]
  events: TimeEvent[]
  live: LiveLastLocation[]
  tasks: Task[]
  projectName: Map<string, string>
  now: number
  onOpenWorker: (p: Profile) => void
}) {
  const { t } = useI18n()
  const byWorker = useMemo(() => {
    const m = new Map<string, TimeEvent[]>()
    for (const e of events) {
      if (!m.has(e.profile_id)) m.set(e.profile_id, [])
      m.get(e.profile_id)!.push(e)
    }
    return m
  }, [events])
  const liveById = useMemo(() => new Map(live.map((l) => [l.worker_id, l])), [live])

  const onShift = team.filter((w) => {
    const evs = byWorker.get(w.id) ?? []
    return evs.length > 0 && shiftState(evs).status !== 'off'
  })

  const currentTask = (workerId: string) => {
    const active = tasks.filter((x) => x.assigned_to === workerId && (x.status === 'in_progress' || x.status === 'open'))
    active.sort((a, b) => (a.status === 'in_progress' ? -1 : 1) - (b.status === 'in_progress' ? -1 : 1))
    return active[0] ?? null
  }

  const gps = (workerId: string) => {
    const l = liveById.get(workerId)
    if (!l || l.minutes_ago === null) return { cls: 'grey', label: t('cc_gps_none') }
    return l.minutes_ago <= GPS_STALE_MINUTES
      ? { cls: 'green', label: t('cc_gps_fresh') }
      : { cls: 'amber', label: t('cc_gps_stale') }
  }

  return (
    <section className="card cc-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>📍 {t('cc_ops_now')}</h2>
        <Link className="btn ghost small" to="/overview">{t('cc_open_overview')}</Link>
      </div>
      {onShift.length === 0 ? (
        <p className="muted">{t('cc_nobody_on_shift')}</p>
      ) : (
        <div className="cc-ops-grid">
          {onShift.map((w) => {
            const evs = byWorker.get(w.id) ?? []
            const st = shiftState(evs)
            const task = currentTask(w.id)
            const g = gps(w.id)
            return (
              <div key={w.id} className="cc-ops-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <button className="inline-link item-title" onClick={() => onOpenWorker(w)}>{w.name}</button>
                  <span className="badge blue">{w.role}</span>
                </div>
                <div className="muted">{st.projectId ? projectName.get(st.projectId) ?? t('unknown_project') : t('unknown_project')}</div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className={`badge ${st.status === 'break' ? 'amber' : 'green'}`}>
                    {st.status === 'break' ? t('on_break') : `${fmtHours(workedMs(evs, now))}${t('h')}`}
                  </span>
                  <span className={`badge ${g.cls}`}>{g.label}</span>
                </div>
                <div className="cc-ops-task muted">
                  {t('cc_current_task')}: {task ? <b>{task.title}</b> : <span>{t('cc_no_active_task')}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ── (6) Доска задач ─────────────────────────────────────────────────────────────
function TaskBoard({ projects, team, tasks, peopleById, projectName, canWrite, onChanged }: {
  projects: Project[]
  team: Profile[]
  tasks: Task[]
  peopleById: Map<string, Profile>
  projectName: Map<string, string>
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const { profile } = useAuth()
  const { t, lang } = useI18n()

  // Create form
  const [fProject, setFProject] = useState('')
  const [fTitle, setFTitle] = useState('')
  const [fDescription, setFDescription] = useState('')
  const [fAssignee, setFAssignee] = useState('')
  const [fPriority, setFPriority] = useState<Task['priority']>('medium')
  // Фото по умолчанию НЕ обязательно (закон Андрея §3): tasks.requires_photo default=true в БД,
  // поэтому передаём явный false, если галочка не стоит — иначе офисные задачи нельзя закрыть без фото.
  const [fRequiresPhoto, setFRequiresPhoto] = useState(false)
  // CLIENT-MEDIA-1: «Отчёт для клиента» — фото/видео-улики такой задачи автоматически
  // помечаются client_visible (см. tasks.metadata.client_report).
  const [fClientReport, setFClientReport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createOk, setCreateOk] = useState(false)
  const [createErr, setCreateErr] = useState(false)

  // Filters
  const [fltProject, setFltProject] = useState('all')
  const [fltStatus, setFltStatus] = useState('all')
  const [hideDone, setHideDone] = useState(false)

  // Card interaction
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({})
  const [attachBusy, setAttachBusy] = useState<string | null>(null)
  const [statusBusy, setStatusBusy] = useState<string | null>(null)
  const [cardError, setCardError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // DELIVERY-2: прогресс позиций «N/M» по доставкам + открытая накладная (модал).
  const [deliveryProgress, setDeliveryProgress] = useState<Record<string, { total: number; delivered: number }>>({})
  const [invoiceTask, setInvoiceTask] = useState<Task | null>(null)

  useEffect(() => {
    const ids = tasks.filter(isDeliveryTask).map((tk) => tk.id)
    if (ids.length === 0) { setDeliveryProgress({}); return }
    let alive = true
    getDeliveryProgress(ids).then((p) => { if (alive) setDeliveryProgress(p) }).catch(() => { /* карточка деградирует без прогресса */ })
    return () => { alive = false }
  }, [tasks])

  const assignableTeam = useMemo(() => team.filter((p) => p.id !== profile?.id && p.role !== 'client'), [team, profile?.id])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !fTitle.trim()) return
    setBusy(true)
    setCreateErr(false)
    setCreateOk(false)
    try {
      await createTask(profile, {
        project_id: fProject || null,
        title: fTitle.trim(),
        task_type: 'work',
        priority: fPriority,
        assigned_to: fAssignee || null,
        description: fDescription,
        requires_photo: fRequiresPhoto,
        metadata: fClientReport ? { client_report: true } : undefined,
      })
      setFTitle(''); setFDescription(''); setFAssignee(''); setFProject(''); setFPriority('medium'); setFRequiresPhoto(false); setFClientReport(false)
      setCreateOk(true)
      await onChanged()
    } catch {
      setCreateErr(true)
    } finally {
      setBusy(false)
    }
  }

  const filtered = useMemo(() => {
    return tasks.filter((task) => {
      if (hideDone && (task.status === 'done' || task.status === 'cancelled')) return false
      if (fltProject !== 'all') {
        if (fltProject === 'none' ? task.project_id !== null : task.project_id !== fltProject) return false
      }
      if (fltStatus !== 'all' && task.status !== fltStatus) return false
      return true
    })
  }, [tasks, hideDone, fltProject, fltStatus])

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
    if (next && !attachments[task.id]) await loadAttachments(task.id)
  }

  const changeStatus = async (task: Task, status: Task['status']) => {
    if (!profile || status === task.status) return
    if (status === 'done' && task.requires_photo) {
      const list = attachments[task.id] ?? await loadAttachments(task.id)
      if (!list.some((a) => a.media_type === 'photo')) { setCardError('task_done_needs_photo'); return }
    }
    setStatusBusy(task.id)
    setCardError(null)
    try {
      await updateTaskStatus(profile, task, status)
      await onChanged()
    } catch {
      setCardError('tasks_status_error')
    } finally {
      setStatusBusy(null)
    }
  }

  const attach = async (task: Task, file: File | undefined) => {
    if (!profile || !file || attachBusy) return
    try { validateUpload(file, 'file') } catch (err) { setCardError(uploadErrorCode(err) ?? 'tasks_attach_error'); return }
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
      setConfirmDeleteId(null)
      setExpandedId(null)
      await onChanged()
    } catch {
      setCardError('tasks_delete_error')
    } finally {
      setStatusBusy(null)
    }
  }

  const renderDetail = (task: Task) => {
    const list = attachments[task.id] ?? []
    const photos = list.filter((a) => a.media_type === 'photo')
    const files = list.filter((a) => a.media_type !== 'photo')
    const uploading = attachBusy === task.id
    return (
      // UI-NAV-2 (b): развёрнутый блок деталей внутри кликабельной cc-task-card — гасим всплытие,
      // чтобы клики по вложениям / кнопке удаления / подтверждению не сворачивали карточку.
      <div className="task-detail" onClick={(e) => e.stopPropagation()}>
        <div className="task-attach-buttons">
          <input id={`cc-gal-${task.id}`} className="photo-input" type="file" accept="image/*" disabled={uploading}
            onChange={(e) => { attach(task, e.target.files?.[0]); e.currentTarget.value = '' }} />
          <label className="btn ghost small" htmlFor={`cc-gal-${task.id}`}>🖼️ {t('tasks_gallery')}</label>
          <input id={`cc-cam-${task.id}`} className="photo-input" type="file" accept="image/*" capture="environment" disabled={uploading}
            onChange={(e) => { attach(task, e.target.files?.[0]); e.currentTarget.value = '' }} />
          <label className="btn ghost small" htmlFor={`cc-cam-${task.id}`}>📷 {t('tasks_camera')}</label>
          <input id={`cc-file-${task.id}`} className="photo-input" type="file" disabled={uploading}
            onChange={(e) => { attach(task, e.target.files?.[0]); e.currentTarget.value = '' }} />
          <label className="btn ghost small" htmlFor={`cc-file-${task.id}`}>📎 {t('tasks_files')}</label>
          {uploading && <span className="muted">{t('photo_uploading')}</span>}
        </div>

        {photos.length > 0 && (
          <div className="task-attach-thumbs">
            {photos.map((a) => (
              <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
                <img className="task-attach-thumb" src={a.url} alt={a.filename ?? ''} />
              </a>
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
                {t('tasks_proof_by')}: {task.done_by ? (peopleById.get(task.done_by)?.name ?? '—') : '—'}
                {task.done_at ? ` · ${fmtWhen(task.done_at)}` : ''}
              </p>
            ) : (
              <p className="muted">{t('tasks_proof_hint')}</p>
            )}
          </div>
        )}

        {canWrite && (
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

  return (
    <section className="card cc-card cc-board">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>🗂️ {t('cc_board')}</h2>
        <Link className="btn ghost small" to="/archive">📦 {t('cc_open_archive')}</Link>
      </div>

      <div className="cc-board-cols">
        {/* LEFT — assign */}
        <div className="cc-board-left" id="cc-assign-task">
          <h3>{t('cc_assign_task')}</h3>
          {canWrite ? (
            <form onSubmit={submit}>
              <label>{t('col_project')}</label>
              <select value={fProject} onChange={(e) => setFProject(e.target.value)}>
                <option value="">{t('tasks_general')}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>

              <label>{t('task_title_label')}</label>
              <div className="row" style={{ gap: 8 }}>
                <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} style={{ flex: 1 }} />
                <VoiceMic lang={lang} title={t('tasks_voice_hint')} onResult={(text) => setFTitle((v) => v ? `${v} ${text}` : text)} />
              </div>

              <label>{t('task_description_label')}</label>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <textarea value={fDescription} onChange={(e) => setFDescription(e.target.value)} rows={2} style={{ flex: 1 }} />
                <VoiceMic lang={lang} title={t('tasks_voice_hint')} onResult={(text) => setFDescription((v) => v ? `${v} ${text}` : text)} />
              </div>

              <div className="row coord-row">
                <div className="coord-field">
                  <label>{t('col_assignee')}</label>
                  <select value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}>
                    <option value="">{t('task_unassigned')}</option>
                    {assignableTeam.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div className="coord-field">
                  <label>{t('col_priority')}</label>
                  <select value={fPriority} onChange={(e) => setFPriority(e.target.value as Task['priority'])}>
                    {TASK_PRIORITIES.map((pr) => <option key={pr} value={pr}>{t(`task_priority_${pr}`)}</option>)}
                  </select>
                </div>
              </div>

              <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
                <input type="checkbox" checked={fRequiresPhoto} onChange={(e) => setFRequiresPhoto(e.target.checked)} style={{ width: 'auto' }} />
                <span>{t('task_requires_photo')}</span>
              </label>

              <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
                <input type="checkbox" checked={fClientReport} onChange={(e) => setFClientReport(e.target.checked)} style={{ width: 'auto' }} />
                <span>{t('task_client_report')}</span>
              </label>

              {createErr && <p className="error-msg">{t('tasks_create_error')}</p>}
              {createOk && <p className="ok-msg">{t('cc_task_created')}</p>}
              <div className="row">
                <button className="btn" disabled={busy || !fTitle.trim()}>{busy ? t('saving') : t('create')}</button>
              </div>
            </form>
          ) : (
            <p className="muted">{t('cc_my_messages_hint')}</p>
          )}
        </div>

        {/* RIGHT — all tasks */}
        <div className="cc-board-right">
          <h3>{t('cc_all_tasks')}</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label>{t('col_project')}</label>
              <select value={fltProject} onChange={(e) => setFltProject(e.target.value)}>
                <option value="all">{t('filter_all')}</option>
                <option value="none">{t('tasks_general')}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label>{t('col_status')}</label>
              <select value={fltStatus} onChange={(e) => setFltStatus(e.target.value)}>
                <option value="all">{t('filter_all')}</option>
                {FILTER_STATUSES.map((st) => <option key={st} value={st}>{t(`task_status_${st}`)}</option>)}
              </select>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
              <span>{t('tasks_hide_done')}</span>
            </label>
          </div>

          {cardError && <p className="error-msg">{t(cardError)}</p>}
          {filtered.length === 0 ? (
            <p className="muted">{t('no_tasks')}</p>
          ) : (
            <div className="cc-tasks">
              {filtered.map((task) => (
                // UI-NAV-2 (b): вся карточка раскрывает детали (тот же toggleExpand, что кнопка «Детали»).
                // Селект статуса, кнопка «Детали» и весь развёрнутый блок деталей гасят всплытие.
                <div key={task.id} className="cc-task-card tap" onClick={() => toggleExpand(task)}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span className={`badge ${priorityTone(task.priority)}`}>{t(`task_priority_${task.priority}`)}</span>{' '}
                      <span className="task-title">{task.title}</span>
                      {task.requires_photo && <span className="badge amber" style={{ marginLeft: 6 }}>📷</span>}
                      {isDeliveryTask(task) && <span className="badge delivery-badge" style={{ marginLeft: 6 }}>🚚 {t('delivery_badge')}</span>}
                      {isDeliveryTask(task) && deliveryProgress[task.id]?.total ? (
                        <span className="badge blue" style={{ marginLeft: 6 }}>{deliveryProgress[task.id].delivered}/{deliveryProgress[task.id].total} {t('delivery_positions')}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="muted">
                    {task.project_id ? projectName.get(task.project_id) ?? '—' : t('tasks_general')}
                    {' · '}{task.assigned_to ? peopleById.get(task.assigned_to)?.name ?? '—' : t('task_unassigned')}
                  </div>
                  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      className="task-status-select"
                      value={STATUS_OPTIONS.includes(task.status) ? task.status : 'open'}
                      disabled={statusBusy === task.id}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => changeStatus(task, e.target.value as Task['status'])}
                    >
                      {STATUS_OPTIONS.map((st) => <option key={st} value={st}>{t(`task_status_${st}`)}</option>)}
                    </select>
                    {isDeliveryTask(task) && (
                      <button className="btn ghost small delivery-open-btn" onClick={(e) => { e.stopPropagation(); setInvoiceTask(task) }}>
                        🚚 {t('delivery_open')}
                      </button>
                    )}
                    <button className="btn ghost small" onClick={(e) => { e.stopPropagation(); toggleExpand(task) }}>
                      {expandedId === task.id ? t('tasks_hide_details') : t('tasks_details')}
                    </button>
                  </div>
                  {expandedId === task.id && renderDetail(task)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {invoiceTask && (
        <DeliveryInvoice
          task={invoiceTask}
          profile={profile}
          team={team}
          onClose={() => setInvoiceTask(null)}
          onProgressChange={(taskId, p) => setDeliveryProgress((cur) => ({ ...cur, [taskId]: p }))}
        />
      )}
    </section>
  )
}

// ── (7) Сообщения мне ───────────────────────────────────────────────────────────
function MyMessagesWidget({ messages, peopleById, meId, onRead, relAge }: {
  messages: MessageRow[]
  peopleById: Map<string, Profile>
  meId: string
  onRead: () => Promise<void>
  relAge: (iso: string) => string
}) {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)

  // Закон владельца: в лицо показываем ТОЛЬКО (a) сообщения от клиентов и (b) адресованные лично
  // мне. Потоки к развозчикам / task-threads между людьми — НЕ показываем (они в «Сообщениях»).
  // Оба случая = входящие ко мне (recipient=я); исключаем priority='task' (это раздачи/треды задач).
  const inbox = useMemo(() => {
    return messages
      .filter((m) => m.recipient_id === meId && m.sender_id !== meId && m.priority !== 'task')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 12)
  }, [messages, meId])

  const read = async (m: MessageRow) => {
    if (!profile || busy) return
    setBusy(m.id)
    try { await markMessageRead(profile, m.id); await onRead() } catch { /* ignore */ } finally { setBusy(null) }
  }

  return (
    <section className="card cc-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>📨 {t('cc_my_messages')}</h2>
        <Link className="btn ghost small" to="/messages">{t('cc_full_history')}</Link>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>{t('cc_my_messages_hint')}</p>
      {inbox.length === 0 ? (
        <p className="muted">{t('cc_no_my_messages')}</p>
      ) : (
        <div className="cc-feed">
          {inbox.map((m) => {
            const sender = peopleById.get(m.sender_id)
            const unread = !m.read_at
            return (
              <div key={m.id} className={`cc-feed-row ${unread ? 'unread' : ''}`}>
                <div>
                  <b>{sender?.name ?? t('unknown_user')}</b>
                  {sender?.role === 'client' && <span className="badge blue" style={{ marginLeft: 6 }}>{t('cc_from_client')}</span>}
                  {unread && <span className="badge red" style={{ marginLeft: 6 }}>{t('cc_unread')}</span>}
                  <div className="muted cc-feed-body">{m.body}</div>
                </div>
                <div className="cc-feed-meta">
                  <span className="muted">{relAge(m.created_at)}</span>
                  {unread && <button className="btn ghost small" disabled={busy === m.id} onClick={() => read(m)}>{t('mark_read')}</button>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
