// SKETCH-EDIT-MODEL-51: чистое ядро режима редактирования 2D-эскиза (без React/DOM).
// Отвечает за: тип режима 'select'|'draw', переходы между режимами, hit-test «что под точкой»
// (узел > стена > комната) и порог магнит-снапа между комнатами. SketchTab держит React-состояние
// и рендер, а решения «клик выделяет или создаёт узел» и «что выбрано под курсором» берёт отсюда —
// единый источник правды, покрытый юнит-тестами.

export type SketchEditMode = 'select' | 'draw'

export type EditPoint = { x: number; y: number }
export type EditContour = { points: EditPoint[]; closed: boolean }
export type EditModel = { contours: EditContour[] }

export type SketchHit =
  | { kind: 'node'; c: number; p: number; distance: number }
  | { kind: 'wall'; c: number; s: number; t: number; distance: number }
  | { kind: 'room'; c: number }

export type SketchHitOptions = {
  // Радиусы попадания в клетках модели (единица сетки), НЕ в пикселях.
  nodeRadiusCells: number
  wallRadiusCells: number
}

// ── Переходы режима ────────────────────────────────────────────────────────────
// Дефолт всегда «Выбор/Перемещение» (стрелка). Рисование — отдельный явный инструмент,
// из которого возвращаемся в «Выбор» по замыканию контура / Esc / кнопке «Готово».

export const DEFAULT_EDIT_MODE: SketchEditMode = 'select'

export function enterDraw(): SketchEditMode {
  return 'draw'
}

export function finishDraw(): SketchEditMode {
  return 'select'
}

export function escapeDraw(_mode?: SketchEditMode): SketchEditMode {
  // Esc из любого состояния рисования гарантированно возвращает в «Выбор».
  return 'select'
}

export function toggleEditMode(mode: SketchEditMode): SketchEditMode {
  return mode === 'draw' ? 'select' : 'draw'
}

// ── Решение «клик создаёт узел или выделяет» ───────────────────────────────────

export function clickCreatesNode(mode: SketchEditMode): boolean {
  return mode === 'draw'
}

export function clickSelects(mode: SketchEditMode): boolean {
  return mode === 'select'
}

export function isDrawMode(mode: SketchEditMode): boolean {
  return mode === 'draw'
}

// ── Геометрия (чистая) ─────────────────────────────────────────────────────────

function distance(a: EditPoint, b: EditPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function projectSegmentT(p: EditPoint, a: EditPoint, b: EditPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 <= 1e-9) return 0
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
}

function distanceToSegment(p: EditPoint, a: EditPoint, b: EditPoint): { distance: number; t: number } {
  const t = projectSegmentT(p, a, b)
  const proj = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  return { distance: distance(p, proj), t }
}

// Сегменты контура: [0..n-2] между соседними точками + замыкающий [n-1] если contour.closed.
export function eachEditSegment(contour: EditContour): Array<{ s: number; a: EditPoint; b: EditPoint }> {
  const out: Array<{ s: number; a: EditPoint; b: EditPoint }> = []
  for (let s = 0; s < contour.points.length - 1; s += 1) {
    out.push({ s, a: contour.points[s], b: contour.points[s + 1] })
  }
  if (contour.closed && contour.points.length >= 3) {
    const last = contour.points.length - 1
    out.push({ s: last, a: contour.points[last], b: contour.points[0] })
  }
  return out
}

// Точка внутри замкнутого контура (ray casting). Открытые/вырожденные контуры — не заливка.
export function pointInEditContour(point: EditPoint, contour: EditContour): boolean {
  if (!contour.closed || contour.points.length < 3) return false
  const pts = contour.points
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i].x
    const yi = pts[i].y
    const xj = pts[j].x
    const yj = pts[j].y
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + (yj === yi ? 1e-12 : 0)) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// ── Hit-test: что под точкой ────────────────────────────────────────────────────
// Приоритет строгий: УЗЕЛ (угол) > СТЕНА (сегмент) > КОМНАТА (заливка). Так «взять угол,
// чтобы менять форму» побеждает «выделить стену», а стена побеждает «двинуть всю комнату».
// При наложении комнат возвращаем ВЕРХНЮЮ (последний контур в массиве рисуется поверх).

export function hitTestSketch(
  model: EditModel,
  point: EditPoint,
  options: SketchHitOptions,
): SketchHit | null {
  const nodeRadius = Number.isFinite(options.nodeRadiusCells) && options.nodeRadiusCells > 0 ? options.nodeRadiusCells : 0
  const wallRadius = Number.isFinite(options.wallRadiusCells) && options.wallRadiusCells > 0 ? options.wallRadiusCells : 0

  // 1) Узел (наивысший приоритет) — ближайшая вершина в радиусе.
  let nodeHit: { c: number; p: number; distance: number } | null = null
  if (nodeRadius > 0) {
    model.contours.forEach((contour, c) => {
      contour.points.forEach((vertex, p) => {
        const d = distance(point, vertex)
        if (d <= nodeRadius && (!nodeHit || d < nodeHit.distance)) {
          nodeHit = { c, p, distance: d }
        }
      })
    })
  }
  if (nodeHit) {
    const hit = nodeHit as { c: number; p: number; distance: number }
    return { kind: 'node', c: hit.c, p: hit.p, distance: hit.distance }
  }

  // 2) Стена — ближайший сегмент в радиусе.
  let wallHit: { c: number; s: number; t: number; distance: number } | null = null
  if (wallRadius > 0) {
    model.contours.forEach((contour, c) => {
      eachEditSegment(contour).forEach((seg) => {
        const { distance: d, t } = distanceToSegment(point, seg.a, seg.b)
        if (d <= wallRadius && (!wallHit || d < wallHit.distance)) {
          wallHit = { c, s: seg.s, t, distance: d }
        }
      })
    })
  }
  if (wallHit) {
    const hit = wallHit as { c: number; s: number; t: number; distance: number }
    return { kind: 'wall', c: hit.c, s: hit.s, t: hit.t, distance: hit.distance }
  }

  // 3) Комната — заливка замкнутого контура (сверху вниз: верхний контур перекрывает нижние).
  for (let c = model.contours.length - 1; c >= 0; c -= 1) {
    if (pointInEditContour(point, model.contours[c])) {
      return { kind: 'room', c }
    }
  }

  return null
}

// В режиме «Выбор» клик по пустому месту НЕ создаёт геометрию: если hit-test пуст — это «снять выделение».
export function selectClickCreatesGeometry(mode: SketchEditMode, hit: SketchHit | null): boolean {
  if (mode !== 'draw') return false
  return hit === null
}

// ── Магнит-снап между комнатами ────────────────────────────────────────────────
// Комнаты НЕ сливаются насильно: магнит совмещает общую стену ТОЛЬКО когда подтаскиваешь
// достаточно близко (в пределах порога). Дальше порога — комната стоит свободно.

export function withinRoomSnapThreshold(distanceCells: number, thresholdCells: number): boolean {
  const threshold = Number.isFinite(thresholdCells) && thresholdCells > 0 ? thresholdCells : 0
  if (threshold <= 0) return false
  if (!Number.isFinite(distanceCells) || distanceCells < 0) return false
  return distanceCells <= threshold
}

export function shouldMagnetRooms(distanceCells: number, thresholdCells: number): boolean {
  return withinRoomSnapThreshold(distanceCells, thresholdCells)
}
