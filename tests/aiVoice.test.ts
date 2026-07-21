import { describe, expect, it } from 'vitest'
import {
  isVoiceAffirm,
  isVoiceCancel,
  isVoiceStopCommand,
  shouldAcceptAssistantVoiceResult,
  looksLikeTtsEcho,
  normalizeVoiceText,
  splitCompletedSpeechSegments,
  stripMarkdownForSpeech,
  voiceEventMessage,
} from '../src/lib/aiVoice'

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
