import { describe, expect, it } from 'vitest'
import {
  resolveOpeningTrim,
  sanitizeOpeningTrim,
  summarizeTrimMaterials,
} from '../src/screens/project-hub/trimCatalog'
import {
  TRIM_MATERIAL_SECTION,
  buildTrimMaterialRows,
} from '../src/screens/project-hub/sketchMaterials'
import { sanitizeSketchOpenings } from '../src/screens/project-hub/sketchFinishes'

const rectangleModel = {
  version: 1 as const,
  cellFt: 1,
  height: 8,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    },
  ],
  openings: [],
}

describe('trim material linear feet', () => {
  it('gives a single window casing on 3 sides + header on top with 10% waste', () => {
    const rows = summarizeTrimMaterials([{ kind: 'window', widthFt: 3, heightFt: 4 }], 10)
    expect(rows.map((row) => row.profileId)).toEqual(['casing-2_5', 'header-5'])
    // casing = left(4) + right(4) + bottom(3) = 11 ft; header = top(3) ft
    expect(rows[0].rawLnft).toBeCloseTo(11, 6)
    expect(rows[0].lnft).toBeCloseTo(12.1, 6)
    expect(rows[1].rawLnft).toBeCloseTo(3, 6)
    expect(rows[1].lnft).toBeCloseTo(3.3, 6)
  })

  it('gives a door casing + header but no stool (no window sill trim)', () => {
    const rows = summarizeTrimMaterials([{ kind: 'door', widthFt: 3, heightFt: 7 }], 10)
    expect(rows.map((row) => row.kind)).toEqual(['casing', 'header'])
    expect(rows.find((row) => row.kind === 'stool')).toBeUndefined()
    // casing = left(7) + right(7) = 14 ft; header = top(3) ft
    expect(rows[0].rawLnft).toBeCloseTo(14, 6)
    expect(rows[1].rawLnft).toBeCloseTo(3, 6)
  })

  it('sums trim across several openings by profile/kind', () => {
    const rows = summarizeTrimMaterials(
      [
        { kind: 'window', widthFt: 3, heightFt: 4 },
        { kind: 'window', widthFt: 3, heightFt: 4 },
      ],
      0,
    )
    expect(rows[0].rawLnft).toBeCloseTo(22, 6)
    expect(rows[0].lnft).toBeCloseTo(22, 6)
    expect(rows[1].rawLnft).toBeCloseTo(6, 6)
  })

  it('uses the stool preset to move the bottom side from casing to stool', () => {
    const rows = summarizeTrimMaterials(
      [{ kind: 'window', trim: { presetId: 'window-stool' }, widthFt: 3, heightFt: 4 }],
      0,
    )
    expect(rows.map((row) => row.kind)).toEqual(['casing', 'header', 'stool'])
    // casing = left(4) + right(4) = 8; header = top(3); stool = bottom(3)
    expect(rows.find((row) => row.kind === 'casing')!.rawLnft).toBeCloseTo(8, 6)
    expect(rows.find((row) => row.kind === 'stool')!.rawLnft).toBeCloseTo(3, 6)
  })

  it('honours a per-side override that disables one side', () => {
    const rows = summarizeTrimMaterials(
      [{ kind: 'window', trim: { sides: { bottom: { profileId: 'casing-2_5', enabled: false } } }, widthFt: 3, heightFt: 4 }],
      0,
    )
    // bottom casing removed → casing = left(4) + right(4) = 8
    expect(rows.find((row) => row.kind === 'casing')!.rawLnft).toBeCloseTo(8, 6)
  })

  it('resolves an empty trim into the default preset (tap → auto-select)', () => {
    const sides = resolveOpeningTrim('window')
    expect(sides.map((side) => `${side.side}:${side.profileId}:${side.enabled}`)).toEqual([
      'top:header-5:true',
      'left:casing-2_5:true',
      'right:casing-2_5:true',
      'bottom:casing-2_5:true',
    ])
    expect(resolveOpeningTrim('door').some((side) => side.side === 'bottom')).toBe(false)
  })

  it('builds trim material rows from a sketch model with a window', () => {
    const rows = buildTrimMaterialRows(
      { ...rectangleModel, openings: [{ kind: 'window', c: 0, s: 0, t: 0.5, w: 3, h: 4, sill: 3 }] },
      { wastePct: 10 },
    )
    expect(rows.every((row) => row.section === TRIM_MATERIAL_SECTION)).toBe(true)
    expect(rows.every((row) => row.unit === 'lnft')).toBe(true)
    const casing = rows.find((row) => row.name.startsWith('Casing'))
    const header = rows.find((row) => row.name.startsWith('Header'))
    expect(casing?.qty).toBeCloseTo(12.1, 6)
    expect(header?.qty).toBeCloseTo(3.3, 6)
  })
})

describe('trim sanitize round-trip', () => {
  it('keeps a known preset and side override, drops unknown sides/profiles', () => {
    expect(
      sanitizeOpeningTrim({
        presetId: 'window-stool',
        sides: {
          top: { profileId: 'header-5', enabled: true },
          bogus: { profileId: 'header-5' },
          left: { profileId: 'not-a-profile' },
        },
      }),
    ).toEqual({ presetId: 'window-stool', sides: { top: { profileId: 'header-5', enabled: true } } })
  })

  it('drops an unknown preset and defaults side enabled to true', () => {
    expect(sanitizeOpeningTrim({ presetId: 'nope' })).toBeUndefined()
    expect(sanitizeOpeningTrim({ sides: { left: { profileId: 'unknown' } } })).toBeUndefined()
    expect(sanitizeOpeningTrim({ sides: { left: { profileId: 'casing-2_5' } } })).toEqual({
      sides: { left: { profileId: 'casing-2_5', enabled: true } },
    })
  })

  it('preserves opening trim through sanitizeSketchOpenings (save/load round-trip)', () => {
    const [opening] = sanitizeSketchOpenings([
      { kind: 'window', c: 0, s: 0, t: 0.5, w: 3, h: 4, sill: 3, trim: { presetId: 'window-stool' } },
    ])
    expect(opening.trim).toEqual({ presetId: 'window-stool' })
  })
})
