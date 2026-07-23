// BLUEPRINT-WALLS-58: чистая геометрия «стен с толщиной» для 2D-плана эскиза.
// Без React/DOM/сайд-эффектов. Модель эскиза (version:1) остаётся CENTERLINE —
// стена по-прежнему хранится как ребро контура (точки), толщина = свойство ОТРИСОВКИ.
// Здесь только математика: оффсет центральной линии в две параллельные (miter-углы) и
// нарезка каждого ребра проёмами (gap-интервалы) в набор «пролётов» стены с торцами (jambs).
//
// Единицы координат — те же, что у точек контура (клетки плана). Толщина передаётся в тех же
// единицах (thicknessCells = thicknessFt / cellFt) — модуль не знает про футы/пиксели.

import type { Pt } from '../screens/project-hub/sketchPlanGeometry'

// Пресеты толщины каркаса (внешний габарит стены с гипсокартоном), футы.
export const WALL_THICKNESS_2X4_FT = 4.5 / 12 // 4.5" = 0.375ft
export const WALL_THICKNESS_2X6_FT = 6.5 / 12 // 6.5" ≈ 0.5417ft
// Дефолт для старых эскизов без поля толщины — 2x4 (4.5").
export const DEFAULT_WALL_THICKNESS_FT = WALL_THICKNESS_2X4_FT

export type WallThicknessPreset = '2x4' | '2x6'

export const WALL_THICKNESS_PRESETS: Array<{ preset: WallThicknessPreset; ft: number }> = [
  { preset: '2x4', ft: WALL_THICKNESS_2X4_FT },
  { preset: '2x6', ft: WALL_THICKNESS_2X6_FT },
]

// Ближайший пресет к произвольной толщине (для подсветки активной кнопки в панели свойств).
export function wallThicknessPreset(ft: number): WallThicknessPreset {
  return Math.abs(ft - WALL_THICKNESS_2X6_FT) < Math.abs(ft - WALL_THICKNESS_2X4_FT) ? '2x6' : '2x4'
}

// Ограничение miter, чтобы на очень острых углах «ус» не улетал в бесконечность.
const MITER_LIMIT = 4
const EPS = 1e-6

type Vec = { x: number; y: number }

function sub(a: Pt, b: Pt): Vec {
  return { x: a.x - b.x, y: a.y - b.y }
}

function norm(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y) || 1
  return { x: v.x / l, y: v.y / l }
}

