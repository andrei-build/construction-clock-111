import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../lib/i18n'
import { useScreenContext, type ScreenContext } from '../lib/useScreenContext'
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
  streamAiSpeech,
  type AiExecuteCandidate,
  type AiExecuteProposalErrorCode,
  type AiMessage,
  type AiProposal,
} from '../lib/api/ai'
import {
  decideVoiceFinalOutcome,
  formatVoiceGateCause,
  getAiOrbToggleIntent,
  getNextAiOrbToggleState,
  hasPendingAssistantSpeech,
  isAiInfoProposalAction,
  isTtsPlaybackBlockedError,
  isVoiceAffirm,
  isVoiceCancel,
  shouldAcceptAssistantVoiceResult,
  shouldAcceptWakePhraseResult,
  shouldArmBargeIn,
  splitCompletedSpeechSegments,
  sttFinalLagMs,
  stripMarkdownForSpeech,
  VOICE_FINAL_RESCUE_MS,
  VOICE_FIRST_BYTE_TIMEOUT_MS,
  VOICE_MAX_ATTEMPTS,
} from '../lib/aiVoice'
import { concatBytes, framesForSeconds, pcm16ToFloat32, splitEvenPcmBytes } from '../lib/aiTtsStream'
import { logVoiceClientEvent as emitVoiceTelemetry } from '../lib/clientErrors'
import { loadBargeInVad, type BargeInVad } from '../lib/vadBargeIn'
import type { Profile, Project } from '../lib/types'

// ORB-SIMPLE-2: единый ДВИЖОК ассистента владельца (чат + голос + озвучка + настройки). Монтируется в
// App ТОЛЬКО для owner как <AiAssistantProvider> — RLS ai_messages/ai_proposals гейтятся app.is_owner(),
// у admin история пуста, а update молча затрагивает 0 строк, поэтому экран строго owner-only.
//
// Один инстанс движка отдаёт контекст (useAiAssistant) ДВУМ потребителям без дублирования и гонок:
//   1) угловой ОРБ-РАЦИЯ (рендерит сам провайдер) — клик = сразу слушает/отвечает голосом, БЕЗ панелей;
//   2) полноэкранная страница /ask (src/screens/Ask.tsx) — история диалога, ввод, микрофон, настройки.
// Прежний попап-оверлей/drawer чата удалён: орб больше НИКОГДА не показывает панель. Кнопка «Спроси»
// в сайдбаре и Ctrl+K ведут на маршрут /ask (см. Nav.tsx / глобальный слушатель ниже).
//
// Контракт с бэкендом: user/assistant-сообщения в ai_messages и pending-предложения в ai_proposals
// пишет ТОЛЬКО edge (service-role) при POST /ai-assistant. С фронта мы историю читаем, предложения
// читаем и помечаем executed/rejected (update). Ничего не вставляем — см. src/lib/api/ai.ts.

const TASK_TYPES = ['work', 'material', 'delivery'] as const
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
const MSG_PRIORITIES = ['urgent', 'info', 'good', 'task'] as const
const EVENT_TYPES = ['meeting', 'inspection', 'measure', 'delivery', 'other'] as const
const LOCAL_ACTIONS = new Set(['create_task', 'send_message', 'send_mail', 'create_event'])
const DISPATCH_ACTIONS = new Set(['assign_worker', 'unassign_worker', 'send_plan'])
export const KNOWN_ACTIONS = new Set([...LOCAL_ACTIONS, ...DISPATCH_ACTIONS])

// VOICE-CLIENT-DEBUG-1: окно тишины перед отправкой распознанной фразы. Раньше ждали 1800мс ВСЕГДА —
// голос «думал» лишние ~2с ещё до сети. Теперь после ФИНАЛА распознавания (isFinal) шлём почти сразу
// (короткое окно — движок изредка досылает уточнение), а на голом интериме держим чуть дольше, чтобы не
// оборвать копящуюся фразу. Итог: конец речи → отправка сокращается, целевой firstSound ≤5с достижим.
const STT_SILENCE_AFTER_FINAL_MS = 350
const STT_SILENCE_AFTER_INTERIM_MS = 900

// VOICE-TIMEOUT-RETRY-8: порог RMS мик-уровня, выше которого считаем, что человек ГОВОРИТ. Нужен для
// замера АКУСТИЧЕСКОГО конца речи (последний кадр выше порога) → лаг Web Speech до финала распознавания.
// Подобран под метр startMeter (сырой rms, ДО множителя *3 визуального индикатора micLevel).
const MIC_SPEECH_RMS_THRESHOLD = 0.05

