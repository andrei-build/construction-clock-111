// Чистая математика вьюпорта/сетки эскиза, вынесенная из SketchTab.tsx.
// Без React/DOM/сайд-эффектов: экранные↔мировые масштабы, fit/zoom/pan, линии сетки.
// Формат модели (version:1) здесь НЕ трогается — используется только геометрия контуров.

export type SketchViewportPoint = { x: number; y: number }
export type SketchViewportContour = { points: SketchViewportPoint[] }
export type SketchViewportModel = { contours: SketchViewportContour[] }

export type CanvasSize = { width: number; height: number }
export type CanvasView = { x: number; y: number; width: number; height: number }

export type SketchBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
  hasPoints: boolean
}

export type SketchGridLines = {
  subX: number[]
  subY: number[]
  majorX: number[]
  majorY: number[]
}

// Геометрия хранится в клетках сетки. Масштаб: 1 клетка = 1 фут.
export const CELL_FT = 1
export const CELL_PX = 32
export const DEFAULT_GRID_COLS = 24
export const DEFAULT_GRID_ROWS = 18
export const VIEW_W = DEFAULT_GRID_COLS * CELL_PX
export const VIEW_H = DEFAULT_GRID_ROWS * CELL_PX
export const MIN_VIEW_CELLS = 4
export const MAX_VIEW_CELLS = 4096
export const MIN_MINOR_GRID_SCREEN_PX = 8

export function sketchBounds(model: SketchViewportModel): SketchBounds {
  const points = model.contours.flatMap((contour) => contour.points)
  if (points.length === 0) {
    return {
      minX: 0,
      maxX: DEFAULT_GRID_COLS,
      minY: 0,
      maxY: DEFAULT_GRID_ROWS,
      width: DEFAULT_GRID_COLS,
      height: DEFAULT_GRID_ROWS,
      hasPoints: false,
    }
  }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(maxX - minX, 0),
    height: Math.max(maxY - minY, 0),
    hasPoints: true,
  }
}

export function canvasAspect(size: CanvasSize): number {
  return size.width > 0 && size.height > 0 ? size.width / size.height : VIEW_W / VIEW_H
}

export function normalizeCanvasView(size: CanvasSize, view: CanvasView): CanvasView {
  const aspect = canvasAspect(size)
  const minWidth = MIN_VIEW_CELLS * CELL_PX
  const maxWidth = MAX_VIEW_CELLS * CELL_PX
  const width = Math.max(minWidth, Math.min(maxWidth, Number.isFinite(view.width) ? view.width : VIEW_W))
  const height = width / aspect
  const cx = Number.isFinite(view.x) && Number.isFinite(view.width) ? view.x + view.width / 2 : 0
  const cy = Number.isFinite(view.y) && Number.isFinite(view.height) ? view.y + view.height / 2 : 0
  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  }
}

export function fitCanvasView(model: SketchViewportModel, size: CanvasSize): CanvasView {
  const bounds = sketchBounds(model)
  const aspect = canvasAspect(size)
  if (!bounds.hasPoints) {
    const width = VIEW_W
    const height = width / aspect
    return normalizeCanvasView(size, {
      x: -width / 2,
      y: -height / 2,
      width,
      height,
    })
  }
  const span = Math.max(bounds.width, bounds.height)
  const padCells = bounds.hasPoints ? Math.max(2, Math.min(8, span * 0.08)) : 0
  const minX = bounds.hasPoints ? bounds.minX - padCells : 0
  const maxX = bounds.hasPoints ? bounds.maxX + padCells : DEFAULT_GRID_COLS
  const minY = bounds.hasPoints ? bounds.minY - padCells : 0
  const maxY = bounds.hasPoints ? bounds.maxY + padCells : DEFAULT_GRID_ROWS
  const boxWidth = Math.max((maxX - minX) * CELL_PX, MIN_VIEW_CELLS * CELL_PX)
  const boxHeight = Math.max((maxY - minY) * CELL_PX, MIN_VIEW_CELLS * CELL_PX)
  const boxAspect = boxWidth / boxHeight
  const width = boxAspect > aspect ? boxWidth : boxHeight * aspect
  const height = width / aspect
  const cx = ((minX + maxX) / 2) * CELL_PX
  const cy = ((minY + maxY) / 2) * CELL_PX
  return normalizeCanvasView(size, {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  })
}

export function canvasViewContainsModel(model: SketchViewportModel, view: CanvasView): boolean {
  const bounds = sketchBounds(model)
  if (!bounds.hasPoints) return true
  const left = view.x / CELL_PX
  const right = (view.x + view.width) / CELL_PX
  const top = view.y / CELL_PX
  const bottom = (view.y + view.height) / CELL_PX
  return bounds.minX >= left && bounds.maxX <= right && bounds.minY >= top && bounds.maxY <= bottom
}

export function gridLinePositions(startPx: number, endPx: number, stepPx: number): number[] {
  const start = Math.floor(startPx / stepPx) - 1
  const end = Math.ceil(endPx / stepPx) + 1
  const count = Math.max(0, end - start + 1)
  return Array.from({ length: count }, (_, i) => (start + i) * stepPx)
}

export function isMajorGridLine(valuePx: number): boolean {
  return Math.abs(valuePx / CELL_PX - Math.round(valuePx / CELL_PX)) < 0.0001
}

export function canvasGridLines(view: CanvasView, snapStepFt: number, pxPerFt: number): SketchGridLines {
  const left = view.x
  const right = view.x + view.width
  const top = view.y
  const bottom = view.y + view.height
  const minorStepPx = Math.max(0.0001, snapStepFt * CELL_PX)
  const includeMinor = snapStepFt < CELL_FT && pxPerFt * snapStepFt >= MIN_MINOR_GRID_SCREEN_PX
  return {
    subX: includeMinor ? gridLinePositions(left, right, minorStepPx).filter((x) => !isMajorGridLine(x)) : [],
    subY: includeMinor ? gridLinePositions(top, bottom, minorStepPx).filter((y) => !isMajorGridLine(y)) : [],
    majorX: gridLinePositions(left, right, CELL_PX),
    majorY: gridLinePositions(top, bottom, CELL_PX),
  }
}
