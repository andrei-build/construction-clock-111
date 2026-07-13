// F61 (П11 parity): short WebAudio chime played when a NEW urgent message arrives for
// the current user. This is the audio companion to the urgent MessageOverlay (F70).
// Dependency-free; mirrors Check Time's client-notification-sound.ts.
//
// The chime is a 988 -> 1319 -> 988 Hz triple beep. Autoplay is unlocked on the first
// user gesture (pointerdown/keydown) because mobile browsers keep audio suspended until
// the user has interacted with the page. Everything degrades to a silent no-op when
// WebAudio is unavailable (SSR, older browsers, autoplay still blocked).

type AudioContextCtor = typeof AudioContext

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ?? null
}

let ctx: AudioContext | null = null
let unlockArmed = false

function ensureContext(): AudioContext | null {
  const Ctor = getAudioContextCtor()
  if (!Ctor) return null
  if (!ctx) {
    try {
      ctx = new Ctor()
    } catch {
      return null
    }
  }
  return ctx
}

// Create/resume the AudioContext in response to a real user gesture. A freshly-created
// context is 'suspended' on mobile until this happens.
function unlock(): void {
  const c = ensureContext()
  if (c && c.state === 'suspended') void c.resume()
}

// Install one-time pointerdown/keydown listeners that unlock audio on the first gesture.
// Safe to call repeatedly (guarded) and safe outside a browser (no-op).
export function armUrgentChimeUnlock(): void {
  if (unlockArmed) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  unlockArmed = true
  const handler = () => {
    unlock()
    window.removeEventListener('pointerdown', handler)
    window.removeEventListener('keydown', handler)
  }
  window.addEventListener('pointerdown', handler, { once: true })
  window.addEventListener('keydown', handler, { once: true })
}

// One tone of the chime, with a short attack/release envelope so beeps don't click.
function beep(c: AudioContext, freq: number, start: number, duration: number): void {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, start)
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(0.18, start + 0.01)
  gain.gain.setValueAtTime(0.18, Math.max(start + 0.01, start + duration - 0.03))
  gain.gain.linearRampToValueAtTime(0, start + duration)
  osc.connect(gain).connect(c.destination)
  osc.start(start)
  osc.stop(start + duration)
}

// Play the urgent chime (988 -> 1319 -> 988 Hz). No-op if WebAudio is unavailable.
export function playUrgentChime(): void {
  const c = ensureContext()
  if (!c) return
  // Best-effort resume; if the user hasn't interacted yet this stays suspended and the
  // scheduled tones simply won't be heard — no error, no throw.
  if (c.state === 'suspended') void c.resume()
  try {
    const now = c.currentTime
    const beat = 0.12
    beep(c, 988, now, beat)
    beep(c, 1319, now + beat, beat)
    beep(c, 988, now + beat * 2, beat)
  } catch {
    // Audio is best-effort; never let a chime failure bubble up into the UI.
  }
}
