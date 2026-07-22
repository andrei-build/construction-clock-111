import { describe, expect, it } from 'vitest'
import {
  clampOpeningSpanT,
  hitTestOpeningIndex,
  nearestSegment,
  openingHitDistance,
} from '../src/screens/project-hub/sketchOpeningGeometry'
import { projectT, type Contour } from '../src/screens/project-hub/sketchPlanGeometry'
import type { ContourModel, SegmentPlacement } from '../src/screens/project-hub/sketchOpeningGeometry'

// SWEEP-FIX-33: чистая геометрия захвата/перетаскивания существующего проёма вдоль стены.
// Замкнутый прямоугольник w×h: сегмент 0 = низ (0,0)->(w,0), 1 = правый, 2 = верх, 3 = замыкающий левый.
const rect = (w: number, h: number, closed = true): Contour => ({
  closed,
  points: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ],
})
const model = (...contours: Contour[]): ContourModel => ({ contours })

describe('openingHitDistance — проекция точки на пролёт проёма', () => {
  const m = model(rect(8, 4))
  const op: SegmentPlacement = { c: 0, s: 0, t: 0.5 } // центр (4,0), ширина 3 клетки => полупролёт 1.5

  it('точка на самом проёме даёт нулевое расстояние', () => {
    expect(openingHitDistance(m, op, 3, { x: 4, y: 0 })).toBeCloseTo(0, 6)
  })

  it('расстояние = перпендикулярному отступу от линии проёма', () => {
    expect(openingHitDistance(m, op, 3, { x: 4, y: 0.3 })).toBeCloseTo(0.3, 6)
  })

  it('за концом пролёта расстояние считается от края (полуширина)', () => {
    // курсор в (7,0): проекция клампится к правому краю пролёта (5.5,0) => 1.5
    expect(openingHitDistance(m, op, 3, { x: 7, y: 0 })).toBeCloseTo(1.5, 6)
  })

  it('вырожденный сегмент => null', () => {
    const degenerate = model({ closed: false, points: [{ x: 0, y: 0 }] })
    expect(openingHitDistance(degenerate, { c: 0, s: 0, t: 0.5 }, 3, { x: 0, y: 0 })).toBeNull()
  })
})

describe('hitTestOpeningIndex — захват проёма кликом имеет приоритет', () => {
  const m = model(rect(8, 4))
  const openings: SegmentPlacement[] = [
    { c: 0, s: 0, t: 0.25 }, // центр (2,0)
    { c: 0, s: 0, t: 0.75 }, // центр (6,0)
  ]
  const span = () => 2 // ширина каждого проёма 2 клетки => полупролёт 1
  const HIT = 0.7

  it('точка над проёмом возвращает его индекс', () => {
    expect(hitTestOpeningIndex(m, openings, { x: 2, y: 0.2 }, HIT, span)).toBe(0)
    expect(hitTestOpeningIndex(m, openings, { x: 6, y: -0.2 }, HIT, span)).toBe(1)
  })

  it('точка на пустом месте стены (мимо всех проёмов) => null', () => {
    // (4,0) — центр стены между проёмами, дальше полупролёта от обоих
    expect(hitTestOpeningIndex(m, openings, { x: 4, y: 0 }, HIT, span)).toBeNull()
    // далеко по нормали за порогом
    expect(hitTestOpeningIndex(m, openings, { x: 2, y: 1.5 }, HIT, span)).toBeNull()
  })

  it('при перекрытии выбирается ближайший проём', () => {
    const overlapping: SegmentPlacement[] = [
      { c: 0, s: 0, t: 0.45 }, // центр (3.6,0) => пролёт [2.1..5.1]
      { c: 0, s: 0, t: 0.55 }, // центр (4.4,0) => пролёт [2.9..5.9]
    ]
    // (5.5,0) вне правого края op0, но внутри op1 => ближе к op1
    expect(hitTestOpeningIndex(m, overlapping, { x: 5.5, y: 0 }, HIT, () => 3)).toBe(1)
    // (2.5,0) вне левого края op1, но внутри op0 => ближе к op0
    expect(hitTestOpeningIndex(m, overlapping, { x: 2.5, y: 0 }, HIT, () => 3)).toBe(0)
  })
})

describe('projectT — курсор проецируется в параметр t на сегменте проёма', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 8, y: 0 }

  it('вдоль сегмента даёт долю длины', () => {
    expect(projectT({ x: 2, y: 0 }, a, b)).toBeCloseTo(0.25, 6)
    expect(projectT({ x: 6, y: 0.9 }, a, b)).toBeCloseTo(0.75, 6) // нормальный отступ не влияет на t
  })

  it('за пределами отрезка клампится в [0,1]', () => {
    expect(projectT({ x: -3, y: 0 }, a, b)).toBe(0)
    expect(projectT({ x: 99, y: 0 }, a, b)).toBe(1)
  })
})

describe('clampOpeningSpanT — проём целиком остаётся в пределах сегмента (полуширина)', () => {
  it('прижимает t к [padT, 1-padT] по полуширине', () => {
    // segLen 8, ширина 3 => padT = 1.5/8 = 0.1875
    expect(clampOpeningSpanT(8, 3, 0)).toBeCloseTo(0.1875, 6)
    expect(clampOpeningSpanT(8, 3, 1)).toBeCloseTo(0.8125, 6)
    expect(clampOpeningSpanT(8, 3, 0.5)).toBeCloseTo(0.5, 6)
  })

  it('слишком широкий проём центрируется', () => {
    expect(clampOpeningSpanT(8, 10, 0.1)).toBe(0.5)
    expect(clampOpeningSpanT(8, 8, 0.9)).toBe(0.5)
  })

  it('вырожденная длина => 0.5', () => {
    expect(clampOpeningSpanT(0, 3, 0.7)).toBe(0.5)
  })

  it('отношение padT не зависит от единиц (клетки == футы при общем масштабе)', () => {
    // 8 клеток × 1 фут/клетка и 8 футов дают один и тот же кламп
    expect(clampOpeningSpanT(8, 3, 0)).toBeCloseTo(clampOpeningSpanT(8, 3, 0), 9)
  })
})

describe('nearestSegment — постановка нового проёма на пустом месте по-прежнему находит сегмент', () => {
  const m = model(rect(8, 4))

  it('точка у нижней стены таргетит сегмент 0 с корректным t', () => {
    const near = nearestSegment(m, { x: 5, y: 0.2 })
    expect(near).not.toBeNull()
    expect(near!.c).toBe(0)
    expect(near!.s).toBe(0)
    expect(near!.t).toBeCloseTo(0.625, 6) // 5/8
    expect(near!.d).toBeCloseTo(0.2, 6)
  })
})
