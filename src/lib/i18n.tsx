import { createContext, useContext, useState, type ReactNode } from 'react'

type Lang = 'ru' | 'en' | 'es'

const dict: Record<string, Record<Lang, string>> = {
  appName: { ru: 'Construction Clock', en: 'Construction Clock', es: 'Construction Clock' },
  desktop_nav: { ru: 'Навигация офиса', en: 'Office navigation', es: 'Navegación de oficina' },
  desktop_workspace: { ru: 'Офис', en: 'Office', es: 'Oficina' },
  nav_group_main: { ru: 'ОСНОВНОЕ', en: 'MAIN', es: 'PRINCIPAL' },
  nav_group_work: { ru: 'РАБОТА', en: 'WORK', es: 'TRABAJO' },
  nav_group_finance_clients: { ru: 'ФИНАНСЫ И КЛИЕНТЫ', en: 'FINANCE & CLIENTS', es: 'FINANZAS Y CLIENTES' },
  nav_group_admin: { ru: 'АДМИН', en: 'ADMIN', es: 'ADMIN' },
  login_office: { ru: 'Офис / Владелец', en: 'Office / Owner', es: 'Oficina / Dueño' },
  login_worker: { ru: 'Работник (PIN)', en: 'Worker (PIN)', es: 'Trabajador (PIN)' },
  email: { ru: 'Почта', en: 'Email', es: 'Correo' },
  password: { ru: 'Пароль', en: 'Password', es: 'Contraseña' },
  signin: { ru: 'Войти', en: 'Sign in', es: 'Entrar' },
  enter_pin: { ru: 'Введите PIN', en: 'Enter PIN', es: 'Ingrese PIN' },
  wrong_login: { ru: 'Неверные данные входа', en: 'Invalid credentials', es: 'Credenciales inválidas' },
  locked: { ru: 'Слишком много попыток. Подождите 15 минут', en: 'Too many attempts. Wait 15 minutes', es: 'Demasiados intentos. Espere 15 minutos' },
  dashboard: { ru: 'Дашборд', en: 'Dashboard', es: 'Panel' },
  checkin: { ru: 'Отметка', en: 'Check-In', es: 'Marcar' },
  projects: { ru: 'Проекты', en: 'Projects', es: 'Proyectos' },
  team: { ru: 'Команда', en: 'Team', es: 'Equipo' },
  more: { ru: 'Ещё', en: 'More', es: 'Más' },
  my_time: { ru: 'Мои часы', en: 'My hours', es: 'Mis horas' },
  on_site_now: { ru: 'Сейчас на объектах', en: 'On site now', es: 'En obra ahora' },
  hours_today: { ru: 'Часов сегодня', en: 'Hours today', es: 'Horas hoy' },
  active_projects: { ru: 'Активные проекты', en: 'Active projects', es: 'Proyectos activos' },
  open_tasks: { ru: 'Открытые задачи', en: 'Open tasks', es: 'Tareas abiertas' },
  recent_activity: { ru: 'Последняя активность', en: 'Recent activity', es: 'Actividad reciente' },
  nobody_on_site: { ru: 'Никого нет на объектах', en: 'Nobody on site', es: 'Nadie en obra' },
  select_project: { ru: 'Выбери проект', en: 'Select project', es: 'Elige proyecto' },
  check_in: { ru: 'ПРИШЁЛ', en: 'CHECK IN', es: 'ENTRADA' },
  check_out: { ru: 'УШЁЛ', en: 'CHECK OUT', es: 'SALIDA' },
  break_start: { ru: 'Перерыв', en: 'Break', es: 'Pausa' },
  break_end: { ru: 'Закончить перерыв', en: 'End break', es: 'Fin pausa' },
  on_shift_since: { ru: 'На смене с', en: 'On shift since', es: 'En turno desde' },
  on_break: { ru: 'На перерыве', en: 'On break', es: 'En pausa' },
  not_on_shift: { ru: 'Не на смене', en: 'Not on shift', es: 'Fuera de turno' },
  gps_wait: { ru: 'Получаю GPS…', en: 'Getting GPS…', es: 'Obteniendo GPS…' },
  gps_ok: { ru: 'GPS получен', en: 'GPS captured', es: 'GPS capturado' },
  gps_fail: { ru: 'GPS не взялся — отметка всё равно пройдёт', en: 'No GPS — check-in still counts', es: 'Sin GPS — la marca cuenta igual' },
  saved: { ru: 'Записано', en: 'Saved', es: 'Guardado' },
  add_worker: { ru: 'Добавить работника', en: 'Add worker', es: 'Agregar trabajador' },
  name: { ru: 'Имя', en: 'Name', es: 'Nombre' },
  role: { ru: 'Роль', en: 'Role', es: 'Rol' },
  pin: { ru: 'PIN (4–8 цифр)', en: 'PIN (4–8 digits)', es: 'PIN (4–8 dígitos)' },
  create: { ru: 'Создать', en: 'Create', es: 'Crear' },
  add_project: { ru: 'Добавить проект', en: 'Add project', es: 'Agregar proyecto' },
  address: { ru: 'Адрес', en: 'Address', es: 'Dirección' },
  today: { ru: 'Сегодня', en: 'Today', es: 'Hoy' },
  week: { ru: 'Неделя', en: 'Week', es: 'Semana' },
  logout: { ru: 'Выйти', en: 'Log out', es: 'Salir' },
  language: { ru: 'Язык', en: 'Language', es: 'Idioma' },
  worker_created: { ru: 'Работник создан', en: 'Worker created', es: 'Trabajador creado' },
  pin_taken: { ru: 'Такой PIN уже занят', en: 'PIN already taken', es: 'PIN ya en uso' },
  error: { ru: 'Ошибка', en: 'Error', es: 'Error' },
  no_tasks: { ru: 'Задач нет', en: 'No tasks', es: 'Sin tareas' },
  tasks: { ru: 'Задачи', en: 'Tasks', es: 'Tareas' },
  done: { ru: 'Готово', en: 'Done', es: 'Hecho' },
  h: { ru: 'ч', en: 'h', es: 'h' },
  org: { ru: 'Организация', en: 'Organization', es: 'Organización' },
}

interface I18n {
  lang: Lang
  setLang: (l: Lang) => void
  t: (k: string) => string
}

const I18nCtx = createContext<I18n>({ lang: 'ru', setLang: () => {}, t: (k) => k })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem('cclock_lang') as Lang) || 'ru')
  const setLang = (l: Lang) => { localStorage.setItem('cclock_lang', l); setLangState(l) }
  const t = (k: string) => dict[k]?.[lang] ?? k
  return <I18nCtx.Provider value={{ lang, setLang, t }}>{children}</I18nCtx.Provider>
}

export const useI18n = () => useContext(I18nCtx)
