// GPS geofence radius bounds (meters). Matches the old Check Time behavior:
// a radius outside this range makes no practical sense for a jobsite geofence.
export const GPS_RADIUS_MIN = 25
export const GPS_RADIUS_MAX = 300
export const GPS_RADIUS_STEP = 5

// SET-1: bounds for the SUPPLY-STORE visit geofence (app_settings.store_visit_radius_m).
// Deliberately tighter than the jobsite range — a store visit is a point-of-sale check-in,
// not a sprawling jobsite. Default 75 m matches migration 0030.
export const STORE_RADIUS_MIN = 50
export const STORE_RADIUS_MAX = 150
export const STORE_RADIUS_STEP = 5
export const STORE_RADIUS_DEFAULT = 75

// Clamp the store-visit radius into [50, 150] m, rounded to an integer.
// Returns the default (75) when the value is not a finite number (empty/NaN input).
export function clampStoreRadius(value: number): number {
  if (!Number.isFinite(value)) return STORE_RADIUS_DEFAULT
  return Math.min(STORE_RADIUS_MAX, Math.max(STORE_RADIUS_MIN, Math.round(value)))
}

// Clamp a geofence radius into the sane [25, 300] m range, rounded to an integer.
// HTML min/max on <input> does not block typed out-of-range values, so callers
// must run the value through this before writing it to state or the DB.
// Returns `fallback` when the value is not a finite number (empty/NaN input).
export function clampGpsRadius(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(GPS_RADIUS_MAX, Math.max(GPS_RADIUS_MIN, Math.round(value)))
}
