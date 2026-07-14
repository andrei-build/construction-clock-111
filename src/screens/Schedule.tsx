import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getTeam,
  getProjects,
  getScheduleAssignments,
  getTimeEventsRange,
  assignWorkerToProject,
} from '../lib/api'
import { isManagerRole, isManagerWrite } from '../lib/types'
import { workedMs, fmtHours } from '../lib/time'
import type { Profile, Project, ScheduleAssignment, TimeEvent } from '../lib/types'

// Экран «Расписание» — недельная сетка ЛЮДИ (строки) × ДНИ (пн–вс). Паритет со старым
// расписанием Check Time. Менеджер+ видит всю команду, работник — только свою строку.
//
// Допущение по назначениям: project_assignments не датируется по дням (это членство в
// проекте на всё время — так его используют «Диспетчер» и карточка работника). Поэтому
// назначение показывается на КАЖДЫЙ день видимой недели для человека, а не привязано к
// одному дню. День без назначений — «дыра» (серый). Фактические часы > 10ч — перегруз (янтарь).

const DAY_MS = 24 * 60 * 60 * 1000

function startOfWeekMonday(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day)
  return d
}

export default function Schedule() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const manager = profile ? isManagerRole(profile.role) : false
  const canWrite = profile ? isManagerWrite(profile.role) : false

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()))
  const [team, setTeam] = useState<Profile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [assignments, setAssignments] = useState<ScheduleAssignment[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [picker, setPicker] = useState<string | null>(null) // profile_id, ячейка-дыра открыта под выбор проекта
  const [busy, setBusy] = useState(false)

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)), [weekStart])
  const locale = lang === 'ru' ? 'ru-RU' : lang === 'es' ? 'es-ES' : 'en-US'

  const load = async () => {
    if (!profile) return
    setLoading(true)
    setLoadError(false)
    try {
      const weekStartISO = weekStart.toISOString()
      const weekEndISO = new Date(weekStart.getTime() + 7 * DAY_MS).toISOString()
      const [people, projectRows, assignmentRows, eventRows] = await Promise.all([
        manager ? getTeam() : Promise.resolve([profile]),
        canWrite ? getProjects() : Promise.resolve([] as Project[]),
        getScheduleAssignments(manager ? undefined : profile.id),
        getTimeEventsRange(weekStartISO, weekEndISO),
      ])
      setTeam(manager ? people : [profile])
      setProjects(projectRows)
      setAssignments(assignmentRows)
      setEvents(eventRows)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id, weekStart, manager])

  // Назначения по человеку (членство в проекте — на всю неделю).
  const assignmentsByPerson = useMemo(() => {
    const map = new Map<string, ScheduleAssignment[]>()
    for (const a of assignments) {
      const list = map.get(a.profile_id) ?? []
      list.push(a)
      map.set(a.profile_id, list)
    }
    return map
  }, [assignments])

  // Отработанные миллисекунды по (человек, день) — из пар check_in/check_out за этот день.
  const hoursByCell = useMemo(() => {
    const map = new Map<string, number>()
    const byPerson = new Map<string, TimeEvent[]>()
    for (const e of events) {
      const list = byPerson.get(e.profile_id) ?? []
      list.push(e)
      byPerson.set(e.profile_id, list)
    }
    const now = Date.now()
    for (const [pid, list] of byPerson) {
      for (let i = 0; i < 7; i++) {
        const dayStart = weekStart.getTime() + i * DAY_MS
        const dayEnd = dayStart + DAY_MS
        const dayEvents = list.filter((e) => {
          const ts = new Date(e.event_time).getTime()
          return ts >= dayStart && ts < dayEnd
        })
        if (dayEvents.length === 0) continue
        const ms = workedMs(dayEvents, Math.min(now, dayEnd))
        if (ms > 0) map.set(`${pid}:${i}`, ms)
      }
    }
    return map
  }, [events, weekStart])

  const shiftWeek = (delta: number) => {
    setPicker(null)
    setWeekStart((w) => new Date(w.getTime() + delta * 7 * DAY_MS))
  }

  const assign = async (personId: string, projectId: string) => {
    if (!profile || !projectId) return
    setBusy(true)
    try {
      await assignWorkerToProject(profile, projectId, personId)
      setPicker(null)
      await load()
    } catch {
      setLoadError(true)
    } finally {
      setBusy(false)
    }
  }

  const weekLabel = `${days[0].toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`
  const todayMs = startOfWeekMonday(new Date()).getTime() === weekStart.getTime()
    ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
    : -1

  return (
    <div className="screen">
      <h1>🗓️ {t('schedule')}</h1>

      <div className="sched-toolbar">
        <button className="btn ghost small" onClick={() => shiftWeek(-1)} aria-label={t('schedule_prev_week')}>‹</button>
        <span className="sched-week-label">{weekLabel}</span>
        <button className="btn ghost small" onClick={() => shiftWeek(1)} aria-label={t('schedule_next_week')}>›</button>
        <button className="btn ghost small" onClick={() => { setPicker(null); setWeekStart(startOfWeekMonday(new Date())) }}>{t('schedule_this_week')}</button>
      </div>

      <div className="sched-legend muted">
        <span><span className="sched-swatch sched-hole" /> {t('schedule_legend_hole')}</span>
        <span><span className="sched-swatch sched-overload" /> {t('schedule_legend_overload')}</span>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('schedule_load_error')}</p>}

      {!loading && !loadError && team.length === 0 && <div className="card muted">{t('schedule_empty')}</div>}

      {!loading && !loadError && team.length > 0 && (
        <div className="card sched-table-wrap">
          <table className="sched-table">
            <thead>
              <tr>
                <th className="sched-person">{t('team')}</th>
                {days.map((d, i) => (
                  <th key={i} className={d.getTime() === todayMs ? 'sched-today' : ''}>
                    <div className="sched-dow">{d.toLocaleDateString(locale, { weekday: 'short' })}</div>
                    <div className="sched-date">{d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {team.map((person) => {
                const personAssignments = assignmentsByPerson.get(person.id) ?? []
                const hasAssignment = personAssignments.length > 0
                return (
                  <tr key={person.id}>
                    <td className="sched-person">{person.name}</td>
                    {days.map((d, i) => {
                      const ms = hoursByCell.get(`${person.id}:${i}`) ?? 0
                      const hours = ms / 3600000
                      const overload = hours > 10
                      const hole = !hasAssignment
                      const cls = overload ? 'sched-overload' : hole ? 'sched-hole' : ''
                      const isPicking = picker === person.id && canWrite
                      return (
                        <td
                          key={i}
                          className={`sched-cell ${cls} ${d.getTime() === todayMs ? 'sched-today' : ''}`}
                          onClick={hole && canWrite && !isPicking ? () => setPicker(person.id) : undefined}
                        >
                          {isPicking ? (
                            <select
                              autoFocus
                              disabled={busy}
                              defaultValue=""
                              onChange={(e) => assign(person.id, e.target.value)}
                              onBlur={() => setPicker(null)}
                            >
                              <option value="">{t('schedule_pick_project')}</option>
                              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          ) : (
                            <>
                              {personAssignments.map((a) => (
                                <span key={a.id} className="sched-chip">{a.project?.name ?? '—'}</span>
                              ))}
                              {ms > 0 && <span className="sched-hours">{fmtHours(ms)} {t('h')}</span>}
                              {hole && canWrite && <span className="sched-add">＋</span>}
                            </>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
