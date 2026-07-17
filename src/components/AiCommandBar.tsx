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

// --- AI-2-front: браузерные голосовые фичи (Web Speech API). Ничего не отправляем на сервер:
// озвучка через window.speechSynthesis, wake-word — локальный webkitSpeechRecognition. ---

// Локаль голоса/распознавания по языку интерфейса.
const SPEECH_LOCALE: Record<'ru' | 'en' | 'es', string> = { ru: 'ru-RU', en: 'en-US', es: 'es-ES' }

// Минимальный тип SpeechRecognition (тот же движок, что в VoiceMic, но нужны continuous/interim/resultIndex).
type SpeechResult = { isFinal?: boolean; 0: { transcript: string } }
type SpeechRecInstance = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: { resultIndex?: number; results: ArrayLike<SpeechResult> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
  abort?: () => void
}
type SpeechRecCtor = new () => SpeechRecInstance

const SpeechRecognitionImpl: SpeechRecCtor | undefined =
  typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: SpeechRecCtor }).webkitSpeechRecognition)
    : undefined

const TTS_SUPPORTED =
  typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined'

// Фразы-триггеры «окей, Клок» (нормализованные: нижний регистр, ё→е, без пунктуации, схлопнутые пробелы).
// Сравниваем по вхождению подстроки — распознавалка может дать разную транскрипцию слова «clock».
const WAKE_PHRASES = ['окей клок', 'окей клак', 'ок клок', 'ok clock', 'okay clock', 'hey clock', 'эй клок', 'хей клок']

