// VOICE-FRONT-STREAM: чистые хелперы прогрессивной озвучки ассистента через edge `ai-tts-stream`.
// Здесь ТОЛЬКО чистая арифметика/парсинг заголовков и PCM — без fetch/AudioContext, чтобы всё
// покрывалось юнит-тестами. Само планирование AudioBuffer'ов «встык» живёт в AiCommandBar (там
// нужен живой AudioContext). Контракт edge (сверено с задачей БЕТА-6 VOICE-FRONT-STREAM):
//  • успех-стрим: Content-Type application/octet-stream + X-Sample-Rate: 24000 +
//    X-Audio-Format: pcm16le-mono → сырые int16 LE mono-чанки по мере генерации;
//  • фолбэк: Content-Type audio/wav + X-Fallback: full → целый WAV (decodeAudioData).
// Различаем СТРОГО по Content-Type ответа.

export const TTS_STREAM_DEFAULT_SAMPLE_RATE = 24000

export type TtsResponseKind = 'stream' | 'fallback'

// Только явный WAV → фолбэк-путь (целый файл, decodeAudioData). Всё остальное (в норме
// application/octet-stream) трактуем как прогрессивный PCM-стрим.
export function classifyTtsResponse(contentType: string | null | undefined): TtsResponseKind {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('audio/wav') || ct.includes('audio/x-wav') || ct.includes('audio/wave')) return 'fallback'
  return 'stream'
}

// X-Sample-Rate → положительное целое; пусто/мусор → дефолт 24000 (контракт edge).
export function parseStreamSampleRate(header: string | null | undefined): number {
  const n = Number(header)
  if (!Number.isFinite(n) || n <= 0) return TTS_STREAM_DEFAULT_SAMPLE_RATE
  return Math.floor(n)
}

// X-Audio-Format ожидаем 'pcm16le-mono'. Пустой заголовок → считаем поддержанным (контракт
// гарантирует pcm16le для octet-stream). Явно иной формат → false, чтобы уйти в фолбэк, а не
// проигрывать мусор.
export function isSupportedPcmFormat(format: string | null | undefined): boolean {
  const f = (format ?? '').trim().toLowerCase()
  if (!f) return true
  return f.includes('pcm16') && (f.includes('le') || f.includes('little'))
}

// VOICE-CLIENT-DEBUG-1: заголовок X-Fallback (какой путь взял edge: full/…) — нормализуем в
// компактную строку для телеметрии. Пусто/пробелы → null (заголовка нет — обычный стрим).
export function parseFallbackHeader(header: string | null | undefined): string | null {
  const v = (header ?? '').trim()
  return v ? v.slice(0, 40) : null
}

const EMPTY_BYTES = new Uint8Array(0)

// Склейка остатка предыдущего чтения с новым чанком стрима.
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

// PCM16 = 2 байта/сэмпл. Берём максимум ЧЁТНЫХ байт, режем на int16 LE (со знаком — присваивание в
// Int16Array само приводит к знаковому 16-бит), нечётный «хвост» отдаём как leftover: его дополнит
// следующий чанк стрима (иначе съедет фаза и пойдёт треск).
export function splitEvenPcmBytes(bytes: Uint8Array): { frames: Int16Array; leftover: Uint8Array } {
  const usable = bytes.length - (bytes.length % 2)
  const frames = new Int16Array(usable / 2)
  for (let i = 0; i < frames.length; i++) {
    frames[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8)
  }
  const leftover = usable === bytes.length ? EMPTY_BYTES : bytes.slice(usable)
  return { frames, leftover }
}

// int16 [-32768..32767] → float32 [-1..1) для AudioBuffer.getChannelData / copyToChannel.
export function pcm16ToFloat32(frames: Int16Array): Float32Array {
  const out = new Float32Array(frames.length)
  for (let i = 0; i < frames.length; i++) out[i] = frames[i] / 32768
  return out
}

// Сколько int16-сэмплов приходится на ~seconds секунд при данной частоте (нарезка на буферы 0.2–0.5с).
export function framesForSeconds(sampleRate: number, seconds: number): number {
  return Math.max(1, Math.round(sampleRate * seconds))
}
