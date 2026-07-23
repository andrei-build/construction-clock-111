import { describe, expect, it } from 'vitest'
import {
  decideVoiceFinalOutcome,
  formatVoiceGateCause,
  isVoiceAffirm,
  isVoiceCancel,
  isVoiceStopCommand,
  shouldAcceptAssistantVoiceResult,
  looksLikeTtsEcho,
  normalizeVoiceText,
  splitCompletedSpeechSegments,
  sttFinalLagMs,
  stripMarkdownForSpeech,
  voiceEventMessage,
  VOICE_FINAL_RESCUE_MS,
  VOICE_FIRST_BYTE_TIMEOUT_MS,
  VOICE_MAX_ATTEMPTS,
  type VoicePipelineSnapshot,
} from '../src/lib/aiVoice'

describe('sttFinalLagMs (VOICE-TIMEOUT-RETRY-8)', () => {
  it('returns null when either stamp is missing', () => {
    expect(sttFinalLagMs(null, 100)).toBeNull()
    expect(sttFinalLagMs(100, null)).toBeNull()
    expect(sttFinalLagMs(null, null)).toBeNull()
  })

  it('returns the positive lag from acoustic speech end to STT final', () => {
    expect(sttFinalLagMs(1000, 2500)).toBe(1500)
    expect(sttFinalLagMs(0, 0)).toBe(0)
  })

  it('clamps a negative difference to 0 (final never precedes speech end)', () => {
    expect(sttFinalLagMs(2000, 1500)).toBe(0)
  })
})

describe('voice timeout constants (VOICE-TIMEOUT-RETRY-8)', () => {
  it('uses an 8s no-first-byte window and exactly one auto-retry (2 attempts total)', () => {
    expect(VOICE_FIRST_BYTE_TIMEOUT_MS).toBe(8_000)
    expect(VOICE_MAX_ATTEMPTS).toBe(2)
  })
})

describe('voiceEventMessage', () => {
  it('encodes stage into a voice: message (no category/stage columns in client_errors)', () => {
    expect(voiceEventMessage('fetch-ok')).toBe('voice:fetch-ok')
    expect(voiceEventMessage('play-fail', 'NotAllowedError')).toBe('voice:play-fail NotAllowedError')
    expect(voiceEventMessage('timing', 'speechEnd2req=420ms')).toBe('voice:timing speechEnd2req=420ms')
  })

  it('omits empty/whitespace detail and trims it', () => {
    expect(voiceEventMessage('autoplay-block', '')).toBe('voice:autoplay-block')
    expect(voiceEventMessage('autoplay-block', '   ')).toBe('voice:autoplay-block')
    expect(voiceEventMessage('decode-fail', '  no_audio_context  ')).toBe('voice:decode-fail no_audio_context')
    expect(voiceEventMessage('fetch-ok', undefined)).toBe('voice:fetch-ok')
  })
})

// VOICE-DROPPED-FINAL-47: чистое ядро конвейера «один непустой финал → РОВНО ОДИН исход». Раньше finalize
// при закрытом гейте делал тихий `if (!canAccept) return` и терял готовый финал (sttFinal2speechEnd есть,
// speechEnd2req нет). Ядро гарантирует: send | hold | drop(reason) — без тихих потерь.
const idle: VoicePipelineSnapshot = { active: true, thinking: false, streaming: false, speechPending: false }

