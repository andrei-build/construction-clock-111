import { supabase } from '../supabase'
import { logEvent } from './_shared'
import { TASK_SELECT, createMaterialRequest } from './tasks'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


// --- MAT-3: Спецификация материалов (plan-BOM, project_materials) ---
// БЕЗ цен — в таблице нет ценовых колонок. RLS: SELECT участники проекта; INSERT/UPDATE менеджер+.
const PROJECT_MATERIAL_SELECT =
  'id, org_id, project_id, section, name, qty, unit, supplier, url, note, sort_order, status, task_id, created_by, created_at, updated_at, deleted_at'

// Черновая позиция для формы/импорта — только пользовательские поля.
export interface ProjectMaterialInput {
  section?: string | null
  name: string
  qty?: number | null
  unit?: string | null
  supplier?: string | null
  url?: string | null
  note?: string | null
}

function cleanMaterialRow(p: Profile, projectId: string, row: ProjectMaterialInput, sortOrder: number) {
  return {
    org_id: p.org_id,
    project_id: projectId,
    created_by: p.id,
    section: row.section?.trim() || null,
    name: row.name.trim(),
    qty: row.qty ?? null,
    unit: row.unit?.trim() || null,
    supplier: row.supplier?.trim() || null,
    url: row.url?.trim() || null,
    note: row.note?.trim() || null,
    sort_order: sortOrder,
    status: 'plan' as MaterialSpecStatus,
  }
}

// Позиции спецификации проекта: не удалённые, по sort_order затем created_at.
export async function getProjectMaterials(projectId: string): Promise<ProjectMaterial[]> {
  const { data, error } = await supabase.from('project_materials')
    .select(PROJECT_MATERIAL_SELECT)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) return []
  return (data as unknown as ProjectMaterial[]) ?? []
}

// Связанные материальные/доставочные задачи проекта — источник живого статуса позиций
// (picked_up_at/delivered_at ставит MAT-1). Читаем и open, и закрытые (доставленная задача — done).
export async function getProjectMaterialTasks(projectId: string): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks')
    .select(TASK_SELECT)
    .eq('project_id', projectId)
    .in('task_type', ['material', 'delivery'])
  if (error) return []
  return (data as unknown as Task[]) ?? []
}

// Следующий свободный sort_order (max+1) для проекта.
async function nextMaterialSortOrder(projectId: string): Promise<number> {
  const { data } = await supabase.from('project_materials')
    .select('sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const max = (data as { sort_order: number | null } | null)?.sort_order
  return (typeof max === 'number' ? max : -1) + 1
}

// Одна новая позиция. created_at/updated_at — дефолты БД. org_id/created_by из p (RLS менеджер+).
export async function createProjectMaterial(p: Profile, projectId: string, row: ProjectMaterialInput): Promise<ProjectMaterial> {
  const sortOrder = await nextMaterialSortOrder(projectId)
  const { data, error } = await supabase.from('project_materials')
    .insert(cleanMaterialRow(p, projectId, row, sortOrder))
    .select(PROJECT_MATERIAL_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'project_material.created', 'project', projectId, { name: row.name })
  return data as unknown as ProjectMaterial
}

// Пакетная вставка (импорт из Excel/CSV). Пустые name отбрасываем, sort_order последователен.
export async function bulkInsertProjectMaterials(p: Profile, projectId: string, rows: ProjectMaterialInput[]): Promise<ProjectMaterial[]> {
  const clean = rows.filter((r) => r.name && r.name.trim())
  if (clean.length === 0) return []
  const base = await nextMaterialSortOrder(projectId)
  const payload = clean.map((row, i) => cleanMaterialRow(p, projectId, row, base + i))
  const { data, error } = await supabase.from('project_materials')
    .insert(payload)
    .select(PROJECT_MATERIAL_SELECT)
    .order('sort_order', { ascending: true })
  if (error) throw error
  await logEvent(p, 'project_material.imported', 'project', projectId, { count: clean.length })
  return (data as unknown as ProjectMaterial[]) ?? []
}

// Правка позиции (менеджер). updated_at обновит touch-триггер.
export async function updateProjectMaterial(
  _p: Profile,
  id: string,
  patch: Partial<ProjectMaterialInput> & { status?: MaterialSpecStatus; task_id?: string | null },
): Promise<ProjectMaterial> {
  const { data, error } = await supabase.from('project_materials')
    .update(patch)
    .eq('id', id)
    .select(PROJECT_MATERIAL_SELECT)
    .single()
  if (error) throw error
  return data as unknown as ProjectMaterial
}

// Мягкое удаление позиции: deleted_at = now() (RLS UPDATE менеджер+).
export async function softDeleteProjectMaterial(_p: Profile, id: string): Promise<void> {
  const { error } = await supabase.from('project_materials')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// «В заявку»: создаём существующую материальную заявку (createMaterialRequest — уведомляет водителей),
// затем привязываем task_id и переводим позицию в 'requested'. Дальнейший статус (забор/доставка)
// отражается из связанной задачи, не пишется в спецификацию.
export async function requestProjectMaterial(p: Profile, material: ProjectMaterial): Promise<ProjectMaterial> {
  const descParts = [
    material.qty != null ? `${material.qty}${material.unit ? ' ' + material.unit : ''}` : (material.unit || null),
    material.supplier || null,
    material.note || null,
  ].filter(Boolean)
  const task = await createMaterialRequest(p, {
    projectId: material.project_id,
    title: material.name,
    description: descParts.length ? descParts.join(' · ') : null,
  })
  return updateProjectMaterial(p, material.id, { task_id: task.id, status: 'requested' })
}
