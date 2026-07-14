import { useEffect, useRef, useState } from 'react'

// Голосовой ввод (Web Speech API). Мягкая деградация: если браузер не поддерживает —
// кнопка не рендерится. Извлечено из MaterialsTab, чтобы переиспользовать в конструкторе
// плана (командный центр). Язык распознавания = язык интерфейса (ru/en/es).
type SpeechCtor = new () => {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

const SpeechRecognitionImpl: SpeechCtor | undefined =
  typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: SpeechCtor }).webkitSpeechRecognition)
    : undefined

const speechLocale: Record<'ru' | 'en' | 'es', string> = { ru: 'ru-RU', en: 'en-US', es: 'es-ES' }

export default function VoiceMic({ lang, onResult, title }: { lang: 'ru' | 'en' | 'es'; onResult: (text: string) => void; title: string }) {
  const [listening, setListening] = useState(false)
  const recRef = useRef<InstanceType<SpeechCtor> | null>(null)

  useEffect(() => () => { try { recRef.current?.stop() } catch { /* ignore */ } }, [])

  if (!SpeechRecognitionImpl) return null

  const toggle = () => {
    if (listening) { try { recRef.current?.stop() } catch { /* ignore */ } ; return }
    const rec = new SpeechRecognitionImpl()
    rec.lang = speechLocale[lang]
    rec.interimResults = false
    rec.maxAlternatives = 1
    rec.onresult = (e) => {
      const text = e.results?.[0]?.[0]?.transcript
      if (text) onResult(String(text).trim())
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    setListening(true)
    try { rec.start() } catch { setListening(false) }
  }

  return (
    <button
      type="button"
      className={`voice-mic ${listening ? 'listening' : ''}`}
      title={title}
      aria-label={title}
      onClick={toggle}
    >
      {listening ? '●' : '🎤'}
    </button>
  )
}
