import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../lib/auth'
import { useI18n } from '../../lib/i18n'
import {
  assignWorkerToProject,
  createTask,
  getRecentDispatchPlanSends,
  sendDispatchPlan,
  softDeleteTask,
  subscribeToOrgEvents,
  subscribeToTaskChanges,
  unassignWorkerFromProject,
  type DispatchPlanSend,
} from '../../lib/api'
import { getOrgSnapshot } from '../../lib/api/dashboard'
import {
  buildDispatchBoard,
  canAssign,
  canSwap,
  DISPATCH_CREW_ROLES,
} from '../../lib/dispatchBoard'
import { isManagerRole } from '../../lib/types'
import type { CurrentAssignmentRow, Profile, Project, Task, UnassignedWorkerRow } from '../../lib/types'
import { useEntityDrawer } from '../../components/EntityDrawer'
import VoiceMic from '../../components/VoiceMic'

function dateValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function tomorrowValue() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return dateValue(d)
}

function template(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

// Что тащим: свободного (from=null) или назначенного (from=projectId) работника.
type DragPayload = { workerId: string; from: string | null }
// Раскрытая карточка назначенного работника (рокировка/задача/снятие).
type EditState = { key: string; moveTo: string; taskText: string }

// DISPATCH-REDESIGN-50: worker-centric доска расстановки (Командный центр). Слова Андрея:
// «слева одна колонка — проекты с назначенными и что каждый делает; справа одна колонка со
// ВСЕМИ ребятами, и как только одного отправил — он ИСЧЕЗ из общей группы; лёгкая рокировка».
// Назначение = assignWorkerToProject; «что делает» = задача (createTask); рокировка = unassign+assign;
// возврат в свободные = unassignWorkerFromProject; рассылка наряда = sendDispatchPlan (без изменений бэка).
export default function PlanConstructor() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const { openWorker, openProject } = useEntityDrawer()
  const manager = profile ? isManagerRole(profile.role) : false

  const [projects, setProjects] = useState<Project[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [assignments, setAssignments] = useState<CurrentAssignmentRow[]>([])
  const [unassigned, setUnassigned] = useState<UnassignedWorkerRow[]>([])
  const [sends, setSends] = useState<DispatchPlanSend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const [date, setDate] = useState(() => tomorrowValue())
  const [sentProject, setSentProject] = useState<string | null>(null)

  // Клик-выбор свободного работника (правая колонка) → панель назначения.
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null)
  const [assignProject, setAssignProject] = useState('')
  const [assignTask, setAssignTask] = useState('')

  // Drag-n-drop (нативный HTML5): payload держим в state (один вкладка/окно).
  const [drag, setDrag] = useState<DragPayload | null>(null)
  const [dragOverProject, setDragOverProject] = useState<string | null>(null)
  const [dragOverFree, setDragOverFree] = useState(false)

  // Раскрытая карточка назначенного (рокировка / +задача / снять).
  const [edit, setEdit] = useState<EditState | null>(null)

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      const [snapshot, sendRows] = await Promise.all([getOrgSnapshot(), getRecentDispatchPlanSends()])
      setProjects(snapshot.projects)
      setTeam(snapshot.team)
      setTasks(snapshot.open_tasks)
      setAssignments(snapshot.assignments)
      setUnassigned(snapshot.unassigned)
      setSends(sendRows)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (manager) void load() }, [profile?.id])
  useEffect(() => {
    if (!manager || !profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => { void load() }, 'tasks:dispatch-board')
  }, [profile?.org_id])
  useEffect(() => {
    if (!manager || !profile?.org_id) return
    return subscribeToOrgEvents(profile.org_id, () => { void load() }, `events:dispatch-board:${profile.org_id}`)
  }, [profile?.org_id])

  const board = useMemo(
    () => buildDispatchBoard({ projects, team, assignments, unassigned, tasks, roles: DISPATCH_CREW_ROLES }),
    [projects, team, assignments, unassigned, tasks],
  )

  const sendByProject = useMemo(() => {
    const m = new Map<string, DispatchPlanSend>()
    for (const s of sends) if (!m.has(s.project_id)) m.set(s.project_id, s) // sends desc → первый = свежий
    return m
  }, [sends])

  const selectedWorkerName = useMemo(
    () => board.free.find((w) => w.id === selectedWorker)?.name ?? null,
    [board.free, selectedWorker],
  )

  // Если выбранный работник исчез из свободных (назначен/перезагрузка) — сбрасываем панель.
  useEffect(() => {
    if (selectedWorker && !board.free.some((w) => w.id === selectedWorker)) {
      setSelectedWorker(null)
      setAssignProject('')
      setAssignTask('')
    }
  }, [board.free, selectedWorker])

  if (!manager) return null

  // ── мутации ────────────────────────────────────────────────────────────────
  const assign = async (workerId: string, projectId: string, taskText: string) => {
    if (!profile || busy) return
    if (!canAssign(assignments, projects, workerId, projectId)) return
    setBusy(`assign-${workerId}`)
    setError(false)
    try {
      await assignWorkerToProject(profile, projectId, workerId)
      const title = taskText.trim()
      if (title) {
        await createTask(profile, {
          project_id: projectId,
          title,
          task_type: 'work',
          priority: 'medium',
          assigned_to: workerId,
          due_date: date,
        })
      }
      setSelectedWorker(null)
      setAssignProject('')
      setAssignTask('')
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  const unassign = async (workerId: string, projectId: string) => {
    if (!profile || busy) return
    setBusy(`unassign-${workerId}`)
    setError(false)
    try {
      await unassignWorkerFromProject(profile, projectId, workerId)
      setEdit(null)
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  const swap = async (workerId: string, fromProjectId: string, toProjectId: string) => {
    if (!profile || busy) return
    if (!canSwap(assignments, workerId, fromProjectId, toProjectId)) return
    setBusy(`swap-${workerId}`)
    setError(false)
    try {
      await unassignWorkerFromProject(profile, fromProjectId, workerId)
      await assignWorkerToProject(profile, toProjectId, workerId)
      setEdit(null)
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  const addTask = async (workerId: string, projectId: string, taskText: string) => {
    if (!profile || busy) return
    const title = taskText.trim()
    if (!title) return
    setBusy(`task-${workerId}`)
    setError(false)
    try {
      await createTask(profile, {
        project_id: projectId,
        title,
        task_type: 'work',
        priority: 'medium',
        assigned_to: workerId,
        due_date: date,
      })
      setEdit((e) => (e ? { ...e, taskText: '' } : e))
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  const removeTask = async (task: Task) => {
    if (!profile || busy) return
    setBusy(`deltask-${task.id}`)
    setError(false)
    try {
      await softDeleteTask(profile, task.id)
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  const sendPlan = async (group: (typeof board.groups)[number]) => {
    if (!profile || busy) return
    const workers = group.workers.map((w) => w.profile)
    if (workers.length === 0) return
    setBusy(`send-${group.project.id}`)
    setError(false)
    setSentProject(null)
    try {
      const projectTasks = tasks.filter((task) => task.project_id === group.project.id)
      await sendDispatchPlan(profile, group.project, workers, projectTasks, date)
      setSentProject(group.project.id)
      setSends(await getRecentDispatchPlanSends())
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  // ── drag-n-drop helpers ──────────────────────────────────────────────────────
  const onDropProject = (projectId: string) => {
    setDragOverProject(null)
    const payload = drag
    setDrag(null)
    if (!payload) return
    if (payload.from === null) void assign(payload.workerId, projectId, '')
    else if (payload.from !== projectId) void swap(payload.workerId, payload.from, projectId)
  }

  const onDropFree = () => {
    setDragOverFree(false)
    const payload = drag
    setDrag(null)
    if (payload?.from) void unassign(payload.workerId, payload.from)
  }

  const projectOptions = projects // все активные проекты как цели назначения/рокировки

  return (
    <section className="card dispatch-cc">
      <div className="row dispatch-cc-head">
        <h2>{t('dispatch_board_title')}</h2>
        <label className="plan-date-picker">
          {t('plan_date')}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value || tomorrowValue())} />
        </label>
      </div>

      {error && <p className="error-msg">{t('load_error')}</p>}

      {loading ? (
        <div className="muted">{t('loading')}</div>
      ) : (
        <>
          {board.doubleAssigned.length > 0 && (
            <div className="dispatch-cc-warn">
              {board.doubleAssigned.map((d) => (
                <div className="dispatch-conflict-row amber" key={d.profileId}>
                  <span className="status-dot amber" />
                  <div className="item-title">
                    {template(t('dispatch_double_warn'), { name: d.name, projects: d.projects.join(', ') })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="dispatch-cc-board">
            {/* ЛЕВАЯ КОЛОНКА — проекты с назначенными + что делает */}
            <div className="dispatch-cc-left">
              {selectedWorker && (
                <div className="dispatch-assign-bar">
                  <div className="dispatch-assign-title">
                    {template(t('dispatch_assign_worker'), { name: selectedWorkerName ?? '' })}
                  </div>
                  <select value={assignProject} onChange={(e) => setAssignProject(e.target.value)}>
                    <option value="">{t('dispatch_pick_project')}</option>
                    {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <div className="dispatch-assign-task-row">
                    <input
                      type="text"
                      value={assignTask}
                      placeholder={t('dispatch_what_doing_ph')}
                      onChange={(e) => setAssignTask(e.target.value)}
                    />
                    <VoiceMic
                      lang={lang}
                      title={t('tasks_voice_hint')}
                      onResult={(text) => setAssignTask((v) => (v ? `${v} ${text}` : text))}
                    />
                  </div>
                  <div className="dispatch-assign-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy !== null || !canAssign(assignments, projects, selectedWorker, assignProject)}
                      onClick={() => assign(selectedWorker, assignProject, assignTask)}
                    >
                      {t('dispatch_assign_btn')}
                    </button>
                    <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => setSelectedWorker(null)}>
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              )}

              {board.groups.length === 0 ? (
                <div className="muted dispatch-cc-empty">{t('dispatch_no_projects')}</div>
              ) : (
                board.groups.map((group) => {
                  const sent = sendByProject.get(group.project.id)
                  const dropReady = drag !== null && drag.from !== group.project.id
                  return (
                    <section
                      key={group.project.id}
                      className={`card dispatch-proj-card${dragOverProject === group.project.id ? ' drag-over' : ''}${dropReady ? ' drop-ready' : ''}`}
                      onDragOver={(e) => { if (drag) { e.preventDefault(); setDragOverProject(group.project.id) } }}
                      onDragLeave={() => setDragOverProject((cur) => (cur === group.project.id ? null : cur))}
                      onDrop={(e) => { e.preventDefault(); onDropProject(group.project.id) }}
                    >
                      <div className="row dispatch-proj-head">
                        <div>
                          <button className="inline-link item-title" onClick={() => openProject(group.project)}>{group.project.name}</button>
                          {group.project.address && <div className="muted">{group.project.address}</div>}
                        </div>
                        <span className="badge blue">{group.workers.length}</span>
                      </div>

                      {sent && (
                        <div className="badge green plan-sent-badge">
                          {template(t('plan_sent_badge'), { n: sent.workers, when: new Date(sent.created_at).toLocaleString() })}
                        </div>
                      )}

                      <div className="dispatch-assigned-list">
                        {group.workers.map((w) => {
                          const key = `${group.project.id}:${w.profile.id}`
                          const open = edit?.key === key
                          return (
                            <div
                              key={w.profile.id}
                              className={`dispatch-assigned${open ? ' open' : ''}`}
                              draggable={busy === null}
                              onDragStart={() => setDrag({ workerId: w.profile.id, from: group.project.id })}
                              onDragEnd={() => { setDrag(null); setDragOverProject(null); setDragOverFree(false) }}
                            >
                              <button
                                type="button"
                                className="dispatch-assigned-main"
                                onClick={() => setEdit(open ? null : { key, moveTo: '', taskText: '' })}
                              >
                                <span className="dispatch-assigned-name">{w.profile.name}</span>
                                <span className="muted dispatch-assigned-role">{w.profile.role}</span>
                                {w.tasks.length > 0 ? (
                                  <span className="dispatch-assigned-task">{w.tasks.map((tk) => tk.title).join(' · ')}</span>
                                ) : w.note ? (
                                  <span className="dispatch-assigned-task">{w.note}</span>
                                ) : (
                                  <span className="muted dispatch-assigned-task">{t('dispatch_no_task')}</span>
                                )}
                              </button>

                              {open && (
                                <div className="dispatch-assigned-edit" onClick={(e) => e.stopPropagation()}>
                                  {w.tasks.length > 0 && (
                                    <ul className="dispatch-task-chips">
                                      {w.tasks.map((tk) => (
                                        <li key={tk.id}>
                                          <span>{tk.title}</span>
                                          <button type="button" className="dispatch-chip-x" disabled={busy !== null} onClick={() => removeTask(tk)}>×</button>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  <div className="dispatch-assign-task-row">
                                    <input
                                      type="text"
                                      value={edit.taskText}
                                      placeholder={t('dispatch_what_doing_ph')}
                                      onChange={(e) => setEdit((s) => (s ? { ...s, taskText: e.target.value } : s))}
                                    />
                                    <button
                                      type="button"
                                      className="btn small"
                                      disabled={busy !== null || edit.taskText.trim() === ''}
                                      onClick={() => addTask(w.profile.id, group.project.id, edit.taskText)}
                                    >
                                      {t('dispatch_add_task_btn')}
                                    </button>
                                  </div>
                                  <div className="dispatch-move-row">
                                    <select value={edit.moveTo} onChange={(e) => setEdit((s) => (s ? { ...s, moveTo: e.target.value } : s))}>
                                      <option value="">{t('dispatch_move_to')}</option>
                                      {projectOptions
                                        .filter((p) => p.id !== group.project.id)
                                        .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                    </select>
                                    <button
                                      type="button"
                                      className="btn small"
                                      disabled={busy !== null || !canSwap(assignments, w.profile.id, group.project.id, edit.moveTo)}
                                      onClick={() => swap(w.profile.id, group.project.id, edit.moveTo)}
                                    >
                                      {t('dispatch_move_btn')}
                                    </button>
                                  </div>
                                  <div className="dispatch-assigned-foot">
                                    <button type="button" className="btn ghost small" disabled={busy !== null} onClick={() => unassign(w.profile.id, group.project.id)}>
                                      {t('dispatch_unassign_btn')}
                                    </button>
                                    <button type="button" className="inline-link" onClick={() => openWorker(w.profile)}>{t('dispatch_open_card')}</button>
                                  </div>
                                </div>
                              )}

                            </div>
                          )
                        })}
                      </div>

                      {selectedWorker && canAssign(assignments, projects, selectedWorker, group.project.id) && (
                        <button
                          type="button"
                          className="btn small dispatch-assign-here"
                          disabled={busy !== null}
                          onClick={() => assign(selectedWorker, group.project.id, assignTask)}
                        >
                          ← {t('dispatch_assign_here')}
                        </button>
                      )}

                      <button
                        className="btn"
                        title={t('send_plan_hint')}
                        disabled={busy !== null || group.workers.length === 0}
                        onClick={() => sendPlan(group)}
                      >
                        {t('send_plan')}
                      </button>
                      {sentProject === group.project.id && <p className="ok-msg">{t('plan_sent')}</p>}
                    </section>
                  )
                })
              )}
            </div>

            {/* ПРАВАЯ КОЛОНКА — все свободные + счётчик «Осталось: N» */}
            <aside
              className={`dispatch-cc-free${dragOverFree ? ' drag-over' : ''}${drag?.from ? ' drop-ready' : ''}`}
              onDragOver={(e) => { if (drag?.from) { e.preventDefault(); setDragOverFree(true) } }}
              onDragLeave={() => setDragOverFree(false)}
              onDrop={(e) => { e.preventDefault(); onDropFree() }}
            >
              <div className="row dispatch-cc-free-head">
                <h3>{t('dispatch_free_title')}</h3>
                <span className={`badge ${board.freeCount > 0 ? 'blue' : 'green'}`}>
                  {template(t('dispatch_free_remaining'), { n: board.freeCount })}
                </span>
              </div>

              {board.free.length === 0 ? (
                <p className="muted dispatch-cc-empty">{t('dispatch_all_distributed')}</p>
              ) : (
                <div className="dispatch-free-list">
                  {board.free.map((w) => (
                    <div
                      key={w.id}
                      className={`dispatch-free-card${selectedWorker === w.id ? ' selected' : ''}`}
                      draggable={busy === null}
                      onDragStart={() => setDrag({ workerId: w.id, from: null })}
                      onDragEnd={() => { setDrag(null); setDragOverProject(null); setDragOverFree(false) }}
                      onClick={() => {
                        setSelectedWorker((cur) => (cur === w.id ? null : w.id))
                        setAssignProject('')
                        setAssignTask('')
                        setEdit(null)
                      }}
                    >
                      <span className="dispatch-free-name">{w.name}</span>
                      <span className="muted dispatch-free-role">{w.role}</span>
                    </div>
                  ))}
                </div>
              )}

              {dragOverFree && <div className="dispatch-drop-hint">{t('dispatch_drop_to_free')}</div>}
              {board.free.length > 0 && !selectedWorker && (
                <p className="muted dispatch-hint">{t('dispatch_select_hint')}</p>
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  )
}
