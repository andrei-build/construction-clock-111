import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import VoiceMic from './VoiceMic'
import {
  getTeam,
  getProjects,
  createTask,
  sendMessage,
  createCalendarEvent,
  sendMail,
} from '../lib/api'
import {
  getAiMessages,
  getPendingProposals,
  askAssistant,
  resolveProposal,
  type AiMessage,
  type AiProposal,
} from '../lib/api/ai'
import type { Profile, Project } from '../lib/types'

// AI-1-UI: «строка-командир» — оверлей-диалог AI-ассистента ВЛАДЕЛЬЦА. Монтируется в App ТОЛЬКО
// для owner (см. App.tsx: {isOwner && <AiCommandBar/>}) — RLS ai_messages/ai_proposals гейтятся
// app.is_owner(), у admin история пуста, а update молча затрагивает 0 строк, поэтому в v1 экран
// строго owner-only. Открывается кнопкой «Спроси» (шапка/сайдбар, Nav.tsx) через AI_OPEN_EVENT и
// глобальным Ctrl+K / Cmd+K (слушатель ниже). Закрытие по Esc / клику по фону.
//
// Контракт с бэкендом: user/assistant-сообщения в ai_messages и pending-предложения в ai_proposals
// пишет ТОЛЬКО edge (service-role) при POST /ai-assistant. С фронта мы историю читаем, предложения
// читаем и помечаем executed/rejected (update). Ничего не вставляем — см. src/lib/api/ai.ts.

// Событие открытия оверлея из шапки (кнопка «Спроси» в Nav диспатчит его) — так кнопка в сайдбаре
// и смонтированный в App оверлей общаются без общего провайдера (паттерн MAIL_UNREAD_EVENT).
export const AI_OPEN_EVENT = 'ai:open'
export function emitAiOpen(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AI_OPEN_EVENT))
}

const TASK_TYPES = ['work', 'material', 'delivery'] as const
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
const MSG_PRIORITIES = ['urgent', 'info', 'good', 'task'] as const
const EVENT_TYPES = ['meeting', 'inspection', 'measure', 'delivery', 'other'] as const
const KNOWN_ACTIONS = new Set(['create_task', 'send_message', 'send_mail', 'create_event'])

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

// Достаём первое непустое строковое/числовое значение из payload по списку синонимичных ключей
// (ИИ может назвать поле по-разному). Триммим строки, числа приводим к строке.
function pStr(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = payload[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

type NameHit = { id: string } | 'ambiguous' | 'none'

// Резолвим имя → id из УЖЕ загруженного списка (team/projects). Сначала точное совпадение имени,
// затем — единственное частичное. Неоднозначно/не найдено → не выдумываем (executed не помечаем).
function resolveName(list: Array<{ id: string; name: string | null }>, name: string | undefined): NameHit {
  if (!name) return 'none'
  const norm = name.trim().toLowerCase()
  if (!norm) return 'none'
  const exact = list.filter((x) => (x.name ?? '').trim().toLowerCase() === norm)
  if (exact.length === 1) return { id: exact[0].id }
  if (exact.length > 1) return 'ambiguous'
  const partial = list.filter((x) => (x.name ?? '').trim().toLowerCase().includes(norm))
  if (partial.length === 1) return { id: partial[0].id }
  return partial.length > 1 ? 'ambiguous' : 'none'
}

// Человекочитаемый разбор payload: пары ключ→значение (пустые/служебные значения отсеиваем,
// объекты сериализуем). БЕЗ dangerouslySetInnerHTML — всё plain text.
function summarizePayload(payload: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(payload)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string])
}

