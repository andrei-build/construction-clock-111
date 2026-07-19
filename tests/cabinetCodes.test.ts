import { describe, expect, it } from 'vitest'
import {
  CABINET_MIN_FILLER_IN,
  cabinetScheduleCsv,
  layoutCabinetRunOnWall,
  parseCabinetCode,
  parseCabinetCodes,
  suggestCabinetCodes,
} from '../src/screens/project-hub/cabinetCodes'
import { sanitizePlacedCatalogItems } from '../src/screens/project-hub/sketchCatalog'

const sixFootWallModel = {
  version: 1 as const,
  cellFt: 1,
  height: 8,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 5 },
        { x: 0, y: 5 },
      ],
    },
  ],
  openings: [],
}

const firstWall = { c: 0, s: 0, a: { x: 0, y: 0 }, b: { x: 6, y: 0 } }

describe('cabinet code parsing', () => {
  it('parses common ProKitchen/2020-style base, drawer, wall, vanity, filler, and panel codes', () => {
    expect(parseCabinetCode('2DB27-R')).toMatchObject({
      code: '2DB27-R',
      prefix: '2DB',
      widthIn: 27,
      depthIn: 24,
      heightIn: 34.5,
      layer: 'base',
      hinge: 'R',
    })
    expect(parseCabinetCode('W3030')).toMatchObject({ prefix: 'W', widthIn: 30, heightIn: 30, depthIn: 12, layer: 'wall' })
    expect(parseCabinetCode('W2442-L')).toMatchObject({ prefix: 'W', widthIn: 24, heightIn: 42, hinge: 'L', layer: 'wall' })
    expect(parseCabinetCode('U189024')).toMatchObject({ prefix: 'U', widthIn: 18, heightIn: 90, depthIn: 24, layer: 'base' })
    expect(parseCabinetCode('V30-L')).toMatchObject({ prefix: 'V', widthIn: 30, depthIn: 21, hinge: 'L' })
    expect(parseCabinetCode('BF3')).toMatchObject({ prefix: 'BF', widthIn: 3, filler: true, layer: 'base' })
    expect(parseCabinetCode('BEP24-3/4')).toMatchObject({ prefix: 'BEP', widthIn: 0.75, depthIn: 24, panel: true })
    expect(parseCabinetCode('WINE.24')).toMatchObject({ prefix: 'WINE', widthIn: 24, depthIn: 24, layer: 'base' })
  })

  it('keeps invalid tokens separate from parsed cabinets', () => {
    const parsed = parseCabinetCodes('B30 nope W3030')

    expect(parsed.cabinets.map((cabinet) => cabinet.code)).toEqual(['B30', 'W3030'])
    expect(parsed.invalidCodes).toEqual(['NOPE'])
  })

  it('normalizes lower-case cabinet codes', () => {
    expect(parseCabinetCode('b30')).toMatchObject({ code: 'B30', prefix: 'B', widthIn: 30 })
    expect(parseCabinetCode('w3030-l')).toMatchObject({ code: 'W3030-L', prefix: 'W', widthIn: 30, heightIn: 30, hinge: 'L' })
  })

  it('joins a prefix and width split by whitespace', () => {
    const parsed = parseCabinetCodes('b 30 sb 36')

    expect(parsed.cabinets.map((cabinet) => cabinet.code)).toEqual(['B30', 'SB36'])
    expect(parsed.invalidCodes).toEqual([])
  })

  it('transliterates Cyrillic lookalikes before parsing', () => {
    expect(parseCabinetCodes('вб 36').cabinets.map((cabinet) => cabinet.code)).toEqual(['SB36'])
    expect(parseCabinetCode('ВЗО')).toMatchObject({ code: 'B30', prefix: 'B', widthIn: 30 })
  })

  it('uses commas and whitespace as cabinet run separators', () => {
    const parsed = parseCabinetCodes('b30, sb36 W3030')

    expect(parsed.cabinets.map((cabinet) => cabinet.code)).toEqual(['B30', 'SB36', 'W3030'])
    expect(parsed.invalidCodes).toEqual([])
  })

  it('offers valid candidates for unrecognized cabinet codes', () => {
    const suggestions = suggestCabinetCodes('x30')
    const parsed = parseCabinetCodes('x30')

    expect(suggestions).toEqual(expect.arrayContaining(['B30', 'DB30', 'W3030']))
    expect(parsed.suggestions.X30).toEqual(expect.arrayContaining(['B30', 'DB30', 'W3030']))
  })
})

describe('cabinet wall layout', () => {
  it('lays out base cabinets end-to-end and fills the remaining wall width', () => {
    const layout = layoutCabinetRunOnWall(sixFootWallModel, firstWall, 'B30 2DB27', 'test-run')

    expect(layout.overflow).toBe(false)
    expect(layout.items.map((item) => item.code)).toEqual(['B30', '2DB27', 'BF15'])
    expect(layout.items[2]).toMatchObject({ filler: true, widthIn: 15 })
    expect(layout.items[2].layoutWarning).toBeUndefined()
    expect(layout.items.map((item) => Math.round((item.t ?? 0) * 72))).toEqual([15, 44, 65])
  })

  it('keeps base and wall layers in separate runs on the same wall', () => {
    const layout = layoutCabinetRunOnWall(sixFootWallModel, firstWall, 'B30 W3030', 'test-run')
    const base = layout.items.filter((item) => item.layer === 'base')
    const wall = layout.items.filter((item) => item.layer === 'wall')

    expect(base.map((item) => item.code)).toEqual(['B30', 'BF42'])
    expect(wall.map((item) => item.code)).toEqual(['W3030', 'F42'])
    expect(wall[0]).toMatchObject({ surface: 'wall', yFt: 5.75, depthIn: 12 })
  })

  it('marks overflow and does not generate fillers when a layer exceeds the wall', () => {
    const layout = layoutCabinetRunOnWall(sixFootWallModel, firstWall, 'B48 B30', 'test-run')

    expect(layout.overflow).toBe(true)
    expect(layout.items).toHaveLength(2)
    expect(layout.items[1]).toMatchObject({ layoutWarning: 'overflow' })
  })

  it('marks generated fillers under the minimum filler width', () => {
    const layout = layoutCabinetRunOnWall(sixFootWallModel, firstWall, 'B69.5', 'test-run')

    expect(layout.smallFiller).toBe(true)
    expect(layout.items[1]).toMatchObject({ filler: true, widthIn: 2.5, layoutWarning: 'small-filler' })
    expect(layout.items[1].widthIn).toBeLessThan(CABINET_MIN_FILLER_IN)
  })

  it('preserves generated cabinet metadata through sanitation and CSV export', () => {
    const layout = layoutCabinetRunOnWall(sixFootWallModel, firstWall, 'B30-L', 'test-run')
    const clean = sanitizePlacedCatalogItems(layout.items)
    const csv = cabinetScheduleCsv(clean)

    expect(clean[0]).toMatchObject({
      code: 'B30-L',
      model: 'B30-L',
      cabinetPrefix: 'B',
      wallId: '0:0',
      layer: 'base',
      hinge: 'L',
      category: 'cabinet',
    })
    expect(csv).toContain('wall_id,layer,code,name,width_in,depth_in,height_in,hinge,filler,warning')
    expect(csv).toContain('0:0,base,B30-L,B30-L,30,24,34.5,L,,')
  })
})