describe('decideVoiceFinalOutcome (VOICE-DROPPED-FINAL-47)', () => {
  it('sends a non-empty final when the gate is open (idle)', () => {
    expect(decideVoiceFinalOutcome({ finalText: 'покажи смету', lastSentText: null, snapshot: idle }))
      .toEqual({ action: 'send' })
  })

  it('HOLDS (does not drop) a final captured while the assistant is thinking', () => {
    expect(decideVoiceFinalOutcome({ finalText: 'сколько часов', lastSentText: null, snapshot: { ...idle, thinking: true } }))
      .toEqual({ action: 'hold' })
  })

  it('HOLDS a final captured while the answer is streaming', () => {
    expect(decideVoiceFinalOutcome({ finalText: 'сколько часов', lastSentText: null, snapshot: { ...idle, streaming: true } }))
      .toEqual({ action: 'hold' })
  })

  it('HOLDS a final captured while the previous turn is still speaking (speechPending)', () => {
    expect(decideVoiceFinalOutcome({ finalText: 'а по второму объекту', lastSentText: null, snapshot: { ...idle, speechPending: true } }))
      .toEqual({ action: 'hold' })
  })

  it('drops an empty / whitespace-only final with reason "empty"', () => {
    expect(decideVoiceFinalOutcome({ finalText: '', lastSentText: null, snapshot: idle }))
      .toEqual({ action: 'drop', reason: 'empty' })
    expect(decideVoiceFinalOutcome({ finalText: '   ', lastSentText: 'что-то', snapshot: idle }))
      .toEqual({ action: 'drop', reason: 'empty' })
  })

  it('drops a duplicate of the last sent text with reason "dup" (normalized, ignores case/punctuation)', () => {
    expect(decideVoiceFinalOutcome({ finalText: 'Покажи смету!', lastSentText: 'покажи смету', snapshot: idle }))
      .toEqual({ action: 'drop', reason: 'dup' })
  })

  it('sends (not dup) when the final differs from the last sent text', () => {
    expect(decideVoiceFinalOutcome({ finalText: 'покажи табель', lastSentText: 'покажи смету', snapshot: idle }))
      .toEqual({ action: 'send' })
  })

  it('sends after a barge-in: gate reopened to idle, non-duplicate phrase', () => {
    expect(decideVoiceFinalOutcome({ finalText: 'стоп, лучше по бригаде', lastSentText: 'покажи смету', snapshot: idle }))
      .toEqual({ action: 'send' })
  })
})

describe('formatVoiceGateCause (VOICE-DROPPED-FINAL-47)', () => {
  it('serialises every pipeline flag so client_errors shows which flag held the gate', () => {
    expect(formatVoiceGateCause({ active: true, thinking: false, streaming: false, speechPending: true, canAccept: false }))
      .toBe('active=true thinking=false streaming=false speechPending=true canAccept=false')
  })
})

describe('VOICE_FINAL_RESCUE_MS (VOICE-DROPPED-FINAL-47)', () => {
  it('is a 1.5s rescue window — under the "завис" perception threshold', () => {
    expect(VOICE_FINAL_RESCUE_MS).toBe(1_500)
  })
})

// ЛОГ-ГЕЙТ: последовательность из 3 финалов подряд в разных стейтах даёт РОВНО 3 осознанных исхода, 0 тишины.
// Симулируем конвейер поверх чистого ядра: гейт закрывается озвучкой предыдущего хода и снова открывается.
describe('voice final pipeline invariant — no silent losses (VOICE-DROPPED-FINAL-47)', () => {
  it('3 finals across states → exactly 3 conscious outcomes (send, hold→send, drop), zero silence', () => {
    // Модель конвейера: держим последний отправленный текст и придержанный финал; каждый исход логируется.
    let lastSent: string | null = null
    let pending: string | null = null
    const outcomes: string[] = []

    const feed = (finalText: string, snapshot: VoicePipelineSnapshot): void => {
      const decision = decideVoiceFinalOutcome({ finalText, lastSentText: lastSent, snapshot })
      if (decision.action === 'send') { lastSent = finalText.trim(); pending = null; outcomes.push('send'); return }
      if (decision.action === 'drop') { outcomes.push(`drop:${decision.reason}`); return }
      // hold: придерживаем финал — он НЕ теряется, а ждёт открытия гейта
      pending = finalText.trim()
      outcomes.push('hold')
    }
    // гейт открылся (озвучка отзвучала) — досылаем придержанный финал ровно один раз
    const openGate = (snapshot: VoicePipelineSnapshot): void => {
      if (!pending) return
      const decision = decideVoiceFinalOutcome({ finalText: pending, lastSentText: lastSent, snapshot })
      if (decision.action === 'send') { lastSent = pending; pending = null; outcomes.push('send') }
    }

    // Финал №1 — в idle: сразу уходит запросом.
    feed('покажи смету', idle)
    // Финал №2 — пока звучит ответ по №1 (speechPending): придерживается (НЕ теряется), затем гейт открылся → уходит.
    feed('а сколько по зарплате', { ...idle, speechPending: true })
    openGate(idle)
    // Финал №3 — дубль уже отправленного №2: осознанный drop.
    feed('А сколько по зарплате?', idle)

    // Ровно 3 финала → 3 осознанных исхода (send, hold→send, drop) + ни одной тишины без следа.
    expect(outcomes).toEqual(['send', 'hold', 'send', 'drop:dup'])
    // Придержанный финал №2 РЕАЛЬНО ушёл (2 send), и ни один непустой финал не потерян молча.
    expect(outcomes.filter((o) => o === 'send')).toHaveLength(2)
    expect(pending).toBeNull()
    expect(lastSent).toBe('а сколько по зарплате')
  })
})

