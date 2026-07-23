// VOICE-DEEPGRAM-EARS-48: новые «уши» ассистента — источник STT на Deepgram nova-2 через прокси-реле
// (edge deepgram-stream, секретный ключ на сервере). Web Speech тянул секунды до финала
// (sttFinal2speechEnd≈1400мс) и глотал фразы — корень боли Андрея. Deepgram отдаёт финал за ~200-300мс.
//
// ЭТОТ МОДУЛЬ: чистое ядро разбора сообщений Deepgram + выбор источника/фолбэк (0 DOM/сети — покрыто
// юнит-тестами) + тонкий раннер (getUserMedia → MediaRecorder → WebSocket → реле). Раннер отдаёт финал
// в ТУ ЖЕ точку конвейера #47 (resolveVoiceFinal), поэтому инвариант «один speech_final → ровно один
// исход» (send|hold|drop) и rescue-таймер переиспользуются бесплатно (см. AiCommandBar.tsx / aiVoice.ts).

// --- Константы контракта реле (НЕ переизобретаем — просто используем; серверная часть готова). ---
// Раннер шлёт бинарные аудио-чанки в реле; реле проксирует их в Deepgram listen со своим ключом
// (model=nova-2, interim_results, smart_format, endpointing=300). Эти значения дублируются на сервере;
// здесь — для документации/тестов и построения URL клиента.
export const DEEPGRAM_MODEL = 'nova-2'
export const DEEPGRAM_ENDPOINTING_MS = 300
export const DEEPGRAM_DEFAULT_LANG = 'ru'
// Таймслайс MediaRecorder: чанк аудио каждые ~150мс → низкая латентность до финала без спама сети.
export const DEEPGRAM_TIMESLICE_MS = 150
// Opus в webm — базовый поддерживаемый в Chrome контейнер для потокового MediaRecorder.
export const DEEPGRAM_MIME = 'audio/webm;codecs=opus'
// Текстовый фрейм «конец речи» — по контракту реле шлём его на стоп, чтобы Deepgram корректно закрыл поток.
export const DEEPGRAM_CLOSE_FRAME = 'CloseStream'

export type SttSource = 'deepgram' | 'webspeech' | 'none'

// VOICE-DEEPGRAM-EARS-48: язык интерфейса → язык распознавания Deepgram (nova-2 знает ru/en/es).
// Дефолт ru (речь Андрея по-русски), для англ. — en. Неизвестное → дефолт ru (не роняем поток).
export function deepgramLangFor(lang: string | undefined | null): string {
  if (lang === 'en' || lang === 'es' || lang === 'ru') return lang
  return DEEPGRAM_DEFAULT_LANG
}

// VOICE-DEEPGRAM-EARS-48: URL WebSocket к реле. baseUrl — тот же https-URL supabase, откуда фронт зовёт
// прочие edge (ai-assistant / ai-tts-stream) — берём из src/lib/supabase (SUPABASE_URL), НЕ хардкодим проект.
// token = access_token текущей supabase-сессии (в браузер попадает JWT пользователя, НЕ ключ Deepgram).
export function buildDeepgramWsUrl(baseUrl: string, token: string, lang?: string): string {
  const wsBase = baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')
  const params = new URLSearchParams({ token, lang: deepgramLangFor(lang) })
  return `${wsBase}/functions/v1/deepgram-stream?${params.toString()}`
}

// VOICE-DEEPGRAM-EARS-48: разобранное сообщение Deepgram. interim — «сырой» промежуточный транскрипт;
// final — финализированный сегмент (is_final) внутри реплики; speechFinal — конец речи (speech_final,
// endpointing) → пора отдавать полную фразу в конвейер; ignore — Metadata/неизвестный type/пустой текст.
export type DeepgramParsed =
  | { kind: 'interim'; transcript: string }
  | { kind: 'final'; transcript: string }
  | { kind: 'speechFinal'; transcript: string }
  | { kind: 'ignore' }

