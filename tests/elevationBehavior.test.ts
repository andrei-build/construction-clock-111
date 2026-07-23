import { describe, expect, it } from 'vitest'
import {
  NUDGE_COARSE_FT,
  NUDGE_FINE_FT,
  arrowNudgeFt,
  formatLiveAreaSqft,
  isArrowKey,
  liveDrawDims,
  nudgeStepFt,
  nudgeValue,
  shouldAutoDrawZone,
} from '../src/screens/project-hub/elevationBehavior'

describe('ELEV-BEHAVIOR-56 nudge step', () => {
  it('стрелка без Shift = 1/8 дюйма (1/96 фута)', () => {
    expect(nudgeStepFt(false)).toBeCloseTo(1 / 96, 10)
    expect(NUDGE_FINE_FT * 12).toBeCloseTo(0.125, 10) // 1/8"
  })

  it('Shift+стрелка = 1 дюйм (1/12 фута)', () => {
    expect(nudgeStepFt(true)).toBeCloseTo(1 / 12, 10)
    expect(NUDGE_COARSE_FT * 12).toBeCloseTo(1, 10) // 1"
  })
})

describe('ELEV-BEHAVIOR-56 arrow → vector', () => {
  it('стрелки дают верный вектор (вверх = +y)', () => {
    expect(arrowNudgeFt('ArrowLeft', false)).toEqual({ dx: -1 / 96, dy: 0 })
    expect(arrowNudgeFt('ArrowRight', false)).toEqual({ dx: 1 / 96, dy: 0 })
    expect(arrowNudgeFt('ArrowUp', false)).toEqual({ dx: 0, dy: 1 / 96 })
    expect(arrowNudgeFt('ArrowDown', false)).toEqual({ dx: 0, dy: -1 / 96 })
  })

  it('Shift масштабирует шаг до 1"', () => {
    expect(arrowNudgeFt('ArrowRight', true)).toEqual({ dx: 1 / 12, dy: 0 })
  })

  it('не-стрелка → null', () => {
    expect(arrowNudgeFt('Enter', false)).toBeNull()
    expect(arrowNudgeFt('a', true)).toBeNull()
    expect(isArrowKey('ArrowUp')).toBe(true)
    expect(isArrowKey('Tab')).toBe(false)
  })

  it('3 нажатия стрелки = 3/8 дюйма суммарно', () => {
    let x = 1
    for (let i = 0; i < 3; i++) x += arrowNudgeFt('ArrowRight', false)!.dx
    expect((x - 1) * 12).toBeCloseTo(0.375, 10) // 3/8"
  })
})

describe('ELEV-BEHAVIOR-56 nudgeValue clamp', () => {
  it('двигает и держит в границах', () => {
    expect(nudgeValue(1, 1 / 96, 0, 10)).toBeCloseTo(1 + 1 / 96, 10)
    expect(nudgeValue(0.02, -1, 0, 10)).toBe(0) // клэмп к нижней границе
    expect(nudgeValue(9.99, 1, 0, 10)).toBe(10) // клэмп к верхней границе
  })

  it('границы можно передавать в любом порядке', () => {
    expect(nudgeValue(5, 0, 10, 0)).toBe(5)
  })
})

describe('ELEV-BEHAVIOR-56 auto-draw zone on Partial', () => {
  it('«Частично» → сразу режим рисования зоны', () => {
    expect(shouldAutoDrawZone('partial')).toBe(true)
  })
  it('«Полностью»/пусто → нет авто-рисования', () => {
    expect(shouldAutoDrawZone('full')).toBe(false)
    expect(shouldAutoDrawZone(undefined)).toBe(false)
    expect(shouldAutoDrawZone(null)).toBe(false)
  })
})

describe('ELEV-BEHAVIOR-56 live draw dims', () => {
  it('Ш×В в дюймах + площадь ft² из углов (футы)', () => {
    // 3 фута × 8 футов = 36" × 96", площадь 24 ft²
    const d = liveDrawDims({ x: 1, y: 0 }, { x: 4, y: 8 })
    expect(d.widthIn).toBeCloseTo(36, 6)
    expect(d.heightIn).toBeCloseTo(96, 6)
    expect(d.areaSqft).toBeCloseTo(24, 6)
  })

  it('порядок точек не важен (модуль)', () => {
    const a = liveDrawDims({ x: 4, y: 8 }, { x: 1, y: 0 })
    expect(a.widthIn).toBeCloseTo(36, 6)
    expect(a.heightIn).toBeCloseTo(96, 6)
    expect(a.areaSqft).toBeCloseTo(24, 6)
  })

  it('формат площади: целое ≥10, иначе 1-2 знака', () => {
    expect(formatLiveAreaSqft(24)).toBe('24')
    expect(formatLiveAreaSqft(2.5)).toBe('2.5')
    expect(formatLiveAreaSqft(0.25)).toBe('0.25')
    expect(formatLiveAreaSqft(-1)).toBe('0')
  })
})
