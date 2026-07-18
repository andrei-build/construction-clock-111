// MARKUP-1: отрисовка распознанных фигур на 2D-контексте. Один рендерер используется и живым canvas-слоем,
// и компоновщиком PNG-копии (одинаковый вид на экране и в сохранённом файле). DOM-код — вне юнит-тестов.
import type { Pt, Shape } from './markupRecognize'
import { distance } from './markupRecognize'

export interface MarkupElement {
  id: string
  color: string
  width: number
  shape: Shape
}

type Ctx = CanvasRenderingContext2D

function strokePolyline(ctx: Ctx, points: Pt[], closed: boolean) {
  if (points.length === 0) return
  if (points.length === 1) {
    // Одиночный тап — точка кружком радиусом в толщину пера.
    ctx.beginPath()
    ctx.arc(points[0].x, points[0].y, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  if (closed) ctx.closePath()
  ctx.stroke()
}

function drawArrow(ctx: Ctx, a: Pt, b: Pt, width: number) {
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
  const len = distance(a, b)
  if (len < 1e-3) return
  const head = Math.min(len * 0.32, Math.max(width * 4, 14))
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const wing = Math.PI / 7
  ctx.beginPath()
  ctx.moveTo(b.x, b.y)
  ctx.lineTo(b.x - head * Math.cos(ang - wing), b.y - head * Math.sin(ang - wing))
  ctx.moveTo(b.x, b.y)
  ctx.lineTo(b.x - head * Math.cos(ang + wing), b.y - head * Math.sin(ang + wing))
  ctx.stroke()
}

function drawStar(ctx: Ctx, cx: number, cy: number, rOuter: number, rInner: number, count: number, rotation: number) {
  ctx.beginPath()
  const steps = count * 2
  for (let i = 0; i < steps; i++) {
    const r = i % 2 === 0 ? rOuter : rInner
    const a = rotation + (i / steps) * Math.PI * 2
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.stroke()
}

// Отрисовать один элемент разметки. Толщина/цвет — из элемента.
export function drawElement(ctx: Ctx, el: MarkupElement) {
  ctx.save()
  ctx.strokeStyle = el.color
  ctx.fillStyle = el.color
  ctx.lineWidth = el.width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const s = el.shape
  switch (s.kind) {
    case 'path':
      strokePolyline(ctx, s.points, false)
      break
    case 'line':
      strokePolyline(ctx, [s.a, s.b], false)
      break
    case 'arrow':
      drawArrow(ctx, s.a, s.b, el.width)
      break
    case 'rect':
      ctx.strokeRect(s.x, s.y, s.w, s.h)
      break
    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(s.cx, s.cy, Math.max(1, s.rx), Math.max(1, s.ry), 0, 0, Math.PI * 2)
      ctx.stroke()
      break
    case 'polygon':
      strokePolyline(ctx, s.points, true)
      break
    case 'star':
      drawStar(ctx, s.cx, s.cy, s.rOuter, s.rInner, s.count, s.rotation)
      break
    case 'check':
      strokePolyline(ctx, s.points, false)
      break
    case 'text': {
      ctx.font = `600 ${Math.max(10, s.size)}px system-ui, sans-serif`
      ctx.textBaseline = 'top'
      // Тонкая тёмная подложка-обводка для читаемости на любом фоне.
      ctx.lineWidth = Math.max(2, s.size / 8)
      ctx.strokeStyle = 'rgba(0,0,0,.55)'
      ctx.strokeText(s.text, s.x, s.y)
      ctx.fillText(s.text, s.x, s.y)
      break
    }
  }
  ctx.restore()
}

export function drawElements(ctx: Ctx, elements: MarkupElement[]) {
  for (const el of elements) drawElement(ctx, el)
}

// Приблизительная дистанция от точки до элемента (для ластика «удалить штрих целиком»).
export function distanceToElement(p: Pt, el: MarkupElement): number {
  const s = el.shape
  const pts: Pt[] = (() => {
    switch (s.kind) {
      case 'path': return s.points
      case 'line': return [s.a, s.b]
      case 'arrow': return [s.a, s.b]
      case 'check': return s.points
      case 'polygon': return [...s.points, s.points[0]]
      case 'rect': return [
        { x: s.x, y: s.y }, { x: s.x + s.w, y: s.y },
        { x: s.x + s.w, y: s.y + s.h }, { x: s.x, y: s.y + s.h }, { x: s.x, y: s.y },
      ]
      case 'ellipse': {
        const out: Pt[] = []
        for (let i = 0; i <= 24; i++) {
          const a = (i / 24) * Math.PI * 2
          out.push({ x: s.cx + Math.cos(a) * s.rx, y: s.cy + Math.sin(a) * s.ry })
        }
        return out
      }
      case 'star': {
        const out: Pt[] = []
        const steps = s.count * 2
        for (let i = 0; i <= steps; i++) {
          const r = i % 2 === 0 ? s.rOuter : s.rInner
          const a = s.rotation + (i / steps) * Math.PI * 2
          out.push({ x: s.cx + Math.cos(a) * r, y: s.cy + Math.sin(a) * r })
        }
        return out
      }
      case 'text': return [{ x: s.x, y: s.y }]
    }
  })()
  let min = Infinity
  if (pts.length === 1) return distance(p, pts[0])
  for (let i = 1; i < pts.length; i++) {
    const d = segDist(p, pts[i - 1], pts[i])
    if (d < min) min = d
  }
  return min
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return distance(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy })
}
