import { describe, expect, it } from 'vitest'
import {
  SKETCH_3D_CAMERA_AIR_MULTIPLIER,
  buildSketch3DWallPlan,
  evaluateSketch3DInsideStanding,
  sketch3dFitDistanceForExtents,
  sketch3dFitPad,
  sketch3dSegmentWorld,
  type Sketch3DWallPiece,
} from '../src/screens/project-hub/sketch3dGeometry'
import type { Sketch3DModel } from '../src/screens/project-hub/sketchFinishes'

const wallClearanceFt = 0.75

function rectangleModel(): Sketch3DModel {
  return {
    version: 1,
    cellFt: 1,
    height: 8,
    contours: [
      {
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 12, y: 0 },
          { x: 12, y: 8 },
          { x: 0, y: 8 },
        ],
      },
    ],
    openings: [],
  }
}

function adjacentRoomsModel(): Sketch3DModel {
  return {
    version: 1,
    cellFt: 1,
    height: 8,
    contours: [
      {
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      },
      {
        closed: true,
        points: [
          { x: 10, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 10 },
          { x: 10, y: 10 },
        ],
      },
    ],
    openings: [],
  }
}

function pieceBounds(piece: Sketch3DWallPiece) {
  return [piece.startFt, piece.endFt, piece.bottomFt, piece.topFt].map((value) => Number(value.toFixed(4)))
}

describe('sketch 3d geometry', () => {
  it('splits a wall into piers, door headers, and window sill/header pieces', () => {
    const model: Sketch3DModel = {
      ...rectangleModel(),
      openings: [
        { kind: 'window', c: 0, s: 0, t: 9 / 12, w: 3, h: 4, sill: 3 },
        { kind: 'door', c: 0, s: 0, t: 3 / 12, w: 2, h: 7 },
      ],
    }
    const segment = sketch3dSegmentWorld(model, 0, 0)
    expect(segment).not.toBeNull()

    const plan = buildSketch3DWallPlan(model, segment!, 8)

    expect(plan.openings.map((opening) => opening.openingIndex)).toEqual([1, 0])
    expect(plan.pieces.filter((piece) => piece.kind === 'pier').map(pieceBounds)).toEqual([
      [0, 2, 0, 8],
      [4, 7.5, 0, 8],
      [10.5, 12, 0, 8],
    ])
    expect(plan.pieces.filter((piece) => piece.kind === 'header').map(pieceBounds)).toEqual([
      [2, 4, 7, 8],
      [7.5, 10.5, 7, 8],
    ])
    expect(plan.pieces.filter((piece) => piece.kind === 'sill').map(pieceBounds)).toEqual([
      [7.5, 10.5, 0, 3],
    ])
  })

  it('cuts the same physical opening into both copies of a shared wall segment', () => {
    const model: Sketch3DModel = {
      ...adjacentRoomsModel(),
      openings: [{ kind: 'door', c: 0, s: 1, t: 0.5, w: 3, h: 7 }],
    }
    const leftCopy = sketch3dSegmentWorld(model, 0, 1)
    const rightCopy = sketch3dSegmentWorld(model, 1, 3)
    expect(leftCopy).not.toBeNull()
    expect(rightCopy).not.toBeNull()

    const leftPlan = buildSketch3DWallPlan(model, leftCopy!, 8)
    const rightPlan = buildSketch3DWallPlan(model, rightCopy!, 8)

    expect(leftPlan.openings).toHaveLength(1)
    expect(rightPlan.openings).toHaveLength(1)
    expect(leftPlan.openings[0]).toMatchObject({ sourceWallKey: '0:1', leftFt: 3.5, rightFt: 6.5 })
    expect(rightPlan.openings[0]).toMatchObject({ sourceWallKey: '0:1', leftFt: 3.5, rightFt: 6.5 })
  })

  it('allows standing in any closed room and crossing a shared wall only through a door', () => {
    const model: Sketch3DModel = {
      ...adjacentRoomsModel(),
      openings: [{ kind: 'door', c: 0, s: 1, t: 0.5, w: 3, h: 7 }],
    }

    expect(evaluateSketch3DInsideStanding(model, 5, 5, { wallClearanceFt }).valid).toBe(true)
    expect(evaluateSketch3DInsideStanding(model, 15, 5, { wallClearanceFt }).valid).toBe(true)
    expect(evaluateSketch3DInsideStanding(model, 10.1, 5, { wallClearanceFt }).valid).toBe(true)
    expect(evaluateSketch3DInsideStanding(model, 10.1, 1, { wallClearanceFt }).valid).toBe(false)
  })

  it('keeps windows non-passable for inside walking', () => {
    const model: Sketch3DModel = {
      ...adjacentRoomsModel(),
      openings: [{ kind: 'window', c: 0, s: 1, t: 0.5, w: 3, h: 4, sill: 3 }],
    }

    expect(evaluateSketch3DInsideStanding(model, 10.1, 5, { wallClearanceFt }).valid).toBe(false)
  })

  it('grows fit distance monotonically and keeps more air than the previous tight multiplier', () => {
    const common = {
      verticalFovRad: (65 * Math.PI) / 180,
      aspect: 1.6,
      minCameraDistanceFt: 6,
      maxCameraDistanceFt: 1000,
    }
    const small = sketch3dFitDistanceForExtents({ ...common, halfWidthFt: 5, halfHeightFt: 4, depthHalfFt: 5 })
    const large = sketch3dFitDistanceForExtents({ ...common, halfWidthFt: 10, halfHeightFt: 8, depthHalfFt: 10 })
    const horizontalFovRad = 2 * Math.atan(Math.tan(common.verticalFovRad / 2) * common.aspect)
    const oldTightDistance = ((Math.max(4 / Math.tan(common.verticalFovRad / 2), 5 / Math.tan(horizontalFovRad / 2)) + 5) * 1.12)

    expect(SKETCH_3D_CAMERA_AIR_MULTIPLIER).toBeGreaterThan(1.12)
    expect(large).toBeGreaterThan(small)
    expect(small).toBeGreaterThan(oldTightDistance)
    expect(sketch3dFitPad(30)).toBeGreaterThan(Math.max(1.25, Math.min(8, 30 * 0.08)))
  })

  it('does not mutate version or opening wall keys while planning wall cuts', () => {
    const model: Sketch3DModel = {
      ...adjacentRoomsModel(),
      openings: [{ kind: 'door', c: 0, s: 1, t: 0.5, w: 3, h: 7 }],
    }
    const before = JSON.stringify(model)
    const segment = sketch3dSegmentWorld(model, 1, 3)
    expect(segment).not.toBeNull()

    buildSketch3DWallPlan(model, segment!, 8)

    expect(model.version).toBe(1)
    expect(model.openings[0]).toMatchObject({ c: 0, s: 1 })
    expect(JSON.stringify(model)).toBe(before)
  })
})
