import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WALL_PAINT,
  normalizeFinishes,
  sketchWallKey,
  type SketchFinishes,
} from '../src/screens/project-hub/sketchFinishes'

// NAV-FIX-2: панель «Стена N» показывает отделку выбранной стены: либо персональный override,
// либо «как все стены» (общая отделка). Гарантируем контракт данных, на который опирается панель.
function wallFinishSummary(finishes: SketchFinishes | undefined, key: string) {
  const normalized = normalizeFinishes(finishes)
  const override = normalized.wallFinishes[key]
  const surface = override ?? normalized.walls
  return {
    overridden: Boolean(override),
    kind: surface.kind,
    color: surface.kind === 'paint' ? surface.color : null,
  }
}

describe('wall selection panel data', () => {
  const key = sketchWallKey(0, 2)

  it('falls back to the shared wall finish when there is no override', () => {
    const summary = wallFinishSummary(undefined, key)
    expect(summary.overridden).toBe(false)
    expect(summary.kind).toBe('paint')
    expect(summary.color).toBe(DEFAULT_WALL_PAINT)
  })

  it('reports a per-wall paint override', () => {
    const finishes: SketchFinishes = { wallFinishes: { [key]: { kind: 'paint', color: '#123456' } } }
    const summary = wallFinishSummary(finishes, key)
    expect(summary.overridden).toBe(true)
    expect(summary.kind).toBe('paint')
    expect(summary.color).toBe('#123456')
  })

  it('reports a per-wall tile override', () => {
    const finishes: SketchFinishes = { wallFinishes: { [key]: { kind: 'tile', tileColor: '#ffffff' } } }
    const summary = wallFinishSummary(finishes, key)
    expect(summary.overridden).toBe(true)
    expect(summary.kind).toBe('tile')
    expect(summary.color).toBeNull()
  })

  it('does not leak one wall override onto another wall', () => {
    const finishes: SketchFinishes = { wallFinishes: { [sketchWallKey(0, 0)]: { kind: 'tile' } } }
    const summary = wallFinishSummary(finishes, sketchWallKey(0, 1))
    expect(summary.overridden).toBe(false)
    expect(summary.kind).toBe('paint')
  })

  it('produces stable, distinct wall keys per contour segment', () => {
    expect(sketchWallKey(0, 2)).toBe(sketchWallKey(0, 2))
    expect(sketchWallKey(0, 2)).not.toBe(sketchWallKey(0, 3))
    expect(sketchWallKey(0, 2)).not.toBe(sketchWallKey(1, 2))
  })
})
