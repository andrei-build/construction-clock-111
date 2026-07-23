// DISPATCH-REDESIGN-50: чистое ядро worker-centric доски диспетчеризации (Командный центр).
// Никакого React/DOM — только модель «кто свободен, кто на каком проекте, что делает, счётчик
// остатка, валидность назначения/рокировки». Слова Андрея: слева проекты с назначенными и что
// каждый делает; справа ВСЕ свободные ребята со счётчиком «Осталось: N»; лёгкая рокировка.
//
// «Что делает» = задача (Task), назначенная на работника внутри проекта — она же уходит в
// «Разослать план» (sendDispatchPlan шлёт задачи проекта). Ставится существующим createTask;
// само назначение человека на проект — существующими assignWorkerToProject/unassignWorkerFromProject.
import type {
  CurrentAssignmentRow,
  Profile,
  Project,
  Role,
  Task,
  UnassignedWorkerRow,
} from './types'
import { buildUnassignedWorkerProfiles, profileFromWorkerSource } from './dashboardSnapshot'

// Бригадные роли, которых распределяем по проектам (как в конструкторе плана).
export const DISPATCH_CREW_ROLES: readonly Role[] = ['worker', 'driver', 'supervisor']

const ACTIVE_TASK_STATUSES = new Set<Task['status']>(['open', 'in_progress'])

export interface AssignedWorker {
  profile: Profile
  // note из project_assignments (если проставлен где-то ещё) — второстепенная подпись.
  note: string | null
  // Открытые задачи этого человека на этом проекте — это и есть «что делает».
  tasks: Task[]
}

export interface DispatchProjectGroup {
  project: Project
  workers: AssignedWorker[]
}

export interface DoubleAssignment {
  profileId: string
  name: string
  projects: string[]
}

export interface DispatchBoard {
  // Правая колонка: все незанятые бригадные работники (отсортированы по имени).
  free: Profile[]
  // Живой счётчик «Осталось: N».
  freeCount: number
  // Сколько уникальных людей уже распределено.
  assignedCount: number
  // Левая колонка: проекты, где есть хотя бы один назначенный (отсортированы по имени).
  groups: DispatchProjectGroup[]
  // Один и тот же человек на 2+ проектах — подсветка «что-то не так».
  doubleAssigned: DoubleAssignment[]
}

function activeTasksFor(tasks: readonly Task[], projectId: string, workerId: string): Task[] {
  return tasks.filter(
    (task) =>
      task.project_id === projectId &&
      task.assigned_to === workerId &&
      ACTIVE_TASK_STATUSES.has(task.status),
  )
}

// Уникальные project_id, на которые назначен человек.
export function workerProjectIds(
  assignments: readonly CurrentAssignmentRow[],
  workerId: string,
): string[] {
  const seen = new Set<string>()
  for (const a of assignments) {
    if (a.profile_id === workerId) seen.add(a.project_id)
  }
  return Array.from(seen)
}

export function isWorkerAssignedTo(
  assignments: readonly CurrentAssignmentRow[],
  workerId: string,
  projectId: string,
): boolean {
  return assignments.some((a) => a.profile_id === workerId && a.project_id === projectId)
}

// Можно ли назначить: человек ещё не на этом проекте (проект должен существовать в списке).
export function canAssign(
  assignments: readonly CurrentAssignmentRow[],
  projects: readonly Project[],
  workerId: string,
  projectId: string,
): boolean {
  if (!workerId || !projectId) return false
  if (!projects.some((p) => p.id === projectId)) return false
  return !isWorkerAssignedTo(assignments, workerId, projectId)
}

// Рокировка проект→проект: цель отличается от источника, человек на источнике и не на цели.
export function canSwap(
  assignments: readonly CurrentAssignmentRow[],
  workerId: string,
  fromProjectId: string,
  toProjectId: string,
): boolean {
  if (!workerId || !fromProjectId || !toProjectId) return false
  if (fromProjectId === toProjectId) return false
  if (!isWorkerAssignedTo(assignments, workerId, fromProjectId)) return false
  return !isWorkerAssignedTo(assignments, workerId, toProjectId)
}

export function findDoubleAssignments(
  assignments: readonly CurrentAssignmentRow[],
  team: readonly Profile[],
): DoubleAssignment[] {
  const nameById = new Map(team.map((p) => [p.id, p.name]))
  const projectsByWorker = new Map<string, Map<string, string>>()
  for (const a of assignments) {
    if (!projectsByWorker.has(a.profile_id)) projectsByWorker.set(a.profile_id, new Map())
    // project_name может быть null в строке назначения — подставим id как крайний случай.
    projectsByWorker.get(a.profile_id)!.set(a.project_id, a.project_name ?? a.project_id)
  }
  const out: DoubleAssignment[] = []
  for (const [profileId, projMap] of projectsByWorker) {
    if (projMap.size < 2) continue
    out.push({
      profileId,
      name: nameById.get(profileId) ?? '—',
      projects: Array.from(projMap.values()).sort((a, b) => a.localeCompare(b)),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function buildDispatchBoard(input: {
  projects: readonly Project[]
  team: readonly Profile[]
  assignments: readonly CurrentAssignmentRow[]
  unassigned: readonly UnassignedWorkerRow[]
  tasks: readonly Task[]
  roles?: readonly Role[]
}): DispatchBoard {
  const roles = input.roles ?? DISPATCH_CREW_ROLES
  const free = buildUnassignedWorkerProfiles(input.unassigned, input.team, roles)
  const teamById = new Map(input.team.map((p) => [p.id, p]))

  // Назначения по проектам (строка = проект×работник). Сохраняем note и профиль работника.
  const byProject = new Map<string, AssignedWorker[]>()
  const assignedProfiles = new Set<string>()
  for (const a of input.assignments) {
    assignedProfiles.add(a.profile_id)
    if (!byProject.has(a.project_id)) byProject.set(a.project_id, [])
    const profile =
      teamById.get(a.profile_id) ??
      profileFromWorkerSource({
        org_id: a.org_id,
        profile_id: a.profile_id,
        role: a.role,
        worker_name: a.worker_name,
      })
    // Один и тот же человек на одном проекте не должен дублироваться карточкой.
    const bucket = byProject.get(a.project_id)!
    if (bucket.some((w) => w.profile.id === a.profile_id)) continue
    bucket.push({
      profile,
      note: a.note,
      tasks: activeTasksFor(input.tasks, a.project_id, a.profile_id),
    })
  }

  const projectById = new Map(input.projects.map((p) => [p.id, p]))
  const groups: DispatchProjectGroup[] = []
  for (const [projectId, workers] of byProject) {
    const project = projectById.get(projectId)
    if (!project) continue
    workers.sort((a, b) => a.profile.name.localeCompare(b.profile.name))
    groups.push({ project, workers })
  }
  groups.sort((a, b) => a.project.name.localeCompare(b.project.name))

  return {
    free,
    freeCount: free.length,
    assignedCount: assignedProfiles.size,
    groups,
    doubleAssigned: findDoubleAssignments(input.assignments, input.team),
  }
}
