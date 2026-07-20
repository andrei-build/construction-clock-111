import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  addProjectExclusion,
  assignWorkerToProject,
  createTimeAdjustment,
  getProjectAssignments,
  getProjectExclusions,
  getProjects,
  getUserCapabilities,
  getVisibleProfileRates,
  getWorkerDayClosedTasks,
  getWorkerDayPhotos,
  getWorkerDayTimeEvents,
  getWorkerIntervals,
  getWorkerLocationConsents,
  getAppSettings,
  getCurrentPayPeriod,
  getWorkerProfile,
  getProfileFiles,
  uploadProfileFileToR2,
  getProjectFileDownloadUrl,
  getWorkerSafetyAcks,
  getWorkerTimeEvents,
  type WorkerDayClosedTask,
  type WorkerDayPhoto,
  type WorkerLocationConsentRow,
  type WorkerSafetyAckRow,
  purgeProfile,
  removeProjectExclusion,
  setMemberPassword,
  setProjectAccessMode,
  setUserCapability,
  setWorkerActive,
  setWorkerPin,
  setWorkerRate,
  unassignWorkerFromProject,
  updateWorkerProfileSettings,
  updateWorkerSkills,
  uploadAvatar,
  updateWorkerPublicProfile,
  updateWorkerDossier,
  getSubcontractorDetails,
  upsertSubcontractorDetails,
  createPpeRequest,
  uploadErrorCode,
} from '../lib/api'
import { currentSafetyVersion, isAckCurrent } from '../lib/safety'
import { fmtClock, fmtHours, computeTravelGaps, intervalsToTravelShifts, DEFAULT_PAID_GAP_ALERT_HOURS } from '../lib/time'
import { computeTransferGaps } from '../lib/shift-gaps'
import { canAssignRole, isManagerRole, isManagerWrite, type AppSettings, type FileRow, type PayPeriod, type Profile, type ProfileRate, type Project, type ProjectAssignment, type ProjectExclusion, type Role, type TimeEvent, type UserCapability, type WorkInterval } from '../lib/types'
import MessageComposer from '../components/MessageComposer'
import VoiceMic from '../components/VoiceMic'

const ELEVEN_HOURS_MS = 11 * 60 * 60 * 1000

// TEAM-2: инициалы для запасного (без фото) круглого аватара.
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '👷'
}

const roleOptions: Role[] = ['worker', 'driver', 'supervisor', 'manager', 'subcontractor', 'sales', 'admin', 'owner']

// ACC-4: роли, которые входят по email+паролю (для них владелец задаёт пароль). PIN-работники
// (worker/driver и т.п.) входят по PIN — им пароль не задаём, блок «Доступ» не показываем.
const EMAIL_ROLES: Role[] = ['owner', 'admin', 'manager', 'sales']

// ACC-4: генератор читаемого пароля (без похожих символов 0/O/1/l) через crypto — для helper «Сгенерировать».
function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const arr = new Uint32Array(12)
  crypto.getRandomValues(arr)
  return Array.from(arr, (n) => chars[n % chars.length]).join('')
}

// TEAM-PIN-UI: случайный 6-значный PIN через crypto для кнопки-генератора в модалке сброса PIN.
// PIN — строка цифр (ведущий 0 допустим); длину 4–8 гейтит валидация ввода.
function generatePin(): string {
  const arr = new Uint32Array(6)
  crypto.getRandomValues(arr)
  return Array.from(arr, (n) => String(n % 10)).join('')
}

// Гибкие права (capabilities), которые владелец/админ выдаёт поверх роли. Пока только доступ к финансам.
const CAPABILITIES: { key: string; labelKey: string; hintKey: string }[] = [
  { key: 'finance_access', labelKey: 'cap_finance_access', hintKey: 'cap_finance_access_hint' },
  { key: 'upload_receipts', labelKey: 'cap_upload_receipts', hintKey: 'cap_upload_receipts_hint' },
  { key: 'view_all_projects_map', labelKey: 'cap_view_all_projects_map', hintKey: 'cap_view_all_projects_map_hint' },
  { key: 'view_supply_stores', labelKey: 'cap_view_supply_stores', hintKey: 'cap_view_supply_stores_hint' },
  { key: 'flag_media', labelKey: 'cap_flag_media', hintKey: 'cap_flag_media_hint' },
]

type BusyKey = 'settings' | 'access' | 'adjustment' | string | null

interface IntervalRow {
  key: string
  interval: WorkInterval
  projectName: string
  hoursMs: number
}

// Ленивая подгрузка «деталей дня» (фото + закрытые задачи) — кэшируется по ключу дня.
interface DayDetail {
  state: 'loading' | 'ready' | 'error'
  photos: WorkerDayPhoto[]
  tasks: WorkerDayClosedTask[]
  // F13: есть ли в этот день отметка с непроверенной локацией (metadata.needs_review/location_unverified).
  needsReview: boolean
}

function startOfDay(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function startOfWeek(date: Date) {
  const d = startOfDay(date)
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day)
  return d
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function startOfNextMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1)
}

function intervalEnd(interval: WorkInterval, now: number) {
  return interval.end_at ? new Date(interval.end_at).getTime() : now
}

// Часы интервалов, попавших в окно [start, end); открытые интервалы считаются до "сейчас"
function rangeIntervalMs(intervals: WorkInterval[], start: Date, end: Date, now: number) {
  const rangeStart = start.getTime()
  const rangeEnd = end.getTime()
  let total = 0
  for (const interval of intervals) {
    const clipStart = Math.max(new Date(interval.start_at).getTime(), rangeStart)
    const clipEnd = Math.min(intervalEnd(interval, now), rangeEnd)
    if (clipEnd > clipStart) total += clipEnd - clipStart
  }
  return total
}

function totalIntervalMs(intervals: WorkInterval[], now: number) {
  let total = 0
  for (const interval of intervals) {
    total += Math.max(0, intervalEnd(interval, now) - new Date(interval.start_at).getTime())
  }
  return total
}

