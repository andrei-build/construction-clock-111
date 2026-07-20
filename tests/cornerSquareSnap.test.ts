import { describe, expect, it } from 'vitest'
import { snapCornerSquare } from '../src/screens/project-hub/sketchGuides'

describe('corner square snap', () => {
  it('snaps the dragged corner x to a neighbor within threshold', () => {
    const result = snapCornerSquare(
      {
        contours: [
          {
            closed: false,
            points: [
              { x: 0, y: 0 },
              { x: 4, y: 4 },
              { x: 8, y: 7 },
            ],
          },
        ],
      },
      { x: 0.2, y: 3.25 },
      { contourIndex: 0, pointIndex: 1, thresholdCells: 0.5 },
    )

    expect(result.point).toEqual({ x: 0, y: 3.25 })
    expect(result.squared).toBe(true)
    expect(result.guides).toMatchObject([{ kind: 'corner-square', axis: 'x', value: 0 }])
  })

  it('snaps the dragged corner y to a neighbor within threshold', () => {
    const result = snapCornerSquare(
      {
        contours: [
          {
            closed: false,
            points: [
              { x: 0, y: 0 },
              { x: 4, y: 4 },
              { x: 8, y: 7 },
            ],
          },
        ],
      },
      { x: 3.25, y: 6.75 },
      { contourIndex: 0, pointIndex: 1, thresholdCells: 0.5 },
    )

    expect(result.point).toEqual({ x: 3.25, y: 7 })
    expect(result.squared).toBe(true)
    expect(result.guides).toMatchObject([{ kind: 'corner-square', axis: 'y', value: 7 }])
  })

  it('leaves a deliberate skew unchanged outside the threshold', () => {
    const draggedPoint = { x: 1, y: 2.4 }
    const result = snapCornerSquare(
      {
        contours: [
          {
            closed: false,
            points: [
              { x: 0, y: 0 },
              { x: 4, y: 4 },
              { x: 8, y: 7 },
            ],
          },
        ],
      },
      draggedPoint,
      { contourIndex: 0, pointIndex: 1, thresholdCells: 0.5 },
    )

    expect(result.point).toEqual(draggedPoint)
    expect(result.squared).toBe(false)
    expect(result.guides).toEqual([])
  })

  it('uses closed-contour wraparound neighbors for the first and last points', () => {
    const model = {
      contours: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 8 },
            { x: 0, y: 8 },
          ],
        },
      ],
    }

    expect(snapCornerSquare(model, { x: 0.2, y: 0.3 }, { contourIndex: 0, pointIndex: 0, thresholdCells: 0.5 }).point)
      .toEqual({ x: 0, y: 0 })
    expect(snapCornerSquare(model, { x: 0.2, y: 7.8 }, { contourIndex: 0, pointIndex: 3, thresholdCells: 0.5 }).point)
      .toEqual({ x: 0, y: 8 })
  })

  it('does not mutate model version or keys', () => {
    const model = {
      version: 1 as const,
      cellFt: 1,
      contours: [
        {
          closed: true,
          label: 'Kitchen',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 8 },
            { x: 0, y: 8 },
          ],
        },
      ],
      openings: [],
      placedItems: [{ id: 'cabinet-1', xFt: 2, zFt: 3 }],
    }
    const before = JSON.parse(JSON.stringify(model))
    const result = snapCornerSquare(model, { x: 9.8, y: 0.2 }, { contourIndex: 0, pointIndex: 1, thresholdCells: 0.5 })

    expect(result.point).toEqual({ x: 10, y: 0 })
    expect('version' in result).toBe(false)
    expect(Object.keys(model)).toEqual(Object.keys(before))
    expect(model).toEqual(before)
  })
})
