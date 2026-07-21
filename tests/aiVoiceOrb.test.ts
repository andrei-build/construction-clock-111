import { describe, expect, it } from 'vitest'
import {
  getAiOrbToggleIntent,
  getNextAiOrbToggleState,
  isAiInfoProposalAction,
} from '../src/lib/aiVoice'

describe('ai voice orb helpers', () => {
  it('classifies report_bug as informational, not actionable', () => {
    expect(isAiInfoProposalAction('report_bug')).toBe(true)
    expect(isAiInfoProposalAction('create_task')).toBe(false)
    expect(isAiInfoProposalAction('send_plan')).toBe(false)
  })

  // ORB-SIMPLE-2: клик по покоящемуся орбу открывает сеанс рации и включает озвучку (жест
  // разблокирует TTS), но НЕ форсит голосовую активацию — выбор wakeOn сохраняется.
  it('activates a walkie-talkie session without forcing voice activation on', () => {
    expect(getNextAiOrbToggleState({
      open: false,
      wakeOn: false,
      speakOn: false,
    })).toEqual({
      intent: 'activate',
      open: true,
      wakeOn: false,
      speakOn: true,
    })
  })

  it('preserves the wake setting when activating a session', () => {
    expect(getNextAiOrbToggleState({
      open: false,
      wakeOn: true,
      speakOn: false,
    })).toEqual({
      intent: 'activate',
      open: true,
      wakeOn: true,
      speakOn: true,
    })
  })

  // ORB-SIMPLE-2: клик во время живого сеанса ЗАКРЫВАЕТ его, не трогая настройки озвучки/активации.
  it('deactivates an active session but keeps speak/wake preferences', () => {
    expect(getNextAiOrbToggleState({
      open: true,
      wakeOn: true,
      speakOn: true,
      voiceStatus: 'listening',
    })).toEqual({
      intent: 'deactivate',
      open: false,
      wakeOn: true,
      speakOn: true,
    })
  })

  // ORB-SIMPLE-2: фоновая голосовая активация (wakeOn) БЕЗ открытого сеанса — клик орба должен
  // НАЧАТЬ разговор, а не выключить фон.
  it('starts a session on click even while background wake is armed', () => {
    expect(getAiOrbToggleIntent({
      open: false,
      wakeOn: true,
      speakOn: true,
      voiceStatus: 'wake',
    })).toBe('activate')
  })

  it('treats a busy assistant (thinking/speaking) as a stoppable session', () => {
    expect(getAiOrbToggleIntent({ open: false, wakeOn: false, speakOn: true, thinking: true })).toBe('deactivate')
    expect(getAiOrbToggleIntent({ open: false, wakeOn: false, speakOn: true, ttsBusy: true })).toBe('deactivate')
    expect(getAiOrbToggleIntent({ open: false, wakeOn: false, speakOn: true, voiceStatus: 'speaking' })).toBe('deactivate')
    expect(getAiOrbToggleIntent({ open: false, wakeOn: false, speakOn: true, voiceStatus: 'off' })).toBe('activate')
  })
})
