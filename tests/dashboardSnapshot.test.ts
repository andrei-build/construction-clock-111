import { describe, expect, it } from 'vitest'
import {
  buildDashboardWorkerProfiles,
  buildUnassignedWorkerProfiles,
  normalizeOrgSnapshot,
  orgSnapshotHoursTodayMs,
} from '../src/lib/dashboardSnapshot'
import type { Profile } from '../src/lib/types'

const profile = (id: string, name: string): Profile => ({
  id,
  org_id: 'org-1',
  name,
  role: 'worker',
  language: 'en',
  is_active: true,
  project_access_mode: 'assigned',
})

describe('dashboard snapshot mapping', () => {
  it('maps canonical snapshot rows into dashboard models', () => {
    const snapshot = normalizeOrgSnapshot({
      projects: [{ id: 'p1', org_id: 'org-1', name: 'Alpha', address: null, status: 'active', gps_radius_m: 150 }],
      team: [profile('w1', 'Ana'), profile('w2', 'Ben')],
      on_shift: [{ org_id: 'org-1', profile_id: 'w1', name: 'Ana', role: 'worker', project_id: 'p1', since: '2026-07-20T15:00:00Z' }],
      assignments: [
        { org_id: 'org-1', project_id: 'p1', project_name: 'Alpha', profile_id: 'w1', worker_name: 'Ana', role: 'worker', note: null, assigned_at: '2026-07-20T14:00:00Z' },
      ],
      unassigned: [{ org_id: 'org-1', profile_id: 'w2', name: 'Ben', role: 'worker' }],
      open_tasks: [{ id: 't1', org_id: 'org-1', project_id: 'p1', task_type: 'work', title: 'Frame', status: 'open', priority: 'high', assigned_to: null }],
      hours_today: '7.5',
      hours_yesterday: 3,
      risks: [],
      projects_money: [],
      recent_events: [],
      as_of: '2026-07-20T16:00:00Z',
    })

    expect(snapshot.on_shift).toEqual([
      { org_id: 'org-1', profile_id: 'w1', name: 'Ana', role: 'worker', project_id: 'p1', since: '2026-07-20T15:00:00Z' },
    ])
    expect(orgSnapshotHoursTodayMs(snapshot)).toBe(7.5 * 60 * 60 * 1000)
    expect(buildDashboardWorkerProfiles(snapshot.assignments, snapshot.unassigned, snapshot.team).map((worker) => worker.name)).toEqual(['Ana', 'Ben'])
    expect(buildUnassignedWorkerProfiles(snapshot.unassigned, snapshot.team).map((worker) => worker.id)).toEqual(['w2'])
  })
})
