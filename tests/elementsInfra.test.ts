import { describe, expect, it } from 'vitest'
import {
  columnObstacleIntervalOnWall,
  electricalDefaultCenterIn,
  electricalDims,
  freeRunsAlongWall,
  infraCenterFloorIn,
  pipeDefaultCenterIn,
  pipeDims,
} from '../src/screens/project-hub/elements'
import { layoutCabinetRunOnWall } from '../src/screens/project-hub/cabinetCodes'
import { sanitizePlacedCatalogItems } from '../src/screens/project-hub/sketchCatalog'

// ELEMENTS-INFRA-26: инженерка-разметка — round-trip новых kind через sanitize (version:1 цел),
// геометрия «колонна режет ряд», живой размер электрики «от пола».

const tenFootWallModel = {
  version: 1 as const,
  cellFt: 1,
  height: 8,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
    },
  ],
  openings: [],
}
const firstWall = { c: 0, s: 0, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }

describe('sanitizePlacedCatalogItems: new infra kinds round-trip (version:1)', () => {
  const base = { xFt: 1, yFt: 1.5, zFt: 1, rotationY: 0, surface: 'wall' as const }

  it('keeps outlet variant (single/double) through save/reload', () => {
    const [placed] = sanitizePlacedCatalogItems([{ id: 'o1', catalogItemId: 'builtin-outlet', kind: 'OUTLET', variant: 'double', widthIn: 5.5, depthIn: 1, heightIn: 4.5, ...base }])
    expect(placed.kind).toBe('OUTLET')
    expect(placed.variant).toBe('double')
    const [reloaded] = sanitizePlacedCatalogItems([placed])
    expect(reloaded.variant).toBe('double')
    expect(reloaded.widthIn).toBe(5.5)
  })

  it('keeps pipe kind (water/gas) through save/reload', () => {
    const [placed] = sanitizePlacedCatalogItems([{ id: 'p1', catalogItemId: 'builtin-pipe', kind: 'PIPE', pipe: 'gas', widthIn: 14, depthIn: 1, heightIn: 3, ...base }])
    expect(placed.kind).toBe('PIPE')
    expect(placed.pipe).toBe('gas')
    expect(sanitizePlacedCatalogItems([placed])[0].pipe).toBe('gas')
  })

  it('keeps column shape (round) + box kind on floor objects', () => {
    const [column] = sanitizePlacedCatalogItems([{ id: 'c1', catalogItemId: 'builtin-column', kind: 'COLUMN', column: 'round', widthIn: 12, depthIn: 12, heightIn: 96, xFt: 2, yFt: 4, zFt: 2, rotationY: 0, surface: 'floor' }])
    expect(column.kind).toBe('COLUMN')
    expect(column.column).toBe('round')
    const [box] = sanitizePlacedCatalogItems([{ id: 'b1', catalogItemId: 'builtin-box', kind: 'BOX', widthIn: 24, depthIn: 18, heightIn: 36, xFt: 2, yFt: 1.5, zFt: 2, rotationY: 0, surface: 'floor' }])
    expect(box.kind).toBe('BOX')
  })

  it('rejects invalid variant/pipe/column values but keeps the item', () => {
    const [placed] = sanitizePlacedCatalogItems([{ id: 'o2', catalogItemId: 'builtin-outlet', kind: 'OUTLET', variant: 'triple', pipe: 'lava', column: 'hex', ...base, widthIn: 3, depthIn: 1, heightIn: 4.5 }])
    expect(placed.variant).toBeUndefined()
    expect(placed.pipe).toBeUndefined()
    expect(placed.column).toBeUndefined()
    expect(placed.kind).toBe('OUTLET')
  })

  it('old sketches (no new fields) still load', () => {
    const [placed] = sanitizePlacedCatalogItems([{ id: 'x', catalogItemId: 'builtin-outlet', kind: 'OUTLET', ...base }])
    expect(placed.variant).toBeUndefined()
    expect(placed.pipe).toBeUndefined()
  })
})

