export type SpeechLang = 'ru' | 'en' | 'es'

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

export function isVoiceStopCommand(text: string): boolean {
  const normalized = normalizeVoiceText(text)
  if (!normalized) return false
  return STOP_COMMANDS.some((cmd) => normalized === cmd || normalized.includes(` ${cmd} `) || normalized.startsWith(`${cmd} `) || normalized.endsWith(` ${cmd}`))
}

export function looksLikeTtsEcho(transcript: string, spokenText: string): boolean {
  const heard = normalizeVoiceText(transcript)
  const spoken = normalizeVoiceText(spokenText)
  if (!heard || !spoken) return false
  if (heard.length < 12) return false
  return spoken.includes(heard) || heard.includes(spoken.slice(0, Math.min(spoken.length, heard.length)))
}
