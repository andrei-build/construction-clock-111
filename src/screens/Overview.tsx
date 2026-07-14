import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getTodayEvents, getTeam, getOpenTasks, getVisibleProfileRates, getMaterialsSpendTotal } from '../lib/api'
import { shiftState, workedMs, fmtHours } from '../lib/time'
import { isManagerWrite } from '../lib/types'
import type { Profile, TimeEvent, Task, ProfileRate } from '../lib/types'

// NAV-2 (а): «Обзор» — лёгкий экран дневных чисел (тайлы) + кнопка в командный центр.
// Переиспользуем те же лёгкие хелперы, что и Dashboard/командный центр — без тяжёлой логики,
// без подписок и таймеров. Тяжёлая оперативная картина живёт в командном центре (Dashboard).
export default function Overview() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [rates, setRates] = useState<ProfileRate[]>([])
  const [materials, setMaterials] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [now] = useState(() => Date.now())

  const financeAccess = profile ? isManagerWrite(profile.role) : false

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [e, tm, tk, visibleRates] = await Promise.all([
          getTodayEvents(),
          getTeam(),
          getOpenTasks(),
          getVisibleProfileRates(),
        ])
        if (!mounted) return
        setEvents(e)
        setTeam(tm)
        setTasks(tk)
        setRates(visibleRates)
        // «Материалы $» — только для финансовых ролей; при ошибке доступа хелпер вернёт 0.
        if (financeAccess) {
          try {
            const m = await getMaterialsSpendTotal()
            if (mounted) setMaterials(m)
          } catch {
            if (mounted) setMaterials(null)
          }
        }
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const byWorker = useMemo(() => {
    const m = new Map<string, TimeEvent[]>()
    for (const e of events) {
      if (!m.has(e.profile_id)) m.set(e.profile_id, [])
      m.get(e.profile_id)!.push(e)
    }
    return m
  }, [events])

  const onSite = useMemo(
    () => team.filter((w) => {
      const evs = byWorker.get(w.id) ?? []
      return evs.length > 0 && shiftState(evs).status !== 'off'
    }),
    [team, byWorker],
  )

  const totalMs = useMemo(
    () => Array.from(byWorker.values()).reduce((acc, evs) => acc + workedMs(evs, now), 0),
    [byWorker, now],
  )

  const rateByWorker = useMemo(() => {
    const m = new Map<string, number>()
    for (const rate of rates) {
      if (rate.hourly_rate !== null) m.set(rate.profile_id, Number(rate.hourly_rate))
    }
    return m
  }, [rates])

  const payDue = useMemo(() => {
    if (rateByWorker.size === 0) return null
    return Array.from(byWorker.entries()).reduce((acc, [workerId, evs]) => {
      const rate = rateByWorker.get(workerId)
      if (!rate) return acc
      return acc + (workedMs(evs, now) / 3600000) * rate
    }, 0)
  }, [byWorker, now, rateByWorker])

  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)

  const tiles = [
    { label: t('on_site_now'), value: String(onSite.length), tone: onSite.length > 0 ? 'green' : 'grey', note: '' },
    { label: t('hours_today'), value: fmtHours(totalMs), tone: totalMs > 0 ? 'blue' : 'grey', note: '' },
    { label: t('pay_due'), value: payDue === null ? '—' : money(payDue), tone: payDue === null ? 'grey' : 'green', note: payDue === null ? t('finance_locked') : '' },
    { label: t('materials_cost'), value: !financeAccess ? '—' : (materials === null ? '—' : money(materials)), tone: financeAccess ? 'blue' : 'grey', note: financeAccess ? '' : t('finance_locked') },
    { label: t('open_tasks'), value: String(tasks.length), tone: tasks.length > 0 ? 'blue' : 'grey', note: '' },
  ]

  return (
    <div className="screen dashboard-screen overview-screen">
      <h1>{t('overview')}</h1>
      <p className="muted">{t('overview_subtitle')}</p>
      {error && <p className="error-msg">{t('load_error')}</p>}

      {loading ? (
        <div className="card center muted">{t('loading')}</div>
      ) : (
        <div className="dashboard-tiles">
          {tiles.map((tile) => (
            <div key={tile.label} className={`card metric-card ${tile.tone}`}>
              <div className="metric-value">{tile.value}</div>
              <div className="muted">{tile.label}</div>
              {tile.note && <div className="metric-note">{tile.note}</div>}
            </div>
          ))}
        </div>
      )}

      <Link to="/" className="btn overview-cta">{t('open_command_center')}</Link>
    </div>
  )
}