export default function AiCommandBar({ profile }: { profile: Profile }) {
  const { t, lang } = useI18n()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [proposals, setProposals] = useState<AiProposal[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [noKey, setNoKey] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const historyEndRef = useRef<HTMLDivElement | null>(null)

  const flashToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => {
      setToast(null)
      toastTimer.current = null
    }, 3200)
  }, [])
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current) }, [])

  // Полная загрузка при открытии: история + pending-предложения + справочники для резолва имён.
  const load = useCallback(async () => {
    const [msgs, props, tm, prj] = await Promise.all([
      getAiMessages(),
      getPendingProposals(),
      getTeam(),
      getProjects(),
    ])
    setMessages(msgs)
    setProposals(props)
    setTeam(tm)
    setProjects(prj)
  }, [])

  // Рефетч после отправки/действия: история (reply пишет edge) + pending-предложения.
  const reload = useCallback(async () => {
    const [msgs, props] = await Promise.all([getAiMessages(), getPendingProposals()])
    setMessages(msgs)
    setProposals(props)
  }, [])

  // Глобальные слушатели: Ctrl+K / Cmd+K и AI_OPEN_EVENT (кнопка «Спроси») открывают оверлей.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen(true)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(AI_OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(AI_OPEN_EVENT, onOpen)
    }
  }, [])

  // Esc закрывает (только пока открыт).
  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [open])

  // При открытии — грузим данные и фокусируем поле ввода.
  useEffect(() => {
    if (!open) return
    setNoKey(false)
    setLoading(true)
    void load().finally(() => setLoading(false))
    const id = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(id)
  }, [open, load])

  // Автоскролл ленты вниз при изменении истории (пока открыт).
  useEffect(() => {
    if (open) historyEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, open])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const msg = input.trim()
    if (!msg || thinking) return
    setThinking(true)
    setNoKey(false)
    const res = await askAssistant(msg)
    if (res.error === 'no_key') { setNoKey(true); setThinking(false); return }
    if (res.error) {
      flashToast(res.error === 'no_session' || res.error === 'request_failed' ? t('ai_error') : res.error)
      setThinking(false)
      return
    }
    // Успех: user/assistant-строки уже записал edge — просто рефетчим историю и предложения.
    setInput('')
    await reload()
    setThinking(false)
  }

  const executeProposal = async (pr: AiProposal) => {
    if (busyId) return
    setBusyId(pr.id)
    try {
      if (pr.action_type === 'create_task') {
        const title = pStr(pr.payload, 'title', 'name')
        if (!title) { flashToast(t('ai_execute_failed')); return }
        let assigned_to: string | null = null
        const assigneeName = pStr(pr.payload, 'assignee_name', 'assigned_to_name', 'assignee')
        if (assigneeName) {
          const hit = resolveName(team, assigneeName)
          if (hit === 'ambiguous' || hit === 'none') { flashToast(t('ai_unresolved')); return }
          assigned_to = hit.id
        }
        let project_id: string | null = null
        const projectName = pStr(pr.payload, 'project_name', 'project')
        if (projectName) {
          const hit = resolveName(projects, projectName)
          if (hit === 'ambiguous' || hit === 'none') { flashToast(t('ai_unresolved')); return }
          project_id = hit.id
        }
        const taskId = await createTask(profile, {
          project_id,
          title,
          task_type: pickEnum(pr.payload.task_type, TASK_TYPES, 'work'),
          priority: pickEnum(pr.payload.priority, TASK_PRIORITIES, 'medium'),
          assigned_to,
          due_date: pStr(pr.payload, 'due_date') ?? null,
          description: pStr(pr.payload, 'description') ?? null,
        })
        await resolveProposal(pr.id, 'executed', { id: taskId })
        flashToast(t('ai_executed_ok'))
      } else if (pr.action_type === 'send_message') {
        const body = pStr(pr.payload, 'body', 'message', 'text')
        if (!body) { flashToast(t('ai_execute_failed')); return }
        const recipientName = pStr(pr.payload, 'recipient_name', 'to_name', 'recipient', 'to')
        const hit = resolveName(team, recipientName)
        if (hit === 'ambiguous' || hit === 'none') { flashToast(t('ai_unresolved')); return }
        await sendMessage(profile, hit.id, body, pickEnum(pr.payload.priority, MSG_PRIORITIES, 'info'))
        await resolveProposal(pr.id, 'executed', {})
        flashToast(t('ai_executed_ok'))
      } else if (pr.action_type === 'send_mail') {
        const account_key = pStr(pr.payload, 'account_key', 'account')
        const to = pStr(pr.payload, 'to')
        if (!account_key || !to) { flashToast(t('ai_execute_failed')); return }
        const res = await sendMail({
          account_key,
          to,
          subject: pStr(pr.payload, 'subject') ?? '',
          body: pStr(pr.payload, 'body', 'message', 'text') ?? '',
          in_reply_to: pStr(pr.payload, 'in_reply_to') ?? null,
        })
        if (!res.ok) { flashToast(res.error ? `${t('ai_execute_failed')}: ${res.error}` : t('ai_execute_failed')); return }
        await resolveProposal(pr.id, 'executed', {})
        flashToast(t('ai_executed_ok'))
      } else if (pr.action_type === 'create_event') {
        const title = pStr(pr.payload, 'title')
        const starts_at = pStr(pr.payload, 'starts_at', 'start', 'starts')
        if (!title || !starts_at) { flashToast(t('ai_execute_failed')); return }
        let project_id: string | null = null
        const projectName = pStr(pr.payload, 'project_name', 'project')
        if (projectName) {
          const hit = resolveName(projects, projectName)
          if (hit === 'ambiguous' || hit === 'none') { flashToast(t('ai_unresolved')); return }
          project_id = hit.id
        }
        let assigned_to: string | null = null
        const assigneeName = pStr(pr.payload, 'assignee_name', 'assigned_to_name', 'assignee')
        if (assigneeName) {
          const hit = resolveName(team, assigneeName)
          if (hit === 'ambiguous' || hit === 'none') { flashToast(t('ai_unresolved')); return }
          assigned_to = hit.id
        }
        await createCalendarEvent(profile, {
          title,
          event_type: pickEnum(pr.payload.event_type, EVENT_TYPES, 'other'),
          starts_at,
          ends_at: pStr(pr.payload, 'ends_at') ?? null,
          permit_number: pStr(pr.payload, 'permit_number') ?? null,
          inspection_status: pStr(pr.payload, 'inspection_status') ?? null,
          project_id,
          assigned_to,
          notes: pStr(pr.payload, 'notes') ?? null,
        })
        await resolveProposal(pr.id, 'executed', {})
        flashToast(t('ai_executed_ok'))
      } else {
        return
      }
      await reload()
    } catch {
      // Ошибка выполнения — статус НЕ трогаем (карточка остаётся pending, можно повторить).
      flashToast(t('ai_execute_failed'))
    } finally {
      setBusyId(null)
    }
  }

  const rejectProposal = async (pr: AiProposal) => {
    if (busyId) return
    setBusyId(pr.id)
    try {
      await resolveProposal(pr.id, 'rejected')
      setProposals((prev) => prev.filter((x) => x.id !== pr.id))
      flashToast(t('ai_rejected_ok'))
    } catch {
      flashToast(t('ai_reject_failed'))
    } finally {
      setBusyId(null)
    }
  }

  if (!open) return null

  return (
    <div
      className="confirm-backdrop ai-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-cmd-title"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
    >
      <div className="card ai-modal">
        <div className="ai-head">
          <div>
            <h2 id="ai-cmd-title" className="ai-title">{t('ai_title')}</h2>
            <p className="muted small ai-sub">{t('ai_subtitle')}</p>
          </div>
          <button type="button" className="btn ghost ai-close" onClick={() => setOpen(false)} aria-label={t('close')}>
            ✕
          </button>
        </div>

        <div className="ai-history">
          {loading ? (
            <p className="muted small">…</p>
          ) : messages.length === 0 ? (
            <p className="muted small ai-empty">{t('ai_empty')}</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`ai-bubble ${m.role === 'user' ? 'ai-bubble-user' : 'ai-bubble-assistant'}`}>
                {m.content}
              </div>
            ))
          )}
          {thinking && <div className="ai-bubble ai-bubble-assistant ai-thinking">{t('ai_thinking')}</div>}
          <div ref={historyEndRef} />
        </div>

        {proposals.length > 0 && (
          <div className="ai-proposals">
            <h3 className="ai-proposals-title">{t('ai_proposals_title')}</h3>
            {proposals.map((pr) => {
              const known = KNOWN_ACTIONS.has(pr.action_type)
              const rows = summarizePayload(pr.payload)
              return (
                <div key={pr.id} className="ai-proposal card">
                  <div className="ai-proposal-title">
                    {t('ai_proposal_prefix')} {pr.title}
                  </div>
                  {rows.length > 0 && (
                    <dl className="ai-proposal-payload">
                      {rows.map(([k, v]) => (
                        <div key={k} className="ai-payload-row">
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {!known && <p className="muted small ai-unsupported">{t('ai_unsupported')}</p>}
                  <div className="row ai-proposal-actions">
                    {known && (
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busyId === pr.id}
                        onClick={() => void executeProposal(pr)}
                      >
                        {t('ai_execute')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busyId === pr.id}
                      onClick={() => void rejectProposal(pr)}
                    >
                      {t('ai_reject')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {noKey && (
          <div className="ai-nokey" role="alert">
            <strong>{t('ai_no_key_title')}</strong>
            <span className="muted small">{t('ai_no_key_desc')}</span>
          </div>
        )}

        <form className="ai-input-row" onSubmit={submit}>
          <input
            ref={inputRef}
            className="ai-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('ai_placeholder')}
            disabled={thinking}
          />
          <VoiceMic
            lang={lang}
            title={t('ai_voice_hint')}
            onResult={(text) => setInput((v) => (v ? `${v} ${text}` : text))}
          />
          <button type="submit" className="btn primary" disabled={thinking || !input.trim()}>
            {thinking ? t('ai_thinking') : t('ai_send')}
          </button>
        </form>
      </div>

      {toast && (
        <div className="travel-toast ai-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  )
}
