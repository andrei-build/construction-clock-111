import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import AccountForm from './AccountForm'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  createContact,
  getAccountContacts,
  getClientDeals,
  getClientDocuments,
  getClientProjectSummaries,
  getEventsSince,
  getOpenTasks,
  getProjectProfit,
  getProjectRecentPhotos,
  getProjectShiftEvents,
  getProjects,
  getRecentActivityForActor,
  getTeam,
  getTodayEvents,
  updateAccount,
} from '../lib/api'
import { fmtHours, shiftState, weekStartISO, workedMs } from '../lib/time'
import { isManagerRole, type Account, type AccountInput, type ClientProjectSummary, type Contact, type ContactInput, type Deal, type DocumentRow, type EventRow, type Profile, type Project, type ProjectPhoto, type ProjectProfit, type Task, type TimeEvent } from '../lib/types'

type DrawerState =
  | { type: 'worker'; worker: Profile }
  | { type: 'project'; project: Project }
  | { type: 'client'; account: Account; onUpdated?: (account: Account) => void }
  | null

interface EntityDrawerApi {
  openWorker: (worker: Profile) => void
  openProject: (project: Project) => void
  openClient: (account: Account, options?: { onUpdated?: (account: Account) => void }) => void
}

const EntityDrawerCtx = createContext<EntityDrawerApi>({
  openWorker: () => {},
  openProject: () => {},
  openClient: () => {},
})

export const useEntityDrawer = () => useContext(EntityDrawerCtx)

export function EntityDrawerProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const close = () => setDrawer(null)

  return (
    <EntityDrawerCtx.Provider value={{
      openWorker: (worker) => setDrawer({ type: 'worker', worker }),
      openProject: (project) => setDrawer({ type: 'project', project }),
      openClient: (account, options) => setDrawer({ type: 'client', account, onUpdated: options?.onUpdated }),
    }}>
      {children}
      {drawer && (
        <>
          <div className="entity-drawer-backdrop" onClick={close} />
          <aside className="entity-drawer" aria-modal="true" role="dialog">
            <button className="drawer-close" aria-label={t('close')} onClick={close}>×</button>
            {drawer.type === 'worker' ? (
              <WorkerPanel
                worker={drawer.worker}
                close={close}
                openProject={(project) => setDrawer({ type: 'project', project })}
              />
            ) : drawer.type === 'project' ? (
              <ProjectPanel
                project={drawer.project}
                close={close}
                openWorker={(worker) => setDrawer({ type: 'worker', worker })}
              />
            ) : (
              <ClientPanel
                account={drawer.account}
                onUpdated={drawer.onUpdated}
              />
            )}
          </aside>
        </>
      )}
    </EntityDrawerCtx.Provider>
  )
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'CC'
}

function roleTone(role: string) {
  return role === 'owner' || role === 'admin' ? 'red' : role === 'manager' || role === 'supervisor' ? 'amber' : role === 'driver' ? 'blue' : 'green'
}

