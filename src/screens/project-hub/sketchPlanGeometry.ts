// Чистая планарная геометрия эскиза (план 2D), вынесенная из SketchTab.tsx.
// Без React/DOM/сайд-эффектов: расстояние между точками, периметр/площадь/центр
// контура, тест «точка внутри контура», проекция точки на сегмент.
// Формат модели (version:1) здесь НЕ трогается — используются только координаты точек.

export type Pt = { x: number; y: number }
export type Contour = { points: Pt[]; closed: boolean; label?: string }

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// Длина контура: сумма сегментов; для замкнутого добавляем ребро замыкания.
export function contourPerimeter(c: Contour): number {
  let total = 0
  for (let i = 1; i < c.points.length; i++) total += dist(c.points[i - 1], c.points[i])
  if (c.closed && c.points.length >= 3) total += dist(c.points[c.points.length - 1], c.points[0])
  return total
}

// Площадь замкнутого контура по формуле шнурков (в клетках²).
export function contourArea(c: Contour): number {
  if (!c.closed || c.points.length < 3) return 0
  let sum = 0
  const p = c.points
  for (let i = 0; i < p.length; i++) {
    const a = p[i]
    const b = p[(i + 1) % p.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

// Центр контура: центроид замкнутого многоугольника, иначе среднее арифметическое точек.
export function contourCenter(contour: Contour): Pt {
  if (contour.points.length === 0) return { x: 0, y: 0 }
  if (contour.closed && contour.points.length >= 3) {
    let area2 = 0
    let cx = 0
    let cy = 0
    contour.points.forEach((point, index) => {
      const next = contour.points[(index + 1) % contour.points.length]
      const cross = point.x * next.y - next.x * point.y
      area2 += cross
      cx += (point.x + next.x) * cross
      cy += (point.y + next.y) * cross
    })
    if (Math.abs(area2) > 0.000001) return { x: cx / (3 * area2), y: cy / (3 * area2) }
  }
  const sum = contour.points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 })
  return { x: sum.x / contour.points.length, y: sum.y / contour.points.length }
}

// Проверка «точка внутри замкнутого контура» (ray casting).
export function pointInContour(p: Pt, contour: Contour): boolean {
  if (!contour.closed || contour.points.length < 3) return false
  let inside = false
  const points = contour.points
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    const crosses = (a.y > p.y) !== (b.y > p.y)
    if (crosses && p.x < ((b.x - a.x) * (p.y - a.y)) / ((b.y - a.y) || 1) + a.x) inside = !inside
  }
  return inside
}

// Проекция точки p на сегмент a→b, параметр t в [0,1].
export function projectT(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return 0
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
}
