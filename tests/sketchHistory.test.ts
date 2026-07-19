import { describe, expect, it } from 'vitest'
import {
  emptySketchHistory,
  recordSketchHistory,
  redoSketchHistory,
  undoSketchHistory,
  SKETCH_HISTORY_LIMIT,
  type SketchHistory,
} from '../src/screens/project-hub/sketchHistory'

type TestSketchState = { step: number; label: string }

function applyOperation(
  history: SketchHistory<TestSketchState>,
  current: TestSketchState,
  next: TestSketchState,
) {
  return {
    current: next,
    history: recordSketchHistory(history, current),
  }
}

describe('sketch undo/redo history', () => {
  it('undoes twice, redoes once, and restores the expected sketch state', () => {
    let state = {
      current: { step: 0, label: 'empty' },
      history: emptySketchHistory<TestSketchState>(),
    }

    state = applyOperation(state.history, state.current, { step: 1, label: 'wall' })
    state = applyOperation(state.history, state.current, { step: 2, label: 'door' })
    state = applyOperation(state.history, state.current, { step: 3, label: 'tile' })

    const firstUndo = undoSketchHistory(state.history, state.current)
    expect(firstUndo?.current).toEqual({ step: 2, label: 'door' })
    if (!firstUndo) return
    state = firstUndo

    const secondUndo = undoSketchHistory(state.history, state.current)
    expect(secondUndo?.current).toEqual({ step: 1, label: 'wall' })
    if (!secondUndo) return
    state = secondUndo

    const redo = redoSketchHistory(state.history, state.current)
    expect(redo?.current).toEqual({ step: 2, label: 'door' })
  })

  it('keeps at least fifty undo states within the configured history depth', () => {
    let state = {
      current: { step: 0, label: 'start' },
      history: emptySketchHistory<TestSketchState>(),
    }

    for (let step = 1; step <= SKETCH_HISTORY_LIMIT + 10; step += 1) {
      state = applyOperation(state.history, state.current, { step, label: `op-${step}` })
    }

    expect(state.history.undo).toHaveLength(SKETCH_HISTORY_LIMIT)
    expect(state.history.undo[0]).toEqual({ step: 10, label: 'op-10' })
    expect(state.history.undo[state.history.undo.length - 1]).toEqual({ step: SKETCH_HISTORY_LIMIT + 9, label: `op-${SKETCH_HISTORY_LIMIT + 9}` })
  })

  it('drops the redo branch after a new operation', () => {
    let state = {
      current: { step: 0, label: 'empty' },
      history: emptySketchHistory<TestSketchState>(),
    }

    state = applyOperation(state.history, state.current, { step: 1, label: 'wall' })
    state = applyOperation(state.history, state.current, { step: 2, label: 'door' })

    const undone = undoSketchHistory(state.history, state.current)
    expect(undone?.history.redo).toEqual([{ step: 2, label: 'door' }])
    if (!undone) return

    state = {
      current: { step: 3, label: 'window' },
      history: recordSketchHistory(undone.history, undone.current),
    }

    expect(state.history.redo).toEqual([])
    expect(redoSketchHistory(state.history, state.current)).toBeNull()
  })
})
