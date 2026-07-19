import { describe, expect, it } from 'vitest'
import {
  CABINET_MATERIAL_SECTION,
  ELECTRICAL_MATERIAL_SECTION,
  WALL_MATERIAL_SECTION,
  buildCabinetMaterialRows,
  buildElectricalMaterialRows,
  buildSketchContourStats,
  buildWallMaterialsRpcArgs,
  collectSketchMaterialFacts,
} from '../src/screens/project-hub/sketchMaterials'
import {
  BUILTIN_SHOWER_PAN_RECT_CATALOG_ID,
  BUILTIN_OUTLET_CATALOG_ID,
  BUILTIN_SWITCH_CATALOG_ID,
  SKETCH_CATALOG_KIND_SHOWER_PAN,
  SKETCH_CATALOG_KIND_OUTLET,
  SKETCH_CATALOG_KIND_SWITCH,
  type SketchPlacedCatalogItem,
} from '../src/screens/project-hub/sketchCatalog'

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

function cabinet(id: string, code: string): SketchPlacedCatalogItem {
  return {
    id,
    catalogItemId: `builtin-cabinet:${code}`,
    category: 'cabinet',
    code,
    model: code,
    name: code,
    xFt: 1,
    yFt: 1.4375,
    zFt: 1,
    rotationY: 0,
    surface: 'floor',
    widthIn: code.startsWith('W') ? 30 : 36,
    heightIn: code.startsWith('W') ? 30 : 34.5,
    depthIn: code.startsWith('W') ? 12 : 24,
  }
}

