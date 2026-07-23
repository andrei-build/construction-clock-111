import { describe, expect, it } from 'vitest'
import {
  buildDispatchBoard,
  canAssign,
  canSwap,
  findDoubleAssignments,
  isWorkerAssignedTo,
  workerProjectIds,
} from '../src/lib/dispatchBoard'
import type { CurrentAssignmentRow, Profile, Project, Task, UnassignedWorkerRow } from '../src/lib/types'

const profile = (id: string, name: string, role: Profile['role'] = 'worker'): Profile => ({
  id,
  org_id: 'org-1',
  name,
  role,
  language: 'en',
  is_active: true,
  project_access_mode: 'assigned',
})

const project = (id: string, name: string): Project => ({
  id,
  org_id: 'org-1',
  name,
  address: `${name} st`,
  status: 'active',
  gps_radius_m: 150,
})

const assignment = (
  projectId: string,
  workerId: string,
  extra: Partial<CurrentAssignmentRow> = {},
): CurrentAssignmentRow => ({
  org_id: 'org-1',
  project_id: projectId,
  project_name: projectId.toUpperCase(),
  profile_id: workerId,
  worker_name: workerId,
  role: 'worker',
  note: null,
  assigned_at: '2026-07-20T14:00:00Z',
  ...extra,
})

const unassignedRow = (id: string, name: string, role: Profile['role'] = 'worker'): UnassignedWorkerRow => ({
  org_id: 'org-1',
  profile_id: id,
  name,
  role,
})

const task = (id: string, projectId: string | null, assignedTo: string | null, extra: Partial<Task> = {}): Task => ({
  id,
  org_id: 'org-1',
  project_id: projectId,
  task_type: 'work',
  title: `task ${id}`,
  status: 'open',
  priority: 'medium',
  assigned_to: assignedTo,
  ...extra,
})

describe('buildDispatchBoard', () => {
  const projects = [project('p1', 'Alpha'), project('p2', 'Beta')]
  const team = [profile('w1', 'Ana'), profile('w2', 'Ben'), profile('w3', 'Cid'), profile('c1', 'Client', 'client')]

  it('right column = all unassigned crew, sorted, with live count', () => {
    const board = buildDispatchBoard({
      projects,
      team,
      assignments: [assignment('p1', 'w1')],
      unassigned: [unassignedRow('w3', 'Cid'), unassignedRow('w2', 'Ben'), unassignedRow('c1', 'Client', 'client')],
      tasks: [],
    })
    // client role filtered out of crew; sorted by name
    expect(board.free.map((p) => p.name)).toEqual(['Ben', 'Cid'])
    expect(board.freeCount).toBe(2)
    expect(board.assignedCount).toBe(1)
  })

  it('left column groups projects with assigned workers and their tasks (что делает)', () => {
    const board = buildDispatchBoard({
      projects,
      team,
      assignments: [assignment('p1', 'w1'), assignment('p1', 'w2'), assignment('p2', 'w3')],
      unassigned: [],
      tasks: [
        task('t1', 'p1', 'w1', { title: 'Frame wall' }),
        task('t2', 'p1', 'w1', { title: 'Done thing', status: 'done' }), // excluded (not active)
        task('t3', 'p2', 'w3', { title: 'Tile floor' }),
        task('t4', 'p2', null, { title: 'Unassigned task' }), // not tied to a worker
      ],
    })
    expect(board.groups.map((g) => g.project.name)).toEqual(['Alpha', 'Beta'])
    const alpha = board.groups[0]
    expect(alpha.workers.map((w) => w.profile.name)).toEqual(['Ana', 'Ben'])
    expect(alpha.workers[0].tasks.map((t) => t.title)).toEqual(['Frame wall'])
    expect(board.groups[1].workers[0].tasks.map((t) => t.title)).toEqual(['Tile floor'])
  })

  it('skips assignments whose project no longer exists', () => {
    const board = buildDispatchBoard({
      projects,
      team,
      assignments: [assignment('gone', 'w1')],
      unassigned: [],
      tasks: [],
    })
    expect(board.groups).toEqual([])
    expect(board.assignedCount).toBe(1)
  })

  it('does not duplicate a worker card if the assignment row repeats', () => {
    const board = buildDispatchBoard({
      projects,
      team,
      assignments: [assignment('p1', 'w1'), assignment('p1', 'w1')],
      unassigned: [],
      tasks: [],
    })
    expect(board.groups[0].workers).toHaveLength(1)
  })

  it('empty everything → all distributed, no groups', () => {
    const board = buildDispatchBoard({ projects, team, assignments: [], unassigned: [], tasks: [] })
    expect(board.freeCount).toBe(0)
    expect(board.groups).toEqual([])
    expect(board.assignedCount).toBe(0)
  })
})

describe('assignment / swap validity', () => {
  const projects = [project('p1', 'Alpha'), project('p2', 'Beta')]
  const assignments = [assignment('p1', 'w1')]

  it('workerProjectIds returns unique projects for a worker', () => {
    const rows = [assignment('p1', 'w1'), assignment('p2', 'w1'), assignment('p1', 'w1')]
    expect(workerProjectIds(rows, 'w1').sort()).toEqual(['p1', 'p2'])
  })

  it('isWorkerAssignedTo detects membership', () => {
    expect(isWorkerAssignedTo(assignments, 'w1', 'p1')).toBe(true)
    expect(isWorkerAssignedTo(assignments, 'w1', 'p2')).toBe(false)
  })

  it('canAssign: free worker to existing project not already on it', () => {
    expect(canAssign(assignments, projects, 'w2', 'p1')).toBe(true)
    expect(canAssign(assignments, projects, 'w1', 'p1')).toBe(false) // already there
    expect(canAssign(assignments, projects, 'w2', 'ghost')).toBe(false) // project missing
    expect(canAssign(assignments, projects, '', 'p1')).toBe(false)
  })

  it('canSwap: different project, on source, not on target', () => {
    expect(canSwap(assignments, 'w1', 'p1', 'p2')).toBe(true)
    expect(canSwap(assignments, 'w1', 'p1', 'p1')).toBe(false) // same
    expect(canSwap(assignments, 'w1', 'p2', 'p1')).toBe(false) // not on source
    const both = [assignment('p1', 'w1'), assignment('p2', 'w1')]
    expect(canSwap(both, 'w1', 'p1', 'p2')).toBe(false) // already on target
  })
})

describe('findDoubleAssignments', () => {
  it('flags a worker booked on two projects', () => {
    const team = [profile('w1', 'Ana'), profile('w2', 'Ben')]
    const rows = [
      assignment('p1', 'w1', { project_name: 'Alpha' }),
      assignment('p2', 'w1', { project_name: 'Beta' }),
      assignment('p1', 'w2', { project_name: 'Alpha' }),
    ]
    const doubles = findDoubleAssignments(rows, team)
    expect(doubles).toHaveLength(1)
    expect(doubles[0]).toEqual({ profileId: 'w1', name: 'Ana', projects: ['Alpha', 'Beta'] })
  })

  it('no doubles when everyone is on at most one project', () => {
    const team = [profile('w1', 'Ana')]
    expect(findDoubleAssignments([assignment('p1', 'w1')], team)).toEqual([])
  })
})
