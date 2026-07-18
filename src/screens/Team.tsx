import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useLiveRefresh } from '../lib/useLiveRefresh'
import { getTeam, getTodayEvents, createWorker, setWorkerCheckoutVideo, getExpiringWorkerDocs } from '../lib/api'
import type { ExpiringWorkerDoc } from '../lib/api'
import { workedMs, fmtHours, shiftState } from '../lib/time'
import { buildWorkerDisambiguationMap } from '../lib/worker-utils'
import { canAssignRole, isManagerWrite, type Profile, type Role, type TimeEvent } from '../lib/types'
import { useEntityDrawer } from '../components/EntityDrawer'

// DOC-EXPIRY-UI: пороги истечения документов для бейджей/плашки реестра. «Красный» уровень = просрочен
// или ≤7 дн. (работать нельзя); «янтарный» = 8–30 дн. (скоро). Соответствует WorkerDetail.
const DOC_EXPIRY_URGENT_DAYS = 7
const DOC_DAY_MS = 24 * 60 * 60 * 1000
type DocLevel = 'red' | 'amber'
// Уровень одного документа по локальной дате expires_at (YYYY-MM-DD): red (≤7д/просрочен) или amber.
function docLevel(expiresAt: string): DocLevel {
  const target = new Date(`${expiresAt}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((target.getTime() - today.getTime()) / DOC_DAY_MS)
  return days <= DOC_EXPIRY_URGENT_DAYS ? 'red' : 'amber'
}

// TEAM-1: порядок ролевых групп на списке /team. owner/admin закреплены сверху,
// далее менеджеры · супервайзеры · рабочие · доставщики · сабконтракторы · sales.
const TEAM_GROUPS: { key: string; titleKey: string; roles: Role[] }[] = [
  { key: 'owners', titleKey: 'team_group_owners', roles: ['owner', 'admin'] },
  { key: 'managers', titleKey: 'team_group_managers', roles: ['manager'] },
  { key: 'supervisors', titleKey: 'team_group_supervisors', roles: ['supervisor'] },
  { key: 'workers', titleKey: 'team_group_workers', roles: ['worker'] },
  { key: 'drivers', titleKey: 'team_group_drivers', roles: ['driver'] },
  { key: 'subcontractors', titleKey: 'team_group_subcontractors', roles: ['subcontractor'] },
  { key: 'sales', titleKey: 'team_group_sales', roles: ['sales'] },
]
const GROUPED_ROLES = new Set<Role>(TEAM_GROUPS.flatMap((g) => g.roles))

// TEAM-2: инициалы для запасного (без фото) круглого аватара в строках списка.
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '👷'
}

export default function Team() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openWorker } = useEntityDrawer()
  const navigate = useNavigate()
  const [team, setTeam] = useState<Profile[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  // DOC-EXPIRY-UI: истекающие/просроченные документы всей команды (одним запросом) — для бейджей и плашки.
  const [expiringDocs, setExpiringDocs] = useState<ExpiringWorkerDoc[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState('worker')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // LIVE-REFRESH-1: у экрана нет флага loading — load() и так фоновый (обновляет только массивы
  // team/events, не трогает форму добавления и открытый drawer), поэтому его же используем как refetch.
  const load = () => Promise.all([getTeam(), getTodayEvents(), getExpiringWorkerDocs()])
    .then(([tm, e, docs]) => { setTeam(tm); setEvents(e); setExpiringDocs(docs) })
  useEffect(() => { load() }, [profile?.id])

  // LIVE-REFRESH-1: дашборд «Команда» — мягкий 60с-поллинг (только пока вкладка видима) + рефетч
  // на возврат/фокус, чтобы «на смене N из M» и часы были свежими без ручной перезагрузки.
  useLiveRefresh(() => { void load().catch(() => {}) }, 60000)

  const byWorker = useMemo(() => {
    const m = new Map<string, TimeEvent[]>()
    for (const e of events) {
      if (!m.has(e.profile_id)) m.set(e.profile_id, [])
      m.get(e.profile_id)!.push(e)
    }
    return m
  }, [events])

  // F16: same-name workers get a role / id suffix so the list stays tellable-apart.
  const workerLabels = useMemo(() => buildWorkerDisambiguationMap(team), [team])

  const onShiftCount = useMemo(
    () => team.filter((w) => shiftState(byWorker.get(w.id) ?? []).status !== 'off').length,
    [team, byWorker],
  )

  // DOC-EXPIRY-UI: худший уровень документа по работнику (red перекрывает amber) — для бейджа карточки.
  const docLevelByWorker = useMemo(() => {
    const m = new Map<string, DocLevel>()
    for (const d of expiringDocs) {
      const lvl = docLevel(d.expires_at)
      if (lvl === 'red' || !m.has(d.profile_id)) m.set(d.profile_id, lvl)
    }
    return m
  }, [expiringDocs])

  // DOC-EXPIRY-UI: сводка для плашки — сколько документов просрочено/≤7д (red) и сколько 8–30д (amber).
  const docSummary = useMemo(() => {
    let red = 0
    let amber = 0
    for (const d of expiringDocs) (docLevel(d.expires_at) === 'red' ? red++ : amber++)
    return { red, amber }
  }, [expiringDocs])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setMsg(null)
    const r = await createWorker(name.trim(), pin.trim(), role)
    if (r.ok) { setMsg('worker_created'); setName(''); setPin(''); setAdding(false); await load() }
    else setMsg(r.error ?? 'error')
    setBusy(false)
  }

  const roleBadge = (r: string) =>
    r === 'owner' || r === 'admin' ? 'red' : r === 'manager' || r === 'supervisor' ? 'amber' : r === 'driver' ? 'blue' : 'green'

  const canManage = profile ? isManagerWrite(profile.role) : false

  // TEAM-1: раскладываем команду по ролевым группам (порядок фиксирован), плюс бакет
  // «Прочие» для ролей вне списка (например client), чтобы никто не исчез из списка.
  const groupedTeam = useMemo(() => {
    const sections = TEAM_GROUPS.map((g) => ({
      key: g.key,
      titleKey: g.titleKey,
      members: team.filter((w) => g.roles.includes(w.role)),
    }))
    const other = team.filter((w) => !GROUPED_ROLES.has(w.role))
    if (other.length) sections.push({ key: 'other', titleKey: 'team_group_other', members: other })
    return sections.filter((s) => s.members.length > 0)
  }, [team])

  // F3: гейт создания работника — предлагаем только роли, которые актёр вправе назначить.
  // Плоский менеджер не увидит driver (его выдают только owner/admin) и не создаст роль >= своей.
  const addRoleOptions: Role[] = ['worker', 'driver', 'supervisor', 'manager', 'subcontractor']
  const creatableRoles = addRoleOptions.filter((r) => (profile ? canAssignRole(profile.role, r) : false))

  const toggleCheckoutVideo = async (worker: Profile) => {
    if (!profile) return
    const next = !worker.require_checkout_video
    // Optimistic: a DB trigger reverts self-changes by non-managers, so we roll back on error.
    setTeam((rows) => rows.map((r) => (r.id === worker.id ? { ...r, require_checkout_video: next } : r)))
    try {
      await setWorkerCheckoutVideo(profile, worker.id, next)
    } catch {
      setTeam((rows) => rows.map((r) => (r.id === worker.id ? { ...r, require_checkout_video: worker.require_checkout_video } : r)))
      setMsg('checkout_video_toggle_failed')
    }
  }

  return (
    <div className="screen">
      <h1>👷 {t('team')}</h1>

      <div className="card pulse-summary" style={{ fontWeight: 700 }}>
        <span className={`badge ${onShiftCount > 0 ? 'green' : 'grey'}`}>●</span>{' '}
        {t('team_pulse_label')}: {t('on_shift')} {onShiftCount} {t('team_pulse_of')} {team.length}
      </div>

      {/* DOC-EXPIRY-UI: компактная плашка-сводка, если у кого-то в команде истекают/просрочены документы. */}
      {(docSummary.red > 0 || docSummary.amber > 0) && (
        <div className={`card doc-expiry-summary ${docSummary.red > 0 ? 'red' : 'amber'}`}>
          {docSummary.red > 0 && <span>{t('team_docs_summary_expired').replace('{n}', String(docSummary.red))}</span>}
          {docSummary.amber > 0 && <span>{t('team_docs_summary_expiring').replace('{n}', String(docSummary.amber))}</span>}
        </div>
      )}

      {!adding && <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('add_worker')}</button>}
      {adding && (
        <form onSubmit={submit} className="card">
          <label>{t('name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t('pin')}</label>
          <input value={pin} inputMode="numeric" pattern="[0-9]*" onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          <label>{t('role')}</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {creatableRoles.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button className="btn" disabled={busy || !name.trim() || pin.length < 4}>{t('create')}</button>
        </form>
      )}
      {msg && <p className={msg === 'worker_created' ? 'ok-msg' : 'error-msg'}>{t(msg)}</p>}

      {groupedTeam.map((section) => (
        <div key={section.key} className="team-group">
          <h2 className="team-group-title">{t(section.titleKey)} <span className="muted">· {section.members.length}</span></h2>
          {section.members.map((w) => {
            const evs = byWorker.get(w.id) ?? []
            const st = shiftState(evs)
            return (
              // UI-NAV-2 (b): вся строка открывает карточку работника (тот же таргет, что ссылка-имя).
              // Вложенные контролы вызывают stopPropagation, чтобы не срабатывал переход по строке.
              <div key={w.id} className="card row tap" onClick={() => openWorker(w)}>
                <div className="team-row-id">
                  {/* TEAM-2: круглый аватар работника (публичный avatar_url) в строке списка. */}
                  <div className="team-avatar sm" aria-hidden="true">
                    {w.avatar_url ? <img src={w.avatar_url} alt="" /> : <span>{initials(w.name)}</span>}
                  </div>
                  <div>
                    <button className="inline-link item-title" onClick={(e) => { e.stopPropagation(); openWorker(w) }}>{workerLabels.get(w.id) ?? w.name}</button>
                    <span className={`badge ${roleBadge(w.role)}`}>{w.role}</span>
                    {/* DOC-EXPIRY-UI: бейдж истечения документа (red ≤7д/просрочен, amber 8–30д); title поясняет. */}
                    {docLevelByWorker.get(w.id) && (
                      <span
                        className={`badge ${docLevelByWorker.get(w.id)}`}
                        title={docLevelByWorker.get(w.id) === 'red' ? t('worker_docs_badge_expired') : t('worker_docs_badge_expiring')}
                      >
                        ⚠ {t('worker_docs_badge')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="center">
                  <div style={{ fontWeight: 700 }}>{fmtHours(workedMs(evs))}{t('h')}</div>
                  {st.status !== 'off' && <span className="badge green">●</span>}
                  {canManage && (
                    <label className="checkout-video-toggle" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12 }} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={Boolean(w.require_checkout_video)}
                        onChange={() => toggleCheckoutVideo(w)}
                      />
                      <span className="muted">{t('checkout_video_required')}</span>
                    </label>
                  )}
                  <button className="btn ghost small team-details-btn" onClick={(e) => { e.stopPropagation(); navigate(`/team/${w.id}`) }}>
                    {t('details')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
