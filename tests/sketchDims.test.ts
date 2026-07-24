import { describe, expect, it } from 'vitest'
import {
  buildBlueprintDimensionLayout,
  collectBlueprintAxes,
  formatBlueprintLengthFt,
  type SketchDimModel,
} from '../src/lib/sketchDims'

const roomWithBearingAxes = (): SketchDimModel => ({
  cellFt: 1,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 12, y: 0 },
        { x: 12, y: 8 },
        { x: 0, y: 8 },
      ],
    },
    { closed: false, points: [{ x: 4, y: 0 }, { x: 4, y: 8 }] },
    { closed: false, points: [{ x: 0, y: 3 }, { x: 12, y: 3 }] },
  ],
  openings: [
    { c: 0, s: 0, t: 0.25 },
    { c: 0, s: 3, t: 0.5 },
  ],
})

describe('formatBlueprintLengthFt', () => {
  it('formats blueprint feet/inches as 3\'-6 1/2"', () => {
    expect(formatBlueprintLengthFt(3 + 6.5 / 12)).toBe('3\'-6 1/2"')
  })
})

describe('buildBlueprintDimensionLayout', () => {
  it('lays out three dimension rows on each side from near to far', () => {
    const layout = buildBlueprintDimensionLayout(roomWithBearingAxes(), { cellPx: 32, screenWorldPx: 1 })
    const topRows = new Set(layout.dimensions.filter((line) => line.side === 'top').map((line) => line.row))
    expect(topRows).toEqual(new Set(['openingsAxes', 'segments', 'overall']))

    const firstByRow = (row: 'openingsAxes' | 'segments' | 'overall') =>
      layout.dimensions.find((line) => line.side === 'top' && line.row === row)

    expect(firstByRow('openingsAxes')?.y1).toBe(-36)
    expect(firstByRow('segments')?.y1).toBe(-64)
    expect(firstByRow('overall')?.y1).toBe(-92)
    expect(firstByRow('overall')?.text).toBe('12\'-0"')
  })

  it('includes opening centers and axes in the nearest row', () => {
    const layout = buildBlueprintDimensionLayout(roomWithBearingAxes(), { cellPx: 32, screenWorldPx: 1 })
    const topNearest = layout.dimensions.filter((line) => line.side === 'top' && line.row === 'openingsAxes')
    expect(topNearest.map((line) => [line.from, line.to])).toEqual([
      [0, 3],
      [3, 4],
      [4, 12],
    ])
  })
})

describe('collectBlueprintAxes', () => {
  it('numbers vertical wall axes left-to-right and horizontal wall axes top-to-bottom', () => {
    const axes = collectBlueprintAxes(roomWithBearingAxes())
    expect(axes.vertical.map((axis) => axis.label)).toEqual(['1', '2', '3'])
    expect(axes.vertical.map((axis) => axis.position)).toEqual([0, 4, 12])
    expect(axes.horizontal.map((axis) => axis.label)).toEqual(['A', 'B', 'C'])
    expect(axes.horizontal.map((axis) => axis.position)).toEqual([0, 3, 8])
  })

  it('keeps axis bubbles attached to bearing wall segment sources', () => {
    const axes = collectBlueprintAxes(roomWithBearingAxes())
    const interiorVertical = axes.vertical.find((axis) => axis.position === 4)
    const interiorHorizontal = axes.horizontal.find((axis) => axis.position === 3)

    expect(interiorVertical?.sources).toEqual([
      { c: 1, s: 0, a: { x: 4, y: 0 }, b: { x: 4, y: 8 } },
    ])
    expect(interiorHorizontal?.sources).toEqual([
      { c: 2, s: 0, a: { x: 0, y: 3 }, b: { x: 12, y: 3 } },
    ])
  })
})
