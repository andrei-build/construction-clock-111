import { describe, expect, it } from 'vitest'
import {
  buildDeepgramWsUrl,
  createDeepgramAccumulator,
  decideSttSource,
  deepgramLangFor,
  parseDeepgramMessage,
  sttFallbackAfterFailure,
  DEEPGRAM_DEFAULT_LANG,
  DEEPGRAM_ENDPOINTING_MS,
  DEEPGRAM_MODEL,
} from '../src/lib/deepgramStt'
import { decideVoiceFinalOutcome } from '../src/lib/aiVoice'

// VOICE-DEEPGRAM-EARS-48: лог-гейт вместо визуального — покрываем ЧИСТОЕ ядро новых «ушей» (Deepgram):
// разбор сообщений, аккумуляцию финалов, выбор источника/фолбэк и стык speech_final → инвариант #47.

// Хелпер: собрать сообщение Deepgram формата Results.
function results(transcript: string, flags: { is_final?: boolean; speech_final?: boolean } = {}) {
  return {
    type: 'Results',
    channel: { alternatives: [{ transcript }] },
    is_final: flags.is_final ?? false,
    speech_final: flags.speech_final ?? false,
  }
}

describe('parseDeepgramMessage — чистый разбор', () => {
  it('interim: Results без is_final/speech_final', () => {
    expect(parseDeepgramMessage(results('привет как'))).toEqual({ kind: 'interim', transcript: 'привет как' })
  })

  it('final: is_final=true, speech_final=false', () => {
    expect(parseDeepgramMessage(results('привет как дела', { is_final: true }))).toEqual({
      kind: 'final',
      transcript: 'привет как дела',
    })
  })

  it('speechFinal: speech_final=true имеет приоритет над is_final', () => {
    expect(parseDeepgramMessage(results('привет как дела', { is_final: true, speech_final: true }))).toEqual({
      kind: 'speechFinal',
      transcript: 'привет как дела',
    })
  })

  it('пустой transcript → ignore (тишина/эхо, без шума)', () => {
    expect(parseDeepgramMessage(results('   ', { speech_final: true }))).toEqual({ kind: 'ignore' })
    expect(parseDeepgramMessage(results('', { is_final: true }))).toEqual({ kind: 'ignore' })
  })

  it('Metadata / незнакомый type → ignore без краша', () => {
    expect(parseDeepgramMessage({ type: 'Metadata', duration: 3.2 })).toEqual({ kind: 'ignore' })
    expect(parseDeepgramMessage({ type: 'UtteranceEnd', last_word_end: 1.1 })).toEqual({ kind: 'ignore' })
  })

  it('битый/пустой объект → ignore (не роняем поток)', () => {
    expect(parseDeepgramMessage(null)).toEqual({ kind: 'ignore' })
    expect(parseDeepgramMessage('строка')).toEqual({ kind: 'ignore' })
    expect(parseDeepgramMessage({})).toEqual({ kind: 'ignore' })
    expect(parseDeepgramMessage({ type: 'Results' })).toEqual({ kind: 'ignore' }) // нет channel/alternatives
    expect(parseDeepgramMessage({ type: 'Results', channel: { alternatives: [] } })).toEqual({ kind: 'ignore' })
  })
})

describe('createDeepgramAccumulator — накопление до speech_final', () => {
  it('interim → is_final → speech_final даёт РОВНО один speechFinal с полным транскриптом', () => {
    const acc = createDeepgramAccumulator()
    const steps: Array<{ speechFinal?: string; interim?: string }> = []
    steps.push(acc.push(parseDeepgramMessage(results('позвони'))))
    steps.push(acc.push(parseDeepgramMessage(results('позвони ивану', { is_final: true }))))
    steps.push(acc.push(parseDeepgramMessage(results('в три часа', { is_final: true, speech_final: true }))))

    const finals = steps.filter((s) => s.speechFinal !== undefined)
    expect(finals).toHaveLength(1)
    expect(finals[0].speechFinal).toBe('позвони ивану в три часа')
  })

  it('после speech_final буфер сброшен — новая реплика копится с нуля', () => {
    const acc = createDeepgramAccumulator()
    acc.push(parseDeepgramMessage(results('первая фраза', { is_final: true, speech_final: true })))
    const step = acc.push(parseDeepgramMessage(results('вторая', { speech_final: true })))
    expect(step.speechFinal).toBe('вторая')
  })

  it('ignore-сообщения (Metadata/пустое) не портят накопление', () => {
    const acc = createDeepgramAccumulator()
    acc.push(parseDeepgramMessage(results('сделай', { is_final: true })))
    acc.push(parseDeepgramMessage({ type: 'Metadata' }))
    acc.push(parseDeepgramMessage(results('', { is_final: true })))
    const step = acc.push(parseDeepgramMessage(results('отчёт', { speech_final: true })))
    expect(step.speechFinal).toBe('сделай отчёт')
  })
})

