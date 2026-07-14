import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getBoardProjects,
  getOpenTasks,
  getProjectProfit,
  getProjectClientRatings,
  getProjectCrewCounts,
  getProjectWeekHours,
  getProjectsNotesPreview,
  getTodayEvents,
  createProject,
  updateProject,
  archiveProject,
  geocodeAddress,
  subscribeToTaskChanges,
  captureGPS,
} from '../lib/api'
import { isManagerWrite } from '../lib/types'
import { GPS_RADIUS_MIN, GPS_RADIUS_MAX, GPS_RADIUS_STEP, clampGpsRadius } from '../lib/geofence'
import type { Project, ProjectProfit, Task } from '../lib/types'
import { isEffectiveOpenTask } from '../lib/task-status'
import ProjectNavActions, { CopyAddressButton } from '../components/ProjectNavActions'
import { getDeadlineInfo, statusDotClass, type TrafficStatus } from './project-hub/status'
import { formatProjectCountdown, projectScheduleState, isDateRangeInvalid } from '../lib/project-schedule'
import { fmtHours } from '../lib/time'

// F29: разбираем вставленную пару «широта, долгота» ("47.61, -122.33", "47.61 -122.33").
// Терпим пробелы, знак градуса и ведущую метку до двоеточия; null, если это не чистая валидная пара.
export function parsePastedCoordinatePair(text: string): { lat: number; lng: number } | null {
  if (!text) return null
  let s = text.trim()
  const colon = s.lastIndexOf(':')
  if (colon !== -1) s = s.slice(colon + 1).trim()
  const parts = s.replace(/°/g, ' ').split(/[\s,]+/).filter(Boolean)
  if (parts.length !== 2) return null
  const lat = Number(parts[0])
  const lng = Number(parts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

// PROJ-1b: числовые координаты объекта из проекта (поля бывают number | string | null).
// site_point (PostGIS EWKB) на клиенте не парсится — берём только lat/lng колонки.
function projectCoords(p: Project): { lat: number; lng: number } | null {
  const lat = typeof p.lat === 'string' ? Number(p.lat) : p.lat
  const lng = typeof p.lng === 'string' ? Number(p.lng) : p.lng
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

// $ для плитки МАТЕРИАЛЫ и т.п. — целые доллары (компактно на карточке). null → ничего не показываем.
function formatMoney0(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

// Дата проекта (start_date/end_date хранятся как YYYY-MM-DD) в локальном формате; null если пусто/битая.
function formatCardDate(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString()
}

// Тон бейджа статуса проекта (паритет ProjectHub.statusBadgeClass): активен→зелёный,
// пауза→жёлтый, завершён→синий, иначе серый.
function statusBadgeTone(status: Project['status']): string {
  if (status === 'active') return 'green'
  if (status === 'paused') return 'amber'
  if (status === 'completed') return 'blue'
  return 'grey'
}

// Ранг для сортировки по дедлайну: красные раньше жёлтых раньше зелёных раньше «без дат».
function deadlineRank(p: Project): number {
  const s = getDeadlineInfo(p).status
  return s === 'red' ? 0 : s === 'amber' ? 1 : s === 'green' ? 2 : 3
}

type StatusFilter = 'all' | 'active' | 'paused' | 'completed'
type ProjectSort = 'name' | 'week' | 'deadline'

export default function Projects() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [profits, setProfits] = useState<ProjectProfit[]>([])
  const [clientRatings, setClientRatings] = useState<Map<string, string>>(new Map())
  // PROJ-1: сколько человек сегодня отметилось на объекте (check_in за сегодня), по проекту.
  // Один общий запрос getTodayEvents() на весь список — НЕ N+1.
  const [peopleTodayByProject, setPeopleTodayByProject] = useState<Map<string, number>>(new Map())
  // PROJ-1b: плитки карточки — БРИГАДА / НЕДЕЛЯ / МАТЕРИАЛЫ / ЗАДАЧИ + превью заметок.
  // Каждая карта — ОДИН общий запрос на весь список (свёрнут в Promise.all), НЕ N+1.
  const [crewByProject, setCrewByProject] = useState<Map<string, number>>(new Map())
  const [weekHoursByProject, setWeekHoursByProject] = useState<Map<string, number>>(new Map())
  const [notesByProject, setNotesByProject] = useState<Map<string, { count: number; firstLine: string }>>(new Map())
  // PROJ-1b: контролы над списком — фильтр статуса / сортировка / поиск.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [sortBy, setSortBy] = useState<ProjectSort>('name')
  const [search, setSearch] = useState('')
  const [removeBusyId, setRemoveBusyId] = useState<string | null>(null)
  // PROJ-1b STEP 4: геокодирование адреса в форме (ручная кнопка + автопопытка при сохранении).
  const [geocodeBusy, setGeocodeBusy] = useState(false)
  const [geocodeMsg, setGeocodeMsg] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // F76: id редактируемого проекта (null — форма в режиме создания).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [gpsRadius, setGpsRadius] = useState('')
  // PROJ-2: даты графика проекта в форме создания/правки (YYYY-MM-DD из <input type="date">).
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [geoBusy, setGeoBusy] = useState(false)
  const [geoError, setGeoError] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const [p, tk, pf, todayEv] = await Promise.all([
      getBoardProjects(), getOpenTasks(), getProjectProfit(), getTodayEvents(),
    ])
    const projectIds = p.map((project) => project.id)
    const accountIds = p.map((project) => project.client_account_id).filter(Boolean) as string[]
    // PROJ-1b: клиентские рейтинги + плитки карточек — по ОДНОМУ общему запросу на весь список
    // (свёрнуты в Promise.all, как PROJ-1 свернул getTodayEvents()), без per-card round-trips.
    const [cr, crew, weekHours, notesPrev] = await Promise.all([
      getProjectClientRatings(accountIds),
      getProjectCrewCounts(projectIds),
      getProjectWeekHours(),
      getProjectsNotesPreview(projectIds),
    ])
    // Уникальные работники, отметившиеся сегодня (check_in) на каждом объекте.
    const byProject = new Map<string, Set<string>>()
    for (const ev of todayEv) {
      if (ev.event_type !== 'check_in' || !ev.project_id) continue
      const set = byProject.get(ev.project_id) ?? new Set<string>()
      set.add(ev.profile_id)
      byProject.set(ev.project_id, set)
    }
    const peopleToday = new Map<string, number>()
    for (const [projectId, set] of byProject) peopleToday.set(projectId, set.size)
    setProjects(p); setTasks(tk); setProfits(pf); setClientRatings(cr)
    setPeopleTodayByProject(peopleToday)
    setCrewByProject(crew); setWeekHoursByProject(weekHours); setNotesByProject(notesPrev)
  }
  useEffect(() => { load() }, [profile?.id])
  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => { void load() }, 'tasks:projects')
  }, [profile?.org_id])

  const canWrite = profile ? isManagerWrite(profile.role) : false
  // PROJ-1b: финансовый гейт для плитки МАТЕРИАЛЫ ($) — только owner/admin (ДНК §1), как в
  // FinanceTab/Documents. Цена/финансы НЕ показываются остальным ролям.
  const financeAllowed = profile ? (profile.role === 'owner' || profile.role === 'admin') : false
  // PROJ-2: диапазон дат в форме битый (end<start) — блокируем сохранение + красный хайлайт полей.
  const dateFormInvalid = Boolean(startDate && endDate && endDate < startDate)

  // PROJ-1b: применяем фильтр статуса + поиск + сортировку. Дефолт «active» сохраняет прежний вид
  // (getBoardProjects тянет все статусы, но по умолчанию показываем активные).
  const visibleProjects = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = projects
    if (statusFilter !== 'all') list = list.filter((p) => p.status === statusFilter)
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.address ?? '').toLowerCase().includes(q))
    const sorted = [...list]
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (sortBy === 'week') sorted.sort((a, b) => (weekHoursByProject.get(b.id) ?? 0) - (weekHoursByProject.get(a.id) ?? 0))
    else if (sortBy === 'deadline') sorted.sort((a, b) => deadlineRank(a) - deadlineRank(b) || a.name.localeCompare(b.name))
    return sorted
  }, [projects, statusFilter, search, sortBy, weekHoursByProject])

  const resetForm = () => {
    setName(''); setAddress(''); setLat(''); setLng(''); setGpsRadius(''); setGeoError(false)
    setStartDate(''); setEndDate('')
    setGeocodeMsg(null)
    setAdding(false); setEditingId(null)
  }

  // PROJ-1b STEP 4: ручное «Определить по адресу». Заполняет lat/lng из Google Geocoding.
  // Без ключа (VITE_GOOGLE_GEOCODING_API_KEY) выдаёт понятное сообщение — код готов под ключ.
  const geocodeFromAddress = async () => {
    if (!address.trim()) { setGeocodeMsg('geocode_missing_address'); return }
    setGeocodeBusy(true); setGeocodeMsg(null)
    try {
      const r = await geocodeAddress(address)
      setLat(String(r.lat)); setLng(String(r.lng)); setGeocodeMsg('geocode_ok')
    } catch (err) {
      setGeocodeMsg(err instanceof Error ? err.message : 'geocode_failed')
    } finally {
      setGeocodeBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !name.trim()) return
    // PROJ-2: end_date < start_date — НЕ сохраняем молча; поля уже подсвечены красным (dateFormInvalid).
    if (dateFormInvalid) return
    setBusy(true)
    try {
      let latNum = lat.trim() === '' ? undefined : Number(lat)
      let lngNum = lng.trim() === '' ? undefined : Number(lng)
      // PROJ-1b STEP 4: авто-геокодирование — координат не ввели, но есть адрес → пробуем получить их.
      // Без ключа тихо продолжаем без координат (см. BACKEND REQUEST: geocoding API key).
      if ((latNum === undefined || lngNum === undefined) && address.trim()) {
        try {
          const r = await geocodeAddress(address)
          latNum = r.lat; lngNum = r.lng
        } catch { /* нет ключа/результата — создаём без координат */ }
      }
      const radiusNum = gpsRadius.trim() === '' ? undefined : clampGpsRadius(Number(gpsRadius), GPS_RADIUS_MIN)
      // PROJ-2: даты графика — пустое поле шлём как null (можно очистить дату).
      const dates = { start_date: startDate.trim() || null, end_date: endDate.trim() || null }
      if (editingId) {
        // F76: пишем name/address/gps_radius_m + site_point (если введены новые координаты) + даты графика.
        await updateProject(profile, editingId, { name: name.trim(), address: address.trim(), lat: latNum, lng: lngNum, gpsRadiusM: radiusNum, ...dates })
      } else {
        await createProject(profile, name.trim(), address.trim(), latNum, lngNum, radiusNum, dates)
      }
      resetForm()
      await load()
    } catch { /* показывается пустым — RLS не пустит не-менеджера */ }
    setBusy(false)
  }

  // F76: prefill формы из текущего проекта. Координаты НЕ префилятся: site_point на клиенте
  // лежит как PostGIS hex EWKB и надёжно не парсится — оставляем lat/lng пустыми; site_point
  // перезапишется ТОЛЬКО если менеджер введёт/захватит новые координаты (см. updateProject).
  const startEdit = (src: Project) => {
    setEditingId(src.id)
    setAdding(false)
    setName(src.name)
    setAddress(src.address ?? '')
    setLat(''); setLng('')
    setGpsRadius(src.gps_radius_m != null ? String(src.gps_radius_m) : '')
    // PROJ-2: префилл дат графика. Битый диапазон НЕ правим — просто показываем как есть (красный хайлайт).
    setStartDate(src.start_date ?? '')
    setEndDate(src.end_date ?? '')
    setGeoError(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Копировать проект как шаблон: переносим name (+ « (copy)»), address, gps_radius_m.
  // ЯВНО НЕ переносим геопривязку смены (lat/lng/site_point) — поля координат оставляем пустыми.
  const copyProject = (src: Project) => {
    setName(`${src.name} (copy)`)
    setAddress(src.address ?? '')
    setLat(''); setLng('')
    setGpsRadius(src.gps_radius_m != null ? String(src.gps_radius_m) : '')
    // PROJ-2: шаблон-копия НЕ наследует даты графика — пусть менеджер задаст свежие.
    setStartDate(''); setEndDate('')
    setGeoError(false)
    setEditingId(null)
    setAdding(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // F29: если вставленный текст — валидная пара «широта, долгота», заполняем оба поля.
  // Иначе не мешаем обычной вставке (можно вставить одно число в одно поле).
  const onPasteCoords = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pair = parsePastedCoordinatePair(e.clipboardData.getData('text'))
    if (!pair) return
    e.preventDefault()
    setLat(String(pair.lat)); setLng(String(pair.lng))
  }

  const useMyLocation = async () => {
    setGeoBusy(true)
    setGeoError(false)
    try {
      const geo = await captureGPS()
      if (geo.status === 'off' || geo.lat === null || geo.lng === null) {
        setGeoError(true)
        return
      }
      setLat(String(geo.lat)); setLng(String(geo.lng))
    } finally {
      setGeoBusy(false)
    }
  }

  // PROJ-1b: «Убрать» проект — мягкая архивация (archiveProject). Спрашиваем подтверждение,
  // затем перезагружаем список. RLS не пустит не-менеджера, поэтому ошибку глотаем тихо.
  const removeProject = async (p: Project) => {
    if (!profile) return
    if (typeof window !== 'undefined' && !window.confirm(t('proj_remove_confirm').replace('{name}', p.name))) return
    setRemoveBusyId(p.id)
    try {
      await archiveProject(profile, p.id)
      await load()
    } catch { /* RLS/permission — тихо */ } finally {
      setRemoveBusyId(null)
    }
  }

  // PROJ-2: инлайн-задачи (фото/цепочка материалов) убраны из карточки списка — они живут в
  // /tasks, во вкладке «Задачи» хаба и в дневном «Маршруте». На карточке задачи = только плитка
  // ЗАДАЧИ со счётчиком (deep-link в хаб). Поэтому обработчики done/фото/материалов здесь не нужны.
  const profitFor = (projectId: string) => profits.find((p) => p.project_id === projectId)
  const formatMargin = (value: number) => `${Math.round(value * 10) / 10}%`

  return (
    <div className="screen">
      <h1>📁 {t('projects')}</h1>

      {canWrite && !adding && !editingId && (
        <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('add_project')}</button>
      )}
      {(adding || editingId) && (
        <form onSubmit={submit} className="card">
          {editingId && <h2 style={{ marginTop: 0 }}>{t('edit_project')}</h2>}
          <label>{t('name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t('address')}</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
          {/* PROJ-2: даты графика проекта + валидация диапазона (end<start → красный + блок сохранения). */}
          <div className="row coord-row">
            <div className="coord-field">
              <label>{t('proj_form_start_date')}</label>
              <input type="date" className={dateFormInvalid ? 'input-invalid' : ''} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="coord-field">
              <label>{t('proj_form_end_date')}</label>
              <input type="date" className={dateFormInvalid ? 'input-invalid' : ''} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          {dateFormInvalid && <p className="error-msg">{t('proj_form_date_range_error')}</p>}
          <div className="row coord-row">
            <div className="coord-field">
              <label>{t('project_lat')}</label>
              <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} onPaste={onPasteCoords} />
            </div>
            <div className="coord-field">
              <label>{t('project_lng')}</label>
              <input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} onPaste={onPasteCoords} />
            </div>
          </div>
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('coord_paste_hint')}</p>
          {editingId && <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('edit_coords_hint')}</p>}
          <label>{t('project_gps_radius')}</label>
          <input
            type="number"
            min={GPS_RADIUS_MIN}
            max={GPS_RADIUS_MAX}
            step={GPS_RADIUS_STEP}
            inputMode="numeric"
            value={gpsRadius}
            onChange={(e) => setGpsRadius(e.target.value)}
          />
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('gps_radius_hint')}</p>
          <div className="row">
            <button type="button" className="btn ghost small" disabled={geoBusy} onClick={useMyLocation}>
              {geoBusy ? t('locating') : t('use_my_location')}
            </button>
            <button type="button" className="btn ghost small" disabled={geocodeBusy || !address.trim()} onClick={geocodeFromAddress}>
              {geocodeBusy ? t('geocode_locating') : t('geocode_from_address')}
            </button>
          </div>
          {geocodeMsg && <p className={geocodeMsg === 'geocode_ok' ? 'muted' : 'warn-msg'}>{t(geocodeMsg)}</p>}
          {geoError && <p className="error-msg">{t('location_unavailable')}</p>}
          <div className="row">
            <button className="btn" disabled={busy || !name.trim() || dateFormInvalid}>{editingId ? t('save_changes') : t('create')}</button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={resetForm}>{t('cancel')}</button>
          </div>
        </form>
      )}

      {projects.length > 0 && (
        <div className="projects-controls">
          <div className="projects-filter-tabs">
            {(['all', 'active', 'paused', 'completed'] as StatusFilter[]).map((key) => (
              <button
                key={key}
                type="button"
                className={statusFilter === key ? 'active' : ''}
                onClick={() => setStatusFilter(key)}
              >
                {t(`projects_filter_${key}`)}
              </button>
            ))}
          </div>
          <div className="projects-controls-row">
            <input
              className="projects-search"
              type="search"
              placeholder={t('projects_search_placeholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="projects-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ProjectSort)}
              aria-label={t('projects_sort_label')}
            >
              <option value="name">{t('projects_sort_name')}</option>
              <option value="week">{t('projects_sort_week')}</option>
              <option value="deadline">{t('projects_sort_deadline')}</option>
            </select>
          </div>
          <p className="muted projects-count">
            {t('projects_shown_count').replace('{n}', String(visibleProjects.length)).replace('{m}', String(projects.length))}
          </p>
        </div>
      )}

      {/* PROJ-2: плотная сетка карточек проектов (2 колонки на десктопе, 1 на мобиле), паритет Check Time. */}
      <div className="projects-grid">
      {visibleProjects.map((p) => {
        // ЗАДАЧИ-плитка: считаем открытые задачи проекта. done_at авторитетнее status (паритет Check Time, F81).
        // Сами задачи (фото/цепочка материалов) на карточке НЕ показываем — только счётчик (PROJ-2).
        const ptasks = tasks.filter((tk) => tk.project_id === p.id && isEffectiveOpenTask(tk))
        const profit = profitFor(p.id)
        const showProfit = profit?.margin_pct !== null && profit?.margin_pct !== undefined && profit.profit_status && profit.profit_status !== 'grey'
        const dlInfo = getDeadlineInfo(p)
        const dl = dlInfo.status
        const countdown = p.end_date ? formatProjectCountdown(p.end_date) : ''
        const rating = (p.client_account_id ? clientRatings.get(p.client_account_id) : undefined) as 'green' | 'amber' | 'red' | undefined
        // PROJ-2: третий светофор — МАРЖА. Цвет из profit_status, но ТОЛЬКО для finance-ролей
        // (owner/admin) — иначе здоровье маржи не раскрываем: нейтральная точка (ДНК §1, паритет плитки МАТЕРИАЛЫ).
        const marginDot: TrafficStatus = financeAllowed && profit?.profit_status && profit.profit_status !== 'grey'
          ? (profit.profit_status as TrafficStatus)
          : 'neutral'
        const peopleToday = peopleTodayByProject.get(p.id) ?? 0
        // PROJ-1b: координаты/геозона, плитки, статус-график, превью заметок.
        const coords = projectCoords(p)
        const hasGeofence = Boolean(p.site_point) || coords != null
        const crew = crewByProject.get(p.id) ?? 0
        const weekMs = weekHoursByProject.get(p.id) ?? 0
        const materials = profit?.expenses_cost
        const schedState = projectScheduleState(p)
        const statusLabel = t(`project_status_${p.status}`)
        const startLabel = formatCardDate(p.start_date) ?? '—'
        const endLabel = formatCardDate(p.end_date) ?? '—'
        // PROJ-2: end_date раньше start_date (опечатка в годе) — красный хайлайт + предупреждение, БЕЗ автоправки.
        const datesInvalid = isDateRangeInvalid(p)
        const healthText = dlInfo.daysOverdue != null
          ? t('proj_overdue_days').replace('{n}', String(dlInfo.daysOverdue))
          : `${t(`proj_sched_${schedState}`)}${countdown && countdown !== 'overdue' ? ` · ${countdown}` : ''}`
        const notePrev = notesByProject.get(p.id)
        const noteFirst = notePrev?.firstLine || (p.notes ? (p.notes.split('\n').map((s) => s.trim()).find(Boolean) ?? '') : '')
        const noteCount = notePrev?.count ?? 0
        return (
          <div key={p.id} className="card project-card">
            {/* Заголовок + 3 светофора (срок / маржа / клиент) + обратный отсчёт. */}
            <div className="project-title-row">
              <button className="inline-link project-name-link" onClick={() => navigate(`/projects/${p.id}`)}>{p.name}</button>
              {canWrite && (
                <button className="btn ghost small project-copy-btn" title={t('copy_project')} aria-label={t('copy_project')} onClick={() => copyProject(p)}>📋</button>
              )}
              {canWrite && (
                <button className="btn ghost small project-copy-btn" title={t('edit_project')} aria-label={t('edit_project')} onClick={() => startEdit(p)}>✏️</button>
              )}
              {showProfit && (
                <span className={`profit-badge ${profit.profit_status}`}>
                  <span className="profit-dot" />
                  {formatMargin(profit.margin_pct!)}
                </span>
              )}
              <span className="project-row-dots" aria-hidden="true">
                <span className={statusDotClass(dl)} title={t('hub_deadline')} />
                <span className={statusDotClass(marginDot)} title={t('proj_dot_margin')} />
                <span className={statusDotClass(rating ?? 'neutral')} title={t('hub_client_rating')} />
              </span>
              {countdown && <span className={`schedule-countdown-badge ${dl}`}>{countdown}</span>}
            </div>

            {/* Статус-строка: бейдж статуса · график/просрочка · старт…до (паритет Check Time). */}
            <div className={`project-status-line ${dl}`}>
              <span className={`badge ${statusBadgeTone(p.status)} project-status-badge`}>{statusLabel}</span>
              <span className="project-status-health">{healthText}</span>
              <span className={`muted project-status-dates${datesInvalid ? ' project-dates-invalid' : ''}`}>{t('proj_card_start')} {startLabel} · {t('proj_card_due')} {endLabel}</span>
              {datesInvalid && <span className="badge red project-dates-invalid-badge" title={t('proj_dates_invalid_hint')}>{t('proj_dates_invalid')}</span>}
            </div>

            {/* Адрес + КОПИРОВАТЬ. */}
            {(p.address || coords) && (
              <div className="project-address-line">
                {p.address
                  ? <span className="muted project-card-address">📍 {p.address}</span>
                  : <span className="muted project-card-address">📍 {coords!.lat}, {coords!.lng}</span>}
                {p.address && <CopyAddressButton address={p.address} />}
              </div>
            )}

            {/* Единая строка навигации (В путь / Apple / Google / Tesla-share / Скопировать точку). */}
            <ProjectNavActions project={p} profile={profile} projectName={p.name} address={p.address} lat={coords?.lat ?? null} lng={coords?.lng ?? null} />

            {/* GPS OK / нет границы — отдельным бейджем. */}
            <div className="project-gps-line">
              <span className={`badge ${hasGeofence ? 'green' : 'amber'} project-gps-badge`}>
                {hasGeofence ? t('proj_gps_ok') : t('proj_gps_none')}
              </span>
            </div>

            {/* 4 плитки в один ряд: БРИГАДА / НЕДЕЛЯ / МАТЕРИАЛЫ ($, finance) / ЗАДАЧИ (deep-link в хаб). */}
            <div className="project-stat-tiles">
              <div className="project-stat-tile">
                <span className="muted">{t('proj_tile_crew')}</span>
                <span className="item-title num-display">{crew}</span>
              </div>
              <div className="project-stat-tile">
                <span className="muted">{t('proj_tile_week')}</span>
                <span className="item-title num-display">{fmtHours(weekMs)} {t('h')}</span>
              </div>
              <div className="project-stat-tile" title={financeAllowed ? undefined : t('finance_locked')}>
                <span className="muted">{t('proj_tile_materials')}</span>
                <span className="item-title num-display">{financeAllowed ? (formatMoney0(materials) ?? '—') : '—'}</span>
              </div>
              <button
                type="button"
                className="project-stat-tile as-button"
                title={t('projects_card_open_tasks').replace('{n}', String(ptasks.length))}
                onClick={() => navigate(`/projects/${p.id}`)}
              >
                <span className="muted">{t('proj_tile_tasks')}</span>
                <span className="item-title num-display">{ptasks.length}</span>
              </button>
            </div>

            {/* Заметки (1 строка + счётчик) + чип «сегодня на объекте». */}
            {(noteFirst || noteCount > 0) && (
              <div className="project-notes-preview">
                <span className="muted project-notes-count">📝 {t('proj_notes_count').replace('{n}', String(noteCount))}</span>
                {noteFirst && <span className="project-notes-first">{noteFirst}</span>}
              </div>
            )}
            {peopleToday > 0 && (
              <div className="project-card-meta">
                <span
                  className="project-card-chip on-site"
                  title={t('projects_card_people_today').replace('{n}', String(peopleToday))}
                >
                  👷 {peopleToday}
                </span>
              </div>
            )}

            {/* Действия карточки — Подробности / Редактировать / Убрать. */}
            <div className="project-card-actions">
              <button type="button" className="btn small" onClick={() => navigate(`/projects/${p.id}`)}>{t('proj_action_details')}</button>
              {canWrite && <button type="button" className="btn ghost small" onClick={() => startEdit(p)}>{t('proj_action_edit')}</button>}
              {canWrite && (
                <button type="button" className="btn ghost small project-remove-btn" disabled={removeBusyId === p.id} onClick={() => removeProject(p)}>
                  {t('proj_action_remove')}
                </button>
              )}
            </div>
          </div>
        )
      })}
      </div>
    </div>
  )
}
