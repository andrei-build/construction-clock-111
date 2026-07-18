// MARKUP-1: геометрическое (без ML) распознавание фигур из свободного штриха.
// Чистый модуль — НЕ импортирует DOM/canvas/React, поэтому покрыт юнит-тестами (tests/markupRecognize.test.ts,
// node-окружение vitest). Вся «магия автоисправления» живёт здесь: упрощение полилинии Ramer–Douglas–Peucker,
// подсчёт вершин, реконструкция правильной фигуры (прямая с привязкой к 0/45/90°, стрелка, круг/эллипс,
// треугольник/прямоугольник/ромб, звезда, галочка) или красивое сглаживание (Catmull–Rom), если не распознали.

export interface Pt {
  x: number
  y: number
}

// Распознанная (или сглаженная) фигура. Рендер — markupRender.ts. 'text' сюда включён только как тип
// (заметка добавляется инструментом текста, recognize() её никогда не возвращает).
export type Shape =
  | { kind: 'path'; points: Pt[] }
  | { kind: 'line'; a: Pt; b: Pt }
  | { kind: 'arrow'; a: Pt; b: Pt }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'polygon'; points: Pt[] }
  | { kind: 'star'; cx: number; cy: number; rOuter: number; rInner: number; count: number; rotation: number }
  | { kind: 'check'; points: Pt[] }
  | { kind: 'text'; x: number; y: number; text: string; size: number }

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// Длина ломаной по точкам.
export function pathLength(points: Pt[]): number {
  let sum = 0
  for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i])
  return sum
}

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export function boundingBox(points: Pt[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function centroid(points: Pt[]): Pt {
  let sx = 0, sy = 0
  for (const p of points) { sx += p.x; sy += p.y }
  return { x: sx / points.length, y: sy / points.length }
}

// Перпендикулярное расстояние от точки p до прямой (a,b). Вырожденный отрезок → расстояние до a.
export function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return distance(p, a)
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  const proj = { x: a.x + t * dx, y: a.y + t * dy }
  return distance(p, proj)
}

// Ramer–Douglas–Peucker: упрощение полилинии до опорных вершин. epsilon — порог отклонения.
export function rdp(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points.slice()
  const first = points[0]
  const last = points[points.length - 1]
  let maxDist = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last)
    if (d > maxDist) { maxDist = d; index = i }
  }
  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, index + 1), epsilon)
    const right = rdp(points.slice(index), epsilon)
    return left.slice(0, -1).concat(right)
  }
  return [first, last]
}

// Убираем подряд идущие почти совпадающие точки (дребезг ввода).
function dedupe(points: Pt[], minGap = 0.01): Pt[] {
  const out: Pt[] = []
  for (const p of points) {
    const prev = out[out.length - 1]
    if (!prev || distance(prev, p) > minGap) out.push(p)
  }
  return out
}

// Catmull–Rom → плотная гладкая ломаная (для fallback «красивая кривая» вместо дрожащего штриха).
export function catmullRomSmooth(points: Pt[], samplesPerSegment = 8): Pt[] {
  if (points.length < 3) return points.slice()
  const out: Pt[] = []
  const n = points.length
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2 < n ? i + 2 : n - 1]
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment
      const t2 = t * t
      const t3 = t2 * t
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  out.push(points[n - 1])
  return out
}

// Прямая с привязкой угла к 0/45/90/135°, если рисунок близок к оси (в пределах tol). Длину сохраняем.
export function snapLine(a: Pt, b: Pt, tolDeg = 8): Shape {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return { kind: 'line', a, b }
  const ang = Math.atan2(dy, dx)
  const step = Math.PI / 4
  const snapped = Math.round(ang / step) * step
  const tol = (tolDeg * Math.PI) / 180
  let delta = ang - snapped
  while (delta > Math.PI) delta -= 2 * Math.PI
  while (delta < -Math.PI) delta += 2 * Math.PI
  if (Math.abs(delta) < tol) {
    return { kind: 'line', a, b: { x: a.x + Math.cos(snapped) * len, y: a.y + Math.sin(snapped) * len } }
  }
  return { kind: 'line', a, b }
}

