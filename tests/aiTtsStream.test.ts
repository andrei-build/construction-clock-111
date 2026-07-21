import { describe, expect, it } from 'vitest'
import {
  TTS_STREAM_DEFAULT_SAMPLE_RATE,
  classifyTtsResponse,
  concatBytes,
  framesForSeconds,
  isSupportedPcmFormat,
  parseStreamSampleRate,
  pcm16ToFloat32,
  splitEvenPcmBytes,
} from '../src/lib/aiTtsStream'
import { shouldArmBargeIn } from '../src/lib/aiVoice'

describe('classifyTtsResponse', () => {
  it('treats audio/wav (and variants) as the whole-file fallback path', () => {
    expect(classifyTtsResponse('audio/wav')).toBe('fallback')
    expect(classifyTtsResponse('audio/x-wav')).toBe('fallback')
    expect(classifyTtsResponse('audio/wave; codecs=1')).toBe('fallback')
    expect(classifyTtsResponse('AUDIO/WAV')).toBe('fallback')
  })

  it('treats octet-stream (and anything non-wav / missing) as the progressive PCM stream', () => {
    expect(classifyTtsResponse('application/octet-stream')).toBe('stream')
    expect(classifyTtsResponse('application/octet-stream; charset=binary')).toBe('stream')
    expect(classifyTtsResponse(null)).toBe('stream')
    expect(classifyTtsResponse(undefined)).toBe('stream')
    expect(classifyTtsResponse('')).toBe('stream')
  })
})

describe('parseStreamSampleRate', () => {
  it('parses a positive integer sample rate', () => {
    expect(parseStreamSampleRate('24000')).toBe(24000)
    expect(parseStreamSampleRate('16000')).toBe(16000)
    expect(parseStreamSampleRate('22050.0')).toBe(22050)
  })

  it('falls back to the default for missing/garbage/non-positive headers', () => {
    expect(parseStreamSampleRate(null)).toBe(TTS_STREAM_DEFAULT_SAMPLE_RATE)
    expect(parseStreamSampleRate(undefined)).toBe(TTS_STREAM_DEFAULT_SAMPLE_RATE)
    expect(parseStreamSampleRate('')).toBe(TTS_STREAM_DEFAULT_SAMPLE_RATE)
    expect(parseStreamSampleRate('abc')).toBe(TTS_STREAM_DEFAULT_SAMPLE_RATE)
    expect(parseStreamSampleRate('0')).toBe(TTS_STREAM_DEFAULT_SAMPLE_RATE)
    expect(parseStreamSampleRate('-8000')).toBe(TTS_STREAM_DEFAULT_SAMPLE_RATE)
  })
})

describe('isSupportedPcmFormat', () => {
  it('accepts pcm16le-mono and an empty/missing header (contract default)', () => {
    expect(isSupportedPcmFormat('pcm16le-mono')).toBe(true)
    expect(isSupportedPcmFormat('PCM16LE-MONO')).toBe(true)
    expect(isSupportedPcmFormat('pcm16-little-endian')).toBe(true)
    expect(isSupportedPcmFormat('')).toBe(true)
    expect(isSupportedPcmFormat(null)).toBe(true)
    expect(isSupportedPcmFormat(undefined)).toBe(true)
  })

  it('rejects an explicit non-pcm16le format so the caller falls back', () => {
    expect(isSupportedPcmFormat('mp3')).toBe(false)
    expect(isSupportedPcmFormat('pcm24le-mono')).toBe(false)
    expect(isSupportedPcmFormat('opus')).toBe(false)
  })
})

describe('concatBytes', () => {
  it('joins two chunks in order', () => {
    const out = concatBytes(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]))
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  it('short-circuits when either side is empty (no needless copy)', () => {
    const b = new Uint8Array([9])
    expect(concatBytes(new Uint8Array(0), b)).toBe(b)
    const a = new Uint8Array([7])
    expect(concatBytes(a, new Uint8Array(0))).toBe(a)
  })
})

describe('splitEvenPcmBytes', () => {
  it('cuts an even byte buffer into little-endian signed int16 frames with no leftover', () => {
    // 0x0100 -> 1 (LE),  0x00FF -> -256,  0xFFFF -> -1
    const bytes = new Uint8Array([0x00, 0x01, 0x00, 0xff, 0xff, 0xff])
    const { frames, leftover } = splitEvenPcmBytes(bytes)
    expect(Array.from(frames)).toEqual([256, -256, -1])
    expect(leftover.length).toBe(0)
  })

  it('returns the trailing odd byte as leftover to prepend to the next chunk', () => {
    const bytes = new Uint8Array([0x10, 0x20, 0x30])
    const { frames, leftover } = splitEvenPcmBytes(bytes)
    expect(frames.length).toBe(1)
    expect(Array.from(leftover)).toEqual([0x30])
  })

  it('reassembles a sample split across two reads via the leftover byte', () => {
    const first = splitEvenPcmBytes(new Uint8Array([0x01]))
    expect(first.frames.length).toBe(0)
    expect(Array.from(first.leftover)).toEqual([0x01])
    const merged = concatBytes(first.leftover, new Uint8Array([0x01]))
    const second = splitEvenPcmBytes(merged)
    expect(Array.from(second.frames)).toEqual([0x0101]) // 257
    expect(second.leftover.length).toBe(0)
  })

  it('handles an empty buffer', () => {
    const { frames, leftover } = splitEvenPcmBytes(new Uint8Array(0))
    expect(frames.length).toBe(0)
    expect(leftover.length).toBe(0)
  })
})

describe('pcm16ToFloat32', () => {
  it('normalises int16 samples into the [-1, 1) float range', () => {
    const out = pcm16ToFloat32(Int16Array.from([0, 32767, -32768, 16384]))
    expect(out[0]).toBeCloseTo(0, 6)
    expect(out[1]).toBeCloseTo(0.99997, 4)
    expect(out[2]).toBe(-1)
    expect(out[3]).toBeCloseTo(0.5, 6)
  })
})

describe('framesForSeconds', () => {
  it('computes sample counts for a chunk duration', () => {
    expect(framesForSeconds(24000, 0.25)).toBe(6000)
    expect(framesForSeconds(16000, 0.2)).toBe(3200)
  })

  it('never returns less than one sample', () => {
    expect(framesForSeconds(24000, 0)).toBe(1)
  })
})

describe('shouldArmBargeIn', () => {
  const base = { wakeOn: true, open: true }

  it('arms while the assistant is loading (thinking or streaming) a voice answer', () => {
    expect(shouldArmBargeIn({ ...base, thinking: true })).toBe(true)
    expect(shouldArmBargeIn({ ...base, streaming: true })).toBe(true)
  })

  it('arms while the answer is being spoken (pending TTS)', () => {
    expect(shouldArmBargeIn({ ...base, ttsBusy: true })).toBe(true)
    expect(shouldArmBargeIn({ ...base, ttsQueueRunning: true })).toBe(true)
    expect(shouldArmBargeIn({ ...base, queuedTtsSegments: 2 })).toBe(true)
  })

  it('stays disarmed when idle, or when voice mode / overlay is off', () => {
    expect(shouldArmBargeIn({ ...base })).toBe(false)
    expect(shouldArmBargeIn({ wakeOn: false, open: true, ttsBusy: true })).toBe(false)
    expect(shouldArmBargeIn({ wakeOn: true, open: false, thinking: true })).toBe(false)
  })
})
