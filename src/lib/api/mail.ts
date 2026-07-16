import { supabase } from '../supabase'
import { warnReadError } from './_shared'

// MAIL-1-UI: чтение развёрнутого mail-бэкенда (таблицы mail_accounts / mail_messages, edge
// `mail-sync`). Backend уже развёрнут — здесь ТОЛЬКО фронт: читаем через RLS (owner-only),
// помечаем письмо прочитанным (update), дёргаем refresh. Ошибки чтения деградируют мягко в []
// (паттерн warnReadError, как в storage.ts/getCompanyFiles) — пустой/ошибочный ящик это НЕ баг
// (Andrei мог ещё не ввести секреты).

export interface MailAccount {
  id: string
  org_id: string
  key: string // 'buildpro' | 'customhomes'
  brand: string // 'nw_build_pro' | 'nw_custom_homes'
  email: string
  display_name: string
  active: boolean
  last_sync_at: string | null
  last_uid: number | null
  last_error: string | null
  imap_host: string | null
  imap_port: number | null
  created_at: string
}

export interface MailMessage {
  id: string
  org_id: string
  account_id: string
  uid: number | null // MAIL-2-UI: у исходящих (direction='out') IMAP-uid нет — стал nullable.
  message_id: string | null
  from_name: string | null
  from_addr: string | null
  to_addr: string | null
  subject: string | null
  snippet: string | null
  body_text: string | null
  sent_at: string | null
  seen: boolean
  direction: 'in' | 'out' // MAIL-2-UI: 'in' входящее (DEFAULT), 'out' исходящее (отправлено из приложения).
  created_at: string
}

const MAIL_ACCOUNT_SELECT =
  'id, org_id, key, brand, email, display_name, active, last_sync_at, last_uid, last_error, imap_host, imap_port, created_at'
const MAIL_MESSAGE_SELECT =
  'id, org_id, account_id, uid, message_id, from_name, from_addr, to_addr, subject, snippet, body_text, sent_at, seen, direction, created_at'

// Оба почтовых ящика (buildpro / customhomes) для вкладок. RLS отдаёт строки только владельцу;
// admin/иные роли получат [] — это ожидаемо (мягкий пустой экран). error → [] (не роняем экран).
export async function getMailAccounts(): Promise<MailAccount[]> {
  const { data, error } = await supabase
    .from('mail_accounts')
    .select(MAIL_ACCOUNT_SELECT)
    .order('created_at', { ascending: true })
  if (error) {
    warnReadError('getMailAccounts', error)
    return []
  }
  return (data as MailAccount[]) ?? []
}

// Письма (опционально одного ящика). Свежие сверху: сначала по дате отправки, затем по created_at
// (sent_at может быть null у сырого письма). error → [] (мягкая деградация UI).
export async function getMailMessages(accountId?: string): Promise<MailMessage[]> {
  let query = supabase
    .from('mail_messages')
    .select(MAIL_MESSAGE_SELECT)
    .order('sent_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
  if (accountId) query = query.eq('account_id', accountId)
  const { data, error } = await query
  if (error) {
    warnReadError('getMailMessages', error)
    return []
  }
  return (data as MailMessage[]) ?? []
}

// Счётчик непрочитанных для бейджа в навигации. head+count — не тянем строки. error → 0.
// MAIL-2-UI: считаем ТОЛЬКО входящие непрочитанные (direction='in' AND seen=false), чтобы
// исходящие письма (direction='out', seen=true) никогда не раздували бейдж непрочитанного.
export async function getMailUnreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from('mail_messages')
    .select('id', { count: 'exact', head: true })
    .eq('seen', false)
    .eq('direction', 'in')
  if (error) {
    warnReadError('getMailUnreadCount', error)
    return 0
  }
  return count ?? 0
}

// Пометить письмо прочитанным (seen=true). RLS mail_messages update — только владелец.
export async function markMailSeen(id: string): Promise<void> {
  const { error } = await supabase.from('mail_messages').update({ seen: true }).eq('id', id)
  if (error) throw error
}

