export const SKETCH_HISTORY_LIMIT = 60

export type SketchHistory<T> = {
  undo: T[]
  redo: T[]
}

export function emptySketchHistory<T>(): SketchHistory<T> {
  return { undo: [], redo: [] }
}

export function recordSketchHistory<T>(
  history: SketchHistory<T>,
  current: T,
  limit = SKETCH_HISTORY_LIMIT,
): SketchHistory<T> {
  const maxDepth = Math.max(1, Math.floor(limit))
  return {
    undo: [...history.undo.slice(-maxDepth + 1), current],
    redo: [],
  }
}

export function undoSketchHistory<T>(
  history: SketchHistory<T>,
  current: T,
  limit = SKETCH_HISTORY_LIMIT,
): { history: SketchHistory<T>; current: T } | null {
  const previous = history.undo[history.undo.length - 1]
  if (previous === undefined) return null
  const maxDepth = Math.max(1, Math.floor(limit))
  return {
    current: previous,
    history: {
      undo: history.undo.slice(0, -1),
      redo: [current, ...history.redo].slice(0, maxDepth),
    },
  }
}

export function redoSketchHistory<T>(
  history: SketchHistory<T>,
  current: T,
  limit = SKETCH_HISTORY_LIMIT,
): { history: SketchHistory<T>; current: T } | null {
  const next = history.redo[0]
  if (next === undefined) return null
  const maxDepth = Math.max(1, Math.floor(limit))
  return {
    current: next,
    history: {
      undo: [...history.undo.slice(-maxDepth + 1), current],
      redo: history.redo.slice(1),
    },
  }
}
