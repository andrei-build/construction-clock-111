import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DRYWALL_PATCH_COLOR,
  DEFAULT_WALL_PAINT,
  cleanColor,
  normalizeFinishes,
  sanitizeSketchFinishes,
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
    color: surface.kind === 'paint'
      ? surface.color
      : surface.kind === 'drywall-patch'
        ? cleanColor(surface.patchColor, DEFAULT_DRYWALL_PATCH_COLOR)
        : null,
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

  it('keeps drywall patch wall overrides in version-1 finish JSON', () => {
    const finishes = sanitizeSketchFinishes({
      wallFinishes: {
        [key]: {
          kind: 'drywall-patch',
          baseColor: '#123456',
          patchColor: '#abcdef',
          xFt: 1,
          yFt: 2,
          widthFt: 3,
          heightFt: 4,
          ignored: true,
        },
      },
    })

    expect(finishes?.wallFinishes?.[key]).toEqual({
      kind: 'drywall-patch',
      baseColor: '#123456',
      patchColor: '#abcdef',
      xFt: 1,
      yFt: 2,
      widthFt: 3,
      heightFt: 4,
    })
  })

  it('reports a per-wall drywall patch override', () => {
    const finishes: SketchFinishes = { wallFinishes: { [key]: { kind: 'drywall-patch', patchColor: DEFAULT_DRYWALL_PATCH_COLOR } } }
    const summary = wallFinishSummary(finishes, key)
    expect(summary.overridden).toBe(true)
    expect(summary.kind).toBe('drywall-patch')
    expect(summary.color).toBe(DEFAULT_DRYWALL_PATCH_COLOR)
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