// Результат одного ящика из edge `mail-sync`. Форму читаем защитно (ключи могут отличаться) —
// поэтому все поля опциональны, а UI сам подбирает лейбл.
export interface MailSyncMailboxResult {
  key?: string
  account?: string
  display_name?: string
  email?: string
  sent?: number
  fetched?: number
  new?: number
  skipped?: number
  error?: string | null
  ok?: boolean
}

export interface MailSyncResult {
  results: MailSyncMailboxResult[]
  error?: string
}

// «Обновить»: дёргаем edge `mail-sync`. supabase-js сам прикрепит JWT залогиненного пользователя
// (edge пускает owner/admin). Возвращает { results: [...] } по каждому ящику. На ошибку invoke —
// { results: [], error } (UI покажет дружелюбный тост, не падает).
export async function triggerMailSync(): Promise<MailSyncResult> {
  const { data, error } = await supabase.functions.invoke('mail-sync')
  if (error) return { results: [], error: 'invoke_failed' }
  const results = Array.isArray((data as { results?: unknown })?.results)
    ? ((data as { results: MailSyncMailboxResult[] }).results)
    : []
  return { results }
}

// MAIL-2-UI: отправка письма ИЗ приложения. Вход в edge `mail-send` (backend уже развёрнут и
// smoke-тестирован). account_key = mail_accounts.key ('buildpro'|'customhomes'); in_reply_to —
// message_id письма, на которое отвечаем (опционально). supabase-js сам прикрепит Bearer JWT;
// edge авторизует owner/admin и САМ вставляет строку mail_messages (direction='out', seen=true)
// и пишет событие mail.sent — поэтому строку исходящего мы НЕ вставляем, а просто рефетчим ящик.
export interface SendMailInput {
  account_key: string
  to: string
  subject: string
  body: string
  in_reply_to?: string | null
}

export interface SendMailResult {
  ok: boolean
  error?: string // текст ошибки от edge (для тоста), если не удалось отправить
}

// Достаём текст ошибки из тела ответа edge (FunctionsHttpError несёт Response в error.context),
// как это делает clients.ts/broadcastFunctionErrorCode. Возвращает undefined, если тела нет.
async function mailSendErrorText(error: unknown): Promise<string | undefined> {
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context
  if (typeof context?.json !== 'function') return undefined
  try {
    const body = await context.json()
    const raw = (body as { error?: unknown } | null)?.error
    return typeof raw === 'string' && raw.trim() ? raw : undefined
  } catch {
    return undefined
  }
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const { data, error } = await supabase.functions.invoke('mail-send', {
    body: {
      account_key: input.account_key,
      to: input.to,
      subject: input.subject,
      body: input.body,
      in_reply_to: input.in_reply_to ?? null,
    },
  })
  if (error) {
    // На non-2xx supabase-js кладёт ошибку в `error` (data=null); читаем текст edge из тела.
    const fromData = (data as { error?: unknown } | null)?.error
    const text = (typeof fromData === 'string' && fromData.trim() ? fromData : undefined)
      ?? (await mailSendErrorText(error))
      ?? (error instanceof Error ? error.message : undefined)
    return { ok: false, error: text }
  }
  // Edge может вернуть 200 с { error } — тоже трактуем как неуспех.
  const dataErr = (data as { error?: unknown } | null)?.error
  if (typeof dataErr === 'string' && dataErr.trim()) return { ok: false, error: dataErr }
  return { ok: true }
}

// Кросс-компонентный сигнал «непрочитанных стало иначе» — Mail.tsx шлёт его после отметки
// прочитанным / после sync, Nav.tsx слушает и пересчитывает бейдж (без общего провайдера).
export const MAIL_UNREAD_EVENT = 'mail:unread-changed'

export function emitMailUnreadChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MAIL_UNREAD_EVENT))
}