describe('elements presets: electrical + pipe dims and floor height', () => {
  it('single vs double electrical widths differ, single is narrower', () => {
    expect(electricalDims('double').widthIn).toBeGreaterThan(electricalDims('single').widthIn)
    expect(electricalDims('single').heightIn).toBeGreaterThan(0)
  })

  it('outlet default center is lower than switch default center (AFF)', () => {
    expect(electricalDefaultCenterIn('outlet')).toBeLessThan(electricalDefaultCenterIn('switch'))
  })

  it('infraCenterFloorIn = yFt * 12 (высота от пола)', () => {
    expect(infraCenterFloorIn({ yFt: 4 })).toBeCloseTo(48, 5)
    expect(infraCenterFloorIn({ yFt: 1.5 })).toBeCloseTo(18, 5)
  })

  it('pipe presets expose positive dims + floor center', () => {
    expect(pipeDims('water-v').heightIn).toBeGreaterThan(pipeDims('water-h').heightIn)
    expect(pipeDefaultCenterIn('gas')).toBeGreaterThan(0)
  })
})

describe('columnObstacleIntervalOnWall: projection onto wall axis', () => {
  const wall = { ax: 0, az: 0, bx: 10, bz: 0 }

  it('projects a near-wall 12in column to a ~12in blocked interval', () => {
    const interval = columnObstacleIntervalOnWall(wall, { xFt: 46 / 12, zFt: 0.5, widthFt: 1, depthFt: 1, rotationY: 0 })
    expect(interval).not.toBeNull()
    expect(interval!.startIn).toBeCloseTo(40, 3)
    expect(interval!.endIn).toBeCloseTo(52, 3)
  })

  it('returns null for an obstacle far from the wall', () => {
    expect(columnObstacleIntervalOnWall(wall, { xFt: 4, zFt: 8, widthFt: 1, depthFt: 1, rotationY: 0 })).toBeNull()
  })
})

describe('freeRunsAlongWall: subtract obstacles', () => {
  it('splits the wall into free runs around one obstacle', () => {
    const runs = freeRunsAlongWall(120, [{ startIn: 40, endIn: 52 }])
    expect(runs).toEqual([{ startIn: 0, endIn: 40 }, { startIn: 52, endIn: 120 }])
  })

  it('merges overlapping obstacles and clips to the wall', () => {
    const runs = freeRunsAlongWall(120, [{ startIn: 30, endIn: 60 }, { startIn: 50, endIn: 70 }, { startIn: 200, endIn: 260 }])
    expect(runs).toEqual([{ startIn: 0, endIn: 30 }, { startIn: 70, endIn: 120 }])
  })

  it('no obstacle → whole wall is one run', () => {
    expect(freeRunsAlongWall(120, [])).toEqual([{ startIn: 0, endIn: 120 }])
  })
})

describe('layoutCabinetRunOnWall: a column cuts the cabinet row', () => {
  const obstacle = [{ startIn: 40, endIn: 52 }]

  const spanIn = (item: { t?: number; widthIn?: number }) => {
    const center = (item.t ?? 0) * 120
    const half = (Number(item.widthIn) || 0) / 2
    return { start: center - half, end: center + half }
  }

  it('without the column, cabinet 2 straddles [40,52]', () => {
    const layout = layoutCabinetRunOnWall(tenFootWallModel, firstWall, 'B24 B24 B24')
    const base = layout.items.filter((i) => i.layer === 'base')
    const spans = base.map(spanIn).sort((a, b) => a.start - b.start)
    // second cabinet spans 24..48 → overlaps the future column interval 40..52
    expect(spans[1].start).toBeLessThan(52)
    expect(spans[1].end).toBeGreaterThan(40)
  })

  it('with the column, no base cabinet overlaps the blocked interval', () => {
    const layout = layoutCabinetRunOnWall(tenFootWallModel, firstWall, 'B24 B24 B24', undefined, obstacle)
    const base = layout.items.filter((i) => i.layer === 'base')
    expect(base).toHaveLength(3)
    base.forEach((item) => {
      const { start, end } = spanIn(item)
      // не пересекает (40,52): либо целиком слева, либо целиком справа
      expect(start >= 52 - 0.01 || end <= 40 + 0.01).toBe(true)
    })
  })

  it('a cabinet that no longer fits before the column jumps past it', () => {
    const layout = layoutCabinetRunOnWall(tenFootWallModel, firstWall, 'B24 B24 B24', undefined, obstacle)
    const base = layout.items.filter((i) => i.layer === 'base').map(spanIn).sort((a, b) => a.start - b.start)
    expect(base[0].start).toBeCloseTo(0, 2)
    // второй шкаф не влез в [0,40] → начинается сразу после колонны (52)
    expect(base[1].start).toBeCloseTo(52, 2)
  })
})