function toDatetimeLocal(iso: string) {
  const date = new Date(iso)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function fromDatetimeLocal(value: string) {
  return new Date(value).toISOString()
}

function dateLabel(iso: string) {
  return new Date(iso).toLocaleDateString()
}

// Размер файла для списка личных документов (как экран «Файлы»).
function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// DOC-EXPIRY-UI: пороги подсветки истечения документа работника (по files.expires_at, date).
const DOC_EXPIRY_URGENT_DAYS = 7 // ≤7 дн. (и уже просрочено) — красный «работать нельзя»
const DOC_EXPIRY_SOON_DAYS = 30 // 8–30 дн. — янтарный «скоро»
const DOC_DAY_MS = 24 * 60 * 60 * 1000

// Дней до истечения по ЛОКАЛЬНОЙ дате (YYYY-MM-DD). Отрицательное — уже просрочено. Как в Files.tsx.
function daysUntilExpiry(expiresAt: string): number {
  const target = new Date(`${expiresAt}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / DOC_DAY_MS)
}

type DocExpiryLevel = 'expired' | 'urgent' | 'soon' | null
// Уровень подсветки строки: null (обычный), 'soon' (8–30д), 'urgent' (≤7д), 'expired' (<0).
function docExpiryLevel(expiresAt: string | null): DocExpiryLevel {
  if (!expiresAt) return null
  const d = daysUntilExpiry(expiresAt)
  if (d < 0) return 'expired'
  if (d <= DOC_EXPIRY_URGENT_DAYS) return 'urgent'
  if (d <= DOC_EXPIRY_SOON_DAYS) return 'soon'
  return null
}

// F15: разрыв перехода как «Nh Mm» — только для показа, часы/оплату не трогает.
function fmtGapDuration(ms: number) {
  const totalMin = Math.round(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}h ${m}m`
}

// Строки смен строятся из v_work_intervals (корректировки менеджера уже применены), новейшие сверху
function intervalRows(intervals: WorkInterval[], projects: Project[], now: number): IntervalRow[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  return intervals.map((interval) => ({
    key: `${interval.start_event_id}-${interval.end_event_id ?? 'open'}`,
    interval,
    projectName: interval.project_id ? projectNames.get(interval.project_id) ?? interval.project_id : '—',
    hoursMs: Math.max(0, intervalEnd(interval, now) - new Date(interval.start_at).getTime()),
  }))
}

export default function WorkerDetail() {
  const { id } = useParams()
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const [worker, setWorker] = useState<Profile | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [intervals, setIntervals] = useState<WorkInterval[]>([])
  const [rates, setRates] = useState<ProfileRate[]>([])
  const [timezone, setTimezone] = useState<string | null>(null)
  const [alertHours, setAlertHours] = useState(DEFAULT_PAID_GAP_ALERT_HOURS)
  const [assignments, setAssignments] = useState<ProjectAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<BusyKey>(null)
  const [now, setNow] = useState(() => Date.now())

  // «Детали дня»: раскрытая дата и кэш загруженных деталей по ключу дня.
  const [expandedDay, setExpandedDay] = useState<string | null>(null)
  const [dayDetails, setDayDetails] = useState<Record<string, DayDetail>>({})
  const [activeDayPhotoUrl, setActiveDayPhotoUrl] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('worker')
  const [rateInput, setRateInput] = useState('')
  const [requireVideo, setRequireVideo] = useState(false)
  const [pinEnabled, setPinEnabled] = useState(false)
  // TEAM-PIN-UI: модалка «Сбросить PIN» — новый PIN (4–8 цифр) + генератор; pinMsg — ошибка/успех
  // внутри модалки (в т.ч. 409 pin_taken, при котором модалку НЕ закрываем).
  const [pinModalOpen, setPinModalOpen] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinMsg, setPinMsg] = useState<string | null>(null)
  const [accessMode, setAccessMode] = useState<Profile['project_access_mode']>('assigned')
  const [exclusions, setExclusions] = useState<ProjectExclusion[]>([])
  const [excludePick, setExcludePick] = useState('')

  const [capabilities, setCapabilities] = useState<UserCapability[]>([])

  // ACC-4: владелец задаёт пароль сотруднику (email-роль) + переключатель «может менять сам».
  const [memberPw, setMemberPw] = useState('')
  const [memberPwShow, setMemberPwShow] = useState(false)
  const [memberPwMsg, setMemberPwMsg] = useState<string | null>(null)

  // TEAM-1: навыки для ИИ-распределения (profiles.skills — text, храним как чипы через запятую)
  // и заметка по способностям (profiles.skills_note — text).
  const [skillsChips, setSkillsChips] = useState<string[]>([])
  const [skillDraft, setSkillDraft] = useState('')
  const [skillsNote, setSkillsNote] = useState('')

  // TEAM-2: клиент-facing публичный профиль — аватар (public bucket) + описание (public_bio).
  // ТОЛЬКО эти поля видит клиент; контакты/навыки остаются внутренними.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [publicBio, setPublicBio] = useState('')
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // TEAM-DOSSIER-1: контакты читаются из profile_contact; кадровые поля — из profile_dossier.
  // Сохранение идёт через data-access helper с раздельными RLS-запросами.
  // dossier_notes («заметки владельца») — только manager+ (экран уже гейтит canView).
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [homeAddress, setHomeAddress] = useState('')
  const [emergencyContact, setEmergencyContact] = useState('')
  const [hireDate, setHireDate] = useState('')
  const [dossierNotes, setDossierNotes] = useState('')
  const [dossierLang, setDossierLang] = useState('')

  // TEAM-DOSSIER-1: реквизиты субподрядчика (subcontractor_details) — только owner, role=subcontractor.
  const [subTrade, setSubTrade] = useState('')
  const [subLicense, setSubLicense] = useState('')
  const [subInsurance, setSubInsurance] = useState('')
  const [subPaymentTerms, setSubPaymentTerms] = useState('')
  const [subNotes, setSubNotes] = useState('')

  // TEAM-1: показатели за неделю (GPS/без GPS, закрытые задачи) + текущий период оплаты (только чтение).
  const [gpsWeek, setGpsWeek] = useState<{ withGps: number; withoutGps: number } | null>(null)
  const [weekTaskCount, setWeekTaskCount] = useState<number | null>(null)
  const [payPeriod, setPayPeriod] = useState<PayPeriod | null>(null)

  // WF-1: «Документы и согласия» — GPS-согласия, подписи ТБ, личные файлы этого работника.
  const [consents, setConsents] = useState<WorkerLocationConsentRow[]>([])
  const [safetyAcks, setSafetyAcks] = useState<WorkerSafetyAckRow[]>([])
  const [profileFiles, setProfileFiles] = useState<FileRow[]>([])
  const [docsState, setDocsState] = useState<'loading' | 'ready' | 'error'>('loading')
  // DOC-EXPIRY-UI: черновик типа документа + «действует до» для следующей загрузки файла работника.
  const [docKindDraft, setDocKindDraft] = useState('')
  const [docExpiresDraft, setDocExpiresDraft] = useState('')
  // SAFETY-2: текущая версия свода ТБ (для метки «Актуально/Устарело») + заказ СИЗ работнику.
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [ppeBusy, setPpeBusy] = useState(false)
  const [ppeMsg, setPpeMsg] = useState<string | null>(null)

  // TRASH-3: владелец удаляет человека безвозвратно (RPC purge_profile). Двойное подтверждение —
  // раскрыть панель + вписать точное имя. Гейт клиента ниже (canPurge), финально гейтит БД.
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgeConfirmName, setPurgeConfirmName] = useState('')
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null)

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [adjustIn, setAdjustIn] = useState('')
  const [adjustOut, setAdjustOut] = useState('')
  const [adjustReason, setAdjustReason] = useState('')
  // M6: показать ли комментарий корректировки работнику («Мои часы»). По умолчанию — выключено.
  const [adjustShowToWorker, setAdjustShowToWorker] = useState(false)

  const canView = profile ? isManagerRole(profile.role) : false
  const canEditProfile = profile ? isManagerWrite(profile.role) : false
  // TRASH-3: кнопку «Удалить безвозвратно» видит ТОЛЬКО владелец и НЕ на самом себе. Прочие гарантии
  // (человек в корзине, нет оплаченной истории) гейтит RPC purge_profile — коды показываем как i18n.
  const canPurge = profile?.role === 'owner' && !!worker && worker.id !== profile.id
  // ДНК §1: finance_access выдаёт ТОЛЬКО owner/admin — не manager. Проверяем роль явно.
  const canManageCapabilities = profile ? (profile.role === 'owner' || profile.role === 'admin') : false
  // ACC-4: блок «Доступ» (задать пароль + переключатель самосмены) — ТОЛЬКО владелец И только для
  // сотрудника с email-ролью. PIN-работникам пароль не задаём. Запрет «owner ставит пароль owner'у»
  // (в т.ч. себе) финально гейтит edge (owner_changes_own_password) — тут коды просто показываем.
  const canSetMemberPassword = profile?.role === 'owner' && !!worker && EMAIL_ROLES.includes(worker.role)
  // ACC-4: текущее состояние права самосмены пароля (грузится вместе с прочими capabilities для owner/admin).
  const canChangePwGranted = capabilities.some((row) => row.capability === 'can_change_password' && row.granted)
  // TEAM-DOSSIER-1: секция реквизитов субподрядчика — ТОЛЬКО owner и ТОЛЬКО для role='subcontractor'.
  // RLS sub_write дублирует гейт на сервере; UI показывает секцию лишь владельцу.
  const canViewSubcontractor = profile?.role === 'owner' && worker?.role === 'subcontractor'

  // F3: гейт назначения ролей. Показываем только роли, которые актёр вправе назначить,
  // плюс всегда оставляем видимой ТЕКУЩУЮ роль работника (иначе <select> её не отрендерит),
  // но такую неназначаемую опцию держим disabled. Так менеджер не может повысить до owner/admin/driver.
  const actorRole = profile?.role
  const roleSelectOptions = roleOptions.filter(
    (option) => option === worker?.role || (actorRole ? canAssignRole(actorRole, option) : false),
  )

  const load = async () => {
    if (!id) return
    setLoading(true)
    setError(false)
    try {
      const [workerRow, projectRows, intervalRowsData, rateRows, settings] = await Promise.all([
        getWorkerProfile(id),
        getProjects(),
        getWorkerIntervals(id),
        getVisibleProfileRates(),
        getAppSettings(),
      ])
      const assignmentRows = await getProjectAssignments(projectRows.map((project) => project.id))
      setWorker(workerRow)
      setProjects(projectRows)
      setIntervals(intervalRowsData)
      setRates(rateRows)
      // G1: часовой пояс организации + порог оповещения о разрыве (для время-в-пути).
      const tz = settings?.timezone?.trim()
      setTimezone(tz ? tz : null)
      const gapAlert = Number(settings?.paid_gap_alert_hours)
      setAlertHours(Number.isFinite(gapAlert) && gapAlert > 0 ? gapAlert : DEFAULT_PAID_GAP_ALERT_HOURS)
      setAssignments(assignmentRows)
      if (workerRow) {
        setName(workerRow.name)
        setRole(workerRow.role)
        setRequireVideo(Boolean(workerRow.require_checkout_video))
        // TEAM-PIN-UI: значение тумблера «вход по PIN» читаем прямо из профиля (profiles.pin_enabled).
        setPinEnabled(Boolean(workerRow.pin_enabled))
        setAccessMode(workerRow.project_access_mode ?? 'assigned')
        // TEAM-1: skills — text-колонка; чипы через запятую. Пустые токены отбрасываем.
        setSkillsChips((workerRow.skills ?? '').split(',').map((s) => s.trim()).filter(Boolean))
        setSkillsNote(workerRow.skills_note ?? '')
        // TEAM-2: клиент-facing поля.
        setAvatarUrl(workerRow.avatar_url ?? null)
        setPublicBio(workerRow.public_bio ?? '')
        // TEAM-DOSSIER-1: контактные/кадровые поля уже склеены data-access helper-ом.
        setPhone(workerRow.phone ?? '')
        setEmail(workerRow.email ?? '')
        setHomeAddress(workerRow.home_address ?? '')
        setEmergencyContact(workerRow.emergency_contact ?? '')
        setHireDate(workerRow.hire_date ?? '')
        setDossierNotes(workerRow.dossier_notes ?? '')
        setDossierLang(workerRow.language ?? '')
        const rate = rateRows.find((row) => row.profile_id === workerRow.id)
        setRateInput(rate?.hourly_rate === null || rate?.hourly_rate === undefined ? '' : String(rate.hourly_rate))
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id, profile?.id])

  // Права грузим отдельно и только когда гейт пройден (owner/admin)
  useEffect(() => {
    if (!id || !canManageCapabilities) { setCapabilities([]); return }
    let active = true
    getUserCapabilities(id).then((rows) => { if (active) setCapabilities(rows) })
    return () => { active = false }
  }, [id, canManageCapabilities])

  // Исключения проектов нужны только в режиме 'all_active' — грузим отдельно по смене режима
  useEffect(() => {
    if (!id || accessMode !== 'all_active') { setExclusions([]); return }
    let active = true
    getProjectExclusions(id).then((rows) => { if (active) setExclusions(rows) })
    return () => { active = false }
  }, [id, accessMode])

  // WF-1: документы и согласия работника — грузим отдельно (RLS уже гейтит доступ на сервере).
  useEffect(() => {
    if (!id) return
    let active = true
    setDocsState('loading')
    Promise.all([
      getWorkerLocationConsents(id),
      getWorkerSafetyAcks(id),
      getProfileFiles(id),
      getAppSettings(),
    ])
      .then(([consentRows, ackRows, fileRows, settingsRow]) => {
        if (!active) return
        setConsents(consentRows)
        setSafetyAcks(ackRows)
        setProfileFiles(fileRows)
        setAppSettings(settingsRow)
        setDocsState('ready')
      })
      .catch(() => { if (active) setDocsState('error') })
    return () => { active = false }
  }, [id])

  // SAFETY-2 «Заказать СИЗ»: менеджер/владелец из досье заводит материальную заявку на СИЗ этому
  // работнику (без объекта — projectId null) → уйдёт в Доставки. Best-effort, не блокирует экран.
  const orderPpeForWorker = async () => {
    if (!profile || !worker || ppeBusy) return
    setPpeBusy(true)
    setPpeMsg(null)
    try {
      await createPpeRequest(profile, { projectId: null, title: `${t('ppe_order_title')} — ${worker.name}` })
      setPpeMsg('ppe_ordered')
    } catch {
      setPpeMsg('error')
    } finally {
      setPpeBusy(false)
    }
  }

  // TEAM-1: показатели за неделю (GPS/без GPS по отметкам входа) + закрытые задачи недели
  // + текущий период оплаты. Только чтение; считаем один раз при смене работника.
  useEffect(() => {
    if (!id) return
    let active = true
    const weekFrom = startOfWeek(new Date())
    const weekTo = addDays(weekFrom, 7)
    Promise.all([
      getWorkerTimeEvents(id),
      getWorkerDayClosedTasks(id, weekFrom.toISOString(), weekTo.toISOString()),
      getCurrentPayPeriod(),
    ])
      .then(([events, weekTasks, period]) => {
        if (!active) return
        // GPS-статистика недели: считаем только отметки входа (check_in) в окне недели.
        const inWeek = (e: TimeEvent) => {
          const ts = new Date(e.event_time).getTime()
          return e.event_type === 'check_in' && ts >= weekFrom.getTime() && ts < weekTo.getTime()
        }
        let withGps = 0
        let withoutGps = 0
        for (const e of events) {
          if (!inWeek(e)) continue
          // По всему приложению «есть GPS» = gps_status 'good'; остальное (off/null) — без GPS.
          if (e.gps_status === 'good') withGps += 1
          else withoutGps += 1
        }
        setGpsWeek({ withGps, withoutGps })
        setWeekTaskCount(weekTasks.length)
        setPayPeriod(period)
      })
      .catch(() => {
        if (!active) return
        setGpsWeek(null)
        setWeekTaskCount(null)
        setPayPeriod(null)
      })
    return () => { active = false }
  }, [id])

  // TEAM-DOSSIER-1: реквизиты субподрядчика — грузим только когда гейт пройден (owner + subcontractor).
  useEffect(() => {
    if (!id || !canViewSubcontractor) {
      setSubTrade(''); setSubLicense(''); setSubInsurance(''); setSubPaymentTerms(''); setSubNotes('')
      return
    }
    let active = true
    getSubcontractorDetails(id).then((row) => {
      if (!active) return
      setSubTrade(row?.trade ?? '')
      setSubLicense(row?.license_number ?? '')
      setSubInsurance(row?.insurance_expires ?? '')
      setSubPaymentTerms(row?.payment_terms ?? '')
      setSubNotes(row?.notes ?? '')
    })
    return () => { active = false }
  }, [id, canViewSubcontractor])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  // F15: обзорные чипы разрывов перехода между проектами в один день (только показ, не меняет часы).
  const transferGaps = useMemo(() => computeTransferGaps(intervals), [intervals])

  // G1: оплачиваемое время в пути — разрывы между сменами в один org-local день (входит в часы).
  const travelGaps = useMemo(
    () => computeTravelGaps(intervalsToTravelShifts(intervals), timezone, alertHours),
    [intervals, timezone, alertHours],
  )
  const travelTotalMs = useMemo(() => travelGaps.reduce((acc, g) => acc + (g.endMs - g.startMs), 0), [travelGaps])
  const travelHasOverAlert = useMemo(() => travelGaps.some((g) => g.overAlert), [travelGaps])

  if (!canView) return <Navigate to="/" />

  const today = startOfDay(new Date(now))
  const tomorrow = addDays(today, 1)
  const yesterday = addDays(today, -1)
  const weekStart = startOfWeek(new Date(now))
  const lastWeekStart = addDays(weekStart, -7)
  const monthStart = startOfMonth(new Date(now))
  const shifts = intervalRows(intervals, projects, now)
  const latestShifts = shifts.slice(0, 10)
  const ratesVisible = rates.length > 0
  const assignmentSet = new Set(assignments.filter((row) => row.profile_id === worker?.id).map((row) => row.project_id))
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const excludedSet = new Set(exclusions.map((row) => row.project_id))
  // В пикер «Исключить» кладём только активные проекты, ещё не попавшие в исключения
  const excludableProjects = projects.filter((project) => !excludedSet.has(project.id))

  const tiles = [
    { key: 'today', label: t('today'), value: rangeIntervalMs(intervals, today, tomorrow, now) },
    { key: 'yesterday', label: t('yesterday'), value: rangeIntervalMs(intervals, yesterday, today, now) },
    { key: 'current_week', label: t('current_week'), value: rangeIntervalMs(intervals, weekStart, addDays(weekStart, 7), now) },
    { key: 'last_week', label: t('last_week'), value: rangeIntervalMs(intervals, lastWeekStart, weekStart, now) },
    { key: 'month', label: t('month'), value: rangeIntervalMs(intervals, monthStart, startOfNextMonth(monthStart), now) },
    { key: 'all_time', label: t('all_time'), value: totalIntervalMs(intervals, now) },
  ]

  // TEAM-1: плитки-показатели. Метрики без источника показываем как «—» (не выдумываем).
  const currentWeekMs = rangeIntervalMs(intervals, weekStart, addDays(weekStart, 7), now)
  const onShiftNow = intervals.some((iv) => !iv.end_at)
  const rateRow = rates.find((row) => row.profile_id === worker?.id)
  const rateValue = rateRow?.hourly_rate ?? null
  const statTiles: { key: string; label: string; value: string }[] = [
    { key: 'week', label: t('week'), value: `${fmtHours(currentWeekMs)} ${t('h')}` },
    { key: 'tasks', label: t('tasks'), value: weekTaskCount === null ? '—' : String(weekTaskCount) },
    { key: 'on_shift', label: t('on_shift'), value: onShiftNow ? t('stat_on_shift_yes') : t('stat_on_shift_no') },
    ...(ratesVisible ? [{ key: 'rate', label: t('rate'), value: rateValue === null ? '—' : `$${rateValue}` }] : []),
    { key: 'with_gps', label: t('stat_with_gps'), value: gpsWeek === null ? '—' : String(gpsWeek.withGps) },
    { key: 'without_gps', label: t('stat_without_gps'), value: gpsWeek === null ? '—' : String(gpsWeek.withoutGps) },
  ]

  // TEAM-1: текущий период оплаты (только чтение, finance-gated через ratesVisible).
  // Не оплачено = часы работника в окне периода × ставка; корректировки = число исправленных смен в окне.
  const payPeriodEnd = payPeriod ? addDays(new Date(payPeriod.period_end), 1) : null
  const payUnpaid = payPeriod && payPeriodEnd && rateValue !== null
    ? (rangeIntervalMs(intervals, new Date(payPeriod.period_start), payPeriodEnd, now) / 3600000) * rateValue
    : null
  const payAdjustments = payPeriod && payPeriodEnd
    ? intervals.filter((iv) => {
        if (!iv.was_adjusted) return false
        const ts = new Date(iv.start_at).getTime()
        return ts >= new Date(payPeriod.period_start).getTime() && ts < payPeriodEnd.getTime()
      }).length
    : 0
  const payStatusKey = payPeriod?.status === 'paid'
    ? 'pay_status_paid'
    : (payPeriod?.status === 'approved' || payPeriod?.status === 'closed')
      ? 'pay_status_closed'
      : 'pay_status_open'

  const dailyRows = Array.from({ length: 7 }, (_, index) => {
    const start = addDays(today, -index)
    const end = addDays(start, 1)
    const hoursMs = rangeIntervalMs(intervals, start, end, now)
    // G1: время в пути этого дня — разрывы, чей уход (startMs) попал в окно суток.
    const startMs = start.getTime()
    const endMs = end.getTime()
    const dayGaps = travelGaps.filter((g) => g.startMs >= startMs && g.startMs < endMs)
    const travelMs = dayGaps.reduce((acc, g) => acc + (g.endMs - g.startMs), 0)
    const travelOverAlert = dayGaps.some((g) => g.overAlert)
    // Границы суток в ISO (в локальной TZ экрана) — их передаём в детали дня.
    return { key: start.toISOString(), label: start.toLocaleDateString(), hoursMs, travelMs, travelOverAlert, startISO: start.toISOString(), endISO: end.toISOString() }
  })

  // Раскрыть/свернуть день; при первом раскрытии — ленивая загрузка фото и закрытых задач (guard по кэшу).
  const toggleDay = (day: { key: string; startISO: string; endISO: string }) => {
    if (expandedDay === day.key) { setExpandedDay(null); return }
    setExpandedDay(day.key)
    if (!id || dayDetails[day.key]) return
    setDayDetails((prev) => ({ ...prev, [day.key]: { state: 'loading', photos: [], tasks: [], needsReview: false } }))
    Promise.all([
      getWorkerDayPhotos(id, day.startISO, day.endISO),
      getWorkerDayClosedTasks(id, day.startISO, day.endISO),
      getWorkerDayTimeEvents(id, day.startISO, day.endISO),
    ])
      .then(([photos, tasks, events]) => {
        // F13: только показ — часы/оплату не трогаем; флаг из additive-метаданных отметок.
        const needsReview = events.some((e) => Boolean(e.metadata?.needs_review) || Boolean(e.metadata?.location_unverified))
        setDayDetails((prev) => ({ ...prev, [day.key]: { state: 'ready', photos, tasks, needsReview } }))
      })
      .catch(() => {
        setDayDetails((prev) => ({ ...prev, [day.key]: { state: 'error', photos: [], tasks: [], needsReview: false } }))
      })
  }

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !worker || !canEditProfile || busy) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setMsg('name_required')
      return
    }
    const hourlyRate = rateInput.trim() === '' ? null : Number(rateInput)
    if (ratesVisible && hourlyRate !== null && Number.isNaN(hourlyRate)) {
      setMsg('rate_invalid')
      return
    }
    setBusy('settings')
    setMsg(null)
    try {
      await updateWorkerProfileSettings(profile, worker.id, {
        name: trimmedName,
        role,
        require_checkout_video: requireVideo,
      })
      if (ratesVisible) await setWorkerRate(profile, worker.id, hourlyRate)
      setMsg('worker_profile_saved')
      await load()
    } catch {
      setMsg('worker_profile_save_failed')
    } finally {
      setBusy(null)
    }
  }

  const changeAccessMode = async (next: Profile['project_access_mode']) => {
    if (!profile || !worker || !canEditProfile || busy) return
    const previous = accessMode
    setAccessMode(next)
    setBusy('access')
    setMsg(null)
    try {
      await setProjectAccessMode(profile, worker.id, next)
      setMsg('project_access_saved')
    } catch {
      setAccessMode(previous)
      setMsg('project_access_failed')
    } finally {
      setBusy(null)
    }
  }

  // Исключить проект из доступа (режим 'all_active'). Обновляем список после записи.
  const excludeProject = async (projectId: string) => {
    if (!profile || !worker || !canEditProfile || busy || !projectId) return
    setBusy(`excl:${projectId}`)
    setMsg(null)
    try {
      await addProjectExclusion(profile, worker.id, projectId)
      setExclusions(await getProjectExclusions(worker.id))
      setExcludePick('')
      setMsg('project_access_saved')
    } catch {
      setMsg('project_access_failed')
    } finally {
      setBusy(null)
    }
  }

  // Вернуть проект в доступ — удалить строку исключения.
  const includeProject = async (projectId: string) => {
    if (!profile || !worker || !canEditProfile || busy) return
    setBusy(`incl:${projectId}`)
    setMsg(null)
    try {
      await removeProjectExclusion(profile, worker.id, projectId)
      setExclusions(await getProjectExclusions(worker.id))
      setMsg('project_access_saved')
    } catch {
      setMsg('project_access_failed')
    } finally {
      setBusy(null)
    }
  }

  const toggleProject = async (projectId: string, checked: boolean) => {
    if (!profile || !worker || busy) return
    setBusy(projectId)
    setMsg(null)
    try {
      if (checked) await assignWorkerToProject(profile, projectId, worker.id)
      else await unassignWorkerFromProject(profile, projectId, worker.id)
      const assignmentRows = await getProjectAssignments(projects.map((project) => project.id))
      setAssignments(assignmentRows)
      setMsg('project_access_saved')
    } catch {
      setMsg('project_access_failed')
    } finally {
      setBusy(null)
    }
  }

  const toggleCapability = async (capability: string, next: boolean) => {
    if (!profile || !worker || !canManageCapabilities || busy) return
    setBusy(`cap:${capability}`)
    setMsg(null)
    try {
      await setUserCapability(profile, worker.id, capability, next)
      setCapabilities(await getUserCapabilities(worker.id))
      setMsg('cap_saved')
    } catch {
      setMsg('cap_failed')
    } finally {
      setBusy(null)
    }
  }

  // ACC-4: владелец задаёт пароль сотруднику через edge set-member-password. На {ok:true} — чистим
  // поле и показываем успех; коды ошибок edge — это i18n-ключи (маппит api/team.ts).
  const submitMemberPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!worker || !canSetMemberPassword || busy) return
    if (memberPw.length < 8) { setMemberPwMsg('bad_input_password_min_8'); return }
    setBusy('set_password')
    setMemberPwMsg(null)
    try {
      const res = await setMemberPassword(worker.id, memberPw)
      if (res.ok) {
        setMemberPw('')
        setMemberPwShow(false)
        setMemberPwMsg('set_pw_success')
      } else {
        setMemberPwMsg(res.error ?? 'set_pw_failed')
      }
    } catch {
      setMemberPwMsg('set_pw_failed')
    } finally {
      setBusy(null)
    }
  }

  // ACC-4: переключатель «может менять пароль сам» — upsert user_capabilities can_change_password.
  const toggleSelfPasswordChange = async (next: boolean) => {
    if (!profile || !worker || !canSetMemberPassword || busy) return
    setBusy('cap:can_change_password')
    setMemberPwMsg(null)
    try {
      await setUserCapability(profile, worker.id, 'can_change_password', next)
      setCapabilities(await getUserCapabilities(worker.id))
      setMemberPwMsg('cap_saved')
    } catch {
      setMemberPwMsg('cap_failed')
    } finally {
      setBusy(null)
    }
  }

  // TEAM-1: чипы навыков (пишутся в profiles.skills одной text-строкой через запятую).
  const addSkill = (raw: string) => {
    const value = raw.trim()
    if (!value) return
    setSkillsChips((prev) => (prev.some((s) => s.toLowerCase() === value.toLowerCase()) ? prev : [...prev, value]))
    setSkillDraft('')
  }
  const removeSkill = (skill: string) => setSkillsChips((prev) => prev.filter((s) => s !== skill))

  const saveSkills = async () => {
    if (!profile || !worker || !canEditProfile || busy) return
    setBusy('skills')
    setMsg(null)
    try {
      await updateWorkerSkills(profile, worker.id, {
        skills: skillsChips.join(', '),
        skills_note: skillsNote.trim() === '' ? null : skillsNote.trim(),
      })
      setMsg('skills_saved')
    } catch {
      setMsg('skills_save_failed')
    } finally {
      setBusy(null)
    }
  }

  // TEAM-2: загрузка аватара в ПУБЛИЧНЫЙ bucket 'avatars' → publicUrl → profiles.avatar_url.
  const onAvatarPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // позволяем повторно выбрать тот же файл
    if (!profile || !worker || !canEditProfile || busy || !file) return
    setBusy('avatar')
    setMsg(null)
    try {
      const url = await uploadAvatar(profile, worker.id, file)
      setAvatarUrl(url)
      setWorker((prev) => (prev ? { ...prev, avatar_url: url } : prev))
      setMsg('avatar_saved')
    } catch (err) {
      setMsg(uploadErrorCode(err) ?? 'avatar_save_failed')
    } finally {
      setBusy(null)
    }
  }

  // TEAM-2: сохранение клиент-facing описания (profiles.public_bio). БЕЗ контактов.
  const savePublicBio = async () => {
    if (!profile || !worker || !canEditProfile || busy) return
    setBusy('public_bio')
    setMsg(null)
    try {
      await updateWorkerPublicProfile(profile, worker.id, {
        public_bio: publicBio.trim() === '' ? null : publicBio.trim(),
      })
      setWorker((prev) => (prev ? { ...prev, public_bio: publicBio.trim() || null } : prev))
      setMsg('public_bio_saved')
    } catch {
      setMsg('public_bio_save_failed')
    } finally {
      setBusy(null)
    }
  }

  // TEAM-DOSSIER-1-files: загрузка файла работника (страховки/сертификаты/документы) в R2 → строка
  // files scope='worker', profile_id. Только manager+ (canEditProfile); RLS дублирует гейт на сервере.
  // Новую строку добавляем в начало списка. Коды валидатора (file_too_large/…) показываем через t().
  const onProfileFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // позволяем повторно выбрать тот же файл
    if (!profile || !worker || !canEditProfile || busy || !file) return
    setBusy('profile_file')
    setMsg(null)
    try {
      // DOC-EXPIRY-UI: прикладываем тип документа и «действует до» (обе опциональны) → files.doc_kind/expires_at.
      const row = await uploadProfileFileToR2(profile, worker.id, file, {
        doc_kind: docKindDraft || null,
        expires_at: docExpiresDraft || null,
      })
      setProfileFiles((rows) => [row, ...rows])
      setDocKindDraft('')
      setDocExpiresDraft('')
      setMsg('dossier_file_uploaded')
    } catch (err) {
      setMsg(uploadErrorCode(err) ?? 'dossier_file_upload_failed')
    } finally {
      setBusy(null)
    }
  }

  // TEAM-DOSSIER-1-files: скачивание файла работника — подписанная ссылка R2 (r2-sign download),
  // открываем в новой вкладке. Тот же механизм, что у файлов клиента/проекта.
  const downloadProfileFile = async (file: FileRow) => {
    try {
      const url = await getProjectFileDownloadUrl(file)
      window.open(url, '_blank', 'noopener')
    } catch {
      setMsg('dossier_file_download_failed')
    }
  }

  // DOC-EXPIRY-UI: локализованное имя типа документа (канон insurance/license/w9/other) — иначе как есть.
  const docKindLabel = (kind: string | null): string => {
    switch (kind) {
      case 'insurance': return t('worker_doc_kind_insurance')
      case 'license': return t('worker_doc_kind_license')
      case 'w9': return t('worker_doc_kind_w9')
      case 'other': return t('worker_doc_kind_other')
      default: return kind || ''
    }
  }

  // DOC-EXPIRY-UI: короткая подпись срока для бейджа строки документа (просрочен/сегодня/через N дн.).
  const docExpiryText = (expiresAt: string): string => {
    const d = daysUntilExpiry(expiresAt)
    if (d < 0) return t('files_expired')
    if (d === 0) return t('files_expires_today')
    return t('files_expires_in').replace('{n}', String(d))
  }

  // TEAM-DOSSIER-1: сохранение контактных/кадровых полей досье. Helper пишет contacts/dossier/language
  // в разные таблицы. Пустые → null, кроме language (колонка NOT NULL) — пустое значение пропускаем.
  const saveDossier = async () => {
    if (!profile || !worker || !canEditProfile || busy) return
    setBusy('dossier')
    setMsg(null)
    const phoneV = phone.trim()
    const emailV = email.trim()
    const homeV = homeAddress.trim()
    const emergV = emergencyContact.trim()
    const hireV = hireDate.trim()
    const notesV = dossierNotes.trim()
    const langV = dossierLang.trim()
    try {
      await updateWorkerDossier(profile, worker.id, {
        phone: phoneV === '' ? null : phoneV,
        email: emailV === '' ? null : emailV,
        home_address: homeV === '' ? null : homeV,
        emergency_contact: emergV === '' ? null : emergV,
        hire_date: hireV === '' ? null : hireV,
        dossier_notes: notesV === '' ? null : notesV,
        language: langV === '' ? undefined : langV,
      })
      setWorker((prev) => (prev ? {
        ...prev,
        phone: phoneV || null,
        email: emailV || null,
        home_address: homeV || null,
        emergency_contact: emergV || null,
        hire_date: hireV || null,
        dossier_notes: notesV || null,
        language: langV || prev.language,
      } : prev))
      setMsg('dossier_saved')
    } catch {
      setMsg('dossier_save_failed')
    } finally {
      setBusy(null)
    }
  }

  // TEAM-DOSSIER-1: сохранение реквизитов субподрядчика (owner-only). Пустые поля → null.
  const saveSubcontractor = async () => {
    if (!profile || !worker || !canViewSubcontractor || busy) return
    setBusy('subcontractor')
    setMsg(null)
    try {
      await upsertSubcontractorDetails(profile, worker.id, {
        trade: subTrade.trim() === '' ? null : subTrade.trim(),
        license_number: subLicense.trim() === '' ? null : subLicense.trim(),
        insurance_expires: subInsurance.trim() === '' ? null : subInsurance.trim(),
        payment_terms: subPaymentTerms.trim() === '' ? null : subPaymentTerms.trim(),
        notes: subNotes.trim() === '' ? null : subNotes.trim(),
      })
      setMsg('subcontractor_saved')
    } catch {
      setMsg('subcontractor_save_failed')
    } finally {
      setBusy(null)
    }
  }

  // TEAM-1: активация/деактивация работника (profiles.is_active).
  const toggleActive = async () => {
    if (!profile || !worker || !canEditProfile || busy) return
    const next = !worker.is_active
    setBusy('active')
    setMsg(null)
    try {
      await setWorkerActive(profile, worker.id, next)
      setMsg(next ? 'worker_activated' : 'worker_deactivated')
      await load()
    } catch {
      setMsg('worker_active_toggle_failed')
    } finally {
      setBusy(null)
    }
  }

  // TEAM-PIN-UI: тумблер «Разрешить вход по PIN» — живое переключение через edge set-worker-pin
  // ({ profile_id, pin_enabled }). Колонку profiles.pin_enabled напрямую не пишем (защищена триггером).
  // Флажок двигаем ТОЛЬКО после успеха; на ошибке состояние не рушим, показываем тост.
  const togglePinEnabled = async (next: boolean) => {
    if (!worker || !canEditProfile || busy) return
    setBusy('pin_enabled')
    setMsg(null)
    try {
      const res = await setWorkerPin({ profileId: worker.id, pinEnabled: next })
      if (res.ok) {
        setPinEnabled(next)
        setWorker((prev) => (prev ? { ...prev, pin_enabled: next } : prev))
        setMsg('pin_access_updated')
      } else {
        setMsg('pin_access_failed')
      }
    } catch {
      setMsg('pin_access_failed')
    } finally {
      setBusy(null)
    }
  }

  const openPinModal = () => {
    setPinInput('')
    setPinMsg(null)
    setPinModalOpen(true)
  }
  const closePinModal = () => {
    if (busy) return
    setPinModalOpen(false)
    setPinInput('')
    setPinMsg(null)
  }

  // TEAM-PIN-UI: сохранить новый PIN через edge set-worker-pin ({ profile_id, pin }). Успех — тост
  // «PIN обновлён» + закрыть модалку. 409 pin_taken — показать «занят, выберите другой», модалку НЕ
  // закрывать. Прочие ошибки — понятный текст в модалке, состояние не рушим.
  const submitPin = async () => {
    if (!worker || !canEditProfile || busy) return
    if (!/^\d{4,8}$/.test(pinInput)) { setPinMsg('pin_invalid'); return }
    setBusy('pin')
    setPinMsg(null)
    try {
      const res = await setWorkerPin({ profileId: worker.id, pin: pinInput })
      if (res.ok) {
        setPinModalOpen(false)
        setPinInput('')
        setPinMsg(null)
        setMsg('pin_updated')
      } else if (res.error === 'pin_taken') {
        setPinMsg('pin_taken_choose_another')
      } else if (res.error === 'bad_pin') {
        setPinMsg('pin_invalid')
      } else {
        setPinMsg('pin_update_failed')
      }
    } catch {
      setPinMsg('pin_update_failed')
    } finally {
      setBusy(null)
    }
  }

  // TRASH-3: безвозвратное удаление. Второй барьер — введённое имя должно ТОЧНО совпасть.
  // На успех уводим на /team (человека больше нет); ошибку показываем кодом-ключом в панели.
  const submitPurge = async () => {
    if (!worker || !canPurge || busy) return
    if (purgeConfirmName.trim() !== worker.name) { setPurgeMsg('purge_name_mismatch'); return }
    setBusy('purge')
    setPurgeMsg(null)
    try {
      const res = await purgeProfile(worker.id)
      if (res.ok) {
        navigate('/team')
      } else {
        setPurgeMsg(res.error ?? 'error')
      }
    } catch {
      setPurgeMsg('error')
    } finally {
      setBusy(null)
    }
  }

  const openAdjustment = (row: IntervalRow) => {
    setEditingKey(row.key)
    setAdjustIn(toDatetimeLocal(row.interval.start_at))
    setAdjustOut(toDatetimeLocal(row.interval.end_at ?? new Date(now).toISOString()))
    setAdjustReason('')
    setAdjustShowToWorker(false)
    setMsg(null)
  }

  const submitAdjustment = async (e: React.FormEvent, row: IntervalRow) => {
    e.preventDefault()
    if (!profile || busy) return
    if (!adjustReason.trim()) {
      setMsg('adjust_reason_required')
      return
    }
    const adjustedCheckIn = fromDatetimeLocal(adjustIn)
    const adjustedCheckOut = fromDatetimeLocal(adjustOut)
    if (new Date(adjustedCheckOut).getTime() <= new Date(adjustedCheckIn).getTime()) {
      setMsg('adjust_time_invalid')
      return
    }
    // ADJ-FIX (в): на смене с перерывом v_work_intervals бьёт смену на сегменты. Метка
    // adjusted_check_in применяется ТОЛЬКО к сегменту, начинающемуся с check_in; adjusted_check_out —
    // только к сегменту, кончающемуся check_out (миграция 0019). Если пользователь двигает границу,
    // попадающую на перерыв (start_type=break_end / end_type=break_start), правка молча теряется.
    // Явно блокируем такой ввод вместо тихой потери часов. Тип концов приходит из getWorkerIntervals
    // (attachIntervalEventTypes); если тип неизвестен (null) — не мешаем (вести себя как раньше).
    const startType = row.interval.start_type
    const endType = row.interval.end_type
    const inApplicable = startType == null || startType === 'check_in'
    const outApplicable = endType == null || endType === 'check_out'
    const inChanged = adjustIn !== toDatetimeLocal(row.interval.start_at)
    const outChanged = adjustOut !== toDatetimeLocal(row.interval.end_at ?? new Date(now).toISOString())
    if ((inChanged && !inApplicable) || (outChanged && !outApplicable)) {
      setMsg('adjust_break_segment_unsupported')
      return
    }
    setBusy('adjustment')
    setMsg(null)
    try {
      await createTimeAdjustment(profile, {
        workerId: row.interval.profile_id,
        projectId: row.interval.project_id,
        originalEventId: row.interval.end_event_id ?? row.interval.start_event_id,
        adjustedCheckIn,
        adjustedCheckOut,
        reason: adjustReason.trim(),
        showToWorker: adjustShowToWorker,
      })
      setMsg('adjustment_saved')
      setEditingKey(null)
      // Перечитываем интервалы, чтобы часы обновились сразу с учётом корректировки
      if (id) setIntervals(await getWorkerIntervals(id))
    } catch {
      setMsg('adjustment_failed')
    } finally {
      setBusy(null)
    }
  }

  const msgClass = msg?.includes('failed') || msg?.includes('invalid') || msg?.includes('required') || msg?.includes('unsupported') ? 'error-msg' : 'ok-msg'

  return (
    <div className="screen worker-detail-screen">
      <div className="worker-detail-head">
        <div className="worker-detail-head-id">
          {/* TEAM-2: круглый аватар в шапке карточки профиля. */}
          {worker && (
            <div className="team-avatar lg">
              {avatarUrl ? <img src={avatarUrl} alt={worker.name} /> : <span>{initials(worker.name)}</span>}
            </div>
          )}
          <div>
            <Link className="inline-link muted" to="/team">← {t('team')}</Link>
            <h1>{worker ? worker.name : t('worker_profile')}</h1>
            {worker && <span className={`badge ${worker.role === 'manager' || worker.role === 'supervisor' ? 'amber' : 'blue'}`}>{worker.role}</span>}
          </div>
        </div>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {msg && <p className={msgClass}>{t(msg)}</p>}
      {!loading && !worker && <div className="card muted">{t('worker_not_found')}</div>}

      {!loading && worker && (
        <>
          <div className="worker-detail-grid">
            <section className="card worker-settings-card">
              <h2>{t('profile_settings')}</h2>
              <form onSubmit={saveSettings}>
                <label>{t('name')}</label>
                <div className="worker-name-row">
                  <input value={name} disabled={!canEditProfile || busy !== null} onChange={(e) => setName(e.target.value)} />
                  {canEditProfile && (
                    <VoiceMic lang={lang} title={t('voice_input')} onResult={(text) => setName(text)} />
                  )}
                </div>

                <label>{t('role')}</label>
                <select value={role} disabled={!canEditProfile || busy !== null} onChange={(e) => setRole(e.target.value as Role)}>
                  {roleSelectOptions.map((option) => (
                    <option key={option} value={option} disabled={!actorRole || !canAssignRole(actorRole, option)}>
                      {option}
                    </option>
                  ))}
                </select>

                {ratesVisible && (
                  <>
                    <label>{t('rate')}</label>
                    <input
                      value={rateInput}
                      disabled={!canEditProfile || busy !== null}
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      onChange={(e) => setRateInput(e.target.value)}
                    />
                  </>
                )}

                <label className="check-row worker-toggle">
                  <input
                    type="checkbox"
                    checked={requireVideo}
                    disabled={!canEditProfile || busy !== null}
                    onChange={(e) => setRequireVideo(e.target.checked)}
                  />
                  <span>{t('checkout_video_required')}</span>
                </label>

                <button className="btn" disabled={!canEditProfile || busy !== null}>{t('save')}</button>
              </form>

              {/* TEAM-PIN-UI: вход по PIN (edge set-worker-pin) — тумблер «Разрешить вход по PIN» +
                  «Сбросить PIN» (модалка). Плюс деактивация. Всё видит/меняет manager+ (canEditProfile). */}
              {canEditProfile && (
                <div className="worker-danger-actions">
                  <label className="check-row worker-toggle">
                    <input
                      type="checkbox"
                      checked={pinEnabled}
                      disabled={busy !== null}
                      onChange={(e) => togglePinEnabled(e.target.checked)}
                    />
                    <span>{t('pin_login_allowed')}</span>
                  </label>
                  <p className="muted">{t('pin_login_hint')}</p>
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy !== null}
                    onClick={openPinModal}
                  >
                    {t('reset_pin')}
                  </button>
                  <button
                    type="button"
                    className={`btn small ${worker.is_active ? 'red' : 'green'}`}
                    disabled={busy !== null}
                    onClick={toggleActive}
                  >
                    {worker.is_active ? t('deactivate') : t('activate')}
                  </button>
                </div>
              )}
            </section>

            {/* TRASH-3: владелец удаляет человека безвозвратно. Owner-only; двойное подтверждение
                (раскрыть панель + вписать точное имя). БД дополнительно гейтит корзину/оплату. */}
            {canPurge && (
              <section className="card worker-purge-card">
                <h2>{t('purge_section')}</h2>
                <p className="muted">{t('purge_hint')}</p>
                {!purgeOpen ? (
                  <button
                    type="button"
                    className="btn red small"
                    disabled={busy !== null}
                    onClick={() => { setPurgeOpen(true); setPurgeConfirmName(''); setPurgeMsg(null) }}
                  >
                    {t('purge_delete_forever')}
                  </button>
                ) : (
                  <div className="purge-confirm">
                    <p className="error-msg">⚠ {t('purge_warning')}</p>
                    <label>{t('purge_type_name_to_confirm')}: <strong>{worker.name}</strong></label>
                    <input
                      value={purgeConfirmName}
                      disabled={busy !== null}
                      placeholder={worker.name}
                      autoComplete="off"
                      onChange={(e) => { setPurgeConfirmName(e.target.value); setPurgeMsg(null) }}
                    />
                    <div className="row purge-actions">
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={busy !== null}
                        onClick={() => { setPurgeOpen(false); setPurgeConfirmName(''); setPurgeMsg(null) }}
                      >
                        {t('cancel')}
                      </button>
                      <button
                        type="button"
                        className="btn red small"
                        disabled={busy !== null || purgeConfirmName.trim() !== worker.name}
                        onClick={submitPurge}
                      >
                        {t('purge_delete_forever')}
                      </button>
                    </div>
                    {purgeMsg && <p className="error-msg">{t(purgeMsg)}</p>}
                  </div>
                )}
              </section>
            )}

            <section>
              <h2>{t('hours_tiles')}</h2>
              <div className="worker-hour-grid">
                {tiles.map((tile) => (
                  <div key={tile.key} className="card metric-card blue">
                    <div className="metric-value num-display">{fmtHours(tile.value)}</div>
                    <div className="muted">{tile.label}</div>
                  </div>
                ))}
              </div>
              {/* G1: оплачиваемое время в пути за всё время (входит в оплачиваемые часы). */}
              {travelTotalMs > 0 && (
                <p className="muted worker-travel-total">
                  {t('travel_hours')}: <strong className="num-display">{fmtHours(travelTotalMs)} {t('h')}</strong>
                  {travelHasOverAlert && (
                    <span className="badge amber" title={t('payroll_gap_alert_hint')}> ⚠ {t('payroll_travel_alert')}</span>
                  )}
                  <span className="muted"> — {t('travel_paid_hint')}</span>
                </p>
              )}
            </section>
          </div>

          {/* TEAM-1: показатели за неделю. */}
          <section>
            <h2>{t('worker_stats')}</h2>
            <div className="worker-hour-grid">
              {statTiles.map((tile) => (
                <div key={tile.key} className="card metric-card blue">
                  <div className="metric-value num-display">{tile.value}</div>
                  <div className="muted">{tile.label}</div>
                </div>
              ))}
            </div>
          </section>

          {/* TEAM-DOSSIER-1: единая карточка-досье (ЗАКОН ДНК §10: ЧЕЛОВЕК = ДОСЬЕ). Контакты,
              кадровые данные, язык + сводка навыков/ставки в одном месте. Helper читает contacts и
              dossier раздельно из новых таблиц; dossier_notes не видны работнику по RLS. */}
          <section className="card worker-dossier-card">
            <h2>{t('dossier_section')}</h2>
            <p className="muted">{t('dossier_hint')}</p>

            <div className="dossier-fields">
              <label>{t('dossier_phone')}</label>
              <input value={phone} disabled={!canEditProfile || busy !== null} onChange={(e) => setPhone(e.target.value)} />

              <label>{t('dossier_email')}</label>
              <input type="email" value={email} disabled={!canEditProfile || busy !== null} onChange={(e) => setEmail(e.target.value)} />

              <label>{t('dossier_home_address')}</label>
              <input value={homeAddress} disabled={!canEditProfile || busy !== null} onChange={(e) => setHomeAddress(e.target.value)} />

              <label>{t('dossier_emergency_contact')}</label>
              <input value={emergencyContact} disabled={!canEditProfile || busy !== null} onChange={(e) => setEmergencyContact(e.target.value)} />

              <label>{t('dossier_hire_date')}</label>
              <input type="date" value={hireDate} disabled={!canEditProfile || busy !== null} onChange={(e) => setHireDate(e.target.value)} />

              <label>{t('language')}</label>
              <select value={dossierLang} disabled={!canEditProfile || busy !== null} onChange={(e) => setDossierLang(e.target.value)}>
                <option value="">—</option>
                <option value="ru">Русский</option>
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </div>

            {/* dossier_notes — «заметки владельца», ВИДНЫ ТОЛЬКО manager+ (сам работник этот экран не видит). */}
            <label>{t('dossier_notes_label')}</label>
            <div className="row public-bio-row">
              <textarea
                value={dossierNotes}
                disabled={!canEditProfile || busy !== null}
                rows={3}
                onChange={(e) => setDossierNotes(e.target.value)}
              />
              {canEditProfile && (
                <VoiceMic
                  lang={lang}
                  title={t('voice_input')}
                  onResult={(text) => setDossierNotes((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))}
                />
              )}
            </div>
            <p className="muted">{t('dossier_notes_caption')}</p>

            {/* Сводка: навыки (profiles.skills), ставка (finance-gated, verbatim — read-only). */}
            <div className="dossier-summary">
              <div className="dossier-summary-item">
                <span className="muted">{t('skills_section')}</span>
                <div className="skills-chip-list">
                  {skillsChips.length === 0
                    ? <span className="muted">{t('skills_empty')}</span>
                    : skillsChips.map((s) => <span key={s} className="skills-chip">{s}</span>)}
                </div>
              </div>
              {ratesVisible && (
                <div className="dossier-summary-item">
                  <span className="muted">{t('rate')}</span>
                  <strong className="num-display">{rateValue === null ? '—' : `$${rateValue}`}</strong>
                </div>
              )}
            </div>

            {canEditProfile && (
              <button type="button" className="btn" disabled={busy !== null} onClick={saveDossier}>{t('save')}</button>
            )}
          </section>

          {/* TEAM-DOSSIER-1: реквизиты субподрядчика — ТОЛЬКО owner и ТОЛЬКО role='subcontractor'. */}
          {canViewSubcontractor && (
            <section className="card worker-subcontractor-card">
              <h2>{t('subcontractor_section')}</h2>
              <p className="muted">{t('subcontractor_hint')}</p>

              <label>{t('sub_trade')}</label>
              <input value={subTrade} disabled={busy !== null} onChange={(e) => setSubTrade(e.target.value)} />

              <label>{t('sub_license_number')}</label>
              <input value={subLicense} disabled={busy !== null} onChange={(e) => setSubLicense(e.target.value)} />

              <label>{t('sub_insurance_expires')}</label>
              <input type="date" value={subInsurance} disabled={busy !== null} onChange={(e) => setSubInsurance(e.target.value)} />

              <label>{t('sub_payment_terms')}</label>
              <input value={subPaymentTerms} disabled={busy !== null} onChange={(e) => setSubPaymentTerms(e.target.value)} />

              <label>{t('sub_notes')}</label>
              <div className="row public-bio-row">
                <textarea value={subNotes} disabled={busy !== null} rows={3} onChange={(e) => setSubNotes(e.target.value)} />
                <VoiceMic lang={lang} title={t('voice_input')} onResult={(text) => setSubNotes((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))} />
              </div>

              <button type="button" className="btn" disabled={busy !== null} onClick={saveSubcontractor}>{t('save')}</button>
            </section>
          )}

          {/* TEAM-2: Публичный профиль — ЕДИНСТВЕННОЕ, что видит клиент (avatar_url + public_bio).
              Контакты работника и навыки НИКОГДА сюда не попадают — они внутренние. */}
          <section className="card public-profile-card">
            <h2>{t('public_profile_section')}</h2>
            <p className="muted">{t('public_profile_hint')}</p>

            <div className="public-profile-avatar-row">
              <div className="team-avatar xl">
                {avatarUrl ? <img src={avatarUrl} alt={worker.name} /> : <span>{initials(worker.name)}</span>}
              </div>
              {canEditProfile && (
                <div className="public-profile-avatar-actions">
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={onAvatarPick}
                  />
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy !== null}
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    {busy === 'avatar' ? t('loading') : t('upload_photo')}
                  </button>
                  <p className="muted">{t('public_photo_caption')}</p>
                </div>
              )}
            </div>

            <label>{t('public_bio_label')}</label>
            <div className="row public-bio-row">
              <textarea
                value={publicBio}
                disabled={!canEditProfile || busy !== null}
                rows={4}
                onChange={(e) => setPublicBio(e.target.value)}
              />
              {canEditProfile && (
                <VoiceMic
                  lang={lang}
                  title={t('voice_input')}
                  onResult={(text) => setPublicBio((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))}
                />
              )}
            </div>
            <p className="muted">{t('public_bio_caption')}</p>

            {canEditProfile && (
              <button type="button" className="btn" disabled={busy !== null} onClick={savePublicBio}>{t('save')}</button>
            )}
          </section>

          {/* TEAM-1: навыки для ИИ-распределения (profiles.skills) + заметка (profiles.skills_note). */}
          <section className="card worker-skills-card">
            <h2>{t('skills_section')}</h2>
            <div className="skills-chip-list">
              {skillsChips.length === 0 && <span className="muted">{t('skills_empty')}</span>}
              {skillsChips.map((skill) => (
                <span key={skill} className="skills-chip">
                  {skill}
                  {canEditProfile && (
                    <button
                      type="button"
                      className="skills-chip-remove"
                      aria-label={t('remove')}
                      disabled={busy !== null}
                      onClick={() => removeSkill(skill)}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
            {canEditProfile && (
              <div className="row skills-add-row">
                <input
                  value={skillDraft}
                  placeholder={t('skills_add_placeholder')}
                  disabled={busy !== null}
                  onChange={(e) => setSkillDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); addSkill(skillDraft) }
                  }}
                />
                <VoiceMic lang={lang} title={t('voice_input')} onResult={(text) => addSkill(text)} />
                <button type="button" className="btn ghost small" disabled={busy !== null || !skillDraft.trim()} onClick={() => addSkill(skillDraft)}>
                  {t('skills_add')}
                </button>
              </div>
            )}

            <label>{t('skills_note_label')}</label>
            <textarea
              value={skillsNote}
              disabled={!canEditProfile || busy !== null}
              rows={3}
              onChange={(e) => setSkillsNote(e.target.value)}
            />
            <p className="muted">{t('skills_note_caption')}</p>

            {canEditProfile && (
              <button type="button" className="btn" disabled={busy !== null} onClick={saveSkills}>{t('save')}</button>
            )}
          </section>

          <section>
            <h2>{t('daily_totals_7')}</h2>
            <div className="worker-days-list">
              {dailyRows.map((day) => {
                const detail = dayDetails[day.key]
                const isOpen = expandedDay === day.key
                return (
                  <div className="worker-day-item" key={day.key}>
                    <button
                      type="button"
                      className="card worker-day-row worker-day-toggle"
                      aria-expanded={isOpen}
                      onClick={() => toggleDay(day)}
                    >
                      <span className="worker-day-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      <span>{day.label}</span>
                      <strong className="num-display">{fmtHours(day.hoursMs)} {t('h')}</strong>
                      {day.travelMs > 0 && (
                        <span
                          className={`badge ${day.travelOverAlert ? 'amber' : 'blue'}`}
                          title={t('travel_paid_hint')}
                        >
                          {day.travelOverAlert ? '⚠ ' : ''}+{fmtHours(day.travelMs)} {t('travel_hours')}
                        </span>
                      )}
                      {day.hoursMs > ELEVEN_HOURS_MS && <span className="badge amber">{t('over_11h')}</span>}
                    </button>

                    {isOpen && (
                      <div className="card worker-day-detail">
                        {(!detail || detail.state === 'loading') && <p className="muted">{t('day_details_loading')}</p>}
                        {detail?.state === 'error' && <p className="error-msg">{t('load_error')}</p>}
                        {detail?.state === 'ready' && (
                          <>
                            {detail.needsReview && (
                              <p className="gps-review-note" title={t('location_needs_review_hint')}>
                                ⚠ {t('location_needs_review')}
                              </p>
                            )}
                            <h3>{t('day_photos')}</h3>
                            {detail.photos.length === 0 ? (
                              <p className="muted">{t('day_no_photos')}</p>
                            ) : (
                              <div className="gallery-grid worker-day-photos">
                                {detail.photos.map((photo) => (
                                  <button
                                    key={photo.id}
                                    type="button"
                                    className="gallery-item"
                                    onClick={() => setActiveDayPhotoUrl(photo.url)}
                                    aria-label={photo.filename ?? t('day_photos')}
                                  >
                                    <img src={photo.url} alt={photo.filename ?? ''} loading="lazy" />
                                  </button>
                                ))}
                              </div>
                            )}

                            <h3>{t('day_closed_tasks')}</h3>
                            {detail.tasks.length === 0 ? (
                              <p className="muted">{t('day_no_closed_tasks')}</p>
                            ) : (
                              <div className="worker-day-tasks">
                                {detail.tasks.map((task) => (
                                  <div className="worker-day-task" key={task.id}>
                                    <div>
                                      <div className="item-title">{task.title}</div>
                                      {task.project_name && <div className="muted">{task.project_name}</div>}
                                    </div>
                                    <span className="muted num-display">{task.done_at ? fmtClock(task.done_at) : '—'}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          <section>
            <h2>{t('latest_shifts')}</h2>
            {/* TEAM-1: ручное добавление НОВОЙ смены нет чем поддержать — механизм корректировок
                привязан к существующей отметке. «Редактировать» ниже работает. См. BACKEND REQUEST. */}
            {canEditProfile && (
              <div className="add-shift-row">
                <button type="button" className="btn ghost small" disabled title={t('add_shift_backend_pending')}>
                  + {t('add_shift_manual')}
                </button>
                <p className="muted">{t('add_shift_backend_pending')}</p>
              </div>
            )}
            {transferGaps.length > 0 && (
              <div className="transfer-gap-list">
                {transferGaps.map((gap) => {
                  const fromName = gap.fromProjectId ? projectNames.get(gap.fromProjectId) ?? gap.fromProjectId : '—'
                  const toName = gap.toProjectId ? projectNames.get(gap.toProjectId) ?? gap.toProjectId : '—'
                  return (
                    <span
                      key={gap.key}
                      className={`transfer-gap-chip ${gap.tier === 'critical' ? 'transfer-gap-critical' : ''}`}
                      title={t('transfer_gap_hint')}
                    >
                      {t('transfer_gap')} {fmtGapDuration(gap.gapMs)} · {fromName} → {toName}
                    </span>
                  )
                })}
              </div>
            )}
            {latestShifts.length === 0 && <div className="card muted">{t('no_shift_rows')}</div>}
            <div className="worker-shifts-list">
              {latestShifts.map((row) => (
                <div className="card worker-shift-card" key={row.key}>
                  <div className="worker-shift-main">
                    <div>
                      <div className="item-title">{dateLabel(row.interval.start_at)}</div>
                      <div className="muted">{row.projectName}</div>
                    </div>
                    <div className="worker-shift-times">
                      <span>{fmtClock(row.interval.start_at)}</span>
                      <span>→</span>
                      <span>{row.interval.end_at ? fmtClock(row.interval.end_at) : '—'}</span>
                    </div>
                    <span className="badge blue">{fmtHours(row.hoursMs)} {t('h')}</span>
                    {row.interval.was_adjusted && (
                      <span className="badge amber" title={row.interval.adjust_reason ?? undefined}>{t('adjusted')}</span>
                    )}
                    <button className="btn ghost small" disabled={busy !== null} onClick={() => openAdjustment(row)}>
                      {t('edit')}
                    </button>
                  </div>

                  {editingKey === row.key && (
                    <form className="adjustment-form" onSubmit={(e) => submitAdjustment(e, row)}>
                      <label>{t('new_check_in')}</label>
                      <input type="datetime-local" value={adjustIn} onChange={(e) => setAdjustIn(e.target.value)} />
                      <label>{t('new_check_out')}</label>
                      <input type="datetime-local" value={adjustOut} onChange={(e) => setAdjustOut(e.target.value)} />
                      <label>{t('adjust_reason')}</label>
                      <div className="row adjust-reason-presets">
                        {(['adjust_preset_forgot_checkout', 'adjust_preset_overtime', 'adjust_preset_correction', 'adjust_preset_worked_extra'] as const).map((presetKey) => (
                          <button
                            key={presetKey}
                            className="btn ghost small"
                            type="button"
                            disabled={busy !== null}
                            onClick={() => setAdjustReason(t(presetKey))}
                          >
                            {t(presetKey)}
                          </button>
                        ))}
                      </div>
                      <textarea value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} rows={2} />
                      {/* M6: по умолчанию заметка НЕ видна работнику; галочка отдаёт adjust_reason на «Мои часы». */}
                      <label className="check-row worker-toggle">
                        <input
                          type="checkbox"
                          checked={adjustShowToWorker}
                          disabled={busy !== null}
                          onChange={(e) => setAdjustShowToWorker(e.target.checked)}
                        />
                        <span>{t('show_note_to_worker')}</span>
                      </label>
                      <div className="row adjustment-actions">
                        <button className="btn ghost small" type="button" disabled={busy !== null} onClick={() => setEditingKey(null)}>{t('cancel')}</button>
                        <button className="btn small" disabled={busy !== null || !adjustReason.trim()}>{t('save_adjustment')}</button>
                      </div>
                    </form>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* WF-1: «Документы и согласия» — только чтение; RLS гейтит менеджер+ / сам работник. */}
          <section className="card worker-docs-card">
            <h2>{t('team_docs_section')}</h2>
            <p className="muted worker-docs-video">
              {requireVideo ? `🎥 ${t('video_checkout_required')}` : t('video_checkout_not_required')}
            </p>

            {docsState === 'loading' && <p className="muted">{t('loading')}</p>}
            {docsState === 'error' && <p className="error-msg">{t('load_error')}</p>}
            {docsState === 'ready' && (
              <>
                <h3>{t('gps_consents')}</h3>
                {consents.length === 0 ? (
                  <p className="muted">{t('no_records')}</p>
                ) : (
                  <div className="worker-docs-list">
                    {consents.map((row) => (
                      <div className="worker-doc-row" key={row.id}>
                        <div className="worker-doc-main">
                          <div className="item-title">{dateLabel(row.signed_at ?? row.created_at)}</div>
                          <div className="muted">{t('consent_version')}: {row.consent_version ?? '—'}</div>
                        </div>
                        <span className={`badge ${row.revoked_at ? 'amber' : 'blue'}`}>
                          {row.revoked_at
                            ? `${t('consent_revoked')} · ${dateLabel(row.revoked_at)}`
                            : t('consent_active')}
                        </span>
                        {row.signature_url && (
                          <button
                            type="button"
                            className="gallery-item worker-doc-sig"
                            onClick={() => setActiveDayPhotoUrl(row.signature_url)}
                            aria-label={t('signature')}
                          >
                            <img src={row.signature_url} alt={t('signature')} loading="lazy" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <h3>{t('safety_acks')}</h3>
                {canEditProfile && (
                  <div style={{ marginBottom: 8 }}>
                    <button className="btn ghost small" type="button" disabled={ppeBusy} onClick={orderPpeForWorker}>
                      🦺 {ppeBusy ? t('loading') : t('ppe_order_btn')}
                    </button>
                    {ppeMsg && <p className={ppeMsg === 'ppe_ordered' ? 'ok-msg' : 'error-msg'}>{t(ppeMsg)}</p>}
                  </div>
                )}
                {safetyAcks.length === 0 ? (
                  <p className="muted">{t('no_records')}</p>
                ) : (
                  <div className="worker-docs-list">
                    {safetyAcks.map((row) => (
                      <div className="worker-doc-row" key={row.id}>
                        <div className="worker-doc-main">
                          <div className="item-title">
                            {row.signed_at ? dateLabel(row.signed_at) : '—'}
                            {' '}
                            {isAckCurrent(row, currentSafetyVersion(appSettings), Date.now())
                              ? <span className="badge green">{t('safety_ack_current')}</span>
                              : <span className="badge grey">{t('safety_ack_outdated')}</span>}
                          </div>
                          <div className="muted">{t('doc_version')}: {row.doc_version ?? '—'}</div>
                        </div>
                        {row.signature_url && (
                          <button
                            type="button"
                            className="gallery-item worker-doc-sig"
                            onClick={() => setActiveDayPhotoUrl(row.signature_url)}
                            aria-label={t('signature')}
                          >
                            <img src={row.signature_url} alt={t('signature')} loading="lazy" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* TEAM-DOSSIER-1-files: файлы работника (страховки/сертификаты/документы) — загрузка,
                    список (имя/дата/размер), скачивание по клику. Загружает manager+ (canEditProfile);
                    RLS files дублирует гейт. scope='worker' + profile_id — download через r2-sign. */}
                <h3>{t('personal_files')}</h3>
                <p className="muted">{t('dossier_files_hint')}</p>
                {profileFiles.length === 0 ? (
                  <p className="muted">{t('no_records')}</p>
                ) : (
                  <div className="worker-docs-list">
                    {profileFiles.map((row) => {
                      // DOC-EXPIRY-UI: подсветка строки по сроку — просрочено/≤7д красным, 8–30д янтарным.
                      const level = docExpiryLevel(row.expires_at)
                      return (
                        <div className={`worker-doc-row${level ? ` doc-${level}` : ''}`} key={row.id}>
                          <div className="worker-doc-main">
                            <div className="item-title">{row.name}</div>
                            <div className="muted">
                              {[docKindLabel(row.doc_kind), formatSize(row.size_bytes), dateLabel(row.created_at)]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                            {row.expires_at && (
                              <div className="worker-doc-badges">
                                <span className={`badge ${level === 'expired' || level === 'urgent' ? 'red' : level === 'soon' ? 'amber' : 'grey'}`}>
                                  {t('worker_doc_expires_label')}: {dateLabel(`${row.expires_at}T00:00:00`)} · {docExpiryText(row.expires_at)}
                                </span>
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className="btn ghost small"
                            onClick={() => downloadProfileFile(row)}
                          >
                            {t('download')}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                {canEditProfile && (
                  // DOC-EXPIRY-UI: перед загрузкой — тип документа (страховка/лицензия/W-9/…) и «действует до».
                  <div className="worker-doc-upload" style={{ marginTop: 8 }}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <label className="worker-doc-field">
                        <span className="muted">{t('worker_doc_kind_label')}</span>
                        <select value={docKindDraft} onChange={(e) => setDocKindDraft(e.target.value)} disabled={busy !== null}>
                          <option value="">{t('worker_doc_kind_none')}</option>
                          <option value="insurance">{t('worker_doc_kind_insurance')}</option>
                          <option value="license">{t('worker_doc_kind_license')}</option>
                          <option value="w9">{t('worker_doc_kind_w9')}</option>
                          <option value="other">{t('worker_doc_kind_other')}</option>
                        </select>
                      </label>
                      <label className="worker-doc-field">
                        <span className="muted">{t('worker_doc_expires_label')}</span>
                        <input type="date" value={docExpiresDraft} onChange={(e) => setDocExpiresDraft(e.target.value)} disabled={busy !== null} />
                      </label>
                    </div>
                    <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>{t('worker_doc_expires_hint')}</p>
                    <label className={`btn small worker-file-upload ${busy === 'profile_file' ? 'busy' : ''}`} style={{ marginTop: 8, display: 'inline-block' }}>
                      <input type="file" hidden disabled={busy !== null} onChange={onProfileFilePick} />
                      {busy === 'profile_file' ? t('loading') : t('dossier_file_upload')}
                    </label>
                  </div>
                )}
              </>
            )}
          </section>

          {/* ACC-4: «Доступ» — ТОЛЬКО владелец, ТОЛЬКО для сотрудника с email-ролью. Задать пароль
              (отдаётся сотруднику лично) + переключатель «может менять сам» (по умолчанию НЕТ). */}
          {canSetMemberPassword && (
            <section className="card worker-access-card">
              <h2>{t('access_section')}</h2>
              <p className="muted">{t('set_member_password_hint')}</p>

              <form onSubmit={submitMemberPassword}>
                <label>{t('set_member_password_label')}</label>
                <div className="row set-password-row">
                  <input
                    type={memberPwShow ? 'text' : 'password'}
                    value={memberPw}
                    disabled={busy !== null}
                    autoComplete="new-password"
                    minLength={8}
                    onChange={(e) => { setMemberPw(e.target.value); setMemberPwMsg(null) }}
                  />
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy !== null}
                    onClick={() => setMemberPwShow((v) => !v)}
                  >
                    {t(memberPwShow ? 'hide_password' : 'show_password')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy !== null}
                    onClick={() => { setMemberPw(generatePassword()); setMemberPwShow(true); setMemberPwMsg(null) }}
                  >
                    {t('generate_password')}
                  </button>
                </div>
                <button className="btn" disabled={busy !== null || memberPw.length < 8}>
                  {t('set_member_password_btn')}
                </button>
              </form>

              <label className="check-row worker-toggle set-selfchange-toggle">
                <input
                  type="checkbox"
                  checked={canChangePwGranted}
                  disabled={busy !== null}
                  onChange={(e) => toggleSelfPasswordChange(e.target.checked)}
                />
                <span>
                  {t('can_change_password_label')}
                  <span className="muted"> — {t('can_change_password_hint')}</span>
                </span>
              </label>

              {memberPwMsg && (
                <p className={memberPwMsg === 'set_pw_success' || memberPwMsg === 'cap_saved' ? 'ok-msg' : 'error-msg'}>
                  {t(memberPwMsg)}
                </p>
              )}
            </section>
          )}

          {canManageCapabilities && (
            <section className="card worker-access-card">
              <h2>{t('capabilities')}</h2>
              <div className="project-toggle-list">
                {CAPABILITIES.map((cap) => {
                  const granted = capabilities.some((row) => row.capability === cap.key && row.granted)
                  const capBusy = busy === `cap:${cap.key}`
                  return (
                    <div key={cap.key} className="worker-day-row">
                      <label className="check-row worker-toggle">
                        <input
                          type="checkbox"
                          checked={granted}
                          disabled={busy !== null}
                          onChange={(e) => toggleCapability(cap.key, e.target.checked)}
                        />
                        <span>
                          {t(cap.labelKey)}
                          <span className="muted"> — {t(cap.hintKey)}</span>
                        </span>
                      </label>
                      <span className={`badge ${granted ? 'blue' : 'amber'}`}>
                        {t(capBusy ? 'loading' : granted ? 'cap_granted' : 'cap_revoked')}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* TEAM-1: текущий период оплаты — только чтение, finance-gated. Логика закрытия — в Payroll (PAY-1). */}
          {ratesVisible && (
            <section className="card worker-pay-period-card">
              <h2>{t('pay_period_current')}</h2>
              {!payPeriod ? (
                <p className="muted">{t('pay_period_none')}</p>
              ) : (
                <>
                  <div className="pay-period-window num-display">
                    {dateLabel(payPeriod.period_start)} — {dateLabel(payPeriod.period_end)}
                  </div>
                  <div className="worker-hour-grid">
                    <div className="card metric-card blue">
                      <div className="metric-value num-display">{payUnpaid === null ? '—' : `$${payUnpaid.toFixed(2)}`}</div>
                      <div className="muted">{t('pay_unpaid')}</div>
                    </div>
                    <div className="card metric-card blue">
                      <div className="metric-value">{t(payStatusKey)}</div>
                      <div className="muted">{t('pay_status')}</div>
                    </div>
                    <div className="card metric-card blue">
                      <div className="metric-value num-display">{payAdjustments}</div>
                      <div className="muted">{t('pay_adjustments')}</div>
                    </div>
                  </div>
                </>
              )}
              {/* PAY-1: передаём работника в /payroll (?worker=<id>) — экран зарплаты преселектит его. */}
              <button type="button" className="btn ghost small" onClick={() => navigate(`/payroll?worker=${encodeURIComponent(worker.id)}`)}>
                {t('close_pay_here')} →
              </button>
            </section>
          )}

          <div className="worker-detail-grid">
            <section className="card worker-access-card">
              <h2>{t('project_access')}</h2>
              <div className="access-mode">
                <label className="check-row">
                  <input
                    type="radio"
                    checked={accessMode === 'assigned'}
                    disabled={!canEditProfile || busy !== null}
                    onChange={() => changeAccessMode('assigned')}
                  />
                  <span>{t('selected_projects_only')}</span>
                </label>
                <label className="check-row">
                  <input
                    type="radio"
                    checked={accessMode === 'all_active'}
                    disabled={!canEditProfile || busy !== null}
                    onChange={() => changeAccessMode('all_active')}
                  />
                  <span>{t('all_active_projects_access')}</span>
                </label>
              </div>

              {accessMode === 'assigned' ? (
                <div className="project-toggle-list">
                  {projects.map((project) => (
                    <label className="check-row" key={project.id}>
                      <input
                        type="checkbox"
                        checked={assignmentSet.has(project.id)}
                        disabled={!canEditProfile || busy !== null}
                        onChange={(e) => toggleProject(project.id, e.target.checked)}
                      />
                      <span>{project.name}</span>
                    </label>
                  ))}
                </div>
              ) : (
                // В режиме «Все активные» проекты видны все, кроме перечисленных исключений
                <div className="excluded-projects">
                  <h3>{t('excluded_projects')}</h3>
                  <p className="muted">{t('excluded_projects_hint')}</p>

                  {exclusions.length === 0 && <p className="muted">{t('no_excluded_projects')}</p>}
                  <div className="project-toggle-list">
                    {exclusions.map((row) => (
                      <div className="worker-day-row" key={row.project_id}>
                        <span>{row.project?.name ?? projectNames.get(row.project_id) ?? row.project_id}</span>
                        <button
                          className="btn ghost small"
                          type="button"
                          disabled={!canEditProfile || busy !== null}
                          onClick={() => includeProject(row.project_id)}
                        >
                          {t('include_project')}
                        </button>
                      </div>
                    ))}
                  </div>

                  {canEditProfile && (
                    <div className="row exclude-add">
                      <select value={excludePick} disabled={busy !== null} onChange={(e) => setExcludePick(e.target.value)}>
                        <option value="">{t('select_project')}</option>
                        {excludableProjects.map((project) => (
                          <option key={project.id} value={project.id}>{project.name}</option>
                        ))}
                      </select>
                      <button
                        className="btn small"
                        type="button"
                        disabled={busy !== null || !excludePick}
                        onClick={() => excludeProject(excludePick)}
                      >
                        {t('exclude_project')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section>
              <h2>{t('send_message')}</h2>
              <MessageComposer recipients={[worker]} initialRecipientId={worker.id} lockRecipient />
            </section>
          </div>
        </>
      )}

      {/* TEAM-PIN-UI: модалка «Сбросить PIN». Ввод только цифр (4–8) + кнопка-генератор. «Сохранить»
          шлёт edge set-worker-pin. 409 pin_taken держит модалку открытой с подсказкой выбрать другой. */}
      {pinModalOpen && worker && (
        <div className="confirm-backdrop" onClick={closePinModal}>
          <div className="card confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="item-title">{t('reset_pin')}</div>
            <p className="muted">{t('reset_pin_modal_hint')}</p>
            <label>{t('new_pin_label')}</label>
            <div className="row set-password-row">
              <input
                value={pinInput}
                disabled={busy !== null}
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                placeholder="••••"
                onChange={(e) => { setPinInput(e.target.value.replace(/\D/g, '').slice(0, 8)); setPinMsg(null) }}
              />
              <button
                type="button"
                className="btn ghost small"
                disabled={busy !== null}
                onClick={() => { setPinInput(generatePin()); setPinMsg(null) }}
              >
                {t('generate_pin')}
              </button>
            </div>
            {pinMsg && <p className={pinMsg === 'pin_updated' ? 'ok-msg' : 'error-msg'}>{t(pinMsg)}</p>}
            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              <button
                type="button"
                className="btn"
                disabled={busy !== null || !/^\d{4,8}$/.test(pinInput)}
                onClick={submitPin}
              >
                {t('save')}
              </button>
              <button type="button" className="btn ghost" disabled={busy !== null} onClick={closePinModal}>
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeDayPhotoUrl && (
        <div className="gallery-lightbox" onClick={() => setActiveDayPhotoUrl(null)}>
          <button
            type="button"
            className="gallery-lightbox-close"
            aria-label={t('close')}
            onClick={() => setActiveDayPhotoUrl(null)}
          >
            ✕
          </button>
          <img src={activeDayPhotoUrl} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
