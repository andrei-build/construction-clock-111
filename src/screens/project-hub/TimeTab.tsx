import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { getProjectTimeEvents } from '../../lib/api'
import type { Project, ProjectTimeEvent } from '../../lib/types'

interface TimeTabProps {
  project: Project
}

interface Shift {
  inAt: string
  outAt: string
  ms: number
}

interface WorkerShifts {
  profileId: string
  name: string
  totalMs: number
  shifts: Shift[]
}

// Пары check_in→check_out на клиенте: события уже отсортированы по event_time.
// Открытый check_in без пары (или дубль check_in) молча пропускаем — это «в смене» или брак.
function pairShifts(events: ProjectTimeEvent[]): WorkerShifts[] {
  const byWorker = new Map<string, ProjectTimeEvent[]>()
  for (const ev of events) {
    const list = byWorker.get(ev.profile_id)
    if (list) list.push(ev)
    else byWorker.set(ev.profile_id, [ev])
  }

  const workers: WorkerShifts[] = []
  for (const [profileId, rows] of byWorker) {
    const shifts: Shift[] = []
    let openIn: ProjectTimeEvent | null = null
    for (const ev of rows) {
      if (ev.event_type === 'check_in') {
        openIn = ev
      } else if (ev.event_type === 'check_out' && openIn) {
        const ms = new Date(ev.event_time).getTime() - new Date(openIn.event_time).getTime()
        if (ms > 0) shifts.push({ inAt: openIn.event_time, outAt: ev.event_time, ms })
        openIn = null
      }
    }
    const name = rows.find((row) => row.profile?.name)?.profile?.name ?? ''
    shifts.reverse() // новейшие смены сверху
    workers.push({
      profileId,
      name,
      totalMs: shifts.reduce((sum, shift) => sum + shift.ms, 0),
      shifts,
    })
  }
  return workers
}

function formatHours(ms: number) {
  return (ms / 3_600_000).toFixed(1)
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString()
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function TimeTab({ project }: TimeTabProps) {
  const { t } = useI18n()
  const [events, setEvents] = useState<ProjectTimeEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const rows = await getProjectTimeEvents(project.id)
        if (mounted) setEvents(rows)
      } catch {
        if (mounted) setLoadError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [project.id])

  const workers = useMemo(() => {
    const rows = pairShifts(events).filter((worker) => worker.shifts.length > 0)
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    return rows
  }, [events])

  const grandTotalMs = useMemo(() => workers.reduce((sum, worker) => sum + worker.totalMs, 0), [workers])

  return (
    <section className="hub-tab-panel hub-time">
      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('hub_time_load_error')}</p>}
      {!loading && !loadError && workers.length === 0 && <div className="card muted">{t('hub_time_empty')}</div>}

      {!loading && !loadError && workers.length > 0 && (
        <>
          <div className="card hub-time-summary">
            <span className="item-title">{t('hub_time_total')}</span>
            <span className="hub-time-hours num-display">{formatHours(grandTotalMs)} {t('hub_time_hours')}</span>
          </div>

          {workers.map((worker) => (
            <div className="card" key={worker.profileId}>
              <div className="hub-time-summary">
                <span className="item-title">{worker.name || t('hub_worker_unknown')}</span>
                <span className="hub-time-hours num-display">{formatHours(worker.totalMs)} {t('hub_time_hours')}</span>
              </div>
              <div className="hub-time-list">
                {worker.shifts.map((shift, index) => (
                  <div className="hub-time-row" key={`${worker.profileId}-${index}`}>
                    <div className="hub-time-info">
                      <span className="item-title">{formatDate(shift.inAt)}</span>
                      <span className="muted">{formatTime(shift.inAt)} → {formatTime(shift.outAt)}</span>
                    </div>
                    <span className="hub-time-hours">{formatHours(shift.ms)} {t('hub_time_hours')}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  )
}
