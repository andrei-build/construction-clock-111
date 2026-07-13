// GPS geofence radius bounds (meters). Matches the old Check Time behavior:
// a radius outside this range makes no practical sense for a jobsite geofence.
export const GPS_RADIUS_MIN = 25
export const GPS_RADIUS_MAX = 300
export const GPS_RADIUS_STEP = 5

// Clamp a geofence radius into the sane [25, 300] m range, rounded to an integer.
// HTML min/max on <input> does not block typed out-of-range values, so callers
// must run the value through this before writing it to state or the DB.
// Returns `fallback` when the value is not a finite number (empty/NaN input).
export function clampGpsRadius(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(GPS_RADIUS_MAX, Math.max(GPS_RADIUS_MIN, Math.round(value)))
}