function normalizeWake(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
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

  // AI-2-front: тумблеры (по умолчанию ВЫКЛ, состояние в localStorage). Мягкая деградация — см. флаги support.
  const [speakOn, setSpeakOn] = useState<boolean>(() => {
    try { return localStorage.getItem('ai_speak') === '1' } catch { return false }
  })
  const [wakeOn, setWakeOn] = useState<boolean>(() => {
    try { return localStorage.getItem('ai_wake') === '1' } catch { return false }
  })
  const [wakeListening, setWakeListening] = useState(false)
  const dictationRef = useRef<SpeechRecInstance | null>(null)
  const lastSpokenIdRef = useRef<string | null>(null)
  const ttsPrimedRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  useEffect(() => { try { localStorage.setItem('ai_speak', speakOn ? '1' : '0') } catch { /* ignore */ } }, [speakOn])
  useEffect(() => { try { localStorage.setItem('ai_wake', wakeOn ? '1' : '0') } catch { /* ignore */ } }, [wakeOn])

  // Озвучка ответа: язык голоса = язык интерфейса, voice подбираем по локали, иначе дефолтный.
  const speak = useCallback((text: string) => {
    if (!TTS_SUPPORTED || !text) return
    const synth = window.speechSynthesis
    try {
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      const locale = SPEECH_LOCALE[lang]
      u.lang = locale
      const voices = synth.getVoices()
      const voice =
        voices.find((v) => v.lang === locale) ||
        voices.find((v) => v.lang?.toLowerCase().startsWith(lang)) ||
        null
      if (voice) u.voice = voice
      synth.speak(u)
    } catch { /* ignore — мягкая деградация */ }
  }, [lang])

  const cancelSpeech = useCallback(() => {
    if (!TTS_SUPPORTED) return
    try { window.speechSynthesis.cancel() } catch { /* ignore */ }
  }, [])

  // Диктовка вопроса после wake-word: локальный распознаватель, interim+final → в поле ввода.
  const startDictation = useCallback(() => {
    if (!SpeechRecognitionImpl || !mountedRef.current) return
    try { dictationRef.current?.stop() } catch { /* ignore */ }
    const rec = new SpeechRecognitionImpl()
    rec.lang = SPEECH_LOCALE[lang]
    rec.continuous = false
    rec.interimResults = true
    rec.maxAlternatives = 1
    let finalText = ''
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
        const r = e.results[i]
        const transcript = r?.[0]?.transcript ?? ''
        if (r?.isFinal) finalText += transcript
        else interim += transcript
      }
      setInput((finalText + interim).trim())
    }
    rec.onend = () => { if (dictationRef.current === rec) dictationRef.current = null }
    rec.onerror = () => { if (dictationRef.current === rec) dictationRef.current = null }
    dictationRef.current = rec
    try { rec.start(); inputRef.current?.focus() } catch { dictationRef.current = null }
  }, [lang])

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

  // AI-2-front: при открытии сбрасываем «прайм» озвучки (историю вслух не читаем), при закрытии — глушим речь.
  useEffect(() => {
    if (open) ttsPrimedRef.current = false
    else cancelSpeech()
  }, [open, cancelSpeech])

  // AI-2-front: озвучиваем ТОЛЬКО новые ответы ассистента. Первый проход после открытия «праймит»
  // последнее сообщение из истории как уже сказанное — иначе при открытии зачитали бы старый ответ.
  useEffect(() => {
    if (!open || !speakOn || !TTS_SUPPORTED) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return
    if (!ttsPrimedRef.current) { lastSpokenIdRef.current = last.id; ttsPrimedRef.current = true; return }
    if (lastSpokenIdRef.current === last.id) return
    lastSpokenIdRef.current = last.id
    speak(last.content)
  }, [messages, open, speakOn, speak])

  // AI-2-front: непрерывное локальное распознавание wake-word «окей, Клок». Активно только пока тумблер
  // включён И панель закрыта — пока панель открыта, микрофон нужен VoiceMic/диктовке (один инстанс за раз).
  // onerror/onend → перезапуск с backoff, но только пока смонтированы и тумблер включён.
  useEffect(() => {
    if (!wakeOn || !SpeechRecognitionImpl || open) { setWakeListening(false); return }
    let active = true
    let rec: SpeechRecInstance | null = null
    let restartTimer: number | null = null

    const clearTimer = () => { if (restartTimer !== null) { window.clearTimeout(restartTimer); restartTimer = null } }
    const scheduleRestart = (delay: number) => {
      clearTimer()
      if (!active) return
      restartTimer = window.setTimeout(() => { restartTimer = null; if (active) start() }, delay)
    }

    const start = () => {
      if (!active || !SpeechRecognitionImpl) return
      const r = new SpeechRecognitionImpl()
      r.lang = SPEECH_LOCALE[lang]
      r.continuous = true
      r.interimResults = true
      r.maxAlternatives = 1
      r.onresult = (e) => {
        for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
          const transcript = e.results[i]?.[0]?.transcript
          if (!transcript) continue
          if (WAKE_PHRASES.some((p) => normalizeWake(String(transcript)).includes(p))) {
            // Триггер: открываем панель (эффект сам остановит wake-распознавание) и запускаем диктовку,
            // когда микрофон освободится.
            setOpen(true)
            window.setTimeout(() => { if (mountedRef.current) startDictation() }, 450)
            return
          }
        }
      }
      r.onerror = () => { setWakeListening(false); scheduleRestart(800) }
      r.onend = () => { setWakeListening(false); if (active) scheduleRestart(400) }
      rec = r
      try { r.start(); setWakeListening(true) } catch { setWakeListening(false); scheduleRestart(800) }
    }

    start()

    return () => {
      active = false
      clearTimer()
      setWakeListening(false)
      if (rec) {
        rec.onresult = null; rec.onerror = null; rec.onend = null
        try { rec.stop() } catch { /* ignore */ }
      }
      rec = null
    }
  }, [wakeOn, open, lang, startDictation])

  // AI-2-front: подчистка на unmount — гасим диктовку и любую озвучку (нет утечек/зависшей речи).
  useEffect(() => () => {
    try { dictationRef.current?.stop() } catch { /* ignore */ }
    cancelSpeech()
  }, [cancelSpeech])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const msg = input.trim()
    if (!msg || thinking) return
    cancelSpeech() // прерываем текущую озвучку при новом вопросе
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

  const wakeSupported = !!SpeechRecognitionImpl

  return (
    <>
      {/* AI-2-front: ненавязчивый индикатор «слушаю» — fixed-бейдж от AiCommandBar (без правки App/Nav),
          виден только когда голосовая активация включена. */}
      {wakeOn && wakeSupported && (
        <div className="ai-listening-badge" role="status" aria-live="polite" title={t('ai_wake_hint')}>
          <span className={`ai-listening-dot ${wakeListening ? 'on' : ''}`} aria-hidden="true" />
          <span className="ai-listening-text">{t('ai_wake_listening')}</span>
        </div>
      )}

      {open && (
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

            {(TTS_SUPPORTED || wakeSupported) && (
              <div className="ai-toggles">
                {TTS_SUPPORTED && (
                  <label className="ai-toggle">
                    <input
                      type="checkbox"
                      checked={speakOn}
                      onChange={(e) => { setSpeakOn(e.target.checked); if (!e.target.checked) cancelSpeech() }}
                    />
                    <span>{t('ai_speak_toggle')}</span>
                  </label>
                )}
                {wakeSupported && (
                  <label className="ai-toggle" title={t('ai_wake_hint')}>
                    <input
                      type="checkbox"
                      checked={wakeOn}
                      onChange={(e) => setWakeOn(e.target.checked)}
                    />
                    <span>{t('ai_wake_toggle')}</span>
                  </label>
                )}
              </div>
            )}

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
      )}
    </>
  )
}