describe('decideSttSource / sttFallbackAfterFailure — выбор источника и фолбэк', () => {
  it('Deepgram доступен → deepgram (приоритет — новые «уши»)', () => {
    expect(decideSttSource({ deepgramSupported: true, webSpeechSupported: true })).toBe('deepgram')
    expect(decideSttSource({ deepgramSupported: true, webSpeechSupported: false })).toBe('deepgram')
  })

  it('нет Deepgram, есть Web Speech → webspeech (фолбэк)', () => {
    expect(decideSttSource({ deepgramSupported: false, webSpeechSupported: true })).toBe('webspeech')
  })

  it('нет ни одного → none', () => {
    expect(decideSttSource({ deepgramSupported: false, webSpeechSupported: false })).toBe('none')
  })

  it('WS-fail в рантайме → откат на webspeech, если он есть; иначе none', () => {
    expect(sttFallbackAfterFailure({ webSpeechSupported: true })).toBe('webspeech')
    expect(sttFallbackAfterFailure({ webSpeechSupported: false })).toBe('none')
  })
})

describe('buildDeepgramWsUrl / deepgramLangFor — URL реле и язык', () => {
  it('строит wss-URL к edge deepgram-stream с token и lang', () => {
    const url = buildDeepgramWsUrl('https://gzjfjszfdnmaazursppx.supabase.co', 'ACCESS_TOKEN', 'ru')
    expect(url).toBe(
      'wss://gzjfjszfdnmaazursppx.supabase.co/functions/v1/deepgram-stream?token=ACCESS_TOKEN&lang=ru',
    )
  })

  it('http→ws, обрезает хвостовой слэш базового URL', () => {
    const url = buildDeepgramWsUrl('http://localhost:54321/', 'T', 'en')
    expect(url).toBe('ws://localhost:54321/functions/v1/deepgram-stream?token=T&lang=en')
  })

  it('дефолт языка — ru; неизвестный → ru; en/es проходят', () => {
    expect(deepgramLangFor(undefined)).toBe(DEEPGRAM_DEFAULT_LANG)
    expect(deepgramLangFor('ru')).toBe('ru')
    expect(deepgramLangFor('en')).toBe('en')
    expect(deepgramLangFor('es')).toBe('es')
    expect(deepgramLangFor('fr')).toBe('ru')
  })

  it('константы контракта реле фиксированы', () => {
    expect(DEEPGRAM_MODEL).toBe('nova-2')
    expect(DEEPGRAM_ENDPOINTING_MS).toBe(300)
  })
})

describe('speech_final → инвариант #47 (decideVoiceFinalOutcome): send / hold / drop', () => {
  const idle = { active: true, thinking: false, streaming: false, speechPending: false }

  // Симуляция раннера: прогоняем поток сообщений через аккумулятор, финал → решение #47.
  function finalFromStream(msgs: unknown[]): string {
    const acc = createDeepgramAccumulator()
    let final = ''
    for (const m of msgs) {
      const step = acc.push(parseDeepgramMessage(m))
      if (step.speechFinal !== undefined) final = step.speechFinal
    }
    return final
  }

  it('idle → send', () => {
    const final = finalFromStream([
      results('покажи'),
      results('покажи смету', { is_final: true, speech_final: true }),
    ])
    expect(decideVoiceFinalOutcome({ finalText: final, lastSentText: null, snapshot: idle })).toEqual({ action: 'send' })
  })

  it('во время озвучки предыдущего хода (speechPending) → hold (не теряем)', () => {
    const final = finalFromStream([results('добавь задачу', { is_final: true, speech_final: true })])
    const speaking = { ...idle, speechPending: true }
    expect(decideVoiceFinalOutcome({ finalText: final, lastSentText: null, snapshot: speaking })).toEqual({ action: 'hold' })
  })

  it('дубль последнего отправленного → drop:dup', () => {
    const final = finalFromStream([results('позвони ивану', { is_final: true, speech_final: true })])
    expect(
      decideVoiceFinalOutcome({ finalText: final, lastSentText: 'позвони Ивану', snapshot: idle }),
    ).toEqual({ action: 'drop', reason: 'dup' })
  })

  it('пустой speech_final не долетает как финал → нет исхода (drop:empty на пустой строке)', () => {
    const final = finalFromStream([results('   ', { is_final: true, speech_final: true })])
    expect(final).toBe('') // аккумулятор не выдал speechFinal (ignore)
    expect(decideVoiceFinalOutcome({ finalText: final, lastSentText: null, snapshot: idle })).toEqual({
      action: 'drop',
      reason: 'empty',
    })
  })
})
