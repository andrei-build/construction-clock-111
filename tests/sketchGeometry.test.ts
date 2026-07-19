import { describe, expect, it } from 'vitest'
import { formatFeetInches, parseFeetInches, parseInches } from '../src/screens/project-hub/inches'
import {
  resizeSketchSegmentToLength,
  sketchContourAreaCells,
  sketchContourPerimeterCells,
  type Sketch3DModel,
} from '../src/screens/project-hub/sketchFinishes'

describe('project hub sketch dimension-driven geometry', () => {
  it('resizes a rectangle side and keeps the opposite side, area, and perimeter in sync', () => {
    const model: Sketch3DModel = {
      version: 1,
      cellFt: 1,
      contours: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 18, y: 0 },
            { x: 18, y: 9 },
            { x: 0, y: 9 },
          ],
        },
      ],
      openings: [],
    }

    const result = resizeSketchSegmentToLength(model, { c: 0, s: 0 }, 20)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const contour = result.model.contours[0]
    expect(contour.points).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 9 },
      { x: 0, y: 9 },
    ])
    expect(sketchContourAreaCells(contour)).toBe(180)
    expect(sketchContourPerimeterCells(contour)).toBe(58)
  })

  it('keeps sixteenth-inch parsing and formatting intact for sketch dimensions', () => {
    expect(parseInches('1/16')).toBe(0.0625)
    expect(parseFeetInches('8 ft 3 1/16 in')).toBe(99.0625)
    expect(formatFeetInches(0.0625)).toBe('1/16 in')
  })
})
