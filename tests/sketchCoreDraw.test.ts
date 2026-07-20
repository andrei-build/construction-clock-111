import { describe, expect, it } from 'vitest'
import {
  finishLastOpenContour,
  screenPointerMovedBeyondThreshold,
  shouldCloseOpenContourFromPoint,
} from '../src/screens/project-hub/sketchGuides'

describe('sketch core drawing interactions', () => {
  it('arms node dragging only after the screen threshold is crossed', () => {
    const origin = { clientX: 100, clientY: 100 }

    expect(screenPointerMovedBeyondThreshold(origin, { clientX: 104, clientY: 104 }, 6)).toBe(false)
    expect(screenPointerMovedBeyondThreshold(origin, { clientX: 107, clientY: 100 }, 6)).toBe(true)
  })

  it('closes the last open contour with three or more points', () => {
    const model = {
      version: 1 as const,
      cellFt: 1,
      contours: [
        {
          label: 'Room',
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 6, y: 0 },
            { x: 6, y: 4 },
          ],
        },
      ],
      openings: [],
    }

    const result = finishLastOpenContour(model)

    expect(result.changed).toBe(true)
    expect(result.action).toBe('closed')
    expect(result.model.version).toBe(1)
    expect(result.model.cellFt).toBe(1)
    expect(result.model.openings).toEqual([])
    expect(result.model.contours[0]).toMatchObject({ label: 'Room', closed: true })
    expect(result.model.contours[0].points).toEqual(model.contours[0].points)
  })

  it('discards incomplete open chains so the rubber line has no active contour', () => {
    const model = {
      version: 1 as const,
      cellFt: 1,
      contours: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 4 },
          ],
        },
        {
          closed: false,
          points: [
            { x: 8, y: 8 },
            { x: 10, y: 8 },
          ],
        },
      ],
      openings: [],
      placedItems: [{ id: 'item-1', xFt: 1, zFt: 2 }],
    }

    const result = finishLastOpenContour(model)

    expect(result.changed).toBe(true)
    expect(result.action).toBe('discarded')
    expect(result.model.version).toBe(1)
    expect(result.model.openings).toBe(model.openings)
    expect(result.model.placedItems).toBe(model.placedItems)
    expect(result.model.contours).toHaveLength(1)
    expect(result.model.contours[0]).toBe(model.contours[0])
  })

  it('treats Escape-style cancellation as discarding the active open chain', () => {
    const model = {
      version: 1 as const,
      cellFt: 1,
      contours: [
        {
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 6, y: 0 },
            { x: 6, y: 4 },
          ],
        },
      ],
      openings: [],
    }

    const result = finishLastOpenContour(model, { closeComplete: false })

    expect(result.changed).toBe(true)
    expect(result.action).toBe('discarded')
    expect(result.model.contours).toEqual([])
  })

  it('detects a click near the start node as a close action for an open contour', () => {
    const contour = {
      closed: false,
      points: [
        { x: 2, y: 2 },
        { x: 8, y: 2 },
        { x: 8, y: 6 },
      ],
    }

    expect(shouldCloseOpenContourFromPoint(contour, { x: 2.3, y: 2.2 }, 0.45)).toBe(true)
    expect(shouldCloseOpenContourFromPoint(contour, { x: 2.6, y: 2.2 }, 0.45)).toBe(false)
    expect(shouldCloseOpenContourFromPoint({ ...contour, closed: true }, { x: 2, y: 2 }, 0.45)).toBe(false)
  })
})
