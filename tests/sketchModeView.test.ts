import { describe, it, expect } from 'vitest'
import {
  sketchModeViewMode,
  infraToolForLight,
  isInfraTool,
  DEFAULT_INFRA_TOOL,
  type SketchModeName,
} from '../src/screens/project-hub/sketchModeView'

describe('sketchModeViewMode', () => {
  // SWEEP-FIX-34: «Электрика» (light) НЕ должна прыгать в 3D — остаётся на 2D-плане.
  it('light режим остаётся в 2D (не 3D)', () => {
    expect(sketchModeViewMode('light')).toBe('2d')
  })

  it('SWEEP-FIX-35: finish (Отделка) больше НЕ прыгает в 3D — открывается на 2D-плане', () => {
    expect(sketchModeViewMode('finish')).toBe('2d')
  })

  it('все режимы рейла — 2D (стены/проёмы/отделка/шкафы/электрика/замер/разметка)', () => {
    const modes: SketchModeName[] = ['wall', 'opening', 'finish', 'cabinet', 'light', 'measure', 'markup']
    for (const mode of modes) {
      expect(sketchModeViewMode(mode)).toBe('2d')
    }
  })

  it('SWEEP-FIX-35: НИ ОДИН режим не даёт 3D автоматически', () => {
    const modes: SketchModeName[] = ['wall', 'opening', 'finish', 'cabinet', 'light', 'measure', 'markup']
    const threeD = modes.filter((mode) => sketchModeViewMode(mode) === '3d')
    expect(threeD).toEqual([])
  })
})

describe('infraToolForLight', () => {
  it('вход в «Электрику» без инфра-инструмента ставит розетку (не стену)', () => {
    expect(infraToolForLight('wall')).toBe(DEFAULT_INFRA_TOOL)
    expect(infraToolForLight('wall')).toBe('outlet')
  })

  it('сохраняет уже выбранный инфра-инструмент', () => {
    expect(infraToolForLight('switch')).toBe('switch')
    expect(infraToolForLight('pipe-gas')).toBe('pipe-gas')
    expect(infraToolForLight('column-round')).toBe('column-round')
  })

  it('никогда не оставляет инструмент «стена» в режиме Электрика', () => {
    expect(infraToolForLight('wall')).not.toBe('wall')
    expect(infraToolForLight('door')).not.toBe('door')
  })
})

describe('isInfraTool', () => {
  it('распознаёт инфраструктурные инструменты', () => {
    expect(isInfraTool('outlet')).toBe(true)
    expect(isInfraTool('pipe-water-h')).toBe(true)
    expect(isInfraTool('appliance-oven')).toBe(true)
  })

  it('не считает инфрой стены/проёмы/замер', () => {
    expect(isInfraTool('wall')).toBe(false)
    expect(isInfraTool('door')).toBe(false)
    expect(isInfraTool('measure')).toBe(false)
  })
})
