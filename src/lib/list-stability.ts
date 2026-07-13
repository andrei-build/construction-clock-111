// F87 (Check Time parity, ref: list-stability.ts keepStableListIfUnchanged):
// Polling refetch normally swaps list state for a brand-new array every tick,
// even when the content is identical — forcing needless re-renders and reorder
// flicker. Keeping the SAME array reference when the refetched content is
// content-equal lets React bail out of the update.

/**
 * Returns `prev` (same reference) when `next` is content-equal to `prev`,
 * otherwise returns `next`. Equality is order-sensitive: same length AND, at
 * every index, the same key. `keyOf` defaults to `JSON.stringify` of the item.
 * Pure — no side effects.
 */
export function keepStableListIfUnchanged<T>(
  prev: T[],
  next: T[],
  keyOf: (item: T) => string = (item) => JSON.stringify(item),
): T[] {
  if (prev === next) return prev
  if (prev.length !== next.length) return next
  for (let i = 0; i < next.length; i++) {
    if (keyOf(prev[i]) !== keyOf(next[i])) return next
  }
  return prev
}