function ActivityList({ rows }: { rows: EventRow[] }) {
  const { t } = useI18n()
  if (rows.length === 0) return <div className="muted">{t('no_activity')}</div>
  return (
    <div className="drawer-feed">
      {rows.map((event) => (
        <div className="feed-item" key={event.id}>
          <div>{event.event_type}</div>
          <div className="when">{new Date(event.created_at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  )
}

function isKnownAccountType(type: string | null): type is 'client' | 'gc' | 'supplier' | 'other' {
  return type === 'client' || type === 'gc' || type === 'supplier' || type === 'other'
}

function accountTypeLabel(t: (key: string) => string, type: string | null) {
  return isKnownAccountType(type) ? t(`account_type_${type}`) : type ?? t('account_type_other')
}

function accountTypeTone(type: string | null) {
  if (type === 'client') return 'green'
  if (type === 'gc') return 'blue'
  if (type === 'supplier') return 'amber'
  return 'red'
}

function money(value: number | null) {
  return value === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

function ClientPanel({ account, onUpdated }: {
  account: Account
  onUpdated?: (account: Account) => void
}) {
  const { t } = useI18n()
  const { profile } = useAuth()
  const [current, setCurrent] = useState(account)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [deals, setDeals] = useState<Deal[]>([])
  const [projects, setProjects] = useState<ClientProjectSummary[]>([])
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [editing, setEditing] = useState(false)
  const [savingAccount, setSavingAccount] = useState(false)
  const [accountError, setAccountError] = useState(false)
  const [contactName, setContactName] = useState('')
  const [contactTitle, setContactTitle] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactPrimary, setContactPrimary] = useState(false)
  const [savingContact, setSavingContact] = useState(false)
  const [contactError, setContactError] = useState(false)

  useEffect(() => {
    setCurrent(account)
    setEditing(false)
    setAccountError(false)
  }, [account.id])

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [contactRows, dealRows, projectRows, documentRows] = await Promise.all([
          getAccountContacts(current.id),
          getClientDeals(current.id),
          getClientProjectSummaries(current.id),
          getClientDocuments(current.id),
        ])
        if (!mounted) return
        setContacts(contactRows)
        setDeals(dealRows)
        setProjects(projectRows)
        setDocuments(documentRows)
      } catch {
        if (mounted) {
          setContacts([])
          setDeals([])
          setProjects([])
          setDocuments([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [current.id])

  async function saveClient(input: AccountInput) {
    if (!profile || savingAccount) return
    setSavingAccount(true)
    setAccountError(false)
    try {
      const updated = await updateAccount(profile, current.id, input)
      setCurrent(updated)
      onUpdated?.(updated)
      setEditing(false)
    } catch {
      setAccountError(true)
    } finally {
      setSavingAccount(false)
    }
  }

  async function addContact(e: FormEvent) {
    e.preventDefault()
    if (!profile || savingContact || !contactName.trim()) return
    const input: ContactInput = {
      name: contactName.trim(),
      title: contactTitle.trim() || null,
      email: contactEmail.trim() || null,
      phone: contactPhone.trim() || null,
      is_primary: contactPrimary,
      notes: null,
    }
    setSavingContact(true)
    setContactError(false)
    try {
      const created = await createContact(profile, current.id, input)
      setContacts((rows) => [...rows, created].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name)))
      setContactName('')
      setContactTitle('')
      setContactEmail('')
      setContactPhone('')
      setContactPrimary(false)
    } catch {
      setContactError(true)
    } finally {
      setSavingContact(false)
    }
  }

  const headerLines = [current.phone, current.email, current.address].filter(Boolean)

  return (
    <>
      <div className="drawer-hero client-drawer-hero">
        <div className="drawer-avatar client">{initials(current.name)}</div>
        <div className="client-drawer-heading">
          <div className="client-drawer-title-row">
            <h1>{current.name}</h1>
            <button type="button" className="drawer-icon-action" aria-label={t('client_edit')} onClick={() => setEditing((value) => !value)}>
              ✎
            </button>
          </div>
          <div className="client-drawer-tags">
            <span className={`badge ${accountTypeTone(current.account_type)}`}>{accountTypeLabel(t, current.account_type)}</span>
            {current.insurance_status && <span className="badge blue">{current.insurance_status}</span>}
          </div>
          {headerLines.length > 0 && <p className="muted client-detail-lines">{headerLines.join(' · ')}</p>}
        </div>
      </div>

      {editing && (
        <section className="drawer-section">
          <h2>{t('client_edit')}</h2>
          <div className="card">
            <AccountForm
              initial={current}
              submitting={savingAccount}
              submitLabel={t('save')}
              submittingLabel={t('clients_saving')}
              onSubmit={saveClient}
              onCancel={() => setEditing(false)}
            />
            {accountError && <p className="error-msg">{t('client_save_failed')}</p>}
          </div>
        </section>
      )}

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && (
        <>
          <section className="drawer-section">
            <h2>{t('contacts')}</h2>
            {contacts.length === 0 && <div className="card muted">{t('contacts_empty')}</div>}
            <div className="client-detail-list">
              {contacts.map((contact) => (
                <div className="client-detail-card" key={contact.id}>
                  <div className="row">
                    <div>
                      <span className="item-title">{contact.name}</span>
                      {contact.title && <div className="muted">{contact.title}</div>}
                    </div>
                    {contact.is_primary && <span className="badge green">{t('primary_contact')}</span>}
                  </div>
                  <div className="muted">{[contact.phone, contact.email].filter(Boolean).join(' · ') || t('client_no_contact')}</div>
                </div>
              ))}
            </div>

            <form className="card client-contact-form" onSubmit={addContact}>
              <label>{t('name')}</label>
              <input value={contactName} onChange={(e) => setContactName(e.target.value)} required />
              <label>{t('title')}</label>
              <input value={contactTitle} onChange={(e) => setContactTitle(e.target.value)} />
              <label>{t('email')}</label>
              <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
              <label>{t('phone')}</label>
              <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
              <label className="check-row client-primary-row">
                <input type="checkbox" checked={contactPrimary} onChange={(e) => setContactPrimary(e.target.checked)} />
                <span>{t('primary_contact')}</span>
              </label>
              {contactError && <p className="error-msg">{t('contact_save_failed')}</p>}
              <button type="submit" className="btn small" disabled={savingContact || !contactName.trim()}>
                {savingContact ? t('clients_saving') : t('contact_add')}
              </button>
            </form>
          </section>

          <section className="drawer-section">
            <h2>{t('client_deals')}</h2>
            {deals.length === 0 && <div className="card muted">{t('no_deals')}</div>}
            <div className="client-detail-list">
              {deals.map((deal) => (
                <div className="client-detail-card" key={deal.id}>
                  <div className="row">
                    <span className="item-title">{deal.title}</span>
                    <span className="badge blue">{t(`deal_stage_${deal.stage}`)}</span>
                  </div>
                  <div className="deal-amount">{money(deal.expected_amount)}</div>
                  {deal.next_action && <div className="muted">{deal.next_action}</div>}
                </div>
              ))}
            </div>
          </section>

          <section className="drawer-section">
            <h2>{t('client_projects')}</h2>
            {projects.length === 0 && <div className="card muted">{t('client_projects_empty')}</div>}
            <div className="client-detail-list">
              {projects.map((project) => (
                <div className="client-detail-card row" key={project.id}>
                  <span className="item-title">{project.name}</span>
                  {project.status && <span className="badge amber">{project.status}</span>}
                </div>
              ))}
            </div>
          </section>

          <section className="drawer-section">
            <h2>{t('client_documents')}</h2>
            {documents.length === 0 && <div className="card muted">{t('client_documents_empty')}</div>}
            <div className="client-detail-list">
              {documents.map((document) => (
                <div className="client-detail-card" key={document.id}>
                  <div className="row">
                    <div>
                      <span className="badge blue">{document.doc_type ?? t('client_document')}</span>
                      {document.number && <span className="client-doc-number">{document.number}</span>}
                    </div>
                    {document.status && <span className="badge amber">{document.status}</span>}
                  </div>
                  <div className="item-title">{document.title ?? document.number ?? t('client_document')}</div>
                  <div className="muted client-doc-totals">
                    {t('total')}: {money(document.total)} · {t('balance')}: {money(document.balance)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  )
}

type ProjectDrawerTab = 'overview' | 'shifts'
type ProjectShiftRow = {
  key: string
  date: string
  workerName: string
  checkIn: string | null
  checkOut: string | null
  hoursMs: number
}

function daysAgoISO(days: number) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function shiftDate(iso: string) {
  return new Date(iso).toLocaleDateString()
}

function shiftClock(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
}

function projectShiftRows(events: TimeEvent[], team: Profile[]): ProjectShiftRow[] {
  const teamById = new Map(team.map((worker) => [worker.id, worker.name]))
  const grouped = new Map<string, TimeEvent[]>()
  for (const event of events) {
    const day = shiftDate(event.event_time)
    const key = `${event.profile_id}-${day}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(event)
  }

  const rows: ProjectShiftRow[] = []
  for (const [key, dayEvents] of grouped) {
    const sorted = [...dayEvents].sort((a, b) => a.event_time.localeCompare(b.event_time))
    const firstIn = sorted.find((event) => event.event_type === 'check_in') ?? null
    const lastOut = [...sorted].reverse().find((event) => event.event_type === 'check_out') ?? null
    if (!firstIn && !lastOut) continue
    const day = shiftDate((firstIn ?? lastOut)!.event_time)
    const workerId = (firstIn ?? lastOut)!.profile_id
    const now = lastOut ? new Date(lastOut.event_time).getTime() : Date.now()
    rows.push({
      key,
      date: day,
      workerName: teamById.get(workerId) ?? workerId,
      checkIn: firstIn?.event_time ?? null,
      checkOut: lastOut?.event_time ?? null,
      hoursMs: workedMs(sorted, now),
    })
  }

  return rows.sort((a, b) => (b.checkIn ?? b.checkOut ?? '').localeCompare(a.checkIn ?? a.checkOut ?? ''))
}

function ProjectShiftList({ rows }: { rows: ProjectShiftRow[] }) {
  const { t } = useI18n()
  if (rows.length === 0) return <div className="card muted">{t('no_shift_rows')}</div>
  return (
    <div className="drawer-shift-list">
      {rows.map((row) => (
        <div className="drawer-shift-row" key={row.key}>
          <div>
            <div className="item-title">{row.workerName}</div>
            <div className="muted">{row.date}</div>
          </div>
          <div className="drawer-shift-times">
            <span>{shiftClock(row.checkIn)}</span>
            <span>→</span>
            <span>{shiftClock(row.checkOut)}</span>
          </div>
          <div className="badge blue">{fmtHours(row.hoursMs)} {t('h')}</div>
        </div>
      ))}
    </div>
  )
}

function WorkerPanel({ worker, close, openProject }: {
  worker: Profile
  close: () => void
  openProject: (project: Project) => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [todayEvents, setTodayEvents] = useState<TimeEvent[]>([])
  const [weekEvents, setWeekEvents] = useState<TimeEvent[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activity, setActivity] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [today, week, projectRows, activityRows] = await Promise.all([
          getTodayEvents(worker.id),
          getEventsSince(weekStartISO(), worker.id),
          getProjects(),
          getRecentActivityForActor(worker.id, worker.name),
        ])
        if (!mounted) return
        setTodayEvents(today)
        setWeekEvents(week)
        setProjects(projectRows)
        setActivity(activityRows)
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [worker.id, worker.name])

  const shift = useMemo(() => shiftState(todayEvents), [todayEvents])
  const currentProject = projects.find((project) => project.id === shift.projectId) ?? null

  return (
    <>
      <div className="drawer-hero">
        <div className="drawer-avatar">{initials(worker.name)}</div>
        <div>
          <h1>{worker.name}</h1>
          <span className={`badge ${roleTone(worker.role)}`}>{worker.role}</span>
        </div>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && (
        <>
          <div className="drawer-metrics">
            <div className="card center">
              <div className="big">{fmtHours(workedMs(todayEvents))}</div>
              <div className="muted">{t('hours_today')}</div>
            </div>
            <div className="card center">
              <div className="big">{fmtHours(workedMs(weekEvents))}</div>
              <div className="muted">{t('hours_week')}</div>
            </div>
          </div>

          <section className="drawer-section">
            <h2>{t('current_project')}</h2>
            {currentProject ? (
              <button className="drawer-row-button" onClick={() => openProject(currentProject)}>
                <span>{currentProject.name}</span>
                <span className={`badge ${shift.status === 'break' ? 'amber' : 'green'}`}>
                  {shift.status === 'break' ? t('on_break') : t('on_shift')}
                </span>
              </button>
            ) : (
              <div className="card muted">{t('not_on_shift')}</div>
            )}
          </section>

          <section className="drawer-section">
            <h2>{t('recent_activity')}</h2>
            <ActivityList rows={activity} />
          </section>

          <div className="drawer-actions">
            <button className="btn ghost small" onClick={() => { close(); navigate(`/team/${worker.id}`) }}>{t('details')}</button>
            <button className="btn ghost small" onClick={() => { close(); navigate('/messages') }}>{t('write_message')}</button>
            <button className="btn small" onClick={() => { close(); navigate('/dispatch') }}>{t('assign_worker')}</button>
          </div>
        </>
      )}
    </>
  )
}

function ProjectPanel({ project, close, openWorker }: {
  project: Project
  close: () => void
  openWorker: (worker: Profile) => void
}) {
  const { t } = useI18n()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [team, setTeam] = useState<Profile[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [shiftEvents, setShiftEvents] = useState<TimeEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [profits, setProfits] = useState<ProjectProfit[]>([])
  const [photos, setPhotos] = useState<ProjectPhoto[]>([])
  const [tab, setTab] = useState<ProjectDrawerTab>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const manager = profile ? isManagerRole(profile.role) : false

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [people, today, taskRows, profitRows, photoRows, shiftRows] = await Promise.all([
          getTeam(),
          getTodayEvents(),
          getOpenTasks(),
          getProjectProfit(),
          getProjectRecentPhotos(project.id),
          manager ? getProjectShiftEvents(project.id, daysAgoISO(14)) : Promise.resolve([]),
        ])
        if (!mounted) return
        setTeam(people)
        setEvents(today)
        setShiftEvents(shiftRows)
        setTasks(taskRows.filter((task) => task.project_id === project.id))
        setProfits(profitRows)
        setPhotos(photoRows)
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [manager, project.id])

  useEffect(() => {
    setTab('overview')
  }, [project.id])

  const byWorker = useMemo(() => {
    const map = new Map<string, TimeEvent[]>()
    for (const event of events) {
      if (!map.has(event.profile_id)) map.set(event.profile_id, [])
      map.get(event.profile_id)!.push(event)
    }
    return map
  }, [events])

  const onSite = team.filter((worker) => {
    const state = shiftState(byWorker.get(worker.id) ?? [])
    return state.status !== 'off' && state.projectId === project.id
  })
  const profit = profits.find((row) => row.project_id === project.id)
  const margin = profit?.margin_pct === null || profit?.margin_pct === undefined ? '—' : `${Math.round(profit.margin_pct * 10) / 10}%`
  const shiftRows = useMemo(() => projectShiftRows(shiftEvents, team), [shiftEvents, team])

  return (
    <>
      <div className="drawer-hero">
        <div className="drawer-avatar project">📁</div>
        <div>
          <h1>{project.name}</h1>
          <p className="muted">{project.address}</p>
        </div>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && (
        <>
          {manager && (
            <div className="drawer-tabs">
              <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>{t('overview')}</button>
              <button className={tab === 'shifts' ? 'active' : ''} onClick={() => setTab('shifts')}>{t('shifts')}</button>
            </div>
          )}

          {tab === 'overview' && (
            <>
              <div className="drawer-metrics">
                <div className="card center">
                  <div className="big">{margin}</div>
                  <div className="muted">{t('project_margin')}</div>
                </div>
                <div className="card center">
                  <div className="big">{onSite.length}</div>
                  <div className="muted">{t('on_site_now')}</div>
                </div>
              </div>

              <section className="drawer-section">
                <h2>{t('on_site_now')}</h2>
                {onSite.length === 0 && <div className="card muted">{t('nobody_on_site')}</div>}
                {onSite.map((worker) => (
                  <button className="drawer-row-button" key={worker.id} onClick={() => openWorker(worker)}>
                    <span>{worker.name}</span>
                    <span className={`badge ${roleTone(worker.role)}`}>{worker.role}</span>
                  </button>
                ))}
              </section>

              <section className="drawer-section">
                <h2>{t('tasks')}</h2>
                {tasks.length === 0 && <div className="card muted">{t('no_tasks')}</div>}
                {tasks.slice(0, 5).map((task) => (
                  <div className="drawer-task" key={task.id}>
                    <span className={`badge ${task.priority === 'urgent' ? 'red' : task.priority === 'high' ? 'amber' : 'blue'}`}>{task.priority}</span>
                    <span>{task.title}</span>
                  </div>
                ))}
              </section>

              <section className="drawer-section">
                <h2>{t('recent_photos')}</h2>
                {photos.length === 0 && <div className="card muted">{t('no_photos')}</div>}
                {photos.length > 0 && (
                  <div className="drawer-photo-grid">
                    {photos.map((photo) => (
                      <img key={photo.id} src={photo.url} alt={photo.filename ?? t('photo_preview')} />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          {manager && tab === 'shifts' && (
            <section className="drawer-section">
              <h2>{t('shifts')}</h2>
              <ProjectShiftList rows={shiftRows} />
            </section>
          )}

          <div className="drawer-actions">
            <button className="btn ghost small" onClick={() => { close(); navigate('/messages') }}>{t('write_message')}</button>
            <button className="btn small" onClick={() => { close(); navigate('/dispatch') }}>{t('assign_worker')}</button>
          </div>
        </>
      )}
    </>
  )
}
