import { describe, expect, it } from 'vitest'
import {
  DIM_PLATE_GLYPH_EM,
  DIM_PLATE_PAD_EM,
  SKETCH_RAIL_ICON_BY_MODE,
  dimPlateRadius,
  dimPlateWidthEm,
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

describe('sketchToolbar — плашка чертёжной подписи размера (#57)', () => {
  it('пустая строка → только горизонтальные поля', () => {
    expect(dimPlateWidthEm('')).toBeCloseTo(DIM_PLATE_PAD_EM, 6)
    // null/undefined безопасно обрабатываются как пустая строка
    expect(dimPlateWidthEm(undefined as unknown as string)).toBeCloseTo(DIM_PLATE_PAD_EM, 6)
  })

  it('ширина растёт линейно по числу глифов (моноширинность)', () => {
    const one = dimPlateWidthEm('1')
    const two = dimPlateWidthEm('12')
    expect(one).toBeCloseTo(DIM_PLATE_GLYPH_EM * 1 + DIM_PLATE_PAD_EM, 6)
    expect(two - one).toBeCloseTo(DIM_PLATE_GLYPH_EM, 6)
    expect(dimPlateWidthEm('12 ft')).toBeCloseTo(DIM_PLATE_GLYPH_EM * 5 + DIM_PLATE_PAD_EM, 6)
  })

  it('дробь-глиф считается одним code point («53 1/4"» длиной 7)', () => {
    // «53 1/4"» — 7 символов; проверяем, что нет double-count суррогатов/фракций
    expect([...'53 1/4"'].length).toBe(7)
    expect(dimPlateWidthEm('53 1/4"')).toBeCloseTo(DIM_PLATE_GLYPH_EM * 7 + DIM_PLATE_PAD_EM, 6)
  })

  it('радиус плашки лёгкий и всегда ≤ потолка (правило radius ≤ 8)', () => {
    // при крупном кегле упираемся в потолок
    expect(dimPlateRadius(100, 8)).toBe(8)
    // при мелком кегле — мягкое скругление меньше потолка
    expect(dimPlateRadius(10, 8)).toBeCloseTo(3.4, 6)
    // защита от отрицательных
    expect(dimPlateRadius(-5, 8)).toBe(0)
    expect(dimPlateRadius(100, -1)).toBe(0)
  })
})
