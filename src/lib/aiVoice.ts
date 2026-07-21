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

const ACTIVE_ORB_VOICE_STATES = new Set(['wake', 'listening', 'thinking', 'speaking'])

export function isAiInfoProposalAction(actionType: string): boolean {
  return actionType === 'report_bug'
}

export function getAiOrbToggleIntent(state: AiOrbToggleSnapshot): AiOrbToggleIntent {
  const activeVoice = state.voiceStatus ? ACTIVE_ORB_VOICE_STATES.has(state.voiceStatus) : false
  return state.wakeOn || state.thinking || state.streaming || state.ttsBusy || activeVoice
    ? 'deactivate'
    : 'activate'
}

export function getNextAiOrbToggleState(state: AiOrbToggleSnapshot): AiOrbToggleNextState {
  const intent = getAiOrbToggleIntent(state)
  if (intent === 'activate') return { intent, open: true, wakeOn: true, speakOn: true }
  return { intent, open: false, wakeOn: false, speakOn: state.speakOn }
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

export function shouldAcceptAssistantVoiceResult(state: AssistantVoiceGateSnapshot): boolean {
  return Boolean(
    state.wakeOn &&
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
  if (!state.wakeOn || !state.open) return false
  return Boolean(state.thinking || state.streaming || hasPendingAssistantSpeech(state))
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