// VOICE-DEEPGRAM-EARS-48 (чистое ядро — 0 сети/DOM, покрыто юнит-тестами). Вход — УЖЕ распарсенный JSON
// (объект). Формат Deepgram: { type:'Results', channel:{ alternatives:[{ transcript }] }, is_final, speech_final }.
// Незнакомые type ('Metadata'/'UtteranceEnd'/…) и пустой транскрипт → ignore (без краша). speech_final
// приоритетнее is_final. НЕ дёргает сеть/DOM — тонкий раннер вызывает её на каждое WS-сообщение.
export function parseDeepgramMessage(msg: unknown): DeepgramParsed {
  if (!msg || typeof msg !== 'object') return { kind: 'ignore' }
  const m = msg as { type?: unknown; is_final?: unknown; speech_final?: unknown; channel?: unknown }
  if (m.type !== 'Results') return { kind: 'ignore' }
  const channel = m.channel as { alternatives?: Array<{ transcript?: unknown }> } | undefined
  const raw = channel?.alternatives?.[0]?.transcript
  const transcript = typeof raw === 'string' ? raw : ''
  if (!transcript.trim()) return { kind: 'ignore' } // пустой (тишина/echo cancel) — игнор без шума
  if (m.speech_final === true) return { kind: 'speechFinal', transcript }
  if (m.is_final === true) return { kind: 'final', transcript }
  return { kind: 'interim', transcript }
}

// VOICE-DEEPGRAM-EARS-48: склейка транскриптов Deepgram в один пробел (без ведущего/двойного пробела).
function joinTranscript(base: string, next: string): string {
  const a = base.trim()
  const b = next.trim()
  if (!a) return b
  if (!b) return a
  return `${a} ${b}`
}

// VOICE-DEEPGRAM-EARS-48: чистый аккумулятор транскриптов (0 сети/DOM — покрыт юнит-тестами). Копит
// финализированные сегменты (is_final) до speech_final; на speech_final отдаёт ПОЛНУЮ фразу и сбрасывается.
// Гарантия лог-гейта: поток interim→is_final→speech_final даёт РОВНО один speechFinal с полным транскриптом.
export type DeepgramAccumulatorStep = { speechFinal?: string; interim?: string }
export function createDeepgramAccumulator() {
  let finalBuffer = ''
  return {
    push(parsed: DeepgramParsed): DeepgramAccumulatorStep {
      if (parsed.kind === 'ignore') return {}
      if (parsed.kind === 'interim') return { interim: joinTranscript(finalBuffer, parsed.transcript) }
      if (parsed.kind === 'final') {
        finalBuffer = joinTranscript(finalBuffer, parsed.transcript)
        return { interim: finalBuffer }
      }
      const full = joinTranscript(finalBuffer, parsed.transcript)
      finalBuffer = ''
      return { speechFinal: full }
    },
    reset() { finalBuffer = '' },
  }
}

// VOICE-DEEPGRAM-EARS-48: выбор источника STT (чистая функция — покрыта юнит-тестом). Deepgram приоритетен
// («уши» с ~200-300мс финалом); нет поддержки Deepgram (нет MediaRecorder/WS/getUserMedia) → Web Speech;
// нет и Web Speech → none (голосовой ввод недоступен). См. точку встройки в AiCommandBar.
export function decideSttSource(caps: { deepgramSupported: boolean; webSpeechSupported: boolean }): SttSource {
  if (caps.deepgramSupported) return 'deepgram'
  if (caps.webSpeechSupported) return 'webspeech'
  return 'none'
}

// VOICE-DEEPGRAM-EARS-48: решение фолбэка в РАНТАЙМЕ (чистая функция). WS не открылся / ошибка WS /
// getUserMedia отклонён / MediaRecorder не поддержан → откат на Web Speech, если он есть; иначе none.
// Один и тот же resolveVoiceFinal обслуживает оба источника — фолбэк не оставляет Андрея без голоса.
export function sttFallbackAfterFailure(caps: { webSpeechSupported: boolean }): SttSource {
  return caps.webSpeechSupported ? 'webspeech' : 'none'
}

// VOICE-DEEPGRAM-EARS-48: поддержан ли Deepgram-источник в этом браузере (DOM-проба, НЕ в тестах).
// Нужны WebSocket + MediaRecorder (+ поддержка opus/webm) + getUserMedia. Иначе фолбэк на Web Speech.
export function isDeepgramSttSupported(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof WebSocket === 'undefined') return false
  if (typeof MediaRecorder === 'undefined') return false
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false
  try {
    if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(DEEPGRAM_MIME)) {
      return false
    }
  } catch {
    return false
  }
  return true
}

// --- Тонкий раннер (DOM/сеть; НЕ покрыт node-юнит-тестами — нужен реальный микрофон/WS). ---