// Галочка ✓: 3 вершины, средняя — самая нижняя, правое плечо длиннее левого, правый конец выше левого начала.
function detectCheck(corners: Pt[]): Shape | null {
  if (corners.length !== 3) return null
  const [a, m, b] = corners
  const leftArm = distance(a, m)
  const rightArm = distance(m, b)
  const midLowest = m.y > a.y + 1e-6 && m.y > b.y + 1e-6
  const goesRight = b.x > a.x
  const rightHigher = b.y < a.y
  const rightLonger = rightArm > leftArm * 1.15
  if (midLowest && goesRight && rightHigher && rightLonger) {
    return { kind: 'check', points: [a, m, b] }
  }
  return null
}

// Стрелка: главный ствол start→tip (tip — самая дальняя от старта вершина), после tip есть «зазубрина»
// (одна-две короткие вершины, направленные НАЗАД к стволу). Иначе — не стрелка (null → станет линией).
function detectArrow(corners: Pt[], diag: number): Shape | null {
  if (corners.length < 3) return null
  const a = corners[0]
  let tip = a
  let tipIdx = 0
  let maxD = 0
  for (let i = 1; i < corners.length; i++) {
    const d = distance(a, corners[i])
    if (d > maxD) { maxD = d; tip = corners[i]; tipIdx = i }
  }
  // После наконечника обязана быть хотя бы одна вершина (зазубрина). Если tip последний — это просто линия.
  if (tipIdx >= corners.length - 1) return null
  const shaftLen = distance(a, tip)
  if (shaftLen < diag * 0.4) return null
  const ux = (tip.x - a.x) / shaftLen
  const uy = (tip.y - a.y) / shaftLen
  let hasBarb = false
  for (let i = tipIdx + 1; i < corners.length; i++) {
    const wx = corners[i].x - tip.x
    const wy = corners[i].y - tip.y
    const back = wx * ux + wy * uy       // проекция на ствол; барб идёт назад → отрицательна
    const wlen = Math.hypot(wx, wy)
    if (back < 0 && wlen > shaftLen * 0.08 && wlen < shaftLen * 0.55) hasBarb = true
  }
  return hasBarb ? { kind: 'arrow', a, b: tip } : null
}

// Звезда: чередование «дальних»/«ближних» вершин относительно центра, лучей ≥ 4, впадины заметно глубже.
function detectStar(corners: Pt[], c: Pt): Shape | null {
  const n = corners.length
  if (n < 8) return null
  const radii = corners.map((p) => distance(p, c))
  const mean = radii.reduce((s, r) => s + r, 0) / n
  const outer: number[] = []
  const inner: number[] = []
  let outerFirstAngle: number | null = null
  let alternates = true
  let prevSign = 0
  for (let i = 0; i < n; i++) {
    const sign = radii[i] >= mean ? 1 : -1
    if (sign === 1) {
      outer.push(radii[i])
      if (outerFirstAngle === null) outerFirstAngle = Math.atan2(corners[i].y - c.y, corners[i].x - c.x)
    } else {
      inner.push(radii[i])
    }
    if (i > 0 && sign === prevSign) alternates = false
    prevSign = sign
  }
  if (!alternates) return null
  if (outer.length < 4 || Math.abs(outer.length - inner.length) > 1) return null
  const rOuter = outer.reduce((s, r) => s + r, 0) / outer.length
  const rInner = inner.reduce((s, r) => s + r, 0) / inner.length
  if (rInner >= rOuter * 0.82) return null // впадины неглубокие — это не звезда
  return {
    kind: 'star',
    cx: c.x,
    cy: c.y,
    rOuter,
    rInner,
    count: outer.length,
    rotation: outerFirstAngle ?? -Math.PI / 2,
  }
}

