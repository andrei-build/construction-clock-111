import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { useScreenContext, type ScreenContext } from '../lib/useScreenContext'
import VoiceMic from './VoiceMic'
import { IconInfo, IconStop, IconText } from './icons'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from '../lib/supabase'
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
  executeAiProposal,
  resolveProposal,
  synthesizeAiSpeech,
  type AiExecuteCandidate,
  type AiExecuteProposalErrorCode,
  type AiMessage,
  type AiProposal,
} from '../lib/api/ai'
import {
  getAiOrbToggleIntent,
  getNextAiOrbToggleState,
  hasPendingAssistantSpeech,
  isAiInfoProposalAction,
  isTtsPlaybackBlockedError,
  isVoiceAffirm,
  isVoiceCancel,
  shouldAcceptAssistantVoiceResult,
  shouldAcceptWakePhraseResult,
  splitCompletedSpeechSegments,
  stripMarkdownForSpeech,
} from '../lib/aiVoice'
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
const LOCAL_ACTIONS = new Set(['create_task', 'send_message', 'send_mail', 'create_event'])
const DISPATCH_ACTIONS = new Set(['assign_worker', 'unassign_worker', 'send_plan'])
const KNOWN_ACTIONS = new Set([...LOCAL_ACTIONS, ...DISPATCH_ACTIONS])
const OVERLAY_PROPOSAL_LIMIT = 4

type ProposalIssue = {
  error: AiExecuteProposalErrorCode | 'failed'
  message?: string
  candidates?: AiExecuteCandidate[]
}

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

function formatTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(value), template)
}

function pStrArray(payload: Record<string, unknown>, ...keys: string[]): string[] {
  for (const k of keys) {
    const v = payload[k]
    if (Array.isArray(v)) {
      const arr = v
        .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim() : ''))
        .filter(Boolean)
      if (arr.length > 0) return arr
    }
    if (typeof v === 'string' && v.trim()) {
      return v.split(',').map((x) => x.trim()).filter(Boolean)
    }
  }
  return []
}

function candidateText(candidate: AiExecuteCandidate): string {
  const name = pStr(candidate, 'name', 'title', 'worker_name', 'project_name')
  const detail = pStr(candidate, 'role', 'type', 'address', 'email')
  const id = pStr(candidate, 'id')
  if (name && detail) return `${name} (${detail})`
  if (name) return name
  if (id) return id
  return JSON.stringify(candidate)
}

// AI-UX-1: на всякий случай убираем markdown при показе (edge v8 уже отдаёт живой текст без разметки,
// но старые записи в истории или сбой промпта могут содержать ** / ## — рендерим plain-текст «как речь»).
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}#{1,6}\s*$/gm, '')
}

// AI-UX-2: распознаём ответ «нет ключа» (ANTHROPIC_API_KEY не задан) по тексту ошибки edge —
// терпимо к формулировке (en/ru). Фолбэк-POST теперь живёт здесь (чтобы добавить поле context, не
// трогая api/ai.ts), поэтому детект дублируем локально — та же логика, что в api/ai.ts:looksLikeNoKey.
function looksLikeNoKey(text: string | undefined): boolean {
  if (!text) return false
  const s = text.toLowerCase()
  return (
    s.includes('anthropic_api_key') ||
    s.includes('api key') ||
    s.includes('api_key') ||
    (s.includes('key') && (s.includes('missing') || s.includes('not set') || s.includes('not configured'))) ||
    s.includes('нет ключ') ||
    s.includes('ключ не')
  )
}

// AI-UX-1: разбор одного SSE-события (блока строк между пустыми строками). Возвращаем имя события и
// распарсенный data (JSON, а если не JSON — как {text}). Терпимо к отсутствию data/комментариям (: ).
type SseEvent = { event: string; data: { text?: string; reply?: string; error?: string } | undefined }
function parseSseEvent(block: string): SseEvent {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length === 0) return { event, data: undefined }
  const raw = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: { text: raw } }
  }
}

// --- AI-2-front: браузерные голосовые фичи. Wake-word/барж-ин — локальный webkitSpeechRecognition,
// озвучка — через live edge `ai-tts` (см. src/lib/api/ai.ts), без speechSynthesis-фолбэка. ---

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
  onerror: ((e: { error?: string }) => void) | null
  start: () => void
  stop: () => void
  abort?: () => void
}
type SpeechRecCtor = new () => SpeechRecInstance

// AI-VOICE-FIX-1: единый статус голосового режима для видимого индикатора (кнопка/панель/бейдж).
//  off — выключено; wake — ждём «окей, Клок» (панель закрыта); listening — слушаем ВОПРОС;
//  thinking — ждём ответ ассистента; speaking — озвучиваем ответ; denied — микрофон запрещён.
type VoiceStatus = 'off' | 'wake' | 'listening' | 'thinking' | 'speaking' | 'denied'

const SpeechRecognitionImpl: SpeechRecCtor | undefined =
  typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: SpeechRecCtor }).webkitSpeechRecognition)
    : undefined

const AUDIO_TTS_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof Audio !== 'undefined' &&
  typeof URL !== 'undefined' &&
  typeof URL.createObjectURL === 'function'

// Фразы-триггеры «окей, Клок» (нормализованные: нижний регистр, ё→е, без пунктуации, схлопнутые пробелы).
// Сравниваем по вхождению подстроки — распознавалка может дать разную транскрипцию слова «clock».
const WAKE_PHRASES = ['окей клок', 'окей клак', 'ок клок', 'ok clock', 'okay clock', 'hey clock', 'эй клок', 'хей клок']

