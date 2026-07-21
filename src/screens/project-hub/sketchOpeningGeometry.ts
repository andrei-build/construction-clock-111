// Чистая сегментно-проёмная геометрия эскиза (план 2D), вынесенная из SketchTab.tsx.
// Без React/DOM/сайд-эффектов: концы сегмента под проёмом, мировая точка/ось проёма,
// перечисление всех сегментов стен и поиск ближайшего сегмента к точке.
// Формат модели (version:1) здесь НЕ трогается — читаются только контуры и поля c/s/t проёма.

import { dist, type Contour, type Pt } from './sketchPlanGeometry'

// Минимальная форма модели: для сегментной геометрии нужны только контуры.
export type ContourModel = { contours: Contour[] }

// Минимальная форма проёма: индекс контура/сегмента и параметр t вдоль сегмента.
export type SegmentPlacement = { c: number; s: number; t: number }

// Сегмент стены с индексами контура/сегмента и концами.
export type WallSegment = { c: number; s: number; a: Pt; b: Pt }

// Ближайший сегмент к точке: индексы, параметр t вдоль сегмента и расстояние d.
export type NearestSegment = { c: number; s: number; t: number; d: number }

// Концы сегмента, на котором сидит проём.
export function openingEnds(model: ContourModel, o: SegmentPlacement): { a: Pt; b: Pt } | null {
  const c = model.contours[o.c]
  if (!c) return null
  const a = c.points[o.s]
  const b = o.s + 1 < c.points.length ? c.points[o.s + 1] : (c.closed ? c.points[0] : null)
  if (!a || !b) return null
  return { a, b }
}

// Мировая точка проёма на сегменте.
export function openingPoint(model: ContourModel, o: SegmentPlacement): Pt | null {
  const e = openingEnds(model, o)
  if (!e) return null
  return { x: e.a.x + (e.b.x - e.a.x) * o.t, y: e.a.y + (e.b.y - e.a.y) * o.t }
}

// Геометрия проёма: центр, единичный вектор вдоль стены, концы сегмента.
export function openingGeom(
  model: ContourModel,
  o: SegmentPlacement,
): { p: Pt; ux: number; uy: number; a: Pt; b: Pt } | null {
  const e = openingEnds(model, o)
  if (!e) return null
  const len = dist(e.a, e.b) || 1
  const ux = (e.b.x - e.a.x) / len
  const uy = (e.b.y - e.a.y) / len
  return { p: { x: e.a.x + (e.b.x - e.a.x) * o.t, y: e.a.y + (e.b.y - e.a.y) * o.t }, ux, uy, a: e.a, b: e.b }
}

// Список сегментов (с индексами контура/сегмента и концами) для поиска ближайшего.
export function eachSegment(model: ContourModel): WallSegment[] {
  const out: WallSegment[] = []
  model.contours.forEach((cont, c) => {
    for (let s = 0; s < cont.points.length - 1; s++) {
      out.push({ c, s, a: cont.points[s], b: cont.points[s + 1] })
    }
    if (cont.closed && cont.points.length >= 3) {
      out.push({ c, s: cont.points.length - 1, a: cont.points[cont.points.length - 1], b: cont.points[0] })
    }
  })
  return out
}

// Ближайший сегмент к точке p, с параметром t вдоль него.
export function nearestSegment(model: ContourModel, p: Pt): NearestSegment | null {
  let best: NearestSegment | null = null
  for (const seg of eachSegment(model)) {
    const dx = seg.b.x - seg.a.x
    const dy = seg.b.y - seg.a.y
    const len2 = dx * dx + dy * dy
    if (len2 === 0) continue
    let t = ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const proj = { x: seg.a.x + dx * t, y: seg.a.y + dy * t }
    const d = dist(p, proj)
    if (!best || d < best.d) best = { c: seg.c, s: seg.s, t, d }
  }
  return best
}
