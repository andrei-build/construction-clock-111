import { describe, expect, it } from 'vitest'
import {
  getNextAiOrbToggleState,
  isAiInfoProposalAction,
} from '../src/lib/aiVoice'

describe('ai voice orb helpers', () => {
  it('classifies report_bug as informational, not actionable', () => {
    expect(isAiInfoProposalAction('report_bug')).toBe(true)
    expect(isAiInfoProposalAction('create_task')).toBe(false)
    expect(isAiInfoProposalAction('send_plan')).toBe(false)
  })

  it('toggles orb state on and then fully off', () => {
    const activated = getNextAiOrbToggleState({
      open: false,
      wakeOn: false,
      speakOn: false,
    })

    expect(activated).toEqual({
      intent: 'activate',
      open: true,
      wakeOn: true,
      speakOn: true,
    })

    const deactivated = getNextAiOrbToggleState({
      ...activated,
      voiceStatus: 'listening',
    })

    expect(deactivated).toEqual({
      intent: 'deactivate',
      open: false,
      wakeOn: false,
      speakOn: true,
    })
  })
})