function normalizeWake(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

export default function AiCommandBar({ profile }: { profile: Profile }) {
  const { t, lang } = useI18n()
  // AI-UX-2 (п.5): контекст текущего экрана (route/screen/details) — БЕЗ запросов к БД, только из
  // pathname. Кладём в ref, чтобы голосовые/стрим-колбэки читали свежее значение без ребилда замыканий.
  const screenContext = useScreenContext()
  const contextRef = useRef<ScreenContext>(screenContext)
  useEffect(() => { contextRef.current = screenContext }, [screenContext])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [proposals, setProposals] = useState<AiProposal[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [noKey, setNoKey] = useState(false)
  // AI-UX-1: живой стрим последнего ответа (печатается по мере прихода SSE) + флаг стрима.
  // AI-UX-2: стрим/история/proposals-список уезжают в ОТДЕЛЬНУЮ выдвижную панель (drawer), не на оверлей.
  const [streamText, setStreamText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [proposalIssues, setProposalIssues] = useState<Record<string, ProposalIssue>>({})
  const streamingRef = useRef(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const historyEndRef = useRef<HTMLDivElement | null>(null)

  // AI-2-front: тумблеры (состояние в localStorage). Мягкая деградация — см. флаги support.
  // AI-UX-2: озвучка ответов первична — по умолчанию ВКЛ (если пользователь ранее не выключил).
  const [speakOn, setSpeakOn] = useState<boolean>(() => {
    try { const v = localStorage.getItem('ai_speak'); return v === null ? true : v === '1' } catch { return true }
  })
  const [wakeOn, setWakeOn] = useState<boolean>(() => {
    try { return localStorage.getItem('ai_wake') === '1' } catch { return false }
  })
  // AI-VOICE-FIX-1: видимое состояние голоса + уровень звука для пульсации «слушаю».
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('off')
  const [micLevel, setMicLevel] = useState(0)
  const [ttsLevel, setTtsLevel] = useState(0)
  const [ttsBusy, setTtsBusy] = useState(false)
  const lastSpokenIdRef = useRef<string | null>(null)
  const ttsPrimedRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // AI-VOICE-FIX-1: рефы для явного микрофона (getUserMedia) + метра уровня (AudioContext/Analyser).
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  // Рефы «живых» значений для колбэков распознавания/озвучки (без устаревших замыканий).
  const speakOnRef = useRef(speakOn)
  const wakeOnRef = useRef(wakeOn)
  const openRef = useRef(open)
  const thinkingRef = useRef(false)
  const ttsBusyRef = useRef(false)
  const voiceStatusRef = useRef<VoiceStatus>('off')
  const convoActiveRef = useRef(false)
  const silenceTimerRef = useRef<number | null>(null)
  const assistantAbortRef = useRef<AbortController | null>(null)
  const ttsQueueRef = useRef<string[]>([])
  const ttsAbortRef = useRef<AbortController | null>(null)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsUrlRef = useRef<string | null>(null)
  const ttsQueueRunningRef = useRef(false)
  const ttsSerialRef = useRef(0)
  const ttsOnIdleRef = useRef<(() => void) | null>(null)
  const ttsErrorShownRef = useRef(false)
  const assistantTurnRef = useRef(0)
  const ttsAudioCtxRef = useRef<AudioContext | null>(null)
  const ttsUnlockedRef = useRef(false)
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null)
  const ttsSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const ttsRafRef = useRef<number | null>(null)

  useEffect(() => { try { localStorage.setItem('ai_speak', speakOn ? '1' : '0') } catch { /* ignore */ } }, [speakOn])
  useEffect(() => { try { localStorage.setItem('ai_wake', wakeOn ? '1' : '0') } catch { /* ignore */ } }, [wakeOn])
  useEffect(() => { speakOnRef.current = speakOn }, [speakOn])
  useEffect(() => { wakeOnRef.current = wakeOn }, [wakeOn])
  useEffect(() => { openRef.current = open }, [open])
  useEffect(() => { thinkingRef.current = thinking }, [thinking])
  useEffect(() => { ttsBusyRef.current = ttsBusy }, [ttsBusy])
  useEffect(() => { voiceStatusRef.current = voiceStatus }, [voiceStatus])

  const setVoiceStatusLive = useCallback((status: VoiceStatus) => {
    voiceStatusRef.current = status
    setVoiceStatus(status)
  }, [])

  const assistantSpeechGateSnapshot = useCallback(() => ({
    wakeOn: wakeOnRef.current,
    open: openRef.current,
    voiceStatus: voiceStatusRef.current,
    thinking: thinkingRef.current,
    streaming: streamingRef.current,
    ttsBusy: ttsBusyRef.current,
    ttsQueueRunning: ttsQueueRunningRef.current,
    queuedTtsSegments: ttsQueueRef.current.length,
  }), [])

  const getTtsAudioContext = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null
    try {
      const existing = ttsAudioCtxRef.current
      if (existing && existing.state !== 'closed') return existing
      const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return null
      const ctx = new Ctx()
      ttsAudioCtxRef.current = ctx
      ttsUnlockedRef.current = false
      return ctx
    } catch (err) {
      console.warn('AI TTS AudioContext init failed', err)
      return null
    }
  }, [])

  const resumeTtsAudioContext = useCallback(async (): Promise<AudioContext | null> => {
    const ctx = getTtsAudioContext()
    if (!ctx) return null
    if (ctx.state !== 'running') {
      try {
        await ctx.resume()
      } catch (err) {
        console.warn('AI TTS AudioContext resume failed', err)
      }
    }
    return ctx
  }, [getTtsAudioContext])

  const unlockTtsAudio = useCallback(async (): Promise<void> => {
    if (!AUDIO_TTS_SUPPORTED) return
    const ctx = getTtsAudioContext()
    if (!ctx) return
    try {
      if (!ttsUnlockedRef.current) {
        const source = ctx.createBufferSource()
        const gain = ctx.createGain()
        source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
        gain.gain.value = 0
        source.connect(gain)
        gain.connect(ctx.destination)
        source.onended = () => {
          try { source.disconnect() } catch { /* ignore */ }
          try { gain.disconnect() } catch { /* ignore */ }
        }
        source.start(0)
      }
      if (ctx.state !== 'running') await ctx.resume()
      ttsUnlockedRef.current = ctx.state === 'running'
    } catch (err) {
      ttsUnlockedRef.current = false
      console.warn('AI TTS audio unlock failed', err)
    }
  }, [getTtsAudioContext])

  const stopTtsMeter = useCallback(() => {
    if (ttsRafRef.current !== null) { cancelAnimationFrame(ttsRafRef.current); ttsRafRef.current = null }
    setTtsLevel(0)
    try { ttsSourceRef.current?.disconnect() } catch { /* ignore */ }
    try { ttsAnalyserRef.current?.disconnect() } catch { /* ignore */ }
    ttsSourceRef.current = null
    ttsAnalyserRef.current = null
  }, [])

  const revokeTtsUrl = useCallback(() => {
    if (!ttsUrlRef.current) return
    try { URL.revokeObjectURL(ttsUrlRef.current) } catch { /* ignore */ }
    ttsUrlRef.current = null
  }, [])

  const stopCurrentTtsAudio = useCallback(() => {
    try { ttsAbortRef.current?.abort() } catch { /* ignore */ }
    ttsAbortRef.current = null
    const audio = ttsAudioRef.current
    if (audio) {
      try {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      } catch { /* ignore */ }
      ttsAudioRef.current = null
    }
    stopTtsMeter()
    revokeTtsUrl()
  }, [revokeTtsUrl, stopTtsMeter])

  const cancelTtsQueue = useCallback((runIdle = false) => {
    ttsSerialRef.current += 1
    ttsQueueRef.current = []
    ttsQueueRunningRef.current = false
    stopCurrentTtsAudio()
    setTtsBusy(false)
    const onIdle = ttsOnIdleRef.current
    ttsOnIdleRef.current = null
    if (runIdle) onIdle?.()
  }, [stopCurrentTtsAudio])

  const startTtsMeter = useCallback(async (audio: HTMLAudioElement): Promise<void> => {
    stopTtsMeter()
    try {
      const ctx = await resumeTtsAudioContext()
      if (!ctx || ctx.state !== 'running') { setTtsLevel(.45); return }
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      const source = ctx.createMediaElementSource(audio)
      source.connect(analyser)
      analyser.connect(ctx.destination)
      ttsSourceRef.current = source
      ttsAnalyserRef.current = analyser
      const buf = new Uint8Array(analyser.fftSize)
      const tick = () => {
        const a = ttsAnalyserRef.current
        if (!a) { ttsRafRef.current = null; return }
        a.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
        setTtsLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
        ttsRafRef.current = requestAnimationFrame(tick)
      }
      ttsRafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      console.warn('AI TTS meter unavailable', err)
      setTtsLevel(.45)
    }
  }, [resumeTtsAudioContext, stopTtsMeter])

  const playTtsAudioElement = useCallback(async (audio: HTMLAudioElement): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        reject(err)
      }
      const attemptPlay = async () => {
        try {
          await audio.play()
        } catch (err) {
          console.warn('AI TTS audio.play() rejected', err)
          if (isTtsPlaybackBlockedError(err)) {
            const ctx = await resumeTtsAudioContext()
            if (ctx?.state === 'running') {
              try {
                await audio.play()
                return
              } catch (retryErr) {
                console.warn('AI TTS audio.play() retry rejected', retryErr)
                fail(retryErr)
                return
              }
            }
          }
          fail(err)
        }
      }
      audio.onended = finish
      audio.onerror = () => fail(new Error('tts_audio_error'))
      audio.onabort = finish
      void attemptPlay()
    })
  }, [resumeTtsAudioContext])

  // AI-VOICE-FIX-1: метр уровня звука — пульсация индикатора «слушаю» по громкости с микрофона.
  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    setMicLevel(0)
  }, [])
  const startMeter = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser || rafRef.current !== null) return
    const buf = new Uint8Array(analyser.fftSize)
    const tick = () => {
      const a = analyserRef.current
      if (!a) { rafRef.current = null; return }
      a.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / buf.length)
      setMicLevel(Math.min(1, rms * 3))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // AI-VOICE-FIX-1: явный запрос микрофона. getUserMedia показывает браузерный промпт при включении
  // тумблера (раньше промпта не было — распознавалка молча падала в onerror и «ждала, но не работала»).
  // Поток же питает Analyser для индикатора уровня. Идемпотентно: повторный вызов переиспользует поток.
  const ensureMic = useCallback(async (): Promise<boolean> => {
    if (streamRef.current) return true
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!md?.getUserMedia) return true // нет API — полагаемся на встроенный микрофон распознавалки
    try {
      const stream = await md.getUserMedia({ audio: true })
      streamRef.current = stream
      try {
        const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (Ctx) {
          const ctx = new Ctx()
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          ctx.createMediaStreamSource(stream).connect(analyser)
          audioCtxRef.current = ctx
          analyserRef.current = analyser
        }
      } catch { /* метр — необязательная роскошь */ }
      return true
    } catch {
      return false // отказ в доступе
    }
  }, [])

  const releaseMic = useCallback(() => {
    stopMeter()
    try { streamRef.current?.getTracks().forEach((tr) => tr.stop()) } catch { /* ignore */ }
    streamRef.current = null
    try { void audioCtxRef.current?.close() } catch { /* ignore */ }
    audioCtxRef.current = null
    analyserRef.current = null
  }, [stopMeter])

  const flashToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => {
      setToast(null)
      toastTimer.current = null
    }, 3200)
  }, [])
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current) }, [])

  const finishTtsQueue = useCallback((serial: number) => {
    if (serial !== ttsSerialRef.current) return
    ttsQueueRunningRef.current = false
    ttsAbortRef.current = null
    setTtsBusy(false)
    stopTtsMeter()
    revokeTtsUrl()
    const onIdle = ttsOnIdleRef.current
    ttsOnIdleRef.current = null
    if (onIdle) {
      onIdle()
    } else {
      setVoiceStatus((prev) => {
        const next: VoiceStatus = prev === 'speaking' ? (wakeOnRef.current && !openRef.current ? 'wake' : 'off') : prev
        voiceStatusRef.current = next
        return next
      })
    }
  }, [revokeTtsUrl, stopTtsMeter])

  const playTtsQueue = useCallback(() => {
    if (!AUDIO_TTS_SUPPORTED || !speakOnRef.current || ttsQueueRunningRef.current) return
    if (ttsQueueRef.current.length === 0) return
    const serial = ttsSerialRef.current
    ttsQueueRunningRef.current = true
    setTtsBusy(true)
    setVoiceStatusLive('speaking')

    void (async () => {
      try {
        while (
          serial === ttsSerialRef.current &&
          speakOnRef.current &&
          ttsQueueRef.current.length > 0
        ) {
          const text = ttsQueueRef.current[0]
          if (!text) {
            ttsQueueRef.current.shift()
            continue
          }
          const aborter = new AbortController()
          ttsAbortRef.current = aborter
          const { blob } = await synthesizeAiSpeech({ text, style: 'jarvis', signal: aborter.signal })
          if (serial !== ttsSerialRef.current || aborter.signal.aborted) break

          revokeTtsUrl()
          const url = URL.createObjectURL(blob)
          ttsUrlRef.current = url
          const audio = new Audio(url)
          ttsAudioRef.current = audio
          await startTtsMeter(audio)
          if (serial !== ttsSerialRef.current || aborter.signal.aborted) break
          await playTtsAudioElement(audio)
          if (serial !== ttsSerialRef.current || aborter.signal.aborted) break

          if (ttsQueueRef.current[0] === text) ttsQueueRef.current.shift()

          if (ttsAudioRef.current === audio) ttsAudioRef.current = null
          stopTtsMeter()
          revokeTtsUrl()
          ttsAbortRef.current = null
        }
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        if (serial === ttsSerialRef.current && name !== 'AbortError') {
          if (!isTtsPlaybackBlockedError(err)) ttsQueueRef.current = []
          if (!ttsErrorShownRef.current) {
            ttsErrorShownRef.current = true
            flashToast(t('ai_tts_error'))
          }
        }
      } finally {
        finishTtsQueue(serial)
      }
    })()
  }, [finishTtsQueue, flashToast, playTtsAudioElement, revokeTtsUrl, setVoiceStatusLive, startTtsMeter, stopTtsMeter, t])

  const enqueueTtsSegments = useCallback((segments: string[]): boolean => {
    if (!AUDIO_TTS_SUPPORTED || !speakOnRef.current) return false
    const clean = segments.map(stripMarkdownForSpeech).filter(Boolean)
    if (clean.length === 0) return false
    ttsQueueRef.current.push(...clean)
    playTtsQueue()
    return true
  }, [playTtsQueue])

  const enqueueTtsText = useCallback((text: string): boolean => {
    const { segments } = splitCompletedSpeechSegments(text, { force: true })
    return enqueueTtsSegments(segments)
  }, [enqueueTtsSegments])

  const cancelActiveAssistant = useCallback((runTtsIdle = false) => {
    assistantTurnRef.current += 1
    try { assistantAbortRef.current?.abort() } catch { /* ignore */ }
    assistantAbortRef.current = null
    streamingRef.current = false
    thinkingRef.current = false
    setStreaming(false)
    setThinking(false)
    setStreamText('')
    cancelTtsQueue(runTtsIdle)
    if (openRef.current && wakeOnRef.current && SpeechRecognitionImpl) setVoiceStatusLive('off')
  }, [cancelTtsQueue, setVoiceStatusLive])

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

  // AI-UX-1: обычный (не-стрим) путь — ФОЛБЭК. AI-UX-2: делаем прямой POST здесь (а не через
  // askAssistant), чтобы приложить поле context {route, screen, details} и в фолбэке тоже. Контракт
  // edge ai-assistant v8 не меняем — только добавляем context в тело. Разбор ошибок/no_key — как в
  // api/ai.ts (looksLikeNoKey), user/assistant-строки и proposals пишет edge, мы их рефетчим.
  const sendViaPost = useCallback(
    async (msg: string, turnId?: number): Promise<{ kind: 'ok' | 'error' | 'nokey'; reply?: string }> => {
      const isCurrentTurn = () => turnId === undefined || turnId === assistantTurnRef.current
      let errText: string | undefined
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token
        if (!token) {
          if (isCurrentTurn()) { flashToast(t('ai_error')); thinkingRef.current = false; setThinking(false) }
          return { kind: 'error' }
        }
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-assistant`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY },
          body: JSON.stringify({ message: msg, context: contextRef.current }),
        })
        const body = (await resp.json().catch(() => null)) as { reply?: unknown; error?: unknown } | null
        const bodyErr = typeof body?.error === 'string' && body.error.trim() ? body.error : undefined
        if (resp.ok && !bodyErr) {
          // Успех: строки уже записал edge — рефетчим историю и предложения.
          const [msgs, props] = await Promise.all([getAiMessages(), getPendingProposals()])
          if (mountedRef.current && isCurrentTurn()) {
            thinkingRef.current = false
            setInput(''); setMessages(msgs); setProposals(props); setThinking(false)
            const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
            if (lastAssistant) lastSpokenIdRef.current = lastAssistant.id
          }
          const reply = typeof body?.reply === 'string' && body.reply
            ? body.reply
            : [...msgs].reverse().find((m) => m.role === 'assistant')?.content
          return { kind: 'ok', reply }
        }
        errText = bodyErr ?? `HTTP ${resp.status}`
      } catch {
        errText = undefined
      }
      if (looksLikeNoKey(errText)) {
        if (isCurrentTurn()) { setNoKey(true); thinkingRef.current = false; setThinking(false) }
        return { kind: 'nokey' }
      }
      if (isCurrentTurn()) {
        flashToast(errText && !looksLikeNoKey(errText) ? errText : t('ai_error'))
        thinkingRef.current = false
        setThinking(false)
      }
      return { kind: 'error' }
    },
    [flashToast, t],
  )

  // AI-VOICE-FIX-1 / AI-UX-1: единый путь отправки вопроса (кнопка «Отправить» и голосовой цикл).
  // ГЛАВНОЕ: SSE-стрим (body.stream=true) — первые слова печатаются сразу, ощущение живого собеседника.
  // Заголовки те же, что supabase.functions.invoke (Authorization Bearer + apikey). Если поток недоступен
  // или упал до первых слов — мягкий фолбэк на обычный POST (sendViaPost), UX не ломается.
  // Возвращает исход + текст ответа, чтобы разговорный цикл мог его озвучить.
  const sendQuestion = useCallback(
    async (raw: string): Promise<{ kind: 'ok' | 'error' | 'nokey' | 'empty'; reply?: string }> => {
      const msg = raw.trim()
      if (!msg || thinkingRef.current) return { kind: 'empty' }
      cancelActiveAssistant() // прерываем текущую озвучку/стрим при новом вопросе
      const turnId = ++assistantTurnRef.current
      ttsErrorShownRef.current = false
      thinkingRef.current = true
      setThinking(true)
      if (openRef.current && wakeOnRef.current && SpeechRecognitionImpl) setVoiceStatusLive('thinking')
      setNoKey(false)
      setStreamText('')
      setStreaming(true)
      streamingRef.current = true

      let streamedReply: string | null = null
      let streamFailed = false
      let speechBuffer = ''
      const assistantAbort = new AbortController()
      assistantAbortRef.current = assistantAbort
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token
        if (!token) throw new Error('no_session')
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-assistant`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: SUPABASE_KEY,
          },
          // AI-UX-2 (п.5): прикладываем контекст экрана — edge v8 подкладывает его ассистенту.
          body: JSON.stringify({ message: msg, stream: true, context: contextRef.current }),
          signal: assistantAbort.signal,
        })
        if (!resp.ok || !resp.body) {
          streamFailed = true // не-2xx (в т.ч. no_key) или нет тела → фолбэк на POST
        } else {
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          let acc = ''
          let errored = false
          let stop = false
          let speechTailFlushed = false
          const flushSpeechBuffer = (force = false) => {
            if (force && speechTailFlushed) return
            if (speakOnRef.current && AUDIO_TTS_SUPPORTED && turnId === assistantTurnRef.current) {
              const split = splitCompletedSpeechSegments(speechBuffer, force ? { force: true } : undefined)
              speechBuffer = split.rest
              enqueueTtsSegments(split.segments)
            }
            if (force) speechTailFlushed = true
          }
          const handleStreamEvent = (ev: ReturnType<typeof parseSseEvent>) => {
            if (ev.event === 'delta') {
              const text = ev.data?.text
              if (typeof text === 'string') {
                acc += text
                if (streamingRef.current && mountedRef.current && turnId === assistantTurnRef.current) {
                  setStreamText(stripMarkdown(acc))
                }
                if (speakOnRef.current && AUDIO_TTS_SUPPORTED && turnId === assistantTurnRef.current) {
                  speechBuffer += text
                  flushSpeechBuffer()
                }
              }
            } else if (ev.event === 'done') {
              streamedReply = typeof ev.data?.reply === 'string' && ev.data.reply ? ev.data.reply : acc
              flushSpeechBuffer(true)
              stop = true
            } else if (ev.event === 'error') {
              errored = true
              stop = true
            }
          }
          const drainCompleteSseBlocks = () => {
            let sep: number
            while ((sep = buf.indexOf('\n\n')) !== -1) {
              const block = buf.slice(0, sep)
              buf = buf.slice(sep + 2)
              if (!block.trim()) continue
              handleStreamEvent(parseSseEvent(block))
              if (stop) break
            }
          }
          while (!stop) {
            const { value, done } = await reader.read()
            if (done) {
              const tail = decoder.decode()
              if (tail) buf = (buf + tail).replace(/\r\n/g, '\n')
              break
            }
            buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
            drainCompleteSseBlocks()
          }
          if (!stop) {
            drainCompleteSseBlocks()
            if (!stop && buf.trim()) handleStreamEvent(parseSseEvent(buf))
          }
          try { await reader.cancel() } catch { /* ignore */ }
          if (streamedReply === null) {
            // Поток закончился без «done»: если что-то напечаталось — считаем ответом, иначе фолбэк.
            if (!errored && acc.trim()) {
              streamedReply = acc
              flushSpeechBuffer(true)
            } else {
              streamFailed = true
            }
          }
        }
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        if (name === 'AbortError' || turnId !== assistantTurnRef.current) {
          if (mountedRef.current && turnId === assistantTurnRef.current) {
            streamingRef.current = false
            thinkingRef.current = false
            setThinking(false); setStreaming(false); setStreamText('')
          }
          return { kind: 'error' }
        }
        streamFailed = true
      } finally {
        if (assistantAbortRef.current === assistantAbort) assistantAbortRef.current = null
      }

      // ФОЛБЭК: поток недоступен/упал до первых слов → обычный POST (текущий путь). UX цел.
      if (turnId !== assistantTurnRef.current) return { kind: 'error' }
      if (streamFailed && streamedReply === null) {
        streamingRef.current = false
        if (mountedRef.current) { setStreaming(false); setStreamText('') }
        const fallback = await sendViaPost(msg, turnId)
        if (fallback.kind === 'ok' && fallback.reply && turnId === assistantTurnRef.current) enqueueTtsText(fallback.reply)
        return fallback
      }

      // Стрим удался: edge уже записал user/assistant-строки и pending-предложения — рефетчим из БД
      // (переиспользуем существующую логику proposals/истории без изменений).
      streamingRef.current = false
      const [msgs, props] = await Promise.all([getAiMessages(), getPendingProposals()])
      if (mountedRef.current && turnId === assistantTurnRef.current) {
        setInput(''); setMessages(msgs); setProposals(props)
        thinkingRef.current = false
        setThinking(false); setStreaming(false); setStreamText('')
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
        if (lastAssistant) lastSpokenIdRef.current = lastAssistant.id
      }
      return { kind: 'ok', reply: streamedReply ?? undefined }
    },
    [cancelActiveAssistant, enqueueTtsSegments, enqueueTtsText, sendViaPost, setVoiceStatusLive],
  )

  const announce = useCallback((text: string) => {
    flashToast(text)
    enqueueTtsText(text)
  }, [enqueueTtsText, flashToast])

  const dispatchSuccessText = useCallback((pr: AiProposal, result: Record<string, unknown>) => {
    if (pr.action_type === 'assign_worker') return t('ai_dispatch_assigned_ok')
    if (pr.action_type === 'unassign_worker') return t('ai_dispatch_unassigned_ok')
    if (pr.action_type === 'send_plan') {
      const failedCount = Number(result.failed_count ?? result.failed ?? 0)
      const errors = Array.isArray(result.errors) ? result.errors : []
      const partial = result.partial === true || failedCount > 0 || errors.length > 0
      return partial ? t('ai_dispatch_plan_partial') : t('ai_dispatch_plan_sent_ok')
    }
    return t('ai_executed_ok')
  }, [t])

  const executeProposal = useCallback(async (pr: AiProposal): Promise<boolean> => {
    if (busyId) return false
    setBusyId(pr.id)
    try {
      if (DISPATCH_ACTIONS.has(pr.action_type)) {
        const res = await executeAiProposal(pr.id)
        if (!res.ok) {
          setProposalIssues((prev) => ({
            ...prev,
            [pr.id]: { error: res.error, message: res.message, candidates: res.candidates },
          }))
          announce(res.error === 'ambiguous' ? t('ai_execute_ambiguous') : t('ai_execute_not_found'))
          return true
        }
        setProposalIssues((prev) => {
          const next = { ...prev }
          delete next[pr.id]
          return next
        })
        await reload()
        announce(dispatchSuccessText(pr, { ...res.raw, ...res.result }))
        return true
      }

      if (pr.action_type === 'create_task') {
        const title = pStr(pr.payload, 'title', 'name')
        if (!title) { announce(t('ai_execute_failed')); return true }
        let assigned_to: string | null = null
        const assigneeName = pStr(pr.payload, 'assignee_name', 'assigned_to_name', 'assignee')
        if (assigneeName) {
          const hit = resolveName(team, assigneeName)
          if (hit === 'ambiguous' || hit === 'none') { announce(t('ai_unresolved')); return true }
          assigned_to = hit.id
        }
        let project_id: string | null = null
        const projectName = pStr(pr.payload, 'project_name', 'project')
        if (projectName) {
          const hit = resolveName(projects, projectName)
          if (hit === 'ambiguous' || hit === 'none') { announce(t('ai_unresolved')); return true }
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
        announce(t('ai_executed_ok'))
      } else if (pr.action_type === 'send_message') {
        const body = pStr(pr.payload, 'body', 'message', 'text')
        if (!body) { announce(t('ai_execute_failed')); return true }
        const recipientName = pStr(pr.payload, 'recipient_name', 'to_name', 'recipient', 'to')
        const hit = resolveName(team, recipientName)
        if (hit === 'ambiguous' || hit === 'none') { announce(t('ai_unresolved')); return true }
        await sendMessage(profile, hit.id, body, pickEnum(pr.payload.priority, MSG_PRIORITIES, 'info'))
        await resolveProposal(pr.id, 'executed', {})
        announce(t('ai_executed_ok'))
      } else if (pr.action_type === 'send_mail') {
        const account_key = pStr(pr.payload, 'account_key', 'account')
        const to = pStr(pr.payload, 'to')
        if (!account_key || !to) { announce(t('ai_execute_failed')); return true }
        const res = await sendMail({
          account_key,
          to,
          subject: pStr(pr.payload, 'subject') ?? '',
          body: pStr(pr.payload, 'body', 'message', 'text') ?? '',
          in_reply_to: pStr(pr.payload, 'in_reply_to') ?? null,
        })
        if (!res.ok) { announce(res.error ? `${t('ai_execute_failed')}: ${res.error}` : t('ai_execute_failed')); return true }
        await resolveProposal(pr.id, 'executed', {})
        announce(t('ai_executed_ok'))
      } else if (pr.action_type === 'create_event') {
        const title = pStr(pr.payload, 'title')
        const starts_at = pStr(pr.payload, 'starts_at', 'start', 'starts')
        if (!title || !starts_at) { announce(t('ai_execute_failed')); return true }
        let project_id: string | null = null
        const projectName = pStr(pr.payload, 'project_name', 'project')
        if (projectName) {
          const hit = resolveName(projects, projectName)
          if (hit === 'ambiguous' || hit === 'none') { announce(t('ai_unresolved')); return true }
          project_id = hit.id
        }
        let assigned_to: string | null = null
        const assigneeName = pStr(pr.payload, 'assignee_name', 'assigned_to_name', 'assignee')
        if (assigneeName) {
          const hit = resolveName(team, assigneeName)
          if (hit === 'ambiguous' || hit === 'none') { announce(t('ai_unresolved')); return true }
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
        announce(t('ai_executed_ok'))
      } else {
        return false
      }
      setProposalIssues((prev) => {
        const next = { ...prev }
        delete next[pr.id]
        return next
      })
      await reload()
      return true
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : undefined
      setProposalIssues((prev) => ({ ...prev, [pr.id]: { error: 'failed', message } }))
      announce(message ? `${t('ai_execute_failed')}: ${message}` : t('ai_execute_failed'))
      return true
    } finally {
      setBusyId(null)
    }
  }, [announce, busyId, dispatchSuccessText, profile, projects, reload, t, team])

  const rejectProposal = useCallback(async (pr: AiProposal): Promise<boolean> => {
    if (busyId) return false
    setBusyId(pr.id)
    try {
      await resolveProposal(pr.id, 'rejected')
      setProposals((prev) => prev.filter((x) => x.id !== pr.id))
      setProposalIssues((prev) => {
        const next = { ...prev }
        delete next[pr.id]
        return next
      })
      announce(t('ai_rejected_ok'))
      return true
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : undefined
      announce(message ? `${t('ai_reject_failed')}: ${message}` : t('ai_reject_failed'))
      return true
    } finally {
      setBusyId(null)
    }
  }, [announce, busyId, t])

  const dismissInfoProposal = useCallback((id: string) => {
    setProposals((prev) => prev.filter((x) => x.id !== id))
    setProposalIssues((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const handleVoiceProposalIntent = useCallback(async (text: string): Promise<boolean> => {
    const pr = proposals[0]
    if (!pr) return false
    if (isAiInfoProposalAction(pr.action_type)) {
      if (isVoiceAffirm(text) || isVoiceCancel(text)) {
        dismissInfoProposal(pr.id)
        return true
      }
      return false
    }
    if (isVoiceCancel(text)) {
      await rejectProposal(pr)
      return true
    }
    if (isVoiceAffirm(text)) {
      if (!KNOWN_ACTIONS.has(pr.action_type)) {
        announce(t('ai_unsupported'))
        return true
      }
      await executeProposal(pr)
      return true
    }
    return false
  }, [announce, dismissInfoProposal, executeProposal, proposals, rejectProposal, t])

  const handleVoiceInput = useCallback(async (text: string) => {
    const snapshot = assistantSpeechGateSnapshot()
    if (snapshot.thinking || snapshot.streaming || hasPendingAssistantSpeech(snapshot)) return
    if (await handleVoiceProposalIntent(text)) return
    if (!thinkingRef.current) await sendQuestion(text)
  }, [assistantSpeechGateSnapshot, handleVoiceProposalIntent, sendQuestion])

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

  // Esc: сначала закрывает выдвижную панель текста (drawer), затем — сам оверлей.
  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (drawerOpen) setDrawerOpen(false)
      else setOpen(false)
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [open, drawerOpen])

  // При открытии — грузим данные и фокусируем поле ввода.
  useEffect(() => {
    if (!open) return
    setNoKey(false)
    setDrawerOpen(false)
    setLoading(true)
    void load().finally(() => setLoading(false))
    const id = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(id)
  }, [open, load])

  // Автоскролл ленты вниз при изменении истории (пока открыт И раскрыта панель текста).
  // AI-UX-2: стрим тоже уезжает в drawer — скроллим и при печати живого ответа.
  useEffect(() => {
    if (open && drawerOpen) historyEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, streamText, open, drawerOpen])

  // При закрытии оверлея останавливаем всё активное: SSE, TTS-fetch, Audio и очередь.
  useEffect(() => {
    if (open) { ttsPrimedRef.current = false; return }
    wakeOnRef.current = false
    setWakeOn(false)
    setContextOpen(false)
    cancelActiveAssistant()
  }, [open, cancelActiveAssistant])

  // Историю вслух не читаем: речь идёт только из текущего SSE/POST turn, где текст сегментируется.
  useEffect(() => {
    if (!open) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return
    if (!ttsPrimedRef.current) { lastSpokenIdRef.current = last.id; ttsPrimedRef.current = true; return }
    lastSpokenIdRef.current = last.id
  }, [messages, open])

  // AI-VOICE-FIX-1 (1): микрофон запрашиваем ЯВНО при включении тумблера голоса — браузер сразу
  // показывает промпт разрешения. Отказ → статус «микрофон запрещён ❌». Выключение → освобождаем поток.
  useEffect(() => {
    if (!wakeOn || !wakeOnRef.current || !SpeechRecognitionImpl) {
      releaseMic()
      setVoiceStatusLive('off')
      return
    }
    let cancelled = false
    void (async () => {
      const ok = await ensureMic()
      if (cancelled) return
      if (!ok) setVoiceStatusLive('denied')
    })()
    return () => { cancelled = true }
  }, [wakeOn, ensureMic, releaseMic, setVoiceStatusLive])

  // AI-VOICE-FIX-1 (2,3): непрерывное распознавание wake-фразы «окей, Клок». Активно пока тумблер включён
  // И панель закрыта (открытая панель → разговорный цикл, микрофон один). onend/onerror перезапускают
  // распознавание (Chrome глушит continuous каждые ~60с — без рестарта это и есть «ждёт, но не работает»);
  // таймер один, чистится при размонтировании/выключении. Отказ в доступе → статус ❌ без бесконечных попыток.
  useEffect(() => {
    if (!wakeOn || !wakeOnRef.current || !SpeechRecognitionImpl || open) return
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
        if (!shouldAcceptWakePhraseResult(assistantSpeechGateSnapshot())) return
        for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
          const transcript = e.results[i]?.[0]?.transcript
          if (!transcript) continue
          if (WAKE_PHRASES.some((p) => normalizeWake(String(transcript)).includes(p))) {
            // Триггер: открываем панель — этот эффект остановится, а эффект разговорного цикла (open) подхватит.
            setOpen(true)
            return
          }
        }
      }
      r.onerror = (ev) => {
        if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') { setVoiceStatusLive('denied'); return }
        if (active) { setVoiceStatusLive('off'); scheduleRestart(800) }
      }
      r.onend = () => { if (active) scheduleRestart(400) }
      rec = r
      setVoiceStatusLive('wake')
      try { r.start() } catch { setVoiceStatusLive('off'); scheduleRestart(800) }
    }

    void (async () => {
      const ok = await ensureMic()
      if (!active) return
      if (!ok) { setVoiceStatusLive('denied'); return }
      start()
    })()

    return () => {
      active = false
      clearTimer()
      if (rec) {
        rec.onresult = null; rec.onerror = null; rec.onend = null
        try { rec.stop() } catch { /* ignore */ }
      }
      rec = null
    }
  }, [wakeOn, open, lang, ensureMic, assistantSpeechGateSnapshot, setVoiceStatusLive])

  // AI-VOICE-FIX-1 (4): окно push-to-talk через орб. Активно только пока wakeOn=true и панель открыта.
  // Слушаем один вопрос, затем во время thinking/speaking recognition не работает; после ответа mic выключается.
  // Один инстанс распознавания за раз; всё останавливается при закрытии панели/выключении тумблера.
  useEffect(() => {
    if (!wakeOn || !SpeechRecognitionImpl || !open) { convoActiveRef.current = false; return }
    let active = true
    convoActiveRef.current = true
    let rec: SpeechRecInstance | null = null

    const clearSilence = () => {
      if (silenceTimerRef.current !== null) { window.clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }
    }
    const stopRec = () => {
      clearSilence()
      stopMeter()
      if (rec) {
        rec.onresult = null; rec.onend = null; rec.onerror = null
        try { rec.stop() } catch { /* ignore */ }
        rec = null
      }
    }

    const finishVoiceCapture = () => {
      if (!active) return
      wakeOnRef.current = false
      setWakeOn(false)
      setVoiceStatusLive('off')
      stopMeter()
    }

    const finishAfterSpeech = () => {
      const speechPending = hasPendingAssistantSpeech(assistantSpeechGateSnapshot())
      if (speakOnRef.current && speechPending) {
        setVoiceStatusLive('speaking')
        ttsOnIdleRef.current = finishVoiceCapture
      } else {
        finishVoiceCapture()
      }
    }

    const listen = () => {
      if (!active) return
      stopRec()
      const snapshot = assistantSpeechGateSnapshot()
      const speechPending = hasPendingAssistantSpeech(snapshot)
      if (snapshot.thinking || snapshot.streaming || speechPending) {
        setVoiceStatusLive(speechPending ? 'speaking' : 'thinking')
        if (speechPending) ttsOnIdleRef.current = finishVoiceCapture
        return
      }
      setVoiceStatusLive('listening')
      const r = new SpeechRecognitionImpl!()
      r.lang = SPEECH_LOCALE[lang]
      r.continuous = true
      r.interimResults = true
      r.maxAlternatives = 1
      let finalText = ''
      const resetSilence = () => {
        clearSilence()
        silenceTimerRef.current = window.setTimeout(() => { silenceTimerRef.current = null; finalize(finalText) }, 1800)
      }
      r.onresult = (e) => {
        if (!shouldAcceptAssistantVoiceResult(assistantSpeechGateSnapshot())) {
          finalText = ''
          clearSilence()
          return
        }
        let interim = ''
        for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
          const res = e.results[i]
          const transcript = res?.[0]?.transcript ?? ''
          if (res?.isFinal) finalText += transcript
          else interim += transcript
        }
        const combined = (finalText + interim).trim()
        setInput(combined)
        if (combined) resetSilence() // тишина отсчитывается только после того, как что-то сказали
      }
      // Chrome сам завершает continuous-распознавание — финализируем накопленное (пусто → просто слушаем дальше).
      r.onend = () => { if (active && rec === r) { clearSilence(); finalize(finalText) } }
      r.onerror = (ev) => {
        if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') { active = false; convoActiveRef.current = false; stopRec(); setVoiceStatusLive('denied'); return }
        if (active && rec === r) { clearSilence(); stopMeter() } // no-speech/aborted → onend перезапустит
      }
      rec = r
      try { r.start(); startMeter() } catch { /* leave visible listening state; browser may recover on next toggle */ }
    }

    const finalize = (text: string) => {
      if (!active) return
      const canAccept = shouldAcceptAssistantVoiceResult(assistantSpeechGateSnapshot())
      stopRec()
      if (!canAccept) return
      const q = text.trim()
      if (!q) { listen(); return } // ничего не сказали — продолжаем слушать
      void runTurn(q)
    }

    const runTurn = async (q: string) => {
      if (!active) return
      setVoiceStatusLive('thinking')
      if (await handleVoiceProposalIntent(q)) {
        if (!active) return
        finishAfterSpeech()
        return
      }
      const res = await sendQuestion(q)
      if (!active) return
      if (res.kind === 'nokey') { finishVoiceCapture(); return } // нет ключа — цикл не крутим впустую
      finishAfterSpeech()
    }

    void (async () => {
      const ok = await ensureMic()
      if (!active) return
      if (!ok) { setVoiceStatusLive('denied'); return }
      listen()
    })()

    return () => {
      active = false
      convoActiveRef.current = false
      stopRec()
    }
  }, [
    wakeOn,
    open,
    lang,
    ensureMic,
    sendQuestion,
    startMeter,
    stopMeter,
    handleVoiceProposalIntent,
    assistantSpeechGateSnapshot,
    setVoiceStatusLive,
  ])

  // PTT gate: while the assistant is thinking or speaking, no extra recognition is started.

  // AI-VOICE-FIX-1: подчистка на unmount — освобождаем микрофон/метр и гасим озвучку (нет утечек).
  useEffect(() => () => {
    releaseMic()
    cancelTtsQueue()
    try { assistantAbortRef.current?.abort() } catch { /* ignore */ }
    try { void ttsAudioCtxRef.current?.close() } catch { /* ignore */ }
  }, [cancelTtsQueue, releaseMic])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (thinking) return
    void unlockTtsAudio()
    // Ручная отправка: озвучку нового ответа делает эффект по messages (разговорный цикл не активен).
    await sendQuestion(input)
  }

  const proposalSummary = (pr: AiProposal): string => {
    if (isAiInfoProposalAction(pr.action_type)) return t('ai_bug_recorded')
    if (pr.action_type === 'assign_worker') {
      const worker = pStr(pr.payload, 'worker_name', 'worker', 'profile_name', 'person_name', 'assignee_name') ?? t('ai_dispatch_worker_unknown')
      const project = pStr(pr.payload, 'project_name', 'project', 'site_name', 'site') ?? t('ai_dispatch_project_unknown')
      const note = pStr(pr.payload, 'note', 'notes')
      return formatTemplate(t('ai_dispatch_assign_summary'), {
        worker,
        project,
        note: note ? `${t('ai_dispatch_note_prefix')} ${note}` : '',
      })
    }
    if (pr.action_type === 'unassign_worker') {
      const worker = pStr(pr.payload, 'worker_name', 'worker', 'profile_name', 'person_name', 'assignee_name') ?? t('ai_dispatch_worker_unknown')
      const project = pStr(pr.payload, 'project_name', 'project', 'site_name', 'site') ?? t('ai_dispatch_project_unknown')
      return formatTemplate(t('ai_dispatch_unassign_summary'), { worker, project })
    }
    if (pr.action_type === 'send_plan') {
      const projectsList = pStrArray(pr.payload, 'project_names', 'projects', 'project_name', 'project')
      if (projectsList.length > 0) {
        return formatTemplate(t('ai_dispatch_send_plan_projects'), { projects: projectsList.join(', ') })
      }
      return t('ai_dispatch_send_plan')
    }
    return pr.title
  }

  const proposalIssueTitle = (issue: ProposalIssue): string => {
    if (issue.error === 'ambiguous') return t('ai_execute_ambiguous')
    if (issue.error === 'not_found') return t('ai_execute_not_found')
    return t('ai_execute_failed')
  }

  const visibleOverlayProposals = proposals.slice(0, OVERLAY_PROPOSAL_LIMIT)
  const hiddenOverlayProposalCount = Math.max(0, proposals.length - visibleOverlayProposals.length)

  const wakeSupported = !!SpeechRecognitionImpl

  // AI-UX-1: состояние «сущности»-орба. Отражает то, ЧТО делает ассистент — и зеркалит меня в «слушаю»
  // (орб пульсирует в ритм моего голоса, micLevel из AI-VOICE-FIX-1). idle — покой (медленный пульс);
  // listening — слушаю; thinking — думаю (идёт стрим/ответ); speaking — говорю (волны).
  const micDenied = wakeOn && wakeSupported && voiceStatus === 'denied'
  const assistantActive = thinking || streaming || ttsBusy
  const orbToggleIntent = getAiOrbToggleIntent({ open, wakeOn, speakOn, thinking, streaming, ttsBusy, voiceStatus })
  const orbToggleActive = orbToggleIntent === 'deactivate'
  const orbState: 'idle' | 'listening' | 'thinking' | 'speaking' =
    ttsBusy || voiceStatus === 'speaking'
      ? 'speaking'
      : thinking || streaming
      ? 'thinking'
      : voiceStatus === 'listening' || voiceStatus === 'wake'
        ? 'listening'
        : 'idle'
  const orbLabel =
    micDenied
      ? t('ai_mic_denied_title')
      : orbState === 'thinking'
        ? t('ai_thinking')
        : voiceStatus === 'wake'
          ? t('ai_wake_listening')
          : orbState === 'listening'
          ? t('ai_status_listening')
          : orbState === 'speaking'
            ? t('ai_status_speaking')
            : t('ai_orb_idle')

  // Бейдж при закрытой панели (оставляем прежним — статус голоса без правки App/Nav).
  const badgeView: { label: string } | null =
    !wakeOn || !wakeSupported
      ? null
      : voiceStatus === 'wake'
        ? { label: t('ai_wake_listening') }
        : voiceStatus === 'listening'
          ? { label: t('ai_status_listening') }
          : voiceStatus === 'thinking'
            ? { label: t('ai_thinking') }
            : voiceStatus === 'speaking'
              ? { label: t('ai_status_speaking') }
              : voiceStatus === 'denied'
                ? { label: t('ai_mic_denied_title') }
                : null
  const launcherPulsing = orbToggleActive && !micDenied
  const launcherStatus = badgeView?.label ?? (orbToggleActive ? t('ai_orb_active') : t('ai_orb_idle'))
  const orbToggleLabel = orbToggleActive ? t('ai_orb_deactivate') : t('ai_orb_activate')

  const handleOrbToggle = useCallback(() => {
    const next = getNextAiOrbToggleState({ open, wakeOn, speakOn, thinking, streaming, ttsBusy, voiceStatus })
    if (next.intent === 'activate') {
      void unlockTtsAudio().then(() => playTtsQueue())
      speakOnRef.current = true
      wakeOnRef.current = true
      openRef.current = true
      setSpeakOn(next.speakOn)
      setWakeOn(next.wakeOn)
      setOpen(next.open)
      return
    }

    wakeOnRef.current = false
    openRef.current = false
    setWakeOn(false)
    setOpen(false)
    setDrawerOpen(false)
    setContextOpen(false)
    cancelActiveAssistant()
    releaseMic()
    setVoiceStatusLive('off')
  }, [cancelActiveAssistant, open, playTtsQueue, releaseMic, setVoiceStatusLive, speakOn, streaming, thinking, ttsBusy, unlockTtsAudio, voiceStatus, wakeOn])

  return (
    <>
      {/* Collapsed global orb: fixed by default, opens the assistant without taking over the screen. */}
      {!open && (
        <button
          type="button"
          className={`ai-orb-launcher ai-voice-${voiceStatus}${launcherPulsing ? ' ai-orb-launcher-pulse' : ''}${orbToggleActive ? ' ai-orb-launcher-active' : ''}`}
          onClick={handleOrbToggle}
          aria-label={orbToggleLabel}
          aria-pressed={orbToggleActive}
          title={orbToggleLabel}
        >
          <span
            className={`ai-orb ai-orb-xs ai-orb-${orbState}${micDenied ? ' ai-orb-denied' : ''}`}
            style={{
              '--mic': orbState === 'listening' ? micLevel : 0,
              '--tts': orbState === 'speaking' ? ttsLevel : 0,
            } as React.CSSProperties}
            aria-hidden="true"
          >
            <span className="ai-orb-ring" />
            <span className="ai-orb-ring ai-orb-ring2" />
            <span className="ai-orb-ring ai-orb-ring3" />
            <span className="ai-orb-ring ai-orb-ring4" />
            <span className="ai-orb-core" />
          </span>
          <span className="ai-launcher-status">{launcherStatus}</span>
        </button>
      )}

      {/* AI-UX-2: КОМПАКТНЫЙ ПЛАВАЮЩИЙ ОВЕРЛЕЙ на фоне приложения. Не блокирует экран (нет backdrop,
          pointer-events только на самой карточке) — приложение под ним видно и работает. На оверлее
          ТОЛЬКО орб + короткая строка состояния + контекст экрана + компактные органы. Текст ответа
          НЕ показываем (голос первичен) — он в выдвижной панели «Показать текст». */}
      {open && (
        <div className="ai-overlay" role="dialog" aria-modal="false" aria-label={t('ai_title')}>
          {/* Маленький аккуратный крестик — просто закрыть. */}
          <button type="button" className="ai-overlay-close" onClick={() => setOpen(false)} aria-label={t('close')}>
            ✕
          </button>

          {/* СУЩНОСТЬ: пульсирующий орб (компактный) + короткая строка состояния + видимый контекст экрана. */}
          <div className="ai-overlay-main">
            <button
              type="button"
              className="ai-orb-toggle"
              onClick={handleOrbToggle}
              aria-label={orbToggleLabel}
              aria-pressed={orbToggleActive}
              title={orbToggleLabel}
            >
              <span
                className={`ai-orb ai-orb-sm ai-orb-${orbState}${micDenied ? ' ai-orb-denied' : ''}`}
                style={{
                  '--mic': orbState === 'listening' ? micLevel : 0,
                  '--tts': orbState === 'speaking' ? ttsLevel : 0,
                } as React.CSSProperties}
                aria-hidden="true"
              >
                <span className="ai-orb-ring" />
                <span className="ai-orb-ring ai-orb-ring2" />
                <span className="ai-orb-ring ai-orb-ring3" />
                <span className="ai-orb-ring ai-orb-ring4" />
                <span className="ai-orb-core" />
              </span>
            </button>
            <div className="ai-overlay-meta">
              <div className="ai-overlay-status-row">
                <p className="ai-orb-label" role="status" aria-live="polite">{orbLabel}</p>
                <button
                  type="button"
                  className="ai-icon-btn ai-context-btn"
                  onClick={() => setContextOpen((v) => !v)}
                  aria-label={t('ai_context_info')}
                  aria-expanded={contextOpen}
                  title={`${t('ai_ctx_seeing')}: ${screenContext.screen}${screenContext.details ? ` · ${screenContext.details}` : ''}`}
                >
                  <IconInfo />
                </button>
                {assistantActive && (
                  <button
                    type="button"
                    className="ai-icon-btn ai-stop-btn"
                    onClick={() => cancelActiveAssistant()}
                    aria-label={t('ai_stop_all')}
                    title={t('ai_stop_all')}
                  >
                    <IconStop />
                  </button>
                )}
              </div>
              {contextOpen && (
                <p className="ai-overlay-ctx muted">
                  {t('ai_ctx_seeing')}: {screenContext.screen}
                  {screenContext.details ? ` · ${screenContext.details}` : ''}
                </p>
              )}
            </div>
          </div>

          {micDenied && <p className="muted small ai-overlay-hint">{t('ai_mic_denied_hint')}</p>}

          {noKey && (
            <div className="ai-nokey ai-overlay-nokey" role="alert">
              <strong>{t('ai_no_key_title')}</strong>
              <span className="muted small">{t('ai_no_key_desc')}</span>
            </div>
          )}

          {/* PROPOSALS ПО ГОЛОСУ: до 4 свежих pending-карточек; голосовое «да/нет» действует на первую. */}
          {visibleOverlayProposals.length > 0 && (
            <div className="ai-overlay-proposals">
              {visibleOverlayProposals.map((pr) => {
                const issue = proposalIssues[pr.id]
                const candidates = issue?.candidates?.slice(0, 2) ?? []
                if (isAiInfoProposalAction(pr.action_type)) {
                  return (
                    <div key={pr.id} className="ai-overlay-proposal ai-overlay-proposal-info" role="status">
                      <div className="ai-overlay-proposal-head">
                        <span className="ai-overlay-proposal-title">{t('ai_bug_recorded')}</span>
                      </div>
                      <div className="row ai-overlay-proposal-actions">
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => dismissInfoProposal(pr.id)}
                        >
                          {t('got_it')}
                        </button>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={pr.id} className="ai-overlay-proposal">
                    <div className="ai-overlay-proposal-head">
                      <span className="ai-overlay-proposal-badge">{t('ai_proposal_badge')}</span>
                      <span className="ai-overlay-proposal-title">{proposalSummary(pr)}</span>
                    </div>
                    {issue && (
                      <div className="ai-proposal-issue" role="alert">
                        <p>{proposalIssueTitle(issue)}</p>
                        {issue.message && <p className="muted small">{issue.message}</p>}
                        {candidates.length > 0 && (
                          <p className="muted small">
                            {t('ai_execute_candidates')}: {candidates.map(candidateText).join(', ')}
                          </p>
                        )}
                        <p className="muted small">{t('ai_execute_still_pending')}</p>
                      </div>
                    )}
                    <div className="row ai-overlay-proposal-actions">
                      {KNOWN_ACTIONS.has(pr.action_type) && (
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
              {hiddenOverlayProposalCount > 0 && (
                <button
                  type="button"
                  className="btn ghost ai-overlay-more"
                  onClick={() => setDrawerOpen(true)}
                >
                  {t('ai_more_proposals').replace('{n}', String(hiddenOverlayProposalCount))}
                </button>
              )}
            </div>
          )}

          {/* КОМПАКТНЫЕ ОРГАНЫ: push-to-talk микрофон (сразу шлёт вопрос) + «Показать текст» (drawer). */}
          <div className="ai-overlay-controls">
            <VoiceMic
              lang={lang}
              title={t('ai_voice_hint')}
              onResult={(text) => { void handleVoiceInput(text) }}
            />
            <button
              type="button"
              className="btn ghost ai-overlay-text-btn"
              onClick={() => setDrawerOpen(true)}
            >
              <IconText />
              <span>{t('ai_show_text')}{messages.length > 0 ? ` (${messages.length})` : ''}</span>
            </button>
          </div>

          {(AUDIO_TTS_SUPPORTED || wakeSupported) && (
            <div className="ai-toggles ai-overlay-toggles">
              {AUDIO_TTS_SUPPORTED && (
                <label className="ai-toggle">
                  <input
                    type="checkbox"
                    checked={speakOn}
                    onChange={(e) => {
                      const checked = e.target.checked
                      speakOnRef.current = checked
                      setSpeakOn(checked)
                      if (checked) void unlockTtsAudio().then(() => playTtsQueue())
                      else cancelTtsQueue()
                    }}
                  />
                  <span>{t('ai_speak_toggle')}</span>
                </label>
              )}
              {wakeSupported && (
                <label className="ai-toggle" title={t('ai_wake_hint')}>
                  <input
                    type="checkbox"
                    checked={wakeOn}
                    onChange={(e) => {
                      const checked = e.target.checked
                      wakeOnRef.current = checked
                      setWakeOn(checked)
                      if (checked) void unlockTtsAudio()
                    }}
                  />
                  <span>{t('ai_wake_toggle')}</span>
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {/* ОТДЕЛЬНАЯ ВЫДВИЖНАЯ ПАНЕЛЬ (drawer): расшифровка диалога (со стримом печати) + полный список
          proposals + вторичный ввод текста. Открывается кнопкой «Показать текст». */}
      {open && drawerOpen && (
        <div
          className="ai-drawer-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) setDrawerOpen(false) }}
        >
          <aside className="card ai-drawer" role="dialog" aria-modal="true" aria-label={t('ai_drawer_title')}>
            <header className="ai-drawer-head">
              <h2 className="ai-drawer-title">{t('ai_drawer_title')}</h2>
              <button type="button" className="ai-overlay-close" onClick={() => setDrawerOpen(false)} aria-label={t('close')}>
                ✕
              </button>
            </header>

            {/* Лента диалога + живой стрим печати внизу (стрим идёт ЗДЕСЬ, а не на оверлее). */}
            <div className="ai-drawer-scroll">
              {loading && messages.length === 0 ? (
                <p className="muted small">…</p>
              ) : null}
              {messages.map((m) => (
                <div key={m.id} className={`ai-hist-row ai-hist-${m.role}`}>
                  <span className="ai-hist-role">{m.role === 'user' ? t('ai_hist_you') : t('ai_hist_ai')}</span>
                  <span className="ai-hist-text">
                    {m.role === 'assistant' ? stripMarkdown(m.content) : m.content}
                  </span>
                </div>
              ))}
              {streaming && streamText && (
                <div className="ai-hist-row ai-hist-assistant">
                  <span className="ai-hist-role">{t('ai_hist_ai')}</span>
                  <span className="ai-hist-text">{streamText}<span className="ai-caret" aria-hidden="true" /></span>
                </div>
              )}
              {(thinking || streaming) && !streamText && (
                <p className="muted small ai-answer-thinking">{t('ai_thinking')}</p>
              )}
              {messages.length === 0 && !loading && !thinking && !streaming && (
                <p className="ai-answer-empty muted">{t('ai_empty')}</p>
              )}
              <div ref={historyEndRef} />
            </div>

            {proposals.length > 0 && (
              <div className="ai-proposals">
                <h3 className="ai-proposals-title">{t('ai_proposals_title')}</h3>
                {proposals.map((pr) => {
                  const known = KNOWN_ACTIONS.has(pr.action_type)
                  const rows = summarizePayload(pr.payload)
                  const issue = proposalIssues[pr.id]
                  const candidates = issue?.candidates?.slice(0, 6) ?? []
                  if (isAiInfoProposalAction(pr.action_type)) {
                    return (
                      <div key={pr.id} className="ai-proposal ai-proposal-info card" role="status">
                        <div className="ai-proposal-title">{t('ai_bug_recorded')}</div>
                        <div className="row ai-proposal-actions">
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => dismissInfoProposal(pr.id)}
                          >
                            {t('got_it')}
                          </button>
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div key={pr.id} className="ai-proposal card">
                      <div className="ai-proposal-title">
                        {t('ai_proposal_prefix')} {proposalSummary(pr)}
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
                      {issue && (
                        <div className="ai-proposal-issue" role="alert">
                          <p>{proposalIssueTitle(issue)}</p>
                          {issue.message && <p className="muted small">{issue.message}</p>}
                          {candidates.length > 0 && (
                            <>
                              <p className="muted small">{t('ai_execute_candidates')}:</p>
                              <ul>
                                {candidates.map((candidate, idx) => (
                                  <li key={`${pr.id}-candidate-${idx}`}>{candidateText(candidate)}</li>
                                ))}
                              </ul>
                            </>
                          )}
                          <p className="muted small">{t('ai_execute_still_pending')}</p>
                        </div>
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

            {/* Вторичный ввод текста (голос первичен). */}
            <form className="ai-input-row ai-drawer-input" onSubmit={submit}>
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
                onResult={(text) => {
                  void (async () => {
                    const snapshot = assistantSpeechGateSnapshot()
                    if (snapshot.thinking || snapshot.streaming || hasPendingAssistantSpeech(snapshot)) return
                    if (await handleVoiceProposalIntent(text)) return
                    setInput((v) => (v ? `${v} ${text}` : text))
                  })()
                }}
              />
              <button type="submit" className="btn primary ai-send-btn" disabled={thinking || !input.trim()}>
                {thinking ? t('ai_thinking') : t('ai_send')}
              </button>
            </form>
          </aside>
        </div>
      )}

      {toast && (
        <div className="travel-toast ai-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  )
}