describe('ai voice helpers', () => {
  it('splits completed sentence segments and keeps the unfinished tail', () => {
    const res = splitCompletedSpeechSegments('First sentence. Second? still streaming')
    expect(res.segments).toEqual(['First sentence.', 'Second?'])
    expect(res.rest).toBe('still streaming')
  })

  it('flushes the tail when forced', () => {
    const res = splitCompletedSpeechSegments('No punctuation yet', { force: true })
    expect(res.segments).toEqual(['No punctuation yet'])
    expect(res.rest).toBe('')
  })

  it('flushes an incremental stream tail once after completed segments', () => {
    let buffer = ''
    const queued: string[] = []

    buffer += 'First sentence. Second sentence without'
    let split = splitCompletedSpeechSegments(buffer)
    queued.push(...split.segments)
    buffer = split.rest

    buffer += ' punctuation yet'
    split = splitCompletedSpeechSegments(buffer, { force: true })
    queued.push(...split.segments)
    buffer = split.rest

    split = splitCompletedSpeechSegments(buffer, { force: true })
    queued.push(...split.segments)

    expect(queued).toEqual(['First sentence.', 'Second sentence without punctuation yet'])
    expect(buffer).toBe('')
  })

  // ORB-SIMPLE-2: приём фразы вопроса завязан на активный сеанс (open) + статус listening; wakeOn
  // больше не требуется (сеанс можно открыть кликом орба без голосовой активации).
  it('accepts assistant mic results only in the active listening orb window', () => {
    expect(shouldAcceptAssistantVoiceResult({
      wakeOn: true,
      open: true,
      voiceStatus: 'listening',
    })).toBe(true)
    expect(shouldAcceptAssistantVoiceResult({
      wakeOn: false,
      open: true,
      voiceStatus: 'listening',
    })).toBe(true)
    expect(shouldAcceptAssistantVoiceResult({
      wakeOn: false,
      open: false,
      voiceStatus: 'listening',
    })).toBe(false)
    expect(shouldAcceptAssistantVoiceResult({
      wakeOn: true,
      open: true,
      voiceStatus: 'speaking',
      ttsBusy: true,
    })).toBe(false)
    expect(shouldAcceptAssistantVoiceResult({
      wakeOn: true,
      open: true,
      voiceStatus: 'listening',
      queuedTtsSegments: 1,
    })).toBe(false)
  })

  it('strips markdown before sending text to speech', () => {
    expect(stripMarkdownForSpeech('## Title\n**Finish** `today`')).toBe('Title Finish today')
  })

  it('recognizes English and Russian stop commands', () => {
    expect(isVoiceStopCommand('please stop')).toBe(true)
    expect(isVoiceStopCommand('хватит, замолчи')).toBe(true)
    expect(isVoiceStopCommand('add a task tomorrow')).toBe(false)
  })

  it('recognizes English and Russian proposal confirmations', () => {
    expect(isVoiceAffirm('yes, execute it')).toBe(true)
    expect(isVoiceAffirm('да, выполни')).toBe(true)
    expect(isVoiceAffirm('go ahead and send')).toBe(true)
    expect(isVoiceAffirm('no, do not execute')).toBe(false)
  })

  it('recognizes English and Russian proposal cancellations', () => {
    expect(isVoiceCancel('no, reject it')).toBe(true)
    expect(isVoiceCancel('отмени предложение')).toBe(true)
    expect(isVoiceCancel('не отправляй')).toBe(true)
    expect(isVoiceCancel('yes, send it')).toBe(false)
  })

  it('normalizes punctuation and ё for command matching', () => {
    expect(normalizeVoiceText('Тихо, ещё раз!')).toBe('тихо еще раз')
  })

  it('detects likely speech-recognition echo of TTS output', () => {
    expect(looksLikeTtsEcho('the schedule is clear today', 'The schedule is clear today. I can assign the crew.')).toBe(true)
    expect(looksLikeTtsEcho('assign alex to the job', 'The schedule is clear today.')).toBe(false)
  })
})
