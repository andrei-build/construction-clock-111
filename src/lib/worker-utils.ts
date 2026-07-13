import type { Profile } from './types'

type WorkerLike = Pick<Profile, 'id' | 'name' | 'role'>

/**
 * F16 (Check Time parity: buildWorkerDisambiguationMap).
 * Pure over already-loaded workers — no queries. Given a list, returns a stable
 * id→label map. Names that are unique across the list render as-is; names shared
 * by two or more workers get a disambiguating suffix so lists stay tellable-apart:
 *   1. role, e.g. "Alex Kim (driver)"
 *   2. if the role also collides, a short id fragment: "Alex Kim (driver · a1b2c3)"
 * Deterministic: output depends only on the input list, never on call order.
 */
export function buildWorkerDisambiguationMap(workers: WorkerLike[]): Map<string, string> {
  const byName = new Map<string, WorkerLike[]>()
  for (const w of workers) {
    const key = (w.name ?? '').trim().toLowerCase()
    const group = byName.get(key)
    if (group) group.push(w)
    else byName.set(key, [w])
  }

  const labels = new Map<string, string>()
  for (const group of byName.values()) {
    if (group.length <= 1) {
      for (const w of group) labels.set(w.id, w.name)
      continue
    }
    // Name collision → try role as the distinguisher; fall back to an id fragment.
    const roleCounts = new Map<string, number>()
    for (const w of group) roleCounts.set(w.role, (roleCounts.get(w.role) ?? 0) + 1)
    for (const w of group) {
      const roleUnique = (roleCounts.get(w.role) ?? 0) <= 1
      const suffix = roleUnique ? w.role : `${w.role} · ${idFragment(w.id)}`
      labels.set(w.id, `${w.name} (${suffix})`)
    }
  }
  return labels
}

function idFragment(id: string): string {
  return id.replace(/-/g, '').slice(-6)
}
