export type SpeechLang = 'ru' | 'en' | 'es'

export type AiOrbToggleIntent = 'activate' | 'deactivate'

export type AiOrbToggleSnapshot = {
  open: boolean
  wakeOn: boolean
  speakOn: boolean
  thinking?: boolean
  streaming?: boolean
  ttsBusy?: boolean
  voiceStatus?: string
}

export type AiOrbToggleNextState = {
  intent: AiOrbToggleIntent
  open: boolean
  wakeOn: boolean
  speakOn: boolean
}

// ORB-SIMPLE-2: голосовые состояния ЖИВОГО сеанса рации (НЕ фоновое ожидание wake-фразы). Именно
// они делают клик по орбу «стоп». Фоновая голосовая активация (wake) сюда НЕ входит: при включённом
// wake клик по орбу должен НАЧАТЬ разговор, а не глушить фон.
const SESSION_ORB_VOICE_STATES = new Set(['listening', 'thinking', 'speaking'])

export function isAiInfoProposalAction(actionType: string): boolean {
  return actionType === 'report_bug'
}

// ORB-SIMPLE-2: орб = кнопка рации. Клик ВЫКЛЮЧАЕТ, только если сейчас идёт живой сеанс (сессия
// открыта / ассистент думает / стримит / озвучивает / слушает). Иначе клик ВКЛЮЧАЕТ сеанс — даже
// если включена фоновая голосовая активация (wakeOn сам по себе «стоп» не делает).
export function getAiOrbToggleIntent(state: AiOrbToggleSnapshot): AiOrbToggleIntent {
  const sessionVoice = state.voiceStatus ? SESSION_ORB_VOICE_STATES.has(state.voiceStatus) : false
  return state.open || state.thinking || state.streaming || state.ttsBusy || sessionVoice
    ? 'deactivate'
    : 'activate'
}

// ORB-SIMPLE-2: настройки (озвучка / голосовая активация) НЕЗАВИСИМЫ от сеанса рации. Активация лишь
// открывает сеанс и гарантирует speakOn (жест клика разблокирует автоплей TTS), НЕ трогая wakeOn —
// пользовательский выбор голосовой активации сохраняется. Деактивация только закрывает сеанс.
export function getNextAiOrbToggleState(state: AiOrbToggleSnapshot): AiOrbToggleNextState {
  const intent = getAiOrbToggleIntent(state)
  if (intent === 'activate') return { intent, open: true, wakeOn: state.wakeOn, speakOn: true }
  return { intent, open: false, wakeOn: state.wakeOn, speakOn: state.speakOn }
}

export type AssistantVoiceGateSnapshot = {
  wakeOn: boolean
  open: boolean
  voiceStatus?: string
  thinking?: boolean
  streaming?: boolean
  ttsBusy?: boolean
  ttsQueueRunning?: boolean
  queuedTtsSegments?: number
}

export function hasPendingAssistantSpeech(state: Pick<
  AssistantVoiceGateSnapshot,
  'ttsBusy' | 'ttsQueueRunning' | 'queuedTtsSegments'
>): boolean {
  return Boolean(state.ttsBusy || state.ttsQueueRunning || (state.queuedTtsSegments ?? 0) > 0)
}

export function shouldAcceptWakePhraseResult(state: AssistantVoiceGateSnapshot): boolean {
  return Boolean(
    state.wakeOn &&
    !state.open &&
    state.voiceStatus === 'wake' &&
    !state.thinking &&
    !state.streaming &&
    !hasPendingAssistantSpeech(state),
  )
}

// ORB-SIMPLE-2: принимаем распознанную фразу вопроса, пока идёт активный сеанс рации (open) и мы
// именно СЛУШАЕМ. wakeOn больше НЕ требуется: сеанс можно открыть кликом орба без голосовой активации.
export function shouldAcceptAssistantVoiceResult(state: AssistantVoiceGateSnapshot): boolean {
  return Boolean(
    state.open &&
    state.voiceStatus === 'listening' &&
    !state.thinking &&
    !state.streaming &&
    !hasPendingAssistantSpeech(state),
  )
}

// VOICE-FRONT-STREAM: barge-in (перебивание) вооружаем ТОЛЬКО пока в голосовом режиме идёт загрузка
// (thinking/streaming) или озвучка (pending speech) ответа — вне этого окна VAD выключен, чтобы не
// хватать чужие голоса и не тратить ресурсы. Гейт микрофона (тумблер wake + открытая панель) — снаружи.
export function shouldArmBargeIn(state: AssistantVoiceGateSnapshot): boolean {
  if (!state.open) return false
  return Boolean(state.thinking || state.streaming || hasPendingAssistantSpeech(state))
}

