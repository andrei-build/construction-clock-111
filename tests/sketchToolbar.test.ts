import { describe, expect, it } from 'vitest'
import {
  SKETCH_RAIL_ICON_BY_MODE,
  isFullscreenControlAlwaysVisible,
  railIconId,
  show3DViewPresetsInStrip,
  type SketchRailMode,
} from '../src/lib/sketchToolbar'

const ALL_MODES: SketchRailMode[] = ['wall', 'opening', 'finish', 'cabinet', 'light', 'measure', 'markup']

describe('sketchToolbar — иконки левого рейла', () => {
  it('у каждого режима есть свой значок', () => {
    for (const mode of ALL_MODES) {
      expect(SKETCH_RAIL_ICON_BY_MODE[mode]).toBe(mode)
      expect(railIconId(mode)).toBe(mode)
    }
  })

  it('иконки различимы (нет двух режимов с одним значком)', () => {
    const ids = ALL_MODES.map((m) => SKETCH_RAIL_ICON_BY_MODE[m])
    expect(new Set(ids).size).toBe(ALL_MODES.length)
  })

  it('незнакомый режим падает в безопасный фолбэк', () => {
    expect(railIconId('does-not-exist')).toBe('wall')
    expect(railIconId('')).toBe('wall')
  })
})

describe('sketchToolbar — дедуп видов в 3D-строке', () => {
  it('в обычном режиме виды НЕ дублируются в 3D-строке (они в общей верхней строке)', () => {
    expect(show3DViewPresetsInStrip({ fullscreenActive: false })).toBe(false)
  })

  it('в полноэкранном режиме виды показываются прямо в 3D-строке (верхней строки нет)', () => {
    expect(show3DViewPresetsInStrip({ fullscreenActive: true })).toBe(true)
  })
})

describe('sketchToolbar — «На весь экран»', () => {
  it('всегда видима', () => {
    expect(isFullscreenControlAlwaysVisible()).toBe(true)
  })
})
