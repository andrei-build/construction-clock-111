// F21 (П11 parity): derive human-readable "last seen" age from a GPS row's server
// timestamp. Parity reference: Check Time's gps-freshness deriveGpsFreshness/formatGpsAge.
//
// TOOLTIP/TEXT ONLY — these helpers produce a label string / tier name for the marker
// tooltip. They intentionally do NOT drive marker color/tone (presence green/gray is a
// separate owner decision; freshness-color is the held task F24). Dependency-free.

export type GpsFreshness = 'fresh' | 'delayed' | 'stale' | 'lost' | 'unknown'

// Tier thresholds in minutes (parity with Check Time): fresh <2m, delayed 2–5,
// stale 5–15, lost >15.
const DELAYED_AFTER_MS = 2 * 60_000
const STALE_AFTER_MS = 5 * 60_000
const LOST_AFTER_MS = 15 * 60_000

function ageMs(serverTime: string | null | undefined, nowMs: number): number | null {
  if (!serverTime) return null
  const then = new Date(serverTime).getTime()
  if (!Number.isFinite(then)) return null
  const diff = nowMs - then
  // Guard against clock skew / future timestamps — treat as "just now" (age 0).
  return diff < 0 ? 0 : diff
}

// Returns a freshness tier for the given GPS timestamp. Use ONLY for tooltip
// text/labels, never for marker color.
export function deriveGpsFreshness(
  serverTime: string | null | undefined,
  nowMs: number = Date.now(),
): GpsFreshness {
  const age = ageMs(serverTime, nowMs)
  if (age === null) return 'unknown'
  if (age < DELAYED_AFTER_MS) return 'fresh'
  if (age < STALE_AFTER_MS) return 'delayed'
  if (age < LOST_AFTER_MS) return 'stale'
  return 'lost'
}

// Returns a short human age like "just now" / "3m ago" / "2h ago", or "" when the
// timestamp is missing/unparseable.
export function formatGpsAge(
  serverTime: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const age = ageMs(serverTime, nowMs)
  if (age === null) return ''
  const minutes = Math.floor(age / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
