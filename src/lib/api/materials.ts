import { supabase } from '../supabase'
import { logEvent, warnReadError } from './_shared'
import { TASK_SELECT, addDeliveryItems, createMaterialRequest, createTask } from './tasks'
import { materialsToDeliveryItemDrafts } from '../materialDelivery'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment, DeliveryItem } from '../types'


// --- MAT-3: Спецификация материалов (plan-BOM, project_materials) ---
// БЕЗ цен — в таблице нет ценовых колонок. RLS: SELECT участники проекта; INSERT/UPDATE менеджер+.
const PROJECT_MATERIAL_SELECT =
  'id, org_id, project_id, section, name, qty, unit, supplier, url, note, sort_order, status, task_id, needed_by, created_by, created_at, updated_at, deleted_at'

// Черновая позиция для формы/импорта — только пользовательские поля.
export interface ProjectMaterialInput {
  section?: string | null
  name: string
  qty?: number | null
  unit?: string | null
  supplier?: string | null
  url?: string | null
  note?: string | null
  needed_by?: string | null
}

export type TileNormPattern = 'straight' | 'offset' | 'diagonal' | 'herringbone'

export interface TileMaterialNormParams {
  coverage_sqft_per_bag: number | null
  bag_lb: number | null
  waste_by_pattern: Partial<Record<TileNormPattern, number | null>>
  lnft_per_tube: number | null
  [key: string]: unknown
}

export interface TileMaterialNorm {
  id?: string
  org_id?: string | null
  work_type: 'tile'
  source: string
  waste_pct: number | null
  params: TileMaterialNormParams
  updated_at?: string | null
}

export interface TileMaterialNormInput {
  waste_pct: number | null
  params: TileMaterialNormParams
}

export const TILE_NORM_DEFAULTS: TileMaterialNormInput = {
  waste_pct: 10,
  params: {
    coverage_sqft_per_bag: 80,
    bag_lb: 50,
    waste_by_pattern: {
      straight: 10,
      offset: 10,
      diagonal: 15,
      herringbone: 15,
    },
    lnft_per_tube: 25,
  },
}

function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function normalizeTileNormParams(value: unknown): TileMaterialNormParams {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const wasteRaw = raw.waste_by_pattern && typeof raw.waste_by_pattern === 'object' && !Array.isArray(raw.waste_by_pattern)
    ? raw.waste_by_pattern as Record<string, unknown>
    : {}
  return {
    ...raw,
    coverage_sqft_per_bag: finiteNumberOrNull(raw.coverage_sqft_per_bag),
    bag_lb: finiteNumberOrNull(raw.bag_lb),
    waste_by_pattern: {
      straight: finiteNumberOrNull(wasteRaw.straight) ?? undefined,
      offset: finiteNumberOrNull(wasteRaw.offset) ?? undefined,
      diagonal: finiteNumberOrNull(wasteRaw.diagonal) ?? undefined,
      herringbone: finiteNumberOrNull(wasteRaw.herringbone) ?? undefined,
    },
    lnft_per_tube: finiteNumberOrNull(raw.lnft_per_tube),
  }
}

function normalizeTileMaterialNorm(row: Record<string, unknown>): TileMaterialNorm {
  return {
    id: typeof row.id === 'string' ? row.id : undefined,
    org_id: typeof row.org_id === 'string' ? row.org_id : null,
    work_type: 'tile',
    source: typeof row.source === 'string' && row.source ? row.source : 'andrew',
    waste_pct: finiteNumberOrNull(row.waste_pct),
    params: normalizeTileNormParams(row.params),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
  }
}

export async function getTileMaterialNorm(): Promise<TileMaterialNorm | null> {
  const { data, error } = await supabase.from('material_norms')
    .select('*')
    .eq('work_type', 'tile')
  if (error) {
    warnReadError('getTileMaterialNorm', error)
    return null
  }
  const rows = (data ?? []) as Record<string, unknown>[]
  const row = rows.find((r) => r.source === 'andrew') ?? rows[0] ?? null
  return row ? normalizeTileMaterialNorm(row) : null
}

export async function saveTileMaterialNorm(p: Profile, input: TileMaterialNormInput): Promise<TileMaterialNorm> {
  const current = await getTileMaterialNorm()
  const currentParams = current?.params ?? TILE_NORM_DEFAULTS.params
  const payload = {
    org_id: p.org_id,
    work_type: 'tile',
    source: 'andrew',
    waste_pct: input.waste_pct,
    params: {
      ...currentParams,
      ...input.params,
      waste_by_pattern: {
        ...(currentParams.waste_by_pattern ?? {}),
        ...(input.params.waste_by_pattern ?? {}),
      },
    },
  }

  if (current) {
    let query = supabase.from('material_norms')
      .update(payload)
      .eq('work_type', 'tile')
    if (current.id) query = query.eq('id', current.id)
    else {
      query = query.eq('source', current.source || 'andrew')
      if (current.org_id) query = query.eq('org_id', current.org_id)
    }
    const { data, error } = await query.select('*').single()
    if (error) throw error
    await logEvent(p, 'material_norm.tile_updated', 'org', p.org_id, { source: 'andrew' })
    return normalizeTileMaterialNorm(data as Record<string, unknown>)
  }

  const { data, error } = await supabase.from('material_norms')
    .insert(payload)
    .select('*')
    .single()
  if (error) throw error
  await logEvent(p, 'material_norm.tile_created', 'org', p.org_id, { source: 'andrew' })
  return normalizeTileMaterialNorm(data as Record<string, unknown>)
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
    needed_by: row.needed_by?.trim() || null,
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

export async function updateProjectMaterialNeededBy(
  p: Profile,
  id: string,
  neededBy: string | null,
): Promise<ProjectMaterial> {
  return updateProjectMaterial(p, id, { needed_by: neededBy?.trim() || null })
}

export interface CreateDeliveryFromProjectMaterialsInput {
  projectId: string
  title: string
  description?: string | null
  materials: ProjectMaterial[]
}

export interface CreateDeliveryFromProjectMaterialsResult {
  taskId: string
  items: DeliveryItem[]
  materials: ProjectMaterial[]
}

export async function createDeliveryFromProjectMaterials(
  p: Profile,
  input: CreateDeliveryFromProjectMaterialsInput,
): Promise<CreateDeliveryFromProjectMaterialsResult> {
  const materials = input.materials.filter((m) => m.name.trim())
  if (materials.length === 0) throw new Error('no_materials_for_delivery')

  const taskId = await createTask(p, {
    project_id: input.projectId,
    title: input.title.trim(),
    task_type: 'delivery',
    priority: 'urgent',
    description: input.description?.trim() || null,
  })
  const taskForItems = {
    id: taskId,
    org_id: p.org_id,
    project_id: input.projectId,
  } as Task
  const itemDrafts = materialsToDeliveryItemDrafts(materials)
  const items = await addDeliveryItems(p, taskForItems, itemDrafts.map((item) => ({
    title: item.title,
    details: item.details,
    needed_by: item.needed_by,
    position: item.position,
  })))

  const ids = materials.map((m) => m.id)
  const { data, error } = await supabase.from('project_materials')
    .update({ task_id: taskId, status: 'requested' as MaterialSpecStatus })
    .in('id', ids)
    .select(PROJECT_MATERIAL_SELECT)
    .order('sort_order', { ascending: true })
  if (error) throw error
  await logEvent(p, 'project_material.delivery_created', 'project', input.projectId, {
    task_id: taskId,
    count: materials.length,
  })

  return {
    taskId,
    items,
    materials: (data as unknown as ProjectMaterial[]) ?? [],
  }
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
