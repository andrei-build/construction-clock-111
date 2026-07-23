import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDIT_MODE,
  clickCreatesNode,
  clickSelects,
  enterDraw,
  escapeDraw,
  finishDraw,
  hitTestSketch,
  pointInEditContour,
  selectClickCreatesGeometry,
  shouldMagnetRooms,
  toggleEditMode,
  withinRoomSnapThreshold,
  type EditModel,
} from '../src/lib/sketchEditMode'

// Квадрат 10x10 (в клетках) от (0,0). Замкнутый контур = комната.
const square = (ox: number, oy: number, size = 10): EditModel['contours'][number] => ({
  points: [
    { x: ox, y: oy },
    { x: ox + size, y: oy },
    { x: ox + size, y: oy + size },
    { x: ox, y: oy + size },
  ],
  closed: true,
})

const HIT = { nodeRadiusCells: 0.6, wallRadiusCells: 0.6 }

describe('sketchEditMode — переходы режима', () => {
  it('дефолт — «Выбор», не «Рисование»', () => {
    expect(DEFAULT_EDIT_MODE).toBe('select')
  })

  it('enterDraw → draw, finishDraw → select', () => {
    expect(enterDraw()).toBe('draw')
    expect(finishDraw()).toBe('select')
  })

  it('Esc из рисования всегда возвращает в «Выбор»', () => {
    expect(escapeDraw('draw')).toBe('select')
    expect(escapeDraw('select')).toBe('select')
    expect(escapeDraw()).toBe('select')
  })

  it('toggleEditMode переключает туда-обратно', () => {
    expect(toggleEditMode('select')).toBe('draw')
    expect(toggleEditMode('draw')).toBe('select')
  })
})

describe('sketchEditMode — решение «клик создаёт узел или выделяет»', () => {
  it('узлы ставятся ТОЛЬКО в режиме рисования', () => {
    expect(clickCreatesNode('draw')).toBe(true)
    expect(clickCreatesNode('select')).toBe(false)
  })

  it('выделение работает ТОЛЬКО в режиме выбора', () => {
    expect(clickSelects('select')).toBe(true)
    expect(clickSelects('draw')).toBe(false)
  })

  it('в «Выбор» клик по пустому месту НЕ создаёт геометрию', () => {
    // пустое место (hit=null) в select → не создаём (снятие выделения)
    expect(selectClickCreatesGeometry('select', null)).toBe(false)
    // даже в draw клик поверх существующего узла не «создаёт на пустом» (hit есть)
    expect(selectClickCreatesGeometry('draw', { kind: 'node', c: 0, p: 0, distance: 0 })).toBe(false)
    // только пустое место в режиме рисования создаёт узел
    expect(selectClickCreatesGeometry('draw', null)).toBe(true)
  })
})

describe('sketchEditMode — hit-test приоритет узел > стена > комната', () => {
  const model: EditModel = { contours: [square(0, 0)] }

  it('узел побеждает стену и комнату', () => {
    // точка ровно на угле (0,0): рядом и стена, и заливка, но приоритет — узел
    const hit = hitTestSketch(model, { x: 0.1, y: 0.1 }, HIT)
    expect(hit?.kind).toBe('node')
    if (hit?.kind === 'node') {
      expect(hit.c).toBe(0)
      expect(hit.p).toBe(0)
    }
  })

  it('стена побеждает комнату (точка на сегменте, вдали от углов)', () => {
    // середина верхней стены (5,0): не рядом с узлом, но на сегменте
    const hit = hitTestSketch(model, { x: 5, y: 0.1 }, HIT)
    expect(hit?.kind).toBe('wall')
    if (hit?.kind === 'wall') {
      expect(hit.c).toBe(0)
      expect(hit.s).toBe(0)
      expect(hit.t).toBeGreaterThan(0.4)
      expect(hit.t).toBeLessThan(0.6)
    }
  })

  it('комната по заливке (точка глубоко внутри)', () => {
    const hit = hitTestSketch(model, { x: 5, y: 5 }, HIT)
    expect(hit?.kind).toBe('room')
    if (hit?.kind === 'room') expect(hit.c).toBe(0)
  })

  it('клик по пустому месту → null (ничего не выделено, ничего не создаётся в select)', () => {
    const hit = hitTestSketch(model, { x: 50, y: 50 }, HIT)
    expect(hit).toBeNull()
  })

  it('узел вне радиуса, но стена в радиусе → возвращается стена', () => {
    // точка в 0.5 от узла (вне nodeRadius=0.3), но на стене
    const tightNode = { nodeRadiusCells: 0.3, wallRadiusCells: 0.6 }
    const hit = hitTestSketch(model, { x: 0.5, y: 0.05 }, tightNode)
    expect(hit?.kind).toBe('wall')
  })
})

describe('sketchEditMode — мульти-комната', () => {
  it('каждая комната независима: клик внутри второй возвращает её индекс', () => {
    const model: EditModel = { contours: [square(0, 0), square(30, 0)] }
    const first = hitTestSketch(model, { x: 5, y: 5 }, HIT)
    const second = hitTestSketch(model, { x: 35, y: 5 }, HIT)
    expect(first?.kind).toBe('room')
    expect(second?.kind).toBe('room')
    if (first?.kind === 'room') expect(first.c).toBe(0)
    if (second?.kind === 'room') expect(second.c).toBe(1)
  })

  it('при наложении комнат выбирается ВЕРХНЯЯ (последний контур)', () => {
    // две перекрывающиеся комнаты — точка внутри обеих
    const model: EditModel = { contours: [square(0, 0, 20), square(5, 5, 20)] }
    const hit = hitTestSketch(model, { x: 10, y: 10 }, HIT)
    expect(hit?.kind).toBe('room')
    if (hit?.kind === 'room') expect(hit.c).toBe(1)
  })

  it('открытый контур не даёт заливки (нельзя «попасть» в незамкнутую комнату)', () => {
    const open: EditModel = { contours: [{ ...square(0, 0), closed: false }] }
    expect(pointInEditContour({ x: 5, y: 5 }, open.contours[0])).toBe(false)
    const hit = hitTestSketch(open, { x: 5, y: 5 }, HIT)
    expect(hit).toBeNull()
  })
})

describe('sketchEditMode — порог магнит-снапа между комнатами', () => {
  it('близко (в пределах порога) → магнитим', () => {
    expect(withinRoomSnapThreshold(0.4, 0.6)).toBe(true)
    expect(shouldMagnetRooms(0.6, 0.6)).toBe(true)
  })

  it('далеко (за порогом) → НЕ магнитим, комнаты не сливаются насильно', () => {
    expect(withinRoomSnapThreshold(0.8, 0.6)).toBe(false)
    expect(shouldMagnetRooms(3, 0.6)).toBe(false)
  })

  it('нулевой/отрицательный порог или дистанция → без магнита', () => {
    expect(withinRoomSnapThreshold(0.1, 0)).toBe(false)
    expect(withinRoomSnapThreshold(-1, 0.6)).toBe(false)
  })
})
