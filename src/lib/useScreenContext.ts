import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useI18n } from './i18n'

// AI-UX-2 (п.5): «сущность должна видеть, что я делаю». Хук собирает ЧЕЛОВЕКОЧИТАЕМЫЙ контекст
// текущего экрана ТОЛЬКО из location.pathname / query (react-router useLocation) — БЕЗ единого
// нового запроса к БД. Результат передаётся ассистенту при каждом вопросе (edge ai-assistant v8
// принимает поле context {route, screen, details}). Имена сущностей в наших URL — это id (имена в
// адресе не лежат), поэтому в screen кладём человекочитаемое имя экрана + короткий id открытой
// карточки, а активную вкладку (?tab=) — в details.
export interface ScreenContext {
  route: string
  screen: string
  details?: string
}

// Первый сегмент пути → существующий i18n-ключ с человекочитаемым именем экрана (переиспользуем
// подписи навигации, чтобы имя было на языке интерфейса и без дублей). Пустой сегмент = '/', у
// владельца это Командный центр (App.tsx редиректит owner с '/' на /dispatch).
const SCREEN_KEY: Record<string, string> = {
  '': 'command_center',
  overview: 'overview',
  dispatch: 'command_center',
  'command-center': 'command_center',
  projects: 'projects',
  team: 'team',
  tasks: 'tasks',
  schedule: 'schedule',
  calendar: 'calendar',
  'team-calendar': 'team_calendar',
  map: 'map',
  sales: 'sales',
  reports: 'reports',
  timeline: 'timeline',
  archive: 'archive',
  trash: 'trash_title',
  stores: 'stores',
  clients: 'clients',
  broadcast: 'broadcast_title',
  gallery: 'gallery',
  documents: 'documents',
  files: 'files',
  daily: 'daily_reports',
  mail: 'mail',
  settings: 'settings',
  catalog: 'catalog',
  time: 'my_time',
  payroll: 'payroll',
  messages: 'messages',
  more: 'more',
  checkin: 'checkin',
  route: 'route_nav',
}

// Маршруты с открытой одной сущностью (в URL лежит её id): база → i18n-ключ «карточка <сущности>».
const ENTITY_KEY: Record<string, string> = {
  projects: 'ai_ctx_project',
  team: 'ai_ctx_worker',
}

export function useScreenContext(): ScreenContext {
  const { pathname, search } = useLocation()
  const { t, lang } = useI18n()
  return useMemo(() => {
    const segs = pathname.split('/').filter(Boolean)
    const base = segs[0] ?? ''
    const entityId = segs[1]

    // Имя экрана: по карте ключей → i18n; неизвестный сегмент отдаём как есть (не выдумываем).
    let screen = t(SCREEN_KEY[base] ?? '')
    if (!screen) screen = base || t('command_center')

    // Открытая карточка сущности — добавляем короткий id (полного имени в URL нет).
    if (entityId && ENTITY_KEY[base]) {
      const shortId = entityId.length > 8 ? `${entityId.slice(0, 8)}…` : entityId
      screen = `${t(ENTITY_KEY[base])} (#${shortId})`
    }

    // Детали: активная вкладка из ?tab= (её используют несколько экранов) — если есть.
    const tab = new URLSearchParams(search).get('tab')
    const details = tab ? `${t('ai_ctx_tab')}: ${tab}` : undefined

    return { route: pathname, screen, details }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search, lang])
}