describe('sketch material area aggregation', () => {
  it('counts wall tile from the actual finish area minus overlapping openings and leaves paint for the rest', () => {
    const facts = collectSketchMaterialFacts({
      ...rectangleModel,
      openings: [{ kind: 'door', c: 0, s: 0, t: 0.5, w: 3, h: 7 }],
      finishes: {
        walls: { kind: 'paint', color: '#ffffff' },
        wallFinishes: {
          '0:0': { kind: 'tile', tileWIn: 12, tileHIn: 24, groutIn: 0.125 },
        },
      },
    })

    expect(facts.wallAreaSqft).toBe(320)
    expect(facts.openingAreaSqft).toBe(21)
    expect(facts.tileAreas).toHaveLength(1)
    expect(facts.tileAreas[0]).toMatchObject({ key: 'wall:0:0', areaSqft: 59, tileWIn: 12, tileHIn: 24 })
    expect(facts.tileAreaSqft).toBe(59)
    expect(facts.paintAreaSqft).toBe(240)
  })

  it('sums tile finish rectangles and clips them to the wall bounds', () => {
    const facts = collectSketchMaterialFacts({
      ...rectangleModel,
      finishes: {
        walls: { kind: 'paint', color: '#ffffff' },
        wallFinishes: {
          '0:0': {
            kind: 'tile',
            tileWIn: 12,
            tileHIn: 24,
            coverage: {
              mode: 'partial',
              regions: [
                { x0Ft: 1, y0Ft: 1, x1Ft: 4, y1Ft: 3 },
                { x0Ft: 8, y0Ft: 0, x1Ft: 14, y1Ft: 10 },
              ],
            },
          },
        },
      },
    })

    expect(facts.tileAreas).toHaveLength(1)
    expect(facts.tileAreaSqft).toBe(22)
    expect(facts.tileAreas[0].areaSqft).toBe(22)
    expect(facts.paintAreaSqft).toBe(298)
  })

  it('keeps legacy partial wall coverage without regions as a full-width vertical band', () => {
    const facts = collectSketchMaterialFacts({
      ...rectangleModel,
      finishes: {
        walls: { kind: 'paint', color: '#ffffff' },
        wallFinishes: {
          '0:0': {
            kind: 'tile',
            tileWIn: 12,
            tileHIn: 24,
            coverage: { mode: 'partial', bottomFt: 2, heightFt: 3 },
          },
        },
      },
    })

    expect(facts.tileAreaSqft).toBe(30)
    expect(facts.paintAreaSqft).toBe(290)
  })

  it('adds tiled shower pan floor and curb area to sketch tile materials', () => {
    const facts = collectSketchMaterialFacts({
      ...rectangleModel,
      placedItems: [{
        id: 'pan-1',
        catalogItemId: BUILTIN_SHOWER_PAN_RECT_CATALOG_ID,
        kind: SKETCH_CATALOG_KIND_SHOWER_PAN,
        category: 'shower',
        name: 'Shower pan 60 x 32',
        model: SKETCH_CATALOG_KIND_SHOWER_PAN,
        xFt: 2.5,
        yFt: 2 / 12,
        zFt: 1.5,
        rotationY: 0,
        surface: 'floor',
        showerPanShape: 'rect',
        widthIn: 60,
        depthIn: 32,
        heightIn: 4,
        panFinish: {
          kind: 'tile',
          tileWIn: 2,
          tileHIn: 2,
          groutIn: 0.125,
          catalogItemId: 'tile-mosaic',
          catalogItemName: 'Mosaic tile',
        },
      }] satisfies SketchPlacedCatalogItem[],
    })

    expect(facts.tileAreas).toHaveLength(1)
    expect(facts.tileAreas[0]).toMatchObject({
      key: 'shower-pan:pan-1',
      label: 'Shower pan 60 x 32',
      tileWIn: 2,
      tileHIn: 2,
      catalogItemId: 'tile-mosaic',
    })
    expect(facts.tileAreas[0].areaSqft).toBeCloseTo(18.444, 3)
    expect(facts.tileAreaSqft).toBeCloseTo(18.444, 3)
    expect(facts.paintAreaSqft).toBe(320)
  })

  it('sums drywall patch areas from wall finish overrides and clips them to the wall bounds', () => {
    const facts = collectSketchMaterialFacts({
      ...rectangleModel,
      finishes: {
        walls: { kind: 'paint', color: '#ffffff' },
        wallFinishes: {
          '0:1': { kind: 'drywall-patch', xFt: 2, yFt: 1, widthFt: 4, heightFt: 3 },
          '0:2': { kind: 'drywall-patch', xFt: 8, yFt: 6, widthFt: 6, heightFt: 5 },
        },
      },
    })

    expect(facts.patchAreaSqft).toBe(16)
    expect(facts.paintAreaSqft).toBe(320)
  })

  it('groups cabinets by code with dimensions and counts outlet/switch primitives', () => {
    const model = {
      ...rectangleModel,
      placedItems: [
        cabinet('c1', 'B36'),
        cabinet('c2', 'B36'),
        cabinet('c3', 'W3030'),
        {
          id: 'o1',
          catalogItemId: BUILTIN_OUTLET_CATALOG_ID,
          kind: SKETCH_CATALOG_KIND_OUTLET,
          category: 'other',
          name: 'Outlet',
          model: SKETCH_CATALOG_KIND_OUTLET,
          xFt: 1,
          yFt: 1.5,
          zFt: 0,
          rotationY: 0,
          surface: 'wall',
          c: 0,
          s: 0,
          t: 0.2,
        },
        {
          id: 's1',
          catalogItemId: BUILTIN_SWITCH_CATALOG_ID,
          kind: SKETCH_CATALOG_KIND_SWITCH,
          category: 'other',
          name: 'Switch',
          model: SKETCH_CATALOG_KIND_SWITCH,
          xFt: 2,
          yFt: 4,
          zFt: 0,
          rotationY: 0,
          surface: 'wall',
          c: 0,
          s: 0,
          t: 0.4,
        },
      ] satisfies SketchPlacedCatalogItem[],
      switches: [{ id: 'legacy-switch', c: 0, s: 1, t: 0.5 }],
    }

    expect(buildCabinetMaterialRows(model)).toEqual([
      { section: CABINET_MATERIAL_SECTION, name: 'B36', qty: 2, unit: 'ea', note: '36" W × 34 1/2" H × 24" D' },
      { section: CABINET_MATERIAL_SECTION, name: 'W3030', qty: 1, unit: 'ea', note: '30" W × 30" H × 12" D' },
    ])
    expect(buildElectricalMaterialRows(model)).toEqual([
      { section: ELECTRICAL_MATERIAL_SECTION, name: 'Outlet', qty: 1, unit: 'ea', note: null },
      { section: ELECTRICAL_MATERIAL_SECTION, name: 'Switch', qty: 2, unit: 'ea', note: null },
    ])
  })

  it('filters open, empty, and zero-area contours from sketch summaries', () => {
    const stats = buildSketchContourStats({
      cellFt: 1,
      contours: [
        { closed: false, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] },
        { closed: true, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }] },
        { closed: true, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] },
        { closed: true, points: [] },
      ],
    })

    expect(stats.perContour.map((contour) => contour.index)).toEqual([2])
    expect(stats.totalArea).toBe(12)
    expect(stats.totalPerimeter).toBe(14)
  })

  it('builds calc_wall_materials RPC argument names exactly', () => {
    expect(buildWallMaterialsRpcArgs({
      paintAreaSqft: 240,
      patchAreaSqft: 16,
      includePrimer: true,
      includeTexture: false,
    })).toEqual({
      p_paint_area_sqft: 240,
      p_patch_area_sqft: 16,
      p_include_primer: true,
      p_include_texture: false,
    })
  })
})