// VOICE-CLIENT-DEBUG-1: единый формат строки телеметрии голосового клиента для таблицы client_errors.
// В схеме client_errors НЕТ колонок category/stage (миграция 0037 — только message/stack_hash/…),
// поэтому этап и деталь кодируем ПРЯМО в message: `voice:<stage>` (+ ` <detail>`). Чистая функция —
// покрыта юнит-тестом; сам insert живёт в clientErrors.ts (там supabase-клиент).
export function voiceEventMessage(stage: string, detail?: string): string {
  const base = `voice:${stage}`
  const trimmed = detail?.trim()
  return trimmed ? `${base} ${trimmed}` : base
}

// VOICE-TIMEOUT-RETRY-8: сколько ждём ПЕРВЫЙ байт ответа голосового конвейера (ai-assistant / ai-tts-stream)
// прежде чем счесть запрос «повисшим». Наблюдаемый баг: один запрос повис БЕЗ ответа И БЕЗ fail-строки
// («молчит 15 секунд»). При превышении — abort + ОДИН авто-ретрай; 8с заметно короче порога восприятия «завис».
export const VOICE_FIRST_BYTE_TIMEOUT_MS = 8_000

// VOICE-TIMEOUT-RETRY-8: попыток на голосовой запрос — исходная + ОДИН авто-ретрай (итого 2). Больше не
// пробуем: 2-й фейл → внятная голос/текст ошибка «не расслышал, повтори» (не молчим и не крутим впустую).
export const VOICE_MAX_ATTEMPTS = 2

// VOICE-TIMEOUT-RETRY-8: лаг Web Speech STT — от РЕАЛЬНОГО (акустического) конца речи (последний кадр
// мик-уровня выше порога) до финала распознавания (первый isFinal). Оба штампа снимаются снаружи (мик-метр
// и onresult); здесь — чистый расчёт: null, если хоть один штамп неизвестен; отрицательную разницу клампим
// в 0 (финал не может предшествовать концу речи). Докажет/опровергнет секундный лаг Web Speech (→ Deepgram).
export function sttFinalLagMs(speechEndAt: number | null, sttFinalAt: number | null): number | null {
  if (speechEndAt === null || sttFinalAt === null) return null
  return Math.max(0, sttFinalAt - speechEndAt)
}

// VOICE-DROPPED-FINAL-47: страховочный порог. Через столько мс после ПЕРВОГО финала STT, если по нему так
// и не ушёл запрос и не записан осознанный drop, конвейер обязан досослать его принудительно (final-rescue).
// 1.5с < порога восприятия «завис», но заметно больше типичного окна отзвучки предыдущего сегмента.
export const VOICE_FINAL_RESCUE_MS = 1_500

// VOICE-DROPPED-FINAL-47: снимок конвейера для чистого решения по финалу STT. active — жив ли разговорный
// цикл; thinking/streaming — идёт загрузка ответа; speechPending — озвучка предыдущего хода ещё звучит/в очереди.
export type VoicePipelineSnapshot = {
  active: boolean
  thinking: boolean
  streaming: boolean
  speechPending: boolean
}

// VOICE-DROPPED-FINAL-47: единственный исход финала STT. send — сразу в ai-assistant; hold — придержать и
// дослать, когда гейт откроется (озвучка/ход предыдущего отзвучали); drop — осознанно отбросить с причиной.
export type VoiceFinalDecision =
  | { action: 'send' }
  | { action: 'hold' }
  | { action: 'drop'; reason: 'empty' | 'dup' }

// VOICE-DROPPED-FINAL-47 (корень бага): раньше finalize при закрытом гейте делал `if (!canAccept) return` и
// ТИХО выбрасывал готовый непустой финал — sttFinal2speechEnd залогирован, а speechEnd2req/запроса нет
// («проглоченный первый финал»). Инвариант: КАЖДЫЙ непустой финал даёт РОВНО ОДИН исход. Чистое ядро (без
// DOM/сети) — покрыто юнит-тестами: пусто → drop('empty'); дубль последнего отправленного → drop('dup');
// гейт закрыт (thinking/streaming/speechPending) → hold (НЕ теряем); гейт открыт (idle/после barge-in) → send.
export function decideVoiceFinalOutcome(input: {
  finalText: string
  lastSentText: string | null
  snapshot: VoicePipelineSnapshot
}): VoiceFinalDecision {
  const text = input.finalText.trim()
  if (!text) return { action: 'drop', reason: 'empty' }
  const lastSent = input.lastSentText?.trim()
  if (lastSent && normalizeVoiceText(text) === normalizeVoiceText(lastSent)) {
    return { action: 'drop', reason: 'dup' }
  }
  const { snapshot } = input
  if (snapshot.thinking || snapshot.streaming || snapshot.speechPending) return { action: 'hold' }
  return { action: 'send' }
}

// VOICE-DROPPED-FINAL-47: причина-стейт для логов hold/final-rescue — все булевы флаги конвейера склеены в
// одну строку, чтобы в client_errors было видно, КАКОЙ флаг держал гейт закрытым (active/thinking/streaming/
// speechPending/canAccept). Логи-маркеры НЕ переводим (внутренняя телеметрия).
export function formatVoiceGateCause(state: {
  active: boolean
  thinking: boolean
  streaming: boolean
  speechPending: boolean
  canAccept: boolean
}): string {
  return `active=${state.active} thinking=${state.thinking} streaming=${state.streaming} ` +
    `speechPending=${state.speechPending} canAccept=${state.canAccept}`
}

