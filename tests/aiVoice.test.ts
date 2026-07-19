import { describe, expect, it } from 'vitest'
import {
  isVoiceStopCommand,
  looksLikeTtsEcho,
  normalizeVoiceText,
  splitCompletedSpeechSegments,
  stripMarkdownForSpeech,
} from '../src/lib/aiVoice'

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

  it('strips markdown before sending text to speech', () => {
    expect(stripMarkdownForSpeech('## Title\n**Finish** `today`')).toBe('Title Finish today')
  })

  it('recognizes English and Russian stop commands', () => {
    expect(isVoiceStopCommand('please stop')).toBe(true)
    expect(isVoiceStopCommand('хватит, замолчи')).toBe(true)
    expect(isVoiceStopCommand('add a task tomorrow')).toBe(false)
  })

  it('normalizes punctuation and ё for command matching', () => {
    expect(normalizeVoiceText('Тихо, ещё раз!')).toBe('тихо еще раз')
  })

  it('detects likely speech-recognition echo of TTS output', () => {
    expect(looksLikeTtsEcho('the schedule is clear today', 'The schedule is clear today. I can assign the crew.')).toBe(true)
    expect(looksLikeTtsEcho('assign alex to the job', 'The schedule is clear today.')).toBe(false)
  })
})
