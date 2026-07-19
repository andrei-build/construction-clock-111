import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SKETCH_ROOM_TEMPLATES,
  duplicateSketchSelection,
  mirrorSketchSelection,
  sketchContourAreaSqft,
  sketchContourPerimeterFt,
  type SketchTemplateModel,
} from '../src/screens/project-hub/sketchTemplates'

const idFactory = (prefix: string, sourceId?: string) => `${prefix}-${sourceId ?? 'copy'}`

describe('project hub sketch room templates', () => {
  it('builds the bathroom 5x8 preset as a closed four-wall 40 sqft contour', () => {
    const template = BUILTIN_SKETCH_ROOM_TEMPLATES.find((item) => item.id === 'bath-5x8')
    expect(template).toBeTruthy()
    if (!template) return

    expect(template.model.contours).toHaveLength(1)
    const contour = template.model.contours[0]
    expect(contour.closed).toBe(true)
    expect(contour.points).toHaveLength(4)
    expect(sketchContourAreaSqft(contour, template.model.cellFt)).toBeCloseTo(40, 5)
    expect(sketchContourPerimeterFt(contour, template.model.cellFt)).toBeCloseTo(26, 5)
  })

  it('mirrors a contour copy across X and keeps it closed', () => {
    const model: SketchTemplateModel = {
      version: 1,
      cellFt: 1,
      contours: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 3 },
            { x: 1, y: 3 },
            { x: 1, y: 5 },
            { x: 0, y: 5 },
          ],
        },
      ],
      openings: [],
    }

    const result = mirrorSketchSelection(model, { kind: 'contour', c: 0 }, 2, { x: 0, y: 0 }, idFactory)

    expect(result).toBeTruthy()
    if (!result) return
    expect(result.model.contours).toHaveLength(2)
    expect(result.model.contours[1].closed).toBe(true)
    expect(result.model.contours[1].points.map((point) => point.x)).toEqual([4, 0, 0, 3, 3, 4])
    expect(result.model.contours[1].points.map((point) => point.y)).toEqual([0, 0, 3, 3, 5, 5])
  })

  it('duplicates a contour with an offset and preserves segment count', () => {
    const model: SketchTemplateModel = {
      version: 1,
      cellFt: 1,
      contours: [
        {
          closed: true,
          points: [
            { x: 2, y: 1 },
            { x: 7, y: 1 },
            { x: 7, y: 6 },
            { x: 2, y: 6 },
          ],
        },
      ],
      openings: [],
    }

    const result = duplicateSketchSelection(model, { kind: 'contour', c: 0 }, { x: 2, y: 3 }, idFactory)

    expect(result).toBeTruthy()
    if (!result) return
    const source = result.model.contours[0]
    const copy = result.model.contours[1]
    expect(copy.points).toEqual(source.points.map((point) => ({ x: point.x + 2, y: point.y + 3 })))
    expect(copy.closed).toBe(source.closed)
    expect(copy.points.length).toBe(source.points.length)
  })
})
