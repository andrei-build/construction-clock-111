import { describe, expect, it } from 'vitest'
import {
  hasClearableSketchContent,
  resolveWallDraftAfterContourFinish,
  shouldResetWallDraftAfterContourFinish,
  shouldTrackWallDraftPointer,
} from '../src/screens/project-hub/sketchGuides'

describe('sketch close draft cleanup', () => {
  it('clears the wall draft after a contour closes without arming a new room', () => {
    const draft = {
      hover: { x: 4, y: 3 },
      hoverSnapped: true,
      hoverSnapGuide: { kind: 'point' },
      newRoomDraftPending: true,
    }

    const result = { changed: true, action: 'closed' as const }

    expect(shouldResetWallDraftAfterContourFinish(result)).toBe(true)
    expect(resolveWallDraftAfterContourFinish(result, draft)).toEqual({
      hover: null,
      hoverSnapped: false,
      hoverSnapGuide: null,
      newRoomDraftPending: false,
    })
  })

  it('keeps the draft unchanged when no contour was finished', () => {
    const draft = {
      hover: { x: 1, y: 2 },
      hoverSnapped: false,
      hoverSnapGuide: null,
      newRoomDraftPending: false,
    }

    expect(resolveWallDraftAfterContourFinish({ changed: false, action: 'none' }, draft)).toBe(draft)
  })

  it('requires clear confirmation only when the sketch has content', () => {
    expect(hasClearableSketchContent({ contours: [] })).toBe(false)
    expect(hasClearableSketchContent({
      contours: [],
      openings: [],
      measurements: [],
      placedItems: [],
    })).toBe(false)
    expect(hasClearableSketchContent({ contours: [{ closed: false, points: [{ x: 0, y: 0 }] }] })).toBe(true)
    expect(hasClearableSketchContent({ contours: [], measurements: [{}] })).toBe(true)
  })

  it('tracks the wall pointer only for an active draft or explicit new-room mode', () => {
    expect(shouldTrackWallDraftPointer(null, false)).toBe(false)
    expect(shouldTrackWallDraftPointer({ closed: true, points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }] }, false)).toBe(false)
    expect(shouldTrackWallDraftPointer({ closed: false, points: [] }, false)).toBe(false)
    expect(shouldTrackWallDraftPointer({ closed: false, points: [{ x: 0, y: 0 }] }, false)).toBe(true)
    expect(shouldTrackWallDraftPointer(null, true)).toBe(true)
  })
})
