import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getMessages, getOpenTasks, subscribeToMyMessages, subscribeToTaskChanges } from './api'
import { useAuth } from './auth'
import { useI18n } from './i18n'
import { armUrgentChimeUnlock, playUrgentChime } from './notification-sound'
import { armNotificationPermission, showNotification } from './web-notification'
import { notifPrefs } from './types'
import type { MessageRow, Task } from './types'

// MSG-1: единый клиентский центр уведомлений для ВСЕХ ролей. Реюзает уже существующие realtime-
// подписки (subscribeToMyMessages / subscribeToTaskChanges) и звук чима (notification-sound.ts).
//   • новое сообщение мне → короткий звук + (если вкладка не в фокусе) Web Notification;
//   • новая задача, назначенная мне (исполнителю) → то же;
//   • бейдж непрочитанных сообщений (unreadMessages) — для пункта «Сообщения» в навигации.
// Уважает profiles.notif_mode через notifPrefs (off → тишина, quiet → без звука). Бейдж пассивный —
// показывается всегда. Менеджерский колокол (ManagerWorkAlertBell) остаётся как есть: он про
// оперативную сводку всей орг., этот провайдер — про личные звук/уведомление и счётчик.

interface NotificationsState {
  unreadMessages: number
  // Немедленный пересчёт бейджа — зовём после отметки «прочитано» (это UPDATE, а подписка
  // subscribeToMyMessages ловит только INSERT, поэтому сама по себе бейдж на чтении не обновит).
  refreshUnread: () => void
}

const Ctx = createContext<NotificationsState>({ unreadMessages: 0, refreshUnread: () => {} })

// Бэкстоп-поллинг бейджа (как ~30с у ManagerWorkAlertBell): страхует от пропущенных событий и
// приводит счётчик в порядок после чтения/удаления сообщений на другом устройстве.
const POLL_MS = 30_000

// Звук всегда (не завязан на фокус — вкладка может быть в фоне), уведомление — только когда вкладка
// скрыта (document.hidden), чтобы не дублировать то, что пользователь и так видит на экране.
function alertArrival(mode: string | null | undefined, title: string, body: string): void {
  const prefs = notifPrefs(mode)
  const hidden = typeof document !== 'undefined' && document.hidden
  if (prefs.sound) {
    playUrgentChime()
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([120])
  }
  if (prefs.notify && hidden) showNotification(title, body)
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [unreadMessages, setUnreadMessages] = useState(0)

  // Множества уже «виденных» id, чтобы звенеть ровно один раз на действительно новое. Первая
  // загрузка = гидратация (сеем как виденное, без звука), как в ManagerWorkAlertBell.
  const seenMsg = useRef<Set<string>>(new Set())
  const seenTask = useRef<Set<string>>(new Set())
  const hydratedMsg = useRef(false)
  const hydratedTask = useRef(false)
  // notif_mode читаем через ref, чтобы колбэки подписок видели свежее значение без переподписки.
  const modeRef = useRef<string | null | undefined>(profile?.notif_mode)
  modeRef.current = profile?.notif_mode

  // Разблокировка звука и запрос разрешения на уведомления — оба на первом жесте, один раз.
  useEffect(() => {
    armUrgentChimeUnlock()
    armNotificationPermission()
  }, [])

  // Сброс состояния при смене пользователя (logout/login под другим профилем).
  useEffect(() => {
    seenMsg.current = new Set()
    seenTask.current = new Set()
    hydratedMsg.current = false
    hydratedTask.current = false
    setUnreadMessages(0)
  }, [profile?.id])

  const reloadMessages = useCallback(async () => {
    if (!profile?.id) return
    let rows: MessageRow[]
    try {
      rows = await getMessages(profile.id)
    } catch {
      return // best-effort: не роняем UI на транзиентной ошибке чтения
    }
    const unreadToMe = rows.filter((m) => m.recipient_id === profile.id && !m.read_at)
    setUnreadMessages(unreadToMe.length)
    const ids = unreadToMe.map((m) => m.id)
    if (!hydratedMsg.current) {
      hydratedMsg.current = true
      for (const id of ids) seenMsg.current.add(id)
      return
    }
    const fresh = unreadToMe.filter((m) => !seenMsg.current.has(m.id))
    seenMsg.current = new Set(ids) // прунинг: прочитанные уходят, память ограничена
    if (fresh.length > 0) {
      const newest = fresh[0] // getMessages отдаёт created_at desc
      alertArrival(modeRef.current, t('notif_new_message'), newest.body)
    }
  }, [profile?.id, t])

  const reloadTasks = useCallback(async () => {
    if (!profile?.id) return
    let tasks: Task[]
    try {
      tasks = await getOpenTasks()
    } catch {
      return
    }
    // Только задачи, назначенные мне как исполнителю (open/in_progress уже отфильтрованы источником).
    const mine = tasks.filter((tk) => tk.assigned_to === profile.id)
    const ids = mine.map((tk) => tk.id)
    if (!hydratedTask.current) {
      hydratedTask.current = true
      for (const id of ids) seenTask.current.add(id)
      return
    }
    const fresh = mine.filter((tk) => !seenTask.current.has(tk.id))
    seenTask.current = new Set(ids)
    if (fresh.length > 0) {
      alertArrival(modeRef.current, t('notif_new_task'), fresh[0].title)
    }
  }, [profile?.id, t])

  // Подписки: новое сообщение мне (INSERT) и изменения задач по орг. (реюз существующих каналов).
  useEffect(() => {
    if (!profile?.id || !profile?.org_id) return
    void reloadMessages()
    void reloadTasks()
    const offMessages = subscribeToMyMessages(profile.id, () => { void reloadMessages() }, `messages:notify:${profile.id}`)
    const offTasks = subscribeToTaskChanges(profile.org_id, () => { void reloadTasks() }, `tasks:notify:${profile.id}`)
    // Бэкстоп-поллинг + пересчёт при возврате фокуса на вкладку (чтение — это UPDATE, не INSERT).
    const poll = window.setInterval(() => { void reloadMessages() }, POLL_MS)
    const onVisible = () => { if (!document.hidden) void reloadMessages() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      offMessages()
      offTasks()
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [profile?.id, profile?.org_id, reloadMessages, reloadTasks])

  return <Ctx.Provider value={{ unreadMessages, refreshUnread: () => { void reloadMessages() } }}>{children}</Ctx.Provider>
}

export const useNotifications = () => useContext(Ctx)
