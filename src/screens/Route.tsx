import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getOpenTasks, getProjects, markMaterialStatus, subscribeToTaskChanges } from '../lib/api'
import type { MaterialStatusAction } from '../lib/api'
import type { Project, Task } from '../lib/types'

// Экран водителя «Маршрут дня» (MAT-2). Две секции:
//   1) ЗАКУПКА — все открытые материальные позиции по всем активным объектам, забор одним чеком.
//   2) РАЗВОЗ  — карточки объектов, где есть забранное, но не доставленное; доставка по позиции/скопом.
// Переиспользуем getOpenTasks (материал/доставка ещё в работе), markMaterialStatus (RPC MAT-1)
// и subscribeToTaskChanges (реалтайм → рефетч). v1 ТОЛЬКО онлайн: офлайн-очереди тут нет — при
// падении RPC показываем ошибку и оставляем прежнее состояние (общий офлайн-механизм задачам
// материала не подключён, см. TasksTab: он умеет queueOffline, но у нас RPC-only поток).
//
// BACKEND REQUEST: политика RLS tasks_select пускает роль 'driver' видеть только task_type='delivery'
// (условие: app.user_role() <> 'driver' OR task_type = 'delivery'). Из-за этого секция ЗАКУПКА
// (task_type='material') у водителя пустая — материальные заявки ему не видны. Нужно расширить
// tasks_select до `... OR task_type IN ('delivery','material')` для роли driver, чтобы водитель
// видел и забирал материал. Для менеджеров экран уже работает полностью. UI не меняется — сразу
// заработает после правки политики. Здесь ничего не выдумываем (RLS — бэкенд).

const localeByLang = { ru: 'ru-RU', en: 'en-US', es: 'es-ES' } as const

function isMaterialFlow(task: Task) {
  return task.task_type === 'material' || task.task_type === 'delivery'
}

// Сортировка закупки: срочные (urgent_flag) первыми, затем новые (created_at desc).
function pickupSort(a: Task, b: Task) {
  const ua = a.urgent_flag ? 1 : 0
  const ub = b.urgent_flag ? 1 : 0
  if (ua !== ub) return ub - ua
  const ca = a.created_at ?? ''
  const cb = b.created_at ?? ''
  if (ca === cb) return 0
  return ca < cb ? 1 : -1
}

function formatTime(iso: string | null | undefined, locale: string) {
  if (!iso) return ''
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

// Крупная кнопка «Взял» с тем же жестом отмены, что и в MaterialStatusChain:
// тап — забрать/вернуть, долгое нажатие — вернуть (пока не доставлено).
function PickupButton({
  task,
  busy,
  onAct,
}: {
  task: Task
  busy: boolean
  onAct: (task: Task, action: MaterialStatusAction) => void
}) {
  const { t } = useI18n()
  const picked = Boolean(task.picked_up_at)
  const longPressTimer = useRef<number | null>(null)
  const longPressFired = useRef(false)

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  const startLongPress = () => {
    if (!picked || busy) return
    clearLongPress()
    longPressFired.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true
      onAct(task, 'undo_picked_up')
    }, 650)
  }

  const click = () => {
    if (longPressFired.current) { longPressFired.current = false; return }
    if (busy) return
    onAct(task, picked ? 'undo_picked_up' : 'picked_up')
  }

  return (
    <button
      type="button"
      className={`route-pick ${picked ? 'complete' : ''}`}
      disabled={busy}
      title={picked ? t('material_undo_pickup_hint') : undefined}
      onClick={click}
      onPointerDown={startLongPress}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      onContextMenu={(e) => { if (picked && !busy) { e.preventDefault(); onAct(task, 'undo_picked_up') } }}
    >
      <span className="route-pick-check" aria-hidden="true">{picked ? '✓' : '○'}</span>
      <span>{t('material_status_picked_up')}</span>
    </button>
  )
}

