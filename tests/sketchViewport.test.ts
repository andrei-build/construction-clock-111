import { describe, expect, it } from 'vitest'
import {
  CELL_PX,
  DEFAULT_GRID_COLS,
  DEFAULT_GRID_ROWS,
  MIN_VIEW_CELLS,
  VIEW_H,
  VIEW_W,
  canvasAspect,
  canvasGridLines,
  canvasViewContainsModel,
  fitCanvasView,
  gridLinePositions,
  isMajorGridLine,
  normalizeCanvasView,
  sketchBounds,
  type SketchViewportModel,
} from '../src/screens/project-hub/sketchViewport'

const modelOf = (points: Array<{ x: number; y: number }>): SketchViewportModel => ({
  contours: [{ points }],
})

describe('sketchBounds', () => {
  it('returns default grid bounds for an empty model', () => {
    expect(sketchBounds({ contours: [] })).toEqual({
      minX: 0,
      maxX: DEFAULT_GRID_COLS,
      minY: 0,
      maxY: DEFAULT_GRID_ROWS,
      width: DEFAULT_GRID_COLS,
      height: DEFAULT_GRID_ROWS,
      hasPoints: false,
    })
  })

  it('computes min/max/width/height across all contour points', () => {
    const model = modelOf([
      { x: 2, y: 3 },
      { x: 10, y: 3 },
      { x: 10, y: 9 },
      { x: 2, y: 9 },
    ])
    expect(sketchBounds(model)).toEqual({
      minX: 2,
      maxX: 10,
      minY: 3,
      maxY: 9,
      width: 8,
      height: 6,
      hasPoints: true,
    })
  })

  it('handles a single point (zero-size bounds) as hasPoints', () => {
    expect(sketchBounds(modelOf([{ x: -4, y: -7 }]))).toEqual({
      minX: -4,
      maxX: -4,
      minY: -7,
      maxY: -7,
      width: 0,
      height: 0,
      hasPoints: true,
    })
  })

  it('spans multiple contours', () => {
    const model: SketchViewportModel = {
      contours: [
        { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { points: [{ x: -5, y: 4 }, { x: 8, y: -2 }] },
      ],
    }
    const bounds = sketchBounds(model)
    expect(bounds.minX).toBe(-5)
    expect(bounds.maxX).toBe(8)
    expect(bounds.minY).toBe(-2)
    expect(bounds.maxY).toBe(4)
  })
})

describe('canvasAspect', () => {
  it('returns width/height for a positive size', () => {
    expect(canvasAspect({ width: 800, height: 400 })).toBe(2)
  })

  it('falls back to the default view aspect for a zero size', () => {
    expect(canvasAspect({ width: 0, height: 0 })).toBe(VIEW_W / VIEW_H)
  })

  it('falls back for negative dimensions', () => {
    expect(canvasAspect({ width: -10, height: 5 })).toBe(VIEW_W / VIEW_H)
  })
})

describe('normalizeCanvasView', () => {
  it('keeps a well-formed square view centered and unchanged', () => {
    const size = { width: 800, height: 800 } // aspect 1
    const view = normalizeCanvasView(size, { x: -100, y: -100, width: 200, height: 200 })
    expect(view).toEqual({ x: -100, y: -100, width: 200, height: 200 })
  })

  it('clamps the width up to the minimum view span and recenters', () => {
    const size = { width: 100, height: 100 } // aspect 1
    const minWidth = MIN_VIEW_CELLS * CELL_PX // 128
    const view = normalizeCanvasView(size, { x: 0, y: 0, width: 1, height: 1 })
    expect(view.width).toBe(minWidth)
    expect(view.height).toBe(minWidth)
    // original center was (0.5, 0.5)
    expect(view.x).toBeCloseTo(0.5 - minWidth / 2)
    expect(view.y).toBeCloseTo(0.5 - minWidth / 2)
  })

  it('recomputes height from the target aspect', () => {
    const size = { width: 800, height: 400 } // aspect 2
    const view = normalizeCanvasView(size, { x: 0, y: 0, width: 400, height: 999 })
    expect(view.width).toBe(400)
    expect(view.height).toBe(200)
  })

  it('falls back to VIEW_W width when view.width is not finite', () => {
    const size = { width: 100, height: 100 } // aspect 1
    const view = normalizeCanvasView(size, { x: 0, y: 0, width: Number.NaN, height: 0 })
    expect(view.width).toBe(VIEW_W)
    // non-finite width => center falls back to 0
    expect(view.x).toBe(-VIEW_W / 2)
  })
})

describe('fitCanvasView', () => {
  it('fits an empty model to a centered default view', () => {
    const view = fitCanvasView({ contours: [] }, { width: VIEW_W, height: VIEW_H })
    expect(view).toEqual({ x: -VIEW_W / 2, y: -VIEW_H / 2, width: VIEW_W, height: VIEW_H })
  })

  it('centers the fitted view on the model bounding box', () => {
    const model = modelOf([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ])
    const view = fitCanvasView(model, { width: 800, height: 600 })
    const cx = view.x + view.width / 2
    const cy = view.y + view.height / 2
    // model center is (10, 5) cells => (320, 160) px
    expect(cx).toBeCloseTo(10 * CELL_PX)
    expect(cy).toBeCloseTo(5 * CELL_PX)
  })
})

describe('canvasViewContainsModel', () => {
  it('always contains an empty model', () => {
    expect(canvasViewContainsModel({ contours: [] }, { x: 0, y: 0, width: 32, height: 32 })).toBe(true)
  })

  it('is true when the model fits inside the view', () => {
    const model = modelOf([{ x: 2, y: 2 }, { x: 4, y: 4 }])
    // view covers cells [0,10] x [0,10]
    const view = { x: 0, y: 0, width: 10 * CELL_PX, height: 10 * CELL_PX }
    expect(canvasViewContainsModel(model, view)).toBe(true)
  })

  it('is false when the model extends beyond the view', () => {
    const model = modelOf([{ x: 2, y: 2 }, { x: 40, y: 4 }])
    const view = { x: 0, y: 0, width: 10 * CELL_PX, height: 10 * CELL_PX }
    expect(canvasViewContainsModel(model, view)).toBe(false)
  })
})

describe('gridLinePositions', () => {
  it('returns padded aligned positions across the range', () => {
    expect(gridLinePositions(0, 64, 32)).toEqual([-32, 0, 32, 64, 96])
  })

  it('handles a range smaller than one step', () => {
    expect(gridLinePositions(0, 1, 32)).toEqual([-32, 0, 32, 64])
  })
})

describe('isMajorGridLine', () => {
  it('is true on cell boundaries', () => {
    expect(isMajorGridLine(0)).toBe(true)
    expect(isMajorGridLine(CELL_PX)).toBe(true)
    expect(isMajorGridLine(-2 * CELL_PX)).toBe(true)
  })

  it('is false between cell boundaries', () => {
    expect(isMajorGridLine(CELL_PX / 2)).toBe(false)
  })
})

describe('canvasGridLines', () => {
  it('emits only major lines when the snap step is a full cell', () => {
    const grid = canvasGridLines({ x: 0, y: 0, width: 64, height: 32 }, 1, 1000)
    expect(grid.subX).toEqual([])
    expect(grid.subY).toEqual([])
    expect(grid.majorX).toEqual([-32, 0, 32, 64, 96])
    expect(grid.majorY).toEqual([-32, 0, 32, 64])
  })

  it('adds minor lines (excluding coincident majors) when zoomed in enough', () => {
    const grid = canvasGridLines({ x: 0, y: 0, width: 64, height: 0 }, 0.5, 100)
    expect(grid.subX).toEqual([-16, 16, 48, 80])
  })

  it('suppresses minor lines when they would be too dense on screen', () => {
    // pxPerFt * snapStepFt = 4 < MIN_MINOR_GRID_SCREEN_PX (8) => no minors
    const grid = canvasGridLines({ x: 0, y: 0, width: 64, height: 32 }, 0.5, 8)
    expect(grid.subX).toEqual([])
    expect(grid.subY).toEqual([])
  })
})