// Классификация 4-вершинного замкнутого контура: ромб (вершины у середин сторон bbox) → иначе выровненный
// по осям прямоугольник (правим до идеального bbox — «выровненный по осям если близко»).
function classifyQuad(corners: Pt[], bbox: BBox, diag: number): Shape {
  const cx = bbox.x + bbox.w / 2
  const cy = bbox.y + bbox.h / 2
  const mids: Pt[] = [
    { x: cx, y: bbox.y },
    { x: bbox.x + bbox.w, y: cy },
    { x: cx, y: bbox.y + bbox.h },
    { x: bbox.x, y: cy },
  ]
  const tol = diag * 0.2
  const matchedMids = mids.every((mid) => corners.some((c) => distance(c, mid) < tol))
  if (matchedMids) return { kind: 'polygon', points: mids }
  return { kind: 'rect', x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h }
}

// Главная точка входа: сырые точки штриха → распознанная фигура (или сглаженная кривая).
export function recognize(raw: Pt[]): Shape {
  const points = dedupe(raw)
  if (points.length < 2) return { kind: 'path', points: points.length ? points : raw.slice() }

  const bbox = boundingBox(points)
  const diag = Math.hypot(bbox.w, bbox.h)
  if (diag < 1e-6) return { kind: 'path', points }

  const len = pathLength(points)
  const first = points[0]
  const last = points[points.length - 1]
  const endGap = distance(first, last)
  const closed = endGap < Math.max(diag * 0.22, 12) && len > diag * 1.2

  const eps = Math.max(2, diag * 0.045)
  let corners = rdp(points, eps)
  if (closed && corners.length > 3 && distance(corners[0], corners[corners.length - 1]) < diag * 0.15) {
    corners = corners.slice(0, -1)
  }
  const nC = corners.length
  const straightness = len > 0 ? endGap / len : 0

  if (!closed) {
    if (nC === 3) {
      const check = detectCheck(corners)
      if (check) return check
    }
    const arrow = detectArrow(corners, diag)
    if (arrow) return arrow
    if (nC === 2 || straightness > 0.9) return snapLine(first, last)
    return { kind: 'path', points: catmullRomSmooth(corners.length >= 3 ? corners : points) }
  }

  // Замкнутый контур: круг/эллипс, звезда, многоугольник.
  const c = centroid(points)

  const star = detectStar(corners, c)
  if (star) return star

  // Эллипс/круг: точки должны ложиться на эллипс, вписанный в bbox — метрика ((x-cx)/rx)²+((y-cy)/ry)²≈1.
  // Средняя невязка мала для круга/эллипса и заметно велика для прямоугольника/ромба/треугольника
  // (у них середины сторон уходят внутрь эллипса), поэтому этот критерий их не путает.
  const ecx = bbox.x + bbox.w / 2
  const ecy = bbox.y + bbox.h / 2
  const rx = bbox.w / 2
  const ry = bbox.h / 2
  if (nC >= 6 && rx > 1 && ry > 1) {
    let errSum = 0
    for (const p of points) {
      errSum += Math.abs(((p.x - ecx) / rx) ** 2 + ((p.y - ecy) / ry) ** 2 - 1)
    }
    const meanErr = errSum / points.length
    if (meanErr < 0.16) {
      if (Math.abs(rx - ry) <= Math.max(rx, ry) * 0.18) {
        const r = (rx + ry) / 2
        return { kind: 'ellipse', cx: ecx, cy: ecy, rx: r, ry: r }
      }
      return { kind: 'ellipse', cx: ecx, cy: ecy, rx, ry }
    }
  }

  if (nC === 3) return { kind: 'polygon', points: corners }
  if (nC === 4) return classifyQuad(corners, bbox, diag)
  return { kind: 'polygon', points: corners }
}
