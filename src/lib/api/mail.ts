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
  uid: number
  message_id: string | null
  from_name: string | null
  from_addr: string | null
  to_addr: string | null
  subject: string | null
  snippet: string | null
  body_text: string | null
  sent_at: string | null
  seen: boolean
  created_at: string
}

const MAIL_ACCOUNT_SELECT =
  'id, org_id, key, brand, email, display_name, active, last_sync_at, last_uid, last_error, imap_host, imap_port, created_at'
const MAIL_MESSAGE_SELECT =
  'id, org_id, account_id, uid, message_id, from_name, from_addr, to_addr, subject, snippet, body_text, sent_at, seen, created_at'

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
export async function getMailUnreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from('mail_messages')
    .select('id', { count: 'exact', head: true })
    .eq('seen', false)
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

// Кросс-компонентный сигнал «непрочитанных стало иначе» — Mail.tsx шлёт его после отметки
// прочитанным / после sync, Nav.tsx слушает и пересчитывает бейдж (без общего провайдера).
export const MAIL_UNREAD_EVENT = 'mail:unread-changed'

export function emitMailUnreadChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MAIL_UNREAD_EVENT))
}