export default function Route() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const locale = localeByLang[lang]

  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [actionError, setActionError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyProject, setBusyProject] = useState<string | null>(null)
  const [openCards, setOpenCards] = useState<Set<string>>(new Set())

  // Реалтайм-новизна: id, известные при первом рендере, считаем «старыми».
  // Всё, что появилось позже (через subscribeToTaskChanges), помечаем badge «НОВОЕ».
  const seenRef = useRef<Set<string> | null>(null)
  const [newIds, setNewIds] = useState<Set<string>>(new Set())

  const load = useCallback(async (spinner = true) => {
    if (spinner) setLoading(true)
    setLoadError(false)
    try {
      const [taskRows, projectRows] = await Promise.all([getOpenTasks(), getProjects()])
      const materialTasks = taskRows.filter(isMaterialFlow)
      setTasks(materialTasks)
      setProjects(projectRows)
      const ids = materialTasks.map((task) => task.id)
      if (seenRef.current === null) {
        seenRef.current = new Set(ids)
      } else {
        const fresh = ids.filter((id) => !seenRef.current!.has(id))
        if (fresh.length > 0) {
          fresh.forEach((id) => seenRef.current!.add(id))
          setNewIds((prev) => {
            const next = new Set(prev)
            fresh.forEach((id) => next.add(id))
            return next
          })
        }
      }
    } catch {
      setLoadError(true)
    } finally {
      if (spinner) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Новые/изменённые задачи прилетают realtime'ом → тихий рефетч (без спиннера).
  useEffect(() => {
    if (!profile?.org_id) return
    const unsubscribe = subscribeToTaskChanges(profile.org_id, () => { void load(false) }, 'route')
    return unsubscribe
  }, [profile?.org_id, load])

  const act = async (task: Task, action: MaterialStatusAction) => {
    setBusyId(task.id)
    setActionError(false)
    try {
      await markMaterialStatus(task.id, action)
      await load(false)
    } catch {
      setActionError(true)
    } finally {
      setBusyId(null)
    }
  }

  const deliverAll = async (projectId: string, items: Task[]) => {
    setBusyProject(projectId)
    setActionError(false)
    try {
      // Последовательные RPC доставки — по одной позиции, как просит ТЗ.
      for (const item of items) {
        if (!item.delivered_at) await markMaterialStatus(item.id, 'delivered')
      }
      await load(false)
    } catch {
      setActionError(true)
    } finally {
      setBusyProject(null)
    }
  }

  const projectById = useMemo(() => {
    const map = new Map<string, Project>()
    for (const p of projects) map.set(p.id, p)
    return map
  }, [projects])

  // ── Секция ЗАКУПКА: все открытые (не доставленные) позиции, сгруппированы по объекту.
  const pickupTasks = useMemo(() => tasks.filter((task) => !task.delivered_at), [tasks])
  const pickedCount = pickupTasks.filter((task) => task.picked_up_at).length

  // Группы в порядке объектов из getProjects; внутри группы — pickupSort.
  const pickupGroups = useMemo(() => {
    const byProject = new Map<string, Task[]>()
    for (const task of pickupTasks) {
      const key = task.project_id ?? 'none'
      const list = byProject.get(key)
      if (list) list.push(task)
      else byProject.set(key, [task])
    }
    const orderedKeys = [
      ...projects.map((p) => p.id).filter((id) => byProject.has(id)),
      ...(byProject.has('none') ? ['none'] : []),
    ]
    return orderedKeys.map((key) => ({
      key,
      project: key === 'none' ? null : projectById.get(key) ?? null,
      items: byProject.get(key)!.slice().sort(pickupSort),
    }))
  }, [pickupTasks, projects, projectById])

  // ── Секция РАЗВОЗ: объекты с забранным, но не доставленным; порядок = порядок объектов.
  const deliveryGroups = useMemo(() => {
    const toDeliver = tasks.filter((task) => task.picked_up_at && !task.delivered_at)
    const byProject = new Map<string, Task[]>()
    for (const task of toDeliver) {
      const key = task.project_id ?? 'none'
      const list = byProject.get(key)
      if (list) list.push(task)
      else byProject.set(key, [task])
    }
    const orderedKeys = [
      ...projects.map((p) => p.id).filter((id) => byProject.has(id)),
      ...(byProject.has('none') ? ['none'] : []),
    ]
    return orderedKeys.map((key) => ({
      key,
      project: key === 'none' ? null : projectById.get(key) ?? null,
      items: byProject.get(key)!.slice().sort(pickupSort),
    }))
  }, [tasks, projects, projectById])

  const toggleCard = (key: string) => {
    setOpenCards((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="screen">
      <h1>🚚 {t('route_title')}</h1>

      {loadError && <p className="error-msg">{t('route_load_error')}</p>}
      {actionError && <p className="error-msg">{t('material_status_failed')}</p>}
      {loading && <div className="card center muted">{t('loading')}</div>}

      {!loading && (
        <>
          {/* ── ЗАКУПКА ────────────────────────────────────────────── */}
          <section className="route-section">
            <div className="route-section-head">
              <div>
                <h2 className="route-section-title">{t('route_procurement')}</h2>
                <p className="route-section-sub">{t('route_procurement_sub')}</p>
              </div>
              <span className="route-counter">
                {t('route_picked_counter')
                  .replace('{n}', String(pickedCount))
                  .replace('{m}', String(pickupTasks.length))}
              </span>
            </div>

            {pickupGroups.length === 0 && (
              <div className="card muted center">{t('route_no_pickup')}</div>
            )}

            {pickupGroups.map((group) => (
              <div className="route-group" key={`pick-${group.key}`}>
                <div className="route-group-head">
                  <span className="route-group-name">{group.project?.name ?? t('unknown_project')}</span>
                  <span className="route-group-addr">{group.project?.address || t('route_no_address')}</span>
                </div>
                {group.items.map((task) => (
                  <div className="route-item card" key={task.id}>
                    <div className="route-item-main">
                      <div className="route-item-badges">
                        {task.urgent_flag && <span className="badge red">{t('route_urgent_badge')}</span>}
                        {newIds.has(task.id) && (
                          <span className="badge green route-new">
                            {t('route_new_badge')} · {formatTime(task.created_at, locale)}
                          </span>
                        )}
                      </div>
                      <div className="route-item-title">{task.title}</div>
                      {task.description && <div className="route-item-desc">{task.description}</div>}
                    </div>
                    <PickupButton task={task} busy={busyId === task.id} onAct={act} />
                  </div>
                ))}
              </div>
            ))}
          </section>

          {/* ── РАЗВОЗ ─────────────────────────────────────────────── */}
          <section className="route-section">
            <div className="route-section-head">
              <div>
                <h2 className="route-section-title">{t('route_delivery')}</h2>
                <p className="route-section-sub">{t('route_delivery_sub')}</p>
              </div>
            </div>

            {deliveryGroups.length === 0 && (
              <div className="card muted center">{t('route_no_delivery')}</div>
            )}

            {deliveryGroups.map((group) => {
              const open = openCards.has(group.key)
              const projectBusy = busyProject === group.key
              return (
                <div className="route-deliver-card card" key={`deliver-${group.key}`}>
                  <button type="button" className="route-deliver-head" onClick={() => toggleCard(group.key)}>
                    <div className="route-deliver-head-main">
                      <span className="route-group-name">{group.project?.name ?? t('unknown_project')}</span>
                      <span className="route-group-addr">{group.project?.address || t('route_no_address')}</span>
                    </div>
                    <span className="badge amber">{t('route_delivery_count').replace('{n}', String(group.items.length))}</span>
                    <span className="route-deliver-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
                  </button>

                  {open && (
                    <div className="route-deliver-body">
                      {group.items.map((task) => (
                        <div className="route-deliver-item" key={task.id}>
                          <div className="route-item-main">
                            <div className="route-item-title">{task.title}</div>
                            {task.description && <div className="route-item-desc">{task.description}</div>}
                          </div>
                          <button
                            type="button"
                            className="route-deliver-btn"
                            disabled={busyId === task.id || projectBusy}
                            onClick={() => act(task, 'delivered')}
                          >
                            {t('route_deliver_one')}
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn route-deliver-all"
                        disabled={projectBusy || group.items.length === 0}
                        onClick={() => deliverAll(group.key, group.items)}
                      >
                        {t('route_deliver_all')}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        </>
      )}
    </div>
  )
}