export type ProposalIssue = {
  error: AiExecuteProposalErrorCode | 'failed'
  message?: string
  candidates?: AiExecuteCandidate[]
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

// VOICE-CLIENT-DEBUG-1: компактная деталь ошибки воспроизведения для телеметрии (name + короткое
// сообщение) — чтобы в client_errors.message было видно, ЧЕМ именно упал плеер, без гигантских строк.
function voiceErrDetail(err: unknown): string {
  const name = (err as { name?: string } | null)?.name
  const message = (err as { message?: string } | null)?.message
  const parts: string[] = []
  if (name) parts.push(name)
  if (message) parts.push(message)
  return (parts.join(': ') || String(err)).slice(0, 160)
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
export function summarizePayload(payload: Record<string, unknown>): Array<[string, string]> {
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

export function candidateText(candidate: AiExecuteCandidate): string {
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
export function stripMarkdown(s: string): string {
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

// ORB-SIMPLE-2: контекст движка ассистента. Один инстанс (провайдер) — два потребителя (орб + /ask),
// чтобы список/отправка/TTS/STT/настройки были ОБЩИМИ, без дублирования логики и без гонок микрофона.
// ASSISTANT-PAGE-3 (п.2): порог отличия перетаскивания орба от одиночного тапа. Локальная константа —
// НЕ импортируем NODE_DRAG_THRESHOLD_PX из эскиза (SketchTab), чтобы не тянуть зависимость эскиза сюда.
const ORB_DRAG_THRESHOLD_PX = 6

// ASSISTANT-PAGE-3 (п.4): одна запись клиентской голосовой телеметрии (voice:<stage> [+ деталь с мс]),
// накопленная В ПАМЯТИ сессии для блока «Диагностика» на /ask. Без обращений к БД.
export type VoiceDiagEvent = { stage: string; detail?: string }

export type AiAssistantContextValue = {
  messages: AiMessage[]
  proposals: AiProposal[]
  proposalIssues: Record<string, ProposalIssue>
  loading: boolean
  thinking: boolean
  streaming: boolean
  streamText: string
  noKey: boolean
  busyId: string | null
  input: string
  setInput: (value: string) => void
  submit: (e: React.FormEvent) => void
  handleVoiceInput: (text: string) => void
  executeProposal: (pr: AiProposal) => Promise<boolean>
  rejectProposal: (pr: AiProposal) => Promise<boolean>
  dismissInfoProposal: (id: string) => void
  proposalSummary: (pr: AiProposal) => string
  proposalIssueTitle: (issue: ProposalIssue) => string
  speakOn: boolean
  wakeOn: boolean
  speakSupported: boolean
  wakeSupported: boolean
  setSpeakEnabled: (checked: boolean) => void
  setWakeEnabled: (checked: boolean) => void
  orbState: 'idle' | 'listening' | 'thinking' | 'speaking'
  orbLabel: string
  voiceStatus: VoiceStatus
  micLevel: number
  ttsLevel: number
  micDenied: boolean
  lang: 'ru' | 'en' | 'es'
  // ASSISTANT-PAGE-3 (п.4): голосовая клиент-телеметрия текущей сессии (в памяти, без запросов в БД).
  voiceDiag: VoiceDiagEvent[]
  voiceHeard: string | null
}

const AiAssistantContext = createContext<AiAssistantContextValue | null>(null)

export function useAiAssistant(): AiAssistantContextValue {
  const ctx = useContext(AiAssistantContext)
  if (!ctx) throw new Error('useAiAssistant must be used within AiAssistantProvider')
  return ctx
}

export default function AiAssistantProvider({ profile, children }: { profile: Profile; children: ReactNode }) {
  const navigate = useNavigate()
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
  const [proposalIssues, setProposalIssues] = useState<Record<string, ProposalIssue>>({})
  const streamingRef = useRef(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

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
  // ASSISTANT-PAGE-3 (п.4): голосовая клиент-телеметрия ЭТОЙ сессии в памяти (для блока «Диагностика»
  // на /ask). voiceDiag — «хвост» последних этапов/таймингов voice:*, voiceHeard — последний распознанный
  // текст. Пишется ЛОКАЛЬНО (никаких запросов в БД); существующая отправка voice:* в client_errors не
  // меняется — logVoice лишь дублирует её в память.
  const [voiceDiag, setVoiceDiag] = useState<VoiceDiagEvent[]>([])
  const [voiceHeard, setVoiceHeard] = useState<string | null>(null)
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
  // VOICE-FRONT-STREAM: прогрессивный PCM-стрим озвучки — планировщик буферов «встык» и его reader,
  // чтобы barge-in/новый вопрос могли МГНОВЕННО оборвать и звук, и чтение сети.
  const ttsPcmSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())
  const ttsPcmGainRef = useRef<GainNode | null>(null)
  const ttsStreamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  // VOICE-FRONT-STREAM: barge-in через Silero-VAD (ленивая загрузка). vadRef — инстанс, handler/listen —
  // «свежие» колбэки в рефах, чтобы MicVAD (создан один раз) не пересоздавался при ребилде замыканий.
  const vadRef = useRef<BargeInVad | null>(null)
  const vadLoadingRef = useRef(false)
  const bargeInListenRef = useRef<(() => void) | null>(null)
  const bargeInHandlerRef = useRef<(() => void) | null>(null)
  // VOICE-CLIENT-DEBUG-1: клиентские тайминги голосового ответа (для телеметрии voice:timing).
  // speechEnd — конец захвата речи (STT-финал); ttsResponseAt — получен TTS-ответ (streamAiSpeech
  // резолвнулся); firstSoundLogged — первый звук уже отмечен в этом голосовом ходу (лог один раз).
  const voiceSpeechEndAtRef = useRef<number | null>(null)
  const voiceTtsResponseAtRef = useRef<number | null>(null)
  const voiceFirstSoundLoggedRef = useRef(false)
  // VOICE-TIMEOUT-RETRY-8: штампы для замера лага Web Speech STT (voice:timing sttFinal2speechEnd).
  // micLastVoiceAt — последний момент, когда мик-уровень был выше порога речи (АКУСТИЧЕСКИЙ конец речи);
  // sttFinalAt — момент, когда onresult ПЕРВЫЙ раз отдал isFinal (финал распознавания). Разница = лаг движка.
  const micLastVoiceAtRef = useRef<number | null>(null)
  const sttFinalAtRef = useRef<number | null>(null)
  // VOICE-DROPPED-FINAL-47: конвейер «один финал → один исход». pendingFinal — непустой финал, придержанный
  // на время закрытого гейта (озвучка/thinking/streaming предыдущего хода); дошлётся, когда гейт откроется
  // (ttsOnIdle) или по rescue-таймеру. lastSentVoice — текст последнего РЕАЛЬНО отправленного финала
  // (анти-дубль). finalRescueTimer — страховочный таймер VOICE_FINAL_RESCUE_MS против тихой потери финала.
  const pendingFinalRef = useRef<string | null>(null)
  const lastSentVoiceRef = useRef<string | null>(null)
  const finalRescueTimerRef = useRef<number | null>(null)

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

  // ASSISTANT-PAGE-3 (п.4): единая обёртка над голосовой телеметрией. Форвардит в logVoiceClientEvent
  // (та же отправка voice:* в client_errors, что и раньше — БЕЗ новых запросов) И одновременно копит
  // событие В ПАМЯТИ сессии для блока «Диагностика» на /ask (хвост последних MAX_VOICE_DIAG). Диагностика
  // читает только этот буфер — никаких select-ов из client_errors.
  const MAX_VOICE_DIAG = 24
  const logVoice = useCallback((stage: string, detail?: string) => {
    emitVoiceTelemetry(stage, detail)
    setVoiceDiag((prev) => {
      const next = prev.length >= MAX_VOICE_DIAG ? prev.slice(prev.length - MAX_VOICE_DIAG + 1) : prev.slice()
      next.push({ stage, ...(detail ? { detail } : {}) })
      return next
    })
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

  // VOICE-CLIENT-DEBUG-1: отметка ПЕРВОГО реального звука голосового ответа. Логируем ОДИН раз за ход:
  // voice:fetch-ok (аудио реально пошло + путь + response→firstSound) и voice:timing
  // (speechEnd→firstSound — цель приёмки ≤5с). Тайминги пишем, только если известны конец речи/приём
  // ответа (т.е. голосовой ход; ручная отправка их не ставит).
  const markFirstVoiceSound = useCallback((path: string) => {
    if (voiceFirstSoundLoggedRef.current) return
    voiceFirstSoundLoggedRef.current = true
    const now = Date.now()
    const okDetail: string[] = [`path=${path}`]
    const respAt = voiceTtsResponseAtRef.current
    if (respAt !== null) okDetail.push(`resp2sound=${now - respAt}ms`)
    logVoice('fetch-ok', okDetail.join(' '))
    const speechEnd = voiceSpeechEndAtRef.current
    if (speechEnd !== null) logVoice('timing', `path=${path} speechEnd2sound=${now - speechEnd}ms`)
  }, [])

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

  // VOICE-FRONT-STREAM: мгновенный стоп прогрессивного PCM-стрима — обрываем чтение сети и глушим ВСЕ
  // запланированные встык AudioBufferSourceNode (barge-in требует <100мс). Идемпотентно.
  const stopPcmPlayback = useCallback(() => {
    const reader = ttsStreamReaderRef.current
    ttsStreamReaderRef.current = null
    if (reader) { try { void reader.cancel() } catch { /* ignore */ } }
    const sources = ttsPcmSourcesRef.current
    sources.forEach((src) => {
      try { src.onended = null; src.stop() } catch { /* ignore */ }
      try { src.disconnect() } catch { /* ignore */ }
    })
    sources.clear()
    const gain = ttsPcmGainRef.current
    ttsPcmGainRef.current = null
    if (gain) { try { gain.disconnect() } catch { /* ignore */ } }
  }, [])

  const stopCurrentTtsAudio = useCallback(() => {
    try { ttsAbortRef.current?.abort() } catch { /* ignore */ }
    ttsAbortRef.current = null
    stopPcmPlayback()
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
  }, [revokeTtsUrl, stopTtsMeter, stopPcmPlayback])

  const cancelTtsQueue = useCallback((runIdle = false) => {
    ttsSerialRef.current += 1
    ttsQueueRef.current = []
    ttsQueueRunningRef.current = false
    stopCurrentTtsAudio()
    // Синхронно гасим ttsBusyRef (иначе barge-in-relisten увидит устаревший «pending speech» и снова
    // уйдёт в 'speaking'): setTtsBusy(false) обновит state-ref лишь на следующем рендере.
    ttsBusyRef.current = false
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

  const playTtsAudioElement = useCallback(async (audio: HTMLAudioElement, onStarted?: () => void): Promise<void> => {
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
          onStarted?.() // VOICE-CLIENT-DEBUG-1: play() принят — звук пошёл (первый звук WAV-пути)
        } catch (err) {
          console.warn('AI TTS audio.play() rejected', err)
          const blocked = isTtsPlaybackBlockedError(err)
          // VOICE-CLIENT-DEBUG-1: не глотаем — фиксируем причину. autoplay-block логируем ДАЖЕ если
          // ретрай ниже спасёт (Андрею важно знать, что политика autoplay мешает без жеста).
          logVoice(blocked ? 'autoplay-block' : 'play-fail', voiceErrDetail(err))
          if (blocked) {
            const ctx = await resumeTtsAudioContext()
            if (ctx?.state === 'running') {
              try {
                await audio.play()
                onStarted?.() // VOICE-CLIENT-DEBUG-1: ретрай после resume удался — звук пошёл
                return
              } catch (retryErr) {
                console.warn('AI TTS audio.play() retry rejected', retryErr)
                logVoice('play-fail', `retry ${voiceErrDetail(retryErr)}`)
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

  // VOICE-FRONT-STREAM: RAF-метр для PCM-стрима — анализатор уже в графе (gain→analyser→destination),
  // крутим тот же RMS-цикл, что и HTMLAudio-путь, читая ttsAnalyserRef.
  const runTtsMeterLoop = useCallback(() => {
    const analyser = ttsAnalyserRef.current
    if (!analyser) return
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
  }, [])

  // VOICE-FRONT-STREAM: прогрессивное проигрывание PCM16LE-стрима. Копим байты, режем на AudioBuffer'ы
  // ~0.25с и планируем ВСТЫК через ttsAudioContext (source.start(nextTime); nextTime += duration) —
  // первые слова звучат почти сразу. Бросаем, ТОЛЬКО если не успели запланировать НИ ОДНОГО буфера
  // (тогда внешний цикл откатится на целый WAV ai-tts); если часть уже играет — глотаем сетевую ошибку
  // (частичный ответ лучше двойного). Прерывание (barge-in/новый вопрос) — serial/abort + stopPcmPlayback.
  const playPcmStream = useCallback(async (
    stream: { sampleRate: number; body: ReadableStream<Uint8Array> },
    serial: number,
    signal: AbortSignal,
    path: string,
    onFirstSound?: () => void, // VOICE-TIMEOUT-RETRY-8: снять «нет-первого-байта» таймаут озвучки
  ): Promise<void> => {
    const ctx = await resumeTtsAudioContext()
    // VOICE-CLIENT-DEBUG-1: нет живого AudioContext (autoplay/PWA не разблокирован) — не молчим,
    // фиксируем decode-fail и бросаем: внешний цикл откатится на WAV, а телеметрия покажет причину.
    if (!ctx || ctx.state !== 'running') { logVoice('decode-fail', 'no_audio_context'); throw new Error('tts_no_audio_context') }

    stopTtsMeter()
    stopPcmPlayback()
    const gain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    gain.connect(analyser)
    analyser.connect(ctx.destination)
    ttsPcmGainRef.current = gain
    ttsAnalyserRef.current = analyser
    const sources = ttsPcmSourcesRef.current
    runTtsMeterLoop()

    const sampleRate = stream.sampleRate
    const minChunkBytes = framesForSeconds(sampleRate, 0.25) * 2
    let nextTime = ctx.currentTime + 0.06
    let scheduledAny = false
    const aborted = () => serial !== ttsSerialRef.current || signal.aborted

    const schedule = (frames: Int16Array) => {
      if (frames.length === 0) return
      const buffer = ctx.createBuffer(1, frames.length, sampleRate)
      buffer.getChannelData(0).set(pcm16ToFloat32(frames))
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(gain)
      const startAt = Math.max(nextTime, ctx.currentTime)
      src.start(startAt)
      nextTime = startAt + buffer.duration
      sources.add(src)
      src.onended = () => { sources.delete(src); try { src.disconnect() } catch { /* ignore */ } }
      // VOICE-CLIENT-DEBUG-1: первый реально запланированный буфер = первый звук ответа.
      if (!scheduledAny) { markFirstVoiceSound(path); onFirstSound?.() }
      scheduledAny = true
    }

    const reader = stream.body.getReader()
    ttsStreamReaderRef.current = reader
    let pending: Uint8Array = new Uint8Array(0)
    try {
      for (;;) {
        if (aborted()) throw new DOMException('aborted', 'AbortError')
        const { value, done } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        pending = concatBytes(pending, value)
        if (pending.length >= minChunkBytes) {
          const { frames, leftover } = splitEvenPcmBytes(pending)
          schedule(frames)
          pending = leftover
        }
      }
      schedule(splitEvenPcmBytes(pending).frames)
    } catch (err) {
      const name = (err as { name?: string } | null)?.name
      if (name === 'AbortError' || aborted() || !scheduledAny) {
        // VOICE-CLIENT-DEBUG-1: обрыв ДО первого звука (не barge-in/abort) — фиксируем decode-fail.
        if (name !== 'AbortError' && !aborted() && !scheduledAny) logVoice('decode-fail', voiceErrDetail(err))
        stopPcmPlayback(); throw err
      }
      // частичное воспроизведение уже идёт — доигрываем запланированное, сетевой обрыв не роняем наружу
    } finally {
      if (ttsStreamReaderRef.current === reader) ttsStreamReaderRef.current = null
    }

    // Ждём, пока доиграют запланированные буферы (или их прервут barge-in/новый вопрос).
    await new Promise<void>((resolve) => {
      const check = () => {
        if (aborted() || ctx.currentTime >= nextTime - 0.02) { resolve(); return }
        window.setTimeout(check, 40)
      }
      check()
    })
    if (!aborted()) { stopTtsMeter(); stopPcmPlayback() }
  }, [resumeTtsAudioContext, stopTtsMeter, stopPcmPlayback, runTtsMeterLoop, markFirstVoiceSound])

  // VOICE-FRONT-STREAM: проигрывание целого аудио-Blob (WAV) — общий путь для фолбэка ai-tts-stream
  // (X-Fallback: full) и старого ai-tts. Метр — через MediaElementSource (startTtsMeter), как раньше.
  const playTtsBlob = useCallback(async (blob: Blob, serial: number, signal: AbortSignal, path: string, onFirstSound?: () => void): Promise<void> => {
    revokeTtsUrl()
    const url = URL.createObjectURL(blob)
    ttsUrlRef.current = url
    const audio = new Audio(url)
    ttsAudioRef.current = audio
    await startTtsMeter(audio)
    if (serial !== ttsSerialRef.current || signal.aborted) return
    await playTtsAudioElement(audio, () => { markFirstVoiceSound(path); onFirstSound?.() })
    if (ttsAudioRef.current === audio) ttsAudioRef.current = null
    stopTtsMeter()
    revokeTtsUrl()
  }, [revokeTtsUrl, startTtsMeter, playTtsAudioElement, stopTtsMeter, markFirstVoiceSound])

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
      // VOICE-TIMEOUT-RETRY-8: запоминаем последний «громкий» кадр = акустический конец речи (для sttFinal2speechEnd).
      if (rms > MIC_SPEECH_RMS_THRESHOLD) micLastVoiceAtRef.current = Date.now()
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
          // VOICE-TIMEOUT-RETRY-8: озвучка сегмента с «нет-первого-байта» таймаутом + ОДНИМ авто-ретраем.
          // Если ни stream, ни fallback не дали ПЕРВОГО звука за 8с → abort, voice:timeout stage=tts,
          // повтор того же сегмента; 2-й таймаут → внятная ошибка (не зависаем беззвучно). Ретрай запускается
          // ТОЛЬКО когда звука ещё не было — задваивания TTS нет (первый звук снимает watchdog).
          let segmentPlayed = false
          let ttsTimedOut = false
          let ttsUserAborted = false
          for (let ttsAttempt = 1; ttsAttempt <= VOICE_MAX_ATTEMPTS; ttsAttempt++) {
            if (serial !== ttsSerialRef.current || !speakOnRef.current) { ttsUserAborted = true; break }
            const aborter = new AbortController()
            ttsAbortRef.current = aborter
            let firstSound = false
            let watchdogTimedOut = false
            let watchdog: number | null = window.setTimeout(() => {
              if (!firstSound) { watchdogTimedOut = true; try { aborter.abort() } catch { /* ignore */ } }
            }, VOICE_FIRST_BYTE_TIMEOUT_MS)
            const clearTtsWatchdog = () => { if (watchdog !== null) { window.clearTimeout(watchdog); watchdog = null } }
            const onFirstSound = () => { firstSound = true; clearTtsWatchdog() }
            // VOICE-FRONT-STREAM: сначала прогрессивный стрим ai-tts-stream (звук идёт по мере генерации);
            // при любой ошибке ДО первого звука — тихий откат на целый WAV ai-tts (прежнее поведение цело).
            try {
              let played = false
              try {
                const streamed = await streamAiSpeech({ text, style: 'jarvis', signal: aborter.signal })
                if (serial !== ttsSerialRef.current || aborter.signal.aborted) { clearTtsWatchdog(); ttsUserAborted = true; break }
                // VOICE-CLIENT-DEBUG-1: получен TTS-ответ — засекаем для response→firstSound; path несёт
                // реальную ветку edge (X-Fallback) в телеметрию voice:fetch-ok/voice:timing.
                voiceTtsResponseAtRef.current = Date.now()
                if (streamed.kind === 'stream') {
                  await playPcmStream(streamed, serial, aborter.signal, streamed.fallback ? `stream:${streamed.fallback}` : 'stream', onFirstSound)
                } else {
                  await playTtsBlob(streamed.blob, serial, aborter.signal, streamed.fallback ? `wav:${streamed.fallback}` : 'wav', onFirstSound)
                }
                played = true
              } catch (streamErr) {
                const sname = (streamErr as { name?: string } | null)?.name
                if (watchdogTimedOut) throw streamErr // таймаут «нет первого байта» → внешний catch (ретрай/ошибка)
                if (sname === 'AbortError' || serial !== ttsSerialRef.current || aborter.signal.aborted) { clearTtsWatchdog(); ttsUserAborted = true; break }
                console.warn('AI TTS stream failed — fallback to ai-tts', streamErr)
              }
              if (!played) {
                const { blob } = await synthesizeAiSpeech({ text, style: 'jarvis', signal: aborter.signal })
                if (serial !== ttsSerialRef.current || aborter.signal.aborted) { clearTtsWatchdog(); ttsUserAborted = true; break }
                voiceTtsResponseAtRef.current = Date.now()
                await playTtsBlob(blob, serial, aborter.signal, 'legacy', onFirstSound)
              }
              clearTtsWatchdog()
              if (serial !== ttsSerialRef.current || aborter.signal.aborted) { ttsUserAborted = true; break }
              segmentPlayed = true
              break
            } catch (err) {
              clearTtsWatchdog()
              if (watchdogTimedOut && serial === ttsSerialRef.current) {
                logVoice('timeout', 'stage=tts')
                if (ttsAttempt < VOICE_MAX_ATTEMPTS) continue // ОДИН авто-ретрай того же сегмента
                ttsTimedOut = true
                break
              }
              const name = (err as { name?: string } | null)?.name
              if (name === 'AbortError' || serial !== ttsSerialRef.current || aborter.signal.aborted) { ttsUserAborted = true; break }
              throw err // прочая ошибка озвучки → внешний catch (тост ai_tts_error)
            }
          }

          if (ttsUserAborted) break
          if (ttsTimedOut) {
            // 2-й таймаут озвучки → не зависаем беззвучно: снимаем сегмент, чистим очередь, внятная ошибка.
            if (ttsQueueRef.current[0] === text) ttsQueueRef.current.shift()
            ttsQueueRef.current = []
            if (!ttsErrorShownRef.current) { ttsErrorShownRef.current = true; flashToast(t('ai_voice_retry')) }
            break
          }
          if (!segmentPlayed) break

          if (ttsQueueRef.current[0] === text) ttsQueueRef.current.shift()

          stopTtsMeter()
          revokeTtsUrl()
          ttsAbortRef.current = null
        }
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        if (serial === ttsSerialRef.current && name !== 'AbortError') {
          // VOICE-CLIENT-DEBUG-1: не глотаем сбой озвучки — фиксируем ДО показа тоста.
          logVoice(isTtsPlaybackBlockedError(err) ? 'autoplay-block' : 'play-fail', voiceErrDetail(err))
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
  }, [finishTtsQueue, flashToast, playPcmStream, playTtsBlob, revokeTtsUrl, setVoiceStatusLive, stopTtsMeter, t])

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
      // VOICE-TIMEOUT-RETRY-8: нестрим-фолбэк тоже не должен молчаливо зависнуть — abort по «нет-ответа» за 8с
      // (ошибку покажет тост ниже). Ретрая здесь нет: POST — уже фолбэк после сорвавшегося стрима.
      const postAbort = new AbortController()
      const postTimer = window.setTimeout(() => { try { postAbort.abort() } catch { /* ignore */ } }, VOICE_FIRST_BYTE_TIMEOUT_MS)
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
          signal: postAbort.signal,
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
      } finally {
        window.clearTimeout(postTimer)
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
      // VOICE-CLIENT-DEBUG-1: новый ход — сбрасываем метки «первого звука» и приёма TTS-ответа.
      voiceFirstSoundLoggedRef.current = false
      voiceTtsResponseAtRef.current = null
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
      let assistantTimedOut = false // обе попытки без ПЕРВОГО байта → «не расслышал, повтори»
      let userAborted = false       // barge-in / новый вопрос / размонтирование прервали текущий ход
      // VOICE-TIMEOUT-RETRY-8: стрим ai-assistant с «нет-первого-байта» таймаутом + ОДНИМ авто-ретраем.
      // Наблюдаемый баг: запрос повис БЕЗ ответа И БЕЗ fail-строки («молчит 15 секунд»). Если ПЕРВЫЙ байт не
      // пришёл за 8с → abort, voice:timeout stage=assistant, повтор того же вопроса; 2-й таймаут → внятная
      // ошибка (не молчим). Ретрай идемпотентен: без первого байта ни одна фраза не озвучена и история не
      // тронута — задваивания сообщений/озвучки нет.
      for (let attempt = 1; attempt <= VOICE_MAX_ATTEMPTS; attempt++) {
        let speechBuffer = ''
        let speechTailFlushed = false
        const assistantAbort = new AbortController()
        assistantAbortRef.current = assistantAbort
        let firstByteSeen = false
        let watchdogTimedOut = false
        let watchdog: number | null = window.setTimeout(() => {
          if (!firstByteSeen) { watchdogTimedOut = true; try { assistantAbort.abort() } catch { /* ignore */ } }
        }, VOICE_FIRST_BYTE_TIMEOUT_MS)
        const clearAssistantWatchdog = () => { if (watchdog !== null) { window.clearTimeout(watchdog); watchdog = null } }
        try {
          const { data: { session } } = await supabase.auth.getSession()
          const token = session?.access_token
          if (!token) throw new Error('no_session')
          if (attempt === 1) {
            // VOICE-CLIENT-DEBUG-1: конец речи → отправка запроса (только голосовой ход, где speechEnd задан).
            const speechEndAt = voiceSpeechEndAtRef.current
            if (speechEndAt !== null) logVoice('timing', `speechEnd2req=${Date.now() - speechEndAt}ms`)
          }
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
            clearAssistantWatchdog()
            streamFailed = true // не-2xx (в т.ч. no_key) или нет тела → фолбэк на POST
            break
          }
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          let acc = ''
          let errored = false
          let stop = false
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
            // VOICE-TIMEOUT-RETRY-8: пришёл ПЕРВЫЙ байт — снимаем «нет-первого-байта» таймаут.
            if (!firstByteSeen) { firstByteSeen = true; clearAssistantWatchdog() }
            buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
            drainCompleteSseBlocks()
          }
          clearAssistantWatchdog()
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
          break // попытка дала окончательный исход (ответ / streamFailed → POST)
        } catch (err) {
          clearAssistantWatchdog()
          if (watchdogTimedOut && turnId === assistantTurnRef.current) {
            logVoice('timeout', 'stage=assistant')
            if (attempt < VOICE_MAX_ATTEMPTS) continue // ОДИН авто-ретрай того же вопроса
            assistantTimedOut = true
            break
          }
          const name = (err as { name?: string } | null)?.name
          if (name === 'AbortError' || turnId !== assistantTurnRef.current) {
            userAborted = true
            break
          }
          streamFailed = true
          break
        } finally {
          if (assistantAbortRef.current === assistantAbort) assistantAbortRef.current = null
        }
      }

      if (userAborted) {
        if (mountedRef.current && turnId === assistantTurnRef.current) {
          streamingRef.current = false
          thinkingRef.current = false
          setThinking(false); setStreaming(false); setStreamText('')
        }
        return { kind: 'error' }
      }

      // ФОЛБЭК: поток недоступен/упал до первых слов → обычный POST (текущий путь). UX цел.
      if (turnId !== assistantTurnRef.current) return { kind: 'error' }

      if (assistantTimedOut) {
        // VOICE-TIMEOUT-RETRY-8: обе попытки без первого байта → не молчим: внятная голос/текст ошибка.
        streamingRef.current = false
        thinkingRef.current = false
        if (mountedRef.current) { setThinking(false); setStreaming(false); setStreamText('') }
        flashToast(t('ai_voice_retry'))
        enqueueTtsText(t('ai_voice_retry'))
        return { kind: 'error' }
      }
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
    [cancelActiveAssistant, enqueueTtsSegments, enqueueTtsText, flashToast, sendViaPost, setVoiceStatusLive, t],
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
    // ASSISTANT-PAGE-3 (п.4): запоминаем последний распознанный текст ЛОКАЛЬНО для блока «Диагностика».
    const heard = text.trim()
    if (heard) setVoiceHeard(heard)
    const snapshot = assistantSpeechGateSnapshot()
    if (snapshot.thinking || snapshot.streaming || hasPendingAssistantSpeech(snapshot)) return
    if (await handleVoiceProposalIntent(text)) return
    if (!thinkingRef.current) await sendQuestion(text)
  }, [assistantSpeechGateSnapshot, handleVoiceProposalIntent, sendQuestion])

  // ORB-SIMPLE-2: Ctrl+K / Cmd+K ведёт на страницу ассистента /ask (прежний попап-оверлей удалён).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        navigate('/ask')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // ORB-SIMPLE-2: движок смонтирован постоянно (owner-only) — грузим историю/предложения/справочники
  // ОДИН раз при монтировании, чтобы и орб-рация, и страница /ask сразу видели диалог. Дальше историю
  // рефетчит sendQuestion/reload после каждого хода.
  useEffect(() => {
    setLoading(true)
    void load().finally(() => setLoading(false))
  }, [load])

  // ORB-SIMPLE-2: конец голосового сеанса рации (open→false) — гасим всё активное (SSE, TTS-fetch,
  // Audio, очередь). Настройки озвучки/голосовой активации НЕ трогаем (независимы от сеанса).
  useEffect(() => {
    if (open) { ttsPrimedRef.current = false; return }
    cancelActiveAssistant()
  }, [open, cancelActiveAssistant])

  // Историю вслух не читаем: речь идёт только из текущего SSE/POST turn, где текст сегментируется.
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return
    lastSpokenIdRef.current = last.id
    ttsPrimedRef.current = true
  }, [messages])

  // AI-VOICE-FIX-1 (1): микрофон запрашиваем ЯВНО при включении тумблера голоса — браузер сразу
  // показывает промпт разрешения. Отказ → статус «микрофон запрещён ❌». Выключение → освобождаем поток.
  // ORB-SIMPLE-2: микрофон нужен либо для фоновой голосовой активации (wakeOn), либо для активного
  // сеанса рации (open, открыт кликом орба). Иначе освобождаем поток и гасим статус.
  useEffect(() => {
    const wantMic = (wakeOn || open) && !!SpeechRecognitionImpl
    if (!wantMic) {
      releaseMic()
      if (!open) setVoiceStatusLive('off')
      return
    }
    let cancelled = false
    void (async () => {
      const ok = await ensureMic()
      if (cancelled) return
      if (!ok) setVoiceStatusLive('denied')
    })()
    return () => { cancelled = true }
  }, [wakeOn, open, ensureMic, releaseMic, setVoiceStatusLive])

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
    // ORB-SIMPLE-2: разговорный цикл питается активным СЕАНСОМ рации (open), а не тумблером wakeOn —
    // клик орба открывает сеанс и мы сразу слушаем вопрос, даже если голосовая активация выключена.
    if (!SpeechRecognitionImpl || !open) { convoActiveRef.current = false; return }
    let active = true
    convoActiveRef.current = true
    let rec: SpeechRecInstance | null = null
    // VOICE-DROPPED-FINAL-47: свежий сеанс — чистим придержанный финал/анти-дубль/страховку (дубль ловим
    // только внутри одного сеанса; между сеансами повтор фразы законен).
    pendingFinalRef.current = null
    lastSentVoiceRef.current = null
    if (finalRescueTimerRef.current !== null) { window.clearTimeout(finalRescueTimerRef.current); finalRescueTimerRef.current = null }

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
      // ORB-SIMPLE-2: ход рации завершён — закрываем СЕАНС (open→false). Настройку голосовой активации
      // не трогаем: если wakeOn включён, возвращаемся к фоновому ожиданию «окей, Клок».
      openRef.current = false
      setOpen(false)
      setVoiceStatusLive(wakeOnRef.current ? 'wake' : 'off')
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
      // VOICE-TIMEOUT-RETRY-8: новый заход прослушивания — сбрасываем штампы лага STT (акустический конец
      // речи и момент первого финала распознавания), чтобы замер sttFinal2speechEnd был по этой фразе.
      micLastVoiceAtRef.current = null
      sttFinalAtRef.current = null
      const r = new SpeechRecognitionImpl!()
      r.lang = SPEECH_LOCALE[lang]
      r.continuous = true
      r.interimResults = true
      r.maxAlternatives = 1
      let finalText = ''
      const resetSilence = (finalReady: boolean) => {
        clearSilence()
        const wait = finalReady ? STT_SILENCE_AFTER_FINAL_MS : STT_SILENCE_AFTER_INTERIM_MS
        silenceTimerRef.current = window.setTimeout(() => { silenceTimerRef.current = null; finalize(finalText) }, wait)
      }
      r.onresult = (e) => {
        if (!shouldAcceptAssistantVoiceResult(assistantSpeechGateSnapshot())) {
          // VOICE-DROPPED-FINAL-47: гейт закрылся ПОСРЕДИ захвата. Раньше здесь безусловно стоял
          // `finalText=''` — уже накопленный непустой финал ТИХО пропадал. Теперь: если финал есть —
          // финализируем его (finalize → resolveVoiceFinal придержит hold и дошлёт, когда гейт откроется),
          // а не выбрасываем. Пустой буфер во время речи ассистента — эхо/чужой звук, просто игнорируем.
          if (finalText.trim()) { finalize(finalText); return }
          finalText = ''
          clearSilence()
          return
        }
        let interim = ''
        let gotFinal = false
        for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
          const res = e.results[i]
          const transcript = res?.[0]?.transcript ?? ''
          if (res?.isFinal) {
            finalText += transcript; gotFinal = true
            // VOICE-TIMEOUT-RETRY-8: момент ПЕРВОГО финала распознавания (для лага sttFinal2speechEnd).
            if (sttFinalAtRef.current === null) sttFinalAtRef.current = Date.now()
          }
          else interim += transcript
        }
        const combined = (finalText + interim).trim()
        setInput(combined)
        // после финала — короткое окно (шлём почти сразу); на голом интериме — накопление фразы
        if (combined) resetSilence(gotFinal)
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

    // VOICE-DROPPED-FINAL-47: снимок конвейера для чистого решения send/hold/drop по финалу STT.
    const voicePipelineSnapshot = () => {
      const snap = assistantSpeechGateSnapshot()
      return {
        active,
        thinking: Boolean(snap.thinking),
        streaming: Boolean(snap.streaming),
        speechPending: hasPendingAssistantSpeech(snap),
      }
    }

    const clearFinalRescue = () => {
      if (finalRescueTimerRef.current !== null) {
        window.clearTimeout(finalRescueTimerRef.current)
        finalRescueTimerRef.current = null
      }
    }

    // VOICE-DROPPED-FINAL-47: ЕДИНСТВЕННЫЙ путь финала STT в runTurn. Чистит придержанный финал и rescue-
    // таймер (без утечек/двойных отправок), запоминает отправленный текст (анти-дубль последнего финала).
    const dispatchVoiceFinal = (q: string) => {
      clearFinalRescue()
      pendingFinalRef.current = null
      lastSentVoiceRef.current = q
      void runTurn(q)
    }

    // VOICE-DROPPED-FINAL-47: гейт открылся (озвучка/ход предыдущего отзвучали) — досылаем придержанный финал.
    // Ставится в ttsOnIdleRef при hold; дёргается из cancelTtsQueue/finishTtsQueue, когда очередь TTS пуста.
    const flushPendingFinalOnIdle = () => {
      if (!active) return
      const q = pendingFinalRef.current
      if (!q) return
      dispatchVoiceFinal(q)
    }

    // VOICE-DROPPED-FINAL-47: страховка от тихой потери. Если через VOICE_FINAL_RESCUE_MS придержанный финал
    // так и не ушёл (гейт залип, ttsOnIdle не дёрнулся, thinking/streaming затянулись) — шлём принудительно и
    // логируем final-rescue с причиной-стейтом (какой флаг держал). На каждый sttFinal остаётся след.
    const armFinalRescue = () => {
      clearFinalRescue()
      finalRescueTimerRef.current = window.setTimeout(() => {
        finalRescueTimerRef.current = null
        if (!active) return
        const q = pendingFinalRef.current
        if (!q) return // финал уже ушёл или осознанно отброшен — страховка не нужна
        const snap = assistantSpeechGateSnapshot()
        logVoice('final-rescue', formatVoiceGateCause({
          active,
          thinking: Boolean(snap.thinking),
          streaming: Boolean(snap.streaming),
          speechPending: hasPendingAssistantSpeech(snap),
          canAccept: shouldAcceptAssistantVoiceResult(snap),
        }))
        dispatchVoiceFinal(q)
      }, VOICE_FINAL_RESCUE_MS)
    }

    // VOICE-DROPPED-FINAL-47: инвариант «один непустой финал → один осознанный исход». Решение — в чистом
    // ядре decideVoiceFinalOutcome (aiVoice.ts). Гейт открыт → send; закрыт → HOLD (придержим + оба триггера
    // досылки: ttsOnIdle и rescue), а не тихий дроп; пусто/дубль → drop (дубль логируем, пустой — просто
    // слушаем дальше без шума в телеметрии).
    const resolveVoiceFinal = (text: string) => {
      const decision = decideVoiceFinalOutcome({
        finalText: text,
        lastSentText: lastSentVoiceRef.current,
        snapshot: voicePipelineSnapshot(),
      })
      if (decision.action === 'drop') {
        clearFinalRescue()
        pendingFinalRef.current = null
        if (decision.reason !== 'empty') logVoice('drop', `reason=${decision.reason}`)
        listen() // цикл не рвём — продолжаем слушать
        return
      }
      const q = text.trim()
      voiceSpeechEndAtRef.current = Date.now() // VOICE-CLIENT-DEBUG-1: конец захвата речи (для speechEnd2req)
      if (decision.action === 'send') {
        dispatchVoiceFinal(q)
        return
      }
      // hold: гейт закрыт — придерживаем финал и вооружаем ОБА триггера досылки (ttsOnIdle + rescue).
      pendingFinalRef.current = q
      const snap = assistantSpeechGateSnapshot()
      logVoice('hold', formatVoiceGateCause({
        active,
        thinking: Boolean(snap.thinking),
        streaming: Boolean(snap.streaming),
        speechPending: hasPendingAssistantSpeech(snap),
        canAccept: false,
      }))
      ttsOnIdleRef.current = flushPendingFinalOnIdle
      armFinalRescue()
    }

    const finalize = (text: string) => {
      if (!active) return
      stopRec()
      // VOICE-TIMEOUT-RETRY-8: лаг Web Speech при КАЖДОМ финале — от акустического конца речи (мик-уровень)
      // до финала распознавания. Докажет/опровергнет, что Web Speech тянет секунды (обоснование Deepgram).
      const sttLag = sttFinalLagMs(micLastVoiceAtRef.current, sttFinalAtRef.current)
      if (sttLag !== null) logVoice('timing', `sttFinal2speechEnd=${sttLag}ms`)
      resolveVoiceFinal(text)
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

    // VOICE-FRONT-STREAM: точка входа barge-in — VAD услышал речь во время загрузки/озвучки ответа,
    // ответ уже оборван (cancelActiveAssistant), сразу возвращаемся к прослушиванию НОВОГО вопроса.
    bargeInListenRef.current = () => { if (active) listen() }

    void (async () => {
      const ok = await ensureMic()
      if (!active) return
      if (!ok) { setVoiceStatusLive('denied'); return }
      listen()
    })()

    return () => {
      active = false
      convoActiveRef.current = false
      bargeInListenRef.current = null
      // VOICE-DROPPED-FINAL-47: снимаем страховочный таймер и придержанный финал (нет утечек/зомби-отправок).
      pendingFinalRef.current = null
      if (finalRescueTimerRef.current !== null) { window.clearTimeout(finalRescueTimerRef.current); finalRescueTimerRef.current = null }
      stopRec()
    }
  }, [
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

  // VOICE-FRONT-STREAM: свежий barge-in-обработчик в рефе (MicVAD создаётся один раз и дёргает его
  // через ref, поэтому пересоздавать VAD при ребилде замыканий не нужно). Глушим ответ ТОЛЬКО если
  // сейчас реально идёт загрузка/озвучка — иначе игнор (ложное срабатывание VAD вне окна).
  useEffect(() => {
    bargeInHandlerRef.current = () => {
      if (!wakeOnRef.current || !openRef.current || !speakOnRef.current) return
      const snap = assistantSpeechGateSnapshot()
      if (!snap.thinking && !snap.streaming && !hasPendingAssistantSpeech(snap)) return
      cancelActiveAssistant()      // мгновенно обрываем SSE-«мозг» + PCM-«рот»
      bargeInListenRef.current?.() // и тут же слушаем новую фразу
    }
  })

  // VOICE-FRONT-STREAM: вооружаем VAD-barge-in ТОЛЬКО в окне загрузки/озвучки ответа. Silero тянется
  // лениво при первом вооружении; вне окна — pause() (микрофон VAD не держим). Нет VAD (сбой/старый
  // браузер) → просто без barge-in.
  const bargeArmed = !!SpeechRecognitionImpl && speakOn && shouldArmBargeIn({ wakeOn, open, thinking, streaming, ttsBusy })
  useEffect(() => {
    if (!bargeArmed) { vadRef.current?.pause(); return }
    let cancelled = false
    void (async () => {
      if (!vadRef.current && !vadLoadingRef.current) {
        vadLoadingRef.current = true
        const vad = await loadBargeInVad({ onSpeechStart: () => bargeInHandlerRef.current?.() })
        vadLoadingRef.current = false
        vadRef.current = vad
      }
      if (cancelled) { vadRef.current?.pause(); return }
      vadRef.current?.start()
    })()
    return () => { cancelled = true; vadRef.current?.pause() }
  }, [bargeArmed])

  // PTT gate: while the assistant is thinking or speaking, no extra recognition is started.

  // AI-VOICE-FIX-1: подчистка на unmount — освобождаем микрофон/метр и гасим озвучку (нет утечек).
  useEffect(() => () => {
    releaseMic()
    cancelTtsQueue()
    try { assistantAbortRef.current?.abort() } catch { /* ignore */ }
    try { void ttsAudioCtxRef.current?.close() } catch { /* ignore */ }
    try { vadRef.current?.destroy() } catch { /* ignore */ }
    vadRef.current = null
  }, [cancelTtsQueue, releaseMic])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (thinking) return
    void unlockTtsAudio()
    voiceSpeechEndAtRef.current = null // VOICE-CLIENT-DEBUG-1: ручная отправка — таймингов «конца речи» нет
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

  const wakeSupported = !!SpeechRecognitionImpl

  // AI-UX-1: состояние «сущности»-орба. Отражает то, ЧТО делает ассистент — и зеркалит меня в «слушаю»
  // (орб пульсирует в ритм моего голоса, micLevel из AI-VOICE-FIX-1). idle — покой (медленный пульс);
  // listening — слушаю; thinking — думаю (идёт стрим/ответ); speaking — говорю (волны).
  const micDenied = (wakeOn || open) && wakeSupported && voiceStatus === 'denied'
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

  // Короткая строка-статус у орба (рация без панели): показываем, пока идёт сеанс (open) ИЛИ включена
  // фоновая голосовая активация (wakeOn). Никакой панели — только строка рядом с орбом.
  const badgeView: { label: string } | null =
    (!wakeOn && !open) || !wakeSupported
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

  // ORB-SIMPLE-2: орб = кнопка рации. Клик по покоящемуся орбу СРАЗУ открывает голосовой сеанс (жест
  // разблокирует автоплей TTS): разговорный цикл начинает слушать → пауза шлёт вопрос → звучит ответ.
  // Никаких панелей/оверлеев. Повторный клик во время сеанса — стоп. Настройку голосовой активации
  // (wakeOn) клик НЕ трогает — это независимый выбор со страницы /ask.
  const handleOrbToggle = useCallback(() => {
    const next = getNextAiOrbToggleState({ open, wakeOn, speakOn, thinking, streaming, ttsBusy, voiceStatus })
    if (next.intent === 'activate') {
      void unlockTtsAudio().then(() => playTtsQueue())
      speakOnRef.current = true
      openRef.current = true
      setSpeakOn(true)
      setOpen(true)
      return
    }

    openRef.current = false
    setOpen(false)
    cancelActiveAssistant()
    // Держим микрофон только если оставлена фоновая голосовая активация; иначе освобождаем и гасим.
    if (!wakeOnRef.current) { releaseMic(); setVoiceStatusLive('off') }
    else setVoiceStatusLive('wake')
  }, [cancelActiveAssistant, open, playTtsQueue, releaseMic, setVoiceStatusLive, speakOn, streaming, thinking, ttsBusy, unlockTtsAudio, voiceStatus, wakeOn])

  // ASSISTANT-PAGE-3 (п.2): орб ПЕРЕТАСКИВАЕМЫЙ по всему окну, позиция запоминается. Орб уже ГЛОБАЛЬНЫЙ —
  // провайдер смонтирован owner-only в App.tsx и оборачивает всю оболочку, поэтому кнопка видна на всех
  // экранах; отдельно ничего не монтируем. Тащим по pointermove, кламп во вьюпорт (чтобы не улетала за
  // край), позиция в localStorage (ai_orb_pos = {x,y} — left/top). Клик-тумблер не ломаем: сдвиг ≥
  // ORB_DRAG_THRESHOLD_PX = drag (последующий click гасим), меньше — обычный клик → handleOrbToggle.
  const orbRef = useRef<HTMLButtonElement | null>(null)
  const [orbPos, setOrbPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem('ai_orb_pos')
      if (!raw) return null
      const p = JSON.parse(raw) as { x?: unknown; y?: unknown }
      if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y }
    } catch { /* ignore */ }
    return null
  })
  const orbPosRef = useRef<{ x: number; y: number } | null>(orbPos)
  const orbDragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, origX: 0, origY: 0, w: 0, h: 0, pointerId: -1 })
  const orbSuppressClickRef = useRef(false)

  const clampOrbPos = useCallback((x: number, y: number, w: number, h: number) => {
    const maxX = Math.max(0, window.innerWidth - w)
    const maxY = Math.max(0, window.innerHeight - h)
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) }
  }, [])

  const applyOrbPos = useCallback((pos: { x: number; y: number } | null) => {
    orbPosRef.current = pos
    setOrbPos(pos)
  }, [])

  const onOrbPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = orbRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const d = orbDragRef.current
    d.active = true; d.moved = false
    d.startX = e.clientX; d.startY = e.clientY
    d.origX = rect.left; d.origY = rect.top
    d.w = rect.width; d.h = rect.height
    d.pointerId = e.pointerId
    try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }, [])

  const onOrbPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = orbDragRef.current
    if (!d.active) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) >= ORB_DRAG_THRESHOLD_PX) d.moved = true
    if (!d.moved) return
    applyOrbPos(clampOrbPos(d.origX + dx, d.origY + dy, d.w, d.h))
  }, [applyOrbPos, clampOrbPos])

  const endOrbDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = orbDragRef.current
    if (!d.active) return
    d.active = false
    try { orbRef.current?.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    if (d.moved) {
      orbSuppressClickRef.current = true
      const pos = orbPosRef.current
      if (pos) { try { localStorage.setItem('ai_orb_pos', JSON.stringify(pos)) } catch { /* ignore */ } }
    }
  }, [])

  const onOrbClick = useCallback(() => {
    // Гасим клик, синтезированный сразу после перетаскивания; иначе — обычный тумблер рации.
    if (orbSuppressClickRef.current) { orbSuppressClickRef.current = false; return }
    handleOrbToggle()
  }, [handleOrbToggle])

  // Кламп сохранённой позиции при ресайзе окна, чтобы орб не оставался за краем после смены размера.
  useEffect(() => {
    const onResize = () => {
      const el = orbRef.current
      const prev = orbPosRef.current
      if (!el || !prev) return
      const rect = el.getBoundingClientRect()
      applyOrbPos(clampOrbPos(prev.x, prev.y, rect.width, rect.height))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [applyOrbPos, clampOrbPos])

  // ORB-SIMPLE-2: настройки со страницы /ask (те же localStorage-ключи ai_speak / ai_wake). Озвучка:
  // включение разблокирует автоплей и доигрывает очередь, выключение — обрывает. Голосовая активация:
  // включение разблокирует автоплей (чтобы ответ после wake-фразы звучал); эффекты выше поднимут mic.
  const setSpeakEnabled = useCallback((checked: boolean) => {
    speakOnRef.current = checked
    setSpeakOn(checked)
    if (checked) void unlockTtsAudio().then(() => playTtsQueue())
    else cancelTtsQueue()
  }, [cancelTtsQueue, playTtsQueue, unlockTtsAudio])

  const setWakeEnabled = useCallback((checked: boolean) => {
    wakeOnRef.current = checked
    setWakeOn(checked)
    if (checked) void unlockTtsAudio()
  }, [unlockTtsAudio])

  const assistant: AiAssistantContextValue = {
    messages,
    proposals,
    proposalIssues,
    loading,
    thinking,
    streaming,
    streamText,
    noKey,
    busyId,
    input,
    setInput,
    submit,
    handleVoiceInput,
    executeProposal,
    rejectProposal,
    dismissInfoProposal,
    proposalSummary,
    proposalIssueTitle,
    speakOn,
    wakeOn,
    speakSupported: AUDIO_TTS_SUPPORTED,
    wakeSupported,
    setSpeakEnabled,
    setWakeEnabled,
    orbState,
    orbLabel,
    voiceStatus,
    micLevel,
    ttsLevel,
    micDenied,
    lang,
    voiceDiag,
    voiceHeard,
  }

  return (
    <AiAssistantContext.Provider value={assistant}>
      {children}

      {/* ORB-SIMPLE-2: угловой ОРБ-РАЦИЯ. Всегда виден (провайдер смонтирован owner-only). Клик =
          СРАЗУ слушать → пауза шлёт вопрос → звучит голосовой ответ. НИКАКИХ панелей/оверлеев/чекбоксов
          при клике — только орб + короткая строка-статус. Все настройки чата — на странице /ask. */}
      <button
        ref={orbRef}
        type="button"
        className={`ai-orb-launcher ai-voice-${voiceStatus}${launcherPulsing ? ' ai-orb-launcher-pulse' : ''}${orbToggleActive ? ' ai-orb-launcher-active' : ''}`}
        style={orbPos ? { left: orbPos.x, top: orbPos.y, right: 'auto', bottom: 'auto' } : undefined}
        onPointerDown={onOrbPointerDown}
        onPointerMove={onOrbPointerMove}
        onPointerUp={endOrbDrag}
        onPointerCancel={endOrbDrag}
        onClick={onOrbClick}
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

      {toast && (
        <div className="travel-toast ai-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </AiAssistantContext.Provider>
  )
}
