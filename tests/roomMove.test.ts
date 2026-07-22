import { describe, expect, it } from 'vitest'
import { snapContourTranslation } from '../src/screens/project-hub/sketchGuides'
import {
  resizeSketchSegmentToLength,
  sketchContourAreaCells,
  type Sketch3DModel,
} from '../src/screens/project-hub/sketchFinishes'

const ROOM_SNAP = 0.6

type Pt = { x: number; y: number }
function translate(points: Pt[], dx: number, dy: number): Pt[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
}

// ROOM-MOVE-23: перетаскивание ВСЕЙ комнаты (сдвиг координат) + магнит стена-к-стене + размер числом после переноса.
describe('ROOM-MOVE-23 whole-room drag + size after move', () => {
  it('translates every node by the same vector without deforming the room (rigid move)', () => {
    const start: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }]
    const moved = translate(start, 3, -2)
    expect(moved).toEqual([{ x: 3, y: -2 }, { x: 13, y: -2 }, { x: 13, y: 6 }, { x: 3, y: 6 }])
    // Форма/площадь целы — это сдвиг, а не деформация.
    const areaBefore = sketchContourAreaCells({ points: start, closed: true })
    const areaAfter = sketchContourAreaCells({ points: moved, closed: true })
    expect(areaAfter).toBeCloseTo(areaBefore)
    // Число узлов и порядок индексов не меняются → узлы после переноса тянутся по тем же {c,p}.
    expect(moved.length).toBe(start.length)
  })

  it('wall-to-wall magnet snaps a moving room corner exactly onto the neighbour (shared wall forms)', () => {
    const neighbour = { closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] }
    const startPointsB: Pt[] = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 8 }, { x: 0, y: 8 }]
    // Комнату B подтащили так, что её левые углы почти совпали с правой стеной A (промах 0.3×0.2 клетки).
    const translated = translate(startPointsB, 10.3, 0.2)
    const liveModel = { contours: [neighbour, { closed: true, points: translated }] }
    const snap = snapContourTranslation(liveModel, 1, translated, { radiusCells: ROOM_SNAP })
    expect(snap.snapped).toBe(true)
    const snapped = translated.map((p) => ({ x: p.x + snap.offset.x, y: p.y + snap.offset.y }))
    // После магнита угол B садится точно на угол A (10,0) → общая стена совмещена.
    expect(snapped.some((p) => Math.abs(p.x - 10) < 1e-6 && Math.abs(p.y - 0) < 1e-6)).toBe(true)
  })

  it('never snaps a room to itself and returns zero offset when nothing is near', () => {
    const room = { closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] }
    const moved = translate(room.points, 50, 50)
    const snap = snapContourTranslation(
      { contours: [room, { closed: true, points: moved }] },
      1,
      moved,
      { radiusCells: ROOM_SNAP },
    )
    expect(snap.snapped).toBe(false)
    expect(snap.offset).toEqual({ x: 0, y: 0 })
  })

  it('dimension-by-number still rebuilds geometry after the room was moved (corners hold)', () => {
    const startPoints: Pt[] = [{ x: 0, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 9 }, { x: 0, y: 9 }]
    const moved = translate(startPoints, 5, 7)
    const model: Sketch3DModel = { version: 1, cellFt: 1, contours: [{ closed: true, points: moved }], openings: [] }
    const result = resizeSketchSegmentToLength(model, { c: 0, s: 0 }, 20, { anchor: 'start' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const pts = result.model.contours[0].points
      expect(pts.length).toBe(4)
      const len0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      expect(len0).toBeCloseTo(20)
      // Прямые углы у прямоугольника держатся (соседняя сторона тоже стала 20).
      const len2 = Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y)
      expect(len2).toBeCloseTo(20)
      // Формат модели не тронут.
      expect(result.model.version).toBe(1)
    }
  })

  it('editing a shared wall moves only the edited room and leaves the neighbour intact', () => {
    const model: Sketch3DModel = {
      version: 1,
      cellFt: 1,
      openings: [],
      contours: [
        { closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] },
        { closed: true, points: [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 8 }, { x: 10, y: 8 }] },
      ],
    }
    const neighbourBefore = model.contours[0].points.map((p) => ({ ...p }))
    // Уменьшаем верхнюю стену комнаты B до 6 ft, якорь start (общий угол x=10 держим) — соседа не трогаем.
    const result = resizeSketchSegmentToLength(model, { c: 1, s: 0 }, 6, { anchor: 'start' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.model.contours[0].points).toEqual(neighbourBefore)
      // Свою сторону подвинули: длина стены B стала 6.
      const pts = result.model.contours[1].points
      const lenB = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      expect(lenB).toBeCloseTo(6)
    }
  })
})