export type DeepgramRunnerOptions = {
  baseUrl: string
  // access_token текущей supabase-сессии (supabase.auth.getSession); раннер сам его тянет перед открытием WS.
  getToken: () => Promise<string | null>
  lang?: string
  // WS открылся — источник реально Deepgram (для лога voice:stt-source=deepgram).
  onOpen?: () => void
  // Промежуточный (interim + накопленные финалы) транскрипт — для живого показа ввода.
  onInterim?: (transcript: string) => void
  // speech_final — полная фраза; отдаём в resolveVoiceFinal (#47). Вызывается РОВНО один раз на реплику.
  onSpeechFinal: (transcript: string) => void
  // WS не открылся / ошибка / mic отклонён / MediaRecorder не поддержан → откат на Web Speech (с причиной).
  onFallback: (reason: string) => void
}

export type DeepgramRunner = { stop: () => void }

// VOICE-DEEPGRAM-EARS-48: поднимает Deepgram-источник. getUserMedia → MediaRecorder(webm/opus).start(150) →
// на ondataavailable читает Blob.arrayBuffer() и шлёт в WS (если OPEN) → on message парсит через чистое ядро
// и копит финалы → на speechFinal зовёт onSpeechFinal(полный транскрипт). На стоп/ошибке шлёт 'CloseStream'
// и корректно закрывает mic-треки + WS (без утечек, без «горящего» микрофона). Любой сбой до/во время →
// onFallback(reason) РОВНО один раз (дальше решает AiCommandBar: откат на Web Speech).
export function createDeepgramRunner(opts: DeepgramRunnerOptions): DeepgramRunner {
  let stopped = false
  let settled = false // fallback уже сообщён — не дублируем
  let ws: WebSocket | null = null
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  const acc = createDeepgramAccumulator()

  const cleanup = () => {
    stopped = true
    if (recorder) {
      try { recorder.ondataavailable = null } catch { /* ignore */ }
      try { if (recorder.state !== 'inactive') recorder.stop() } catch { /* ignore */ }
      recorder = null
    }
    if (ws) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(DEEPGRAM_CLOSE_FRAME) } catch { /* ignore */ }
      try { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null } catch { /* ignore */ }
      try { ws.close() } catch { /* ignore */ }
      ws = null
    }
    if (stream) {
      try { stream.getTracks().forEach((tr) => tr.stop()) } catch { /* ignore */ }
      stream = null
    }
  }

  const fail = (reason: string) => {
    if (settled || stopped) { cleanup(); return }
    settled = true
    cleanup()
    opts.onFallback(reason)
  }

  void (async () => {
    let token: string | null = null
    try { token = await opts.getToken() } catch { token = null }
    if (stopped) { cleanup(); return }
    if (!token) { fail('no-token'); return }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      fail('mic-denied'); return
    }
    if (stopped) { cleanup(); return }

    let rec: MediaRecorder
    try {
      const supported = typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(DEEPGRAM_MIME)
      rec = new MediaRecorder(stream, supported ? { mimeType: DEEPGRAM_MIME } : undefined)
    } catch {
      fail('recorder-unsupported'); return
    }
    recorder = rec

    let socket: WebSocket
    try {
      socket = new WebSocket(buildDeepgramWsUrl(opts.baseUrl, token, opts.lang))
    } catch {
      fail('ws-init'); return
    }
    socket.binaryType = 'arraybuffer'
    ws = socket

    socket.onopen = () => {
      if (stopped) { cleanup(); return }
      settled = true // WS открылся — Deepgram живой, дальнейшие ошибки не откатывают тихо в webspeech
      opts.onOpen?.()
      rec.ondataavailable = (e: BlobEvent) => {
        const blob = e.data
        if (!blob || blob.size === 0) return
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        void blob.arrayBuffer().then((buf) => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf)
        }).catch(() => { /* чанк потерян — не критично, следующий уйдёт */ })
      }
      try { rec.start(DEEPGRAM_TIMESLICE_MS) } catch { fail('recorder-start') }
    }

    socket.onmessage = (ev: MessageEvent) => {
      if (stopped) return
      if (typeof ev.data !== 'string') return
      let data: unknown
      try { data = JSON.parse(ev.data) } catch { return } // битый фрейм — игнор без краша
      const step = acc.push(parseDeepgramMessage(data))
      if (step.speechFinal !== undefined) { opts.onSpeechFinal(step.speechFinal); return }
      if (step.interim !== undefined && step.interim) opts.onInterim?.(step.interim)
    }

    socket.onerror = () => { fail('ws-error') }
    // Закрытие ДО onopen (settled=false) = провал → фолбэк; после (settled=true) = штатное завершение.
    socket.onclose = () => { if (!stopped && !settled) fail('ws-close') }
  })()

  return { stop: () => cleanup() }
}
