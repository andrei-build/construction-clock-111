// F24: per-worker deterministic marker colours for the Live Map.
// The same worker id always maps to the same colour across sessions/reloads —
// no randomness, no Date, pure function of the id. The hue is spread across the
// full wheel while S/L are fixed for consistent contrast (dark marker glyph on a
// light OSM basemap). The on-shift vs no-GPS signal is carried separately by the
// ring/muted treatment in styles.css — colour here is identity, not state.

// Fixed saturation/lightness tuned so the dark marker glyph (#070b12) stays
// legible on every hue while colours read as clearly distinct on a light map.
const MARKER_SATURATION = 68
const MARKER_LIGHTNESS = 60

// Deterministic 32-bit FNV-1a hash of the id string.
function hashId(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    // 32-bit FNV prime multiply, kept in unsigned 32-bit range.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Deterministic per-worker marker colour keyed off the worker id.
 * Returns an `hsl(...)` string with a hashed hue and fixed S/L.
 */
export function workerMarkerColor(id: string): string {
  const hue = hashId(id) % 360
  return `hsl(${hue} ${MARKER_SATURATION}% ${MARKER_LIGHTNESS}%)`
}