// Левая нормаль направления (поворот на +90°). «Лево»/«право» — просто две стороны
// центральной линии; тело стены лежит между ними независимо от обхода контура.
function leftNormal(d: Vec): Vec {
  return { x: -d.y, y: d.x }
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

// Оффсет каждой вершины контура на ±half по левой/правой нормали, со сросшимися (miter)
// углами на внутренних вершинах. Концы разомкнутого контура — простой перпендикуляр.
export function offsetVertices(points: Pt[], closed: boolean, half: number): { left: Pt[]; right: Pt[] } {
  const n = points.length
  const left: Pt[] = []
  const right: Pt[] = []

  // Направление ребра, начинающегося в вершине i (i → i+1); null у разомкнутого конца.
  const edgeDir = (i: number): Vec | null => {
    if (i + 1 < n) return norm(sub(points[i + 1], points[i]))
    if (closed && n >= 2) return norm(sub(points[0], points[i]))
    return null
  }

  for (let i = 0; i < n; i++) {
    const dPrev = i > 0 ? edgeDir(i - 1) : closed && n >= 2 ? edgeDir(n - 1) : null
    const dNext = edgeDir(i)

    let nx = 0
    let ny = 0
    let scale = 0

    if (dPrev && dNext) {
      const nP = leftNormal(dPrev)
      const nN = leftNormal(dNext)
      let mx = nP.x + nN.x
      let my = nP.y + nN.y
      const mlen = Math.hypot(mx, my)
      if (mlen < EPS) {
        // Разворот на ~180° (шпилька): miter вырождается — берём нормаль исходящего ребра.
        nx = nN.x
        ny = nN.y
        scale = half
      } else {
        mx /= mlen
        my /= mlen
        const cos = mx * nP.x + my * nP.y // = cos(половины угла между нормалями)
        nx = mx
        ny = my
        scale = cos > EPS ? Math.min(half / cos, half * MITER_LIMIT) : half * MITER_LIMIT
      }
    } else if (dNext) {
      const nN = leftNormal(dNext)
      nx = nN.x
      ny = nN.y
      scale = half
    } else if (dPrev) {
      const nP = leftNormal(dPrev)
      nx = nP.x
      ny = nP.y
      scale = half
    }

    left.push({ x: points[i].x + nx * scale, y: points[i].y + ny * scale })
    right.push({ x: points[i].x - nx * scale, y: points[i].y - ny * scale })
  }

  return { left, right }
}

// Gap-интервал проёма на ребре s контура: [t0,t1] вдоль ребра (0..1).
export type WallGap = { s: number; t0: number; t1: number }

// Один «пролёт» стены (кусок ребра между проёмами / до угла): две параллельные линии
// (outer/inner), заполняющий четырёхугольник body и торцы-jamb (capStart/capEnd — там,
// где пролёт упирается в проём, а не в угол; на углах торца нет — линии сходятся в miter).
export type WallSpan = {
  s: number
  t0: number
  t1: number
  outer: [Pt, Pt]
  inner: [Pt, Pt]
  body: [Pt, Pt, Pt, Pt]
  capStart: [Pt, Pt] | null
  capEnd: [Pt, Pt] | null
}

// Слить пересекающиеся/касающиеся gap-интервалы одного ребра, обрезать до [0,1].
function mergeGaps(gaps: Array<{ t0: number; t1: number }>): Array<{ t0: number; t1: number }> {
  const cleaned = gaps
    .map((g) => ({ t0: Math.max(0, Math.min(g.t0, g.t1)), t1: Math.min(1, Math.max(g.t0, g.t1)) }))
    .filter((g) => g.t1 > g.t0 + EPS)
    .sort((a, b) => a.t0 - b.t0)
  const out: Array<{ t0: number; t1: number }> = []
  for (const g of cleaned) {
    const last = out[out.length - 1]
    if (last && g.t0 <= last.t1 + EPS) last.t1 = Math.max(last.t1, g.t1)
    else out.push({ t0: g.t0, t1: g.t1 })
  }
  return out
}

// Закрашенные интервалы ребра = дополнение gap-ов в пределах [0,1].
// capStart/capEnd: true — граница интервала это КРАЙ ПРОЁМА (нужен торец), false — угол (t=0/1).
export function paintedIntervals(
  gaps: Array<{ t0: number; t1: number }>,
): Array<{ t0: number; t1: number; capStart: boolean; capEnd: boolean }> {
  const merged = mergeGaps(gaps)
  const spans: Array<{ t0: number; t1: number; capStart: boolean; capEnd: boolean }> = []
  let cursor = 0
  for (const g of merged) {
    if (g.t0 > cursor + EPS) spans.push({ t0: cursor, t1: g.t0, capStart: cursor > EPS, capEnd: true })
    cursor = Math.max(cursor, g.t1)
  }
  if (cursor < 1 - EPS) spans.push({ t0: cursor, t1: 1, capStart: cursor > EPS, capEnd: false })
  return spans
}

// Главная функция рендера: контур центральной линии + толщина + gap-интервалы проёмов →
// список пролётов стены (двойные линии с miter-углами; проёмы рвут ОБЕ линии, оставляя торцы).
export function wallSpans(points: Pt[], closed: boolean, thickness: number, gaps: WallGap[]): WallSpan[] {
  const n = points.length
  if (n < 2 || thickness <= 0) return []
  const half = thickness / 2
  const { left, right } = offsetVertices(points, closed, half)
  const edgeCount = closed ? n : n - 1
  const out: WallSpan[] = []

  for (let s = 0; s < edgeCount; s++) {
    const iA = s
    const iB = (s + 1) % n
    const lA = left[iA]
    const lB = left[iB]
    const rA = right[iA]
    const rB = right[iB]
    const edgeGaps = gaps.filter((g) => g.s === s)

    for (const iv of paintedIntervals(edgeGaps)) {
      const o0 = lerp(lA, lB, iv.t0)
      const o1 = lerp(lA, lB, iv.t1)
      const i0 = lerp(rA, rB, iv.t0)
      const i1 = lerp(rA, rB, iv.t1)
      out.push({
        s,
        t0: iv.t0,
        t1: iv.t1,
        outer: [o0, o1],
        inner: [i0, i1],
        body: [o0, o1, i1, i0],
        capStart: iv.capStart ? [o0, i0] : null,
        capEnd: iv.capEnd ? [o1, i1] : null,
      })
    }
  }

  return out
}

// Утилита рендера: «points» строка для SVG polygon/polyline из массива точек в мировых
// координатах, умноженных на масштаб (CELL_PX). Держим здесь, чтобы не плодить в SketchTab.
export function ptsToSvg(pts: Pt[], scale: number): string {
  return pts.map((p) => `${p.x * scale},${p.y * scale}`).join(' ')
}