export function isTtsPlaybackBlockedError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  const message = (err as { message?: string } | null)?.message?.toLowerCase() ?? ''
  return name === 'NotAllowedError' || message.includes('user gesture') || message.includes('play()')
}

const SENTENCE_END_RE = /[.!?]+|[。！？]+|…+/g
const LONG_SEGMENT_LIMIT = 220

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function stripMarkdownForSpeech(text: string): string {
  return normalizeSpaces(
    text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*\*/g, '')
      .replace(/`{1,3}/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}#{1,6}\s*$/gm, ''),
  )
}

export function normalizeVoiceText(text: string): string {
  return normalizeSpaces(
    text
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}\s]/gu, ' '),
  )
}

export function splitCompletedSpeechSegments(
  buffer: string,
  options: { force?: boolean; maxSegmentLength?: number } = {},
): { segments: string[]; rest: string } {
  const maxSegmentLength = options.maxSegmentLength ?? LONG_SEGMENT_LIMIT
  const segments: string[] = []
  let rest = buffer

  while (rest.length > 0) {
    SENTENCE_END_RE.lastIndex = 0
    const match = SENTENCE_END_RE.exec(rest)
    if (match) {
      const end = match.index + match[0].length
      const sentence = stripMarkdownForSpeech(rest.slice(0, end))
      if (sentence) segments.push(sentence)
      rest = rest.slice(end).trimStart()
      continue
    }

    if (rest.length >= maxSegmentLength) {
      const slice = rest.slice(0, maxSegmentLength)
      const cut = Math.max(slice.lastIndexOf(','), slice.lastIndexOf(';'), slice.lastIndexOf(' '))
      if (cut > 80) {
        const chunk = stripMarkdownForSpeech(rest.slice(0, cut + 1))
        if (chunk) segments.push(chunk)
        rest = rest.slice(cut + 1).trimStart()
        continue
      }
    }
    break
  }

  if (options.force && rest.trim()) {
    const finalSegment = stripMarkdownForSpeech(rest)
    if (finalSegment) segments.push(finalSegment)
    rest = ''
  }

  return { segments, rest }
}

const STOP_COMMANDS = [
  'stop',
  'quiet',
  'be quiet',
  'shut up',
  'cancel',
  'стоп',
  'остановись',
  'останови',
  'замолчи',
  'тихо',
  'молчи',
  'хватит',
  'перестань',
  'прекрати',
]

const AFFIRM_COMMANDS = [
  'yes',
  'yep',
  'yeah',
  'correct',
  'confirm',
  'approve',
  'execute',
  'run',
  'run it',
  'do it',
  'go ahead',
  'send',
  'send it',
  'proceed',
  'apply',
  'ok',
  'okay',
  'да',
  'ага',
  'верно',
  'правильно',
  'подтверждаю',
  'подтвердить',
  'выполнить',
  'выполни',
  'запускай',
  'сделай',
  'отправь',
  'разошли',
  'можно',
  'ок',
  'окей',
]

const CANCEL_COMMANDS = [
  'no',
  'nope',
  'cancel',
  'reject',
  'decline',
  'do not',
  'don t',
  'dont',
  'не надо',
  'нет',
  'отмена',
  'отмени',
  'отменить',
  'отклонить',
  'отклоняю',
  'не выполняй',
  'не отправляй',
]

function containsVoiceCommand(normalized: string, cmd: string): boolean {
  return normalized === cmd ||
    normalized.includes(` ${cmd} `) ||
    normalized.startsWith(`${cmd} `) ||
    normalized.endsWith(` ${cmd}`)
}

export function isVoiceStopCommand(text: string): boolean {
  const normalized = normalizeVoiceText(text)
  if (!normalized) return false
  return STOP_COMMANDS.some((cmd) => containsVoiceCommand(normalized, cmd))
}

export function isVoiceAffirm(text: string): boolean {
  const normalized = normalizeVoiceText(text)
  if (!normalized) return false
  if (isVoiceCancel(text)) return false
  return AFFIRM_COMMANDS.some((cmd) => containsVoiceCommand(normalized, cmd))
}

export function isVoiceCancel(text: string): boolean {
  const normalized = normalizeVoiceText(text)
  if (!normalized) return false
  return CANCEL_COMMANDS.some((cmd) => containsVoiceCommand(normalized, cmd))
}

export function looksLikeTtsEcho(transcript: string, spokenText: string): boolean {
  const heard = normalizeVoiceText(transcript)
  const spoken = normalizeVoiceText(spokenText)
  if (!heard || !spoken) return false
  if (heard.length < 12) return false
  return spoken.includes(heard) || heard.includes(spoken.slice(0, Math.min(spoken.length, heard.length)))
}
