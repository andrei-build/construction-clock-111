import { describe, expect, it } from 'vitest'
import { snapToExistingGeometry } from '../src/screens/project-hub/sketchGuides'
import { sketchWallKey } from '../src/screens/project-hub/sketchFinishes'

describe('multi-room sketch geometry', () => {
  it('snaps a new room point to an existing room vertex and ignores the active open contour', () => {
    const result = snapToExistingGeometry(
      {
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
          {
            closed: false,
            points: [
              { x: 10.35, y: 0.2 },
              { x: 12, y: 0.2 },
            ],
          },
        ],
      },
      { x: 10.35, y: 0.2 },
      { radiusCells: 0.6 },
    )

    expect(result?.point).toEqual({ x: 10, y: 0 })
    expect(result?.target).toMatchObject({ kind: 'point', c: 0, p: 1 })
  })

  it('snaps a new room point to the nearest point on an existing wall segment', () => {
    const result = snapToExistingGeometry(
      {
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
      },
      { x: 5, y: 0.42 },
      { radiusCells: 0.6 },
    )

    expect(result?.point).toEqual({ x: 5, y: 0 })
    expect(result?.target).toMatchObject({ kind: 'segment', c: 0, s: 0, t: 0.5 })
  })

  it('does not snap to points that belong only to the active open contour', () => {
    const result = snapToExistingGeometry(
      {
        contours: [
          {
            closed: true,
            points: [
              { x: 0, y: 0 },
              { x: 4, y: 0 },
              { x: 4, y: 4 },
              { x: 0, y: 4 },
            ],
          },
          {
            closed: false,
            points: [
              { x: 20, y: 20 },
              { x: 21, y: 20 },
            ],
          },
        ],
      },
      { x: 20.1, y: 20.05 },
      { radiusCells: 0.6 },
    )

    expect(result).toBeNull()
  })

  it('keeps wall finish keys distinct for different contours', () => {
    expect(sketchWallKey(0, 0)).toBe('0:0')
    expect(sketchWallKey(1, 0)).toBe('1:0')
    expect(sketchWallKey(0, 0)).not.toBe(sketchWallKey(1, 0))
  })
})
