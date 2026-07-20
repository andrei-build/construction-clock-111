import type {
  CurrentAssignmentRow,
  EventRow,
  OnShiftNowRow,
  OrgSnapshot,
  Profile,
  Project,
  Role,
  SuspiciousShift,
  Task,
  UnassignedWorkerRow,
} from './types'

const HOUR_MS = 60 * 60 * 1000
const KNOWN_ROLES: readonly Role[] = [
  'owner',
  'admin',
  'manager',
  'supervisor',
  'worker',
  'driver',
  'subcontractor',
  'client',
  'sales',
]
const KNOWN_ROLE_SET = new Set<string>(KNOWN_ROLES)

type UnknownRecord = Record<string, unknown>
type WorkerSource = {
  org_id: string
  profile_id: string
  role: Role
  name?: string | null
  worker_name?: string | null
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRows(value: unknown): UnknownRecord[] {
  return asArray(value).filter(isRecord)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function numberValue(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0
  return Number.isFinite(n) ? n : 0
}

function roleValue(value: unknown): Role {
  return typeof value === 'string' && KNOWN_ROLE_SET.has(value) ? value as Role : 'worker'
}

function sourceName(source: WorkerSource): string {
  return source.worker_name ?? source.name ?? '—'
}

export function normalizeOnShiftRows(value: unknown): OnShiftNowRow[] {
  return asRows(value)
    .map((row) => ({
      org_id: stringValue(row.org_id),
      profile_id: stringValue(row.profile_id),
      name: stringValue(row.name, '—'),
      role: roleValue(row.role),
      project_id: nullableString(row.project_id),
      since: nullableString(row.since),
    }))
    .filter((row) => row.profile_id !== '')
}

export function normalizeAssignmentRows(value: unknown): CurrentAssignmentRow[] {
  return asRows(value)
    .map((row) => ({
      org_id: stringValue(row.org_id),
      project_id: stringValue(row.project_id),
      project_name: nullableString(row.project_name),
      profile_id: stringValue(row.profile_id),
      worker_name: stringValue(row.worker_name, '—'),
      role: roleValue(row.role),
      note: nullableString(row.note),
      assigned_at: nullableString(row.assigned_at),
    }))
    .filter((row) => row.project_id !== '' && row.profile_id !== '')
}

export function normalizeUnassignedRows(value: unknown): UnassignedWorkerRow[] {
  return asRows(value)
    .map((row) => ({
      org_id: stringValue(row.org_id),
      profile_id: stringValue(row.profile_id),
      name: stringValue(row.name, '—'),
      role: roleValue(row.role),
    }))
    .filter((row) => row.profile_id !== '')
}

export function normalizeOrgSnapshot(value: unknown): OrgSnapshot {
  const row = asRecord(value)
  return {
    projects: asArray(row.projects) as Project[],
    team: asArray(row.team) as Profile[],
    on_shift: normalizeOnShiftRows(row.on_shift),
    assignments: normalizeAssignmentRows(row.assignments),
    unassigned: normalizeUnassignedRows(row.unassigned),
    open_tasks: asArray(row.open_tasks) as Task[],
    hours_today: numberValue(row.hours_today),
    hours_yesterday: numberValue(row.hours_yesterday),
    risks: asArray(row.risks) as SuspiciousShift[],
    projects_money: asArray(row.projects_money),
    recent_events: asArray(row.recent_events) as EventRow[],
    as_of: nullableString(row.as_of),
  }
}

export function dashboardHoursToMs(hours: number | null | undefined): number {
  const n = Number(hours ?? 0)
  return Number.isFinite(n) && n > 0 ? n * HOUR_MS : 0
}

export function orgSnapshotHoursTodayMs(snapshot: Pick<OrgSnapshot, 'hours_today'>): number {
  return dashboardHoursToMs(snapshot.hours_today)
}

export function elapsedSinceMs(since: string | null | undefined, now: number): number {
  const start = since ? new Date(since).getTime() : NaN
  return Number.isFinite(start) ? Math.max(0, now - start) : 0
}

export function profileFromWorkerSource(source: WorkerSource, existing?: Profile | null): Profile {
  if (existing) return existing
  return {
    id: source.profile_id,
    org_id: source.org_id,
    name: sourceName(source),
    role: source.role,
    language: 'en',
    is_active: true,
    project_access_mode: 'assigned',
  }
}

export function buildDashboardWorkerProfiles(
  assignments: readonly CurrentAssignmentRow[],
  unassigned: readonly UnassignedWorkerRow[],
  team: readonly Profile[],
  allowedRoles?: readonly Role[],
): Profile[] {
  const allowed = allowedRoles ? new Set<Role>(allowedRoles) : null
  const teamById = new Map(team.map((profile) => [profile.id, profile]))
  const seen = new Set<string>()
  const out: Profile[] = []

  for (const source of [...assignments, ...unassigned]) {
    if (seen.has(source.profile_id)) continue
    if (allowed && !allowed.has(source.role)) continue
    seen.add(source.profile_id)
    out.push(profileFromWorkerSource(source, teamById.get(source.profile_id)))
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function buildUnassignedWorkerProfiles(
  unassigned: readonly UnassignedWorkerRow[],
  team: readonly Profile[],
  allowedRoles?: readonly Role[],
): Profile[] {
  const allowed = allowedRoles ? new Set<Role>(allowedRoles) : null
  const teamById = new Map(team.map((profile) => [profile.id, profile]))
  return unassigned
    .filter((source) => !allowed || allowed.has(source.role))
    .map((source) => profileFromWorkerSource(source, teamById.get(source.profile_id)))
    .sort((a, b) => a.name.localeCompare(b.name))
}
