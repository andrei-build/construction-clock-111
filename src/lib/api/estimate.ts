import { supabase } from '../supabase'
import {
  clampBbox,
  normalizeKind,
  normalizeSeverity,
  type PinKind,
  type PinSeverity,
  type PlanPinBbox,
} from '../planPinCore'
import type { Profile } from '../types'

// PIN-LAYER-38 (серия PLAN-TO-ESTIMATE): read/insert слоя пинов plan_pins поверх встроенного
// просмотрщика PDF/изображений (FileViewer, #37). RLS сама гейтит доступ: SELECT — участник org
// (не client); INSERT/UPDATE — только owner/admin. Здесь НЕ проверяем роль повторно — доверяем БД,
// а UI просто прячет кнопку добавления не-менеджерам. Читаем защитно: [] на ошибке/пусто, НЕ бросаем
// в UI-слой (пустая таблица/файл без пинов = пустой слой, не падение).

const PLAN_PIN_SELECT =
  'id, org_id, project_id, file_id, page, bbox, severity, kind, title, note, estimate_item_id, created_by, created_at'

export interface PlanPin {
  id: string
  org_id: string
  project_id: string
  file_id: string | null
  page: number
  bbox: PlanPinBbox
  severity: PinSeverity
  kind: PinKind
  title: string | null
  note: string | null
  estimate_item_id: string | null
  created_by: string | null
  created_at: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

// Строка БД → типизированный PlanPin. bbox/severity/kind нормализуем через чистое ядро planPinCore,
// чтобы кривой jsonb из БД не ронял слой.
function normalizePlanPin(row: Record<string, unknown>): PlanPin {
  return {
    id: String(row.id ?? ''),
    org_id: String(row.org_id ?? ''),
    project_id: String(row.project_id ?? ''),
    file_id: str(row.file_id),
    page: typeof row.page === 'number' && Number.isFinite(row.page) ? Math.round(row.page) : 1,
    bbox: clampBbox(row.bbox),
    severity: normalizeSeverity(row.severity),
    kind: normalizeKind(row.kind),
    title: str(row.title),
    note: str(row.note),
    estimate_item_id: str(row.estimate_item_id),
    created_by: str(row.created_by),
    created_at: str(row.created_at),
  }
}

export interface ListPlanPinsParams {
  projectId: string
  fileId?: string | null
}

// Пины проекта (опц. одного файла). RLS уже гейтит org/роль — здесь только фильтр по project/file.
// Возвращаем [] на любой ошибке/пусто, чтобы UI-слой никогда не падал.
export async function listPlanPins(_profile: Profile, params: ListPlanPinsParams): Promise<PlanPin[]> {
  let query = supabase.from('plan_pins').select(PLAN_PIN_SELECT).eq('project_id', params.projectId)
  if (params.fileId) query = query.eq('file_id', params.fileId)
  const { data, error } = await query
  if (error) return []
  return ((data as Record<string, unknown>[] | null) ?? []).map(normalizePlanPin)
}

export interface CreatePlanPinInput {
  projectId: string
  fileId?: string | null
  page?: number | null
  bbox: PlanPinBbox
  severity?: PinSeverity
  kind?: PinKind
  title?: string | null
  note?: string | null
}

// Новый пин (RLS: только owner/admin). org_id/created_by из профиля; bbox/severity/kind нормализуем.
// Бросаем при ошибке — вызывающий (форма в FileViewer) покажет сбой, но список остаётся живым.
export async function createPlanPin(profile: Profile, input: CreatePlanPinInput): Promise<PlanPin> {
  const { data, error } = await supabase
    .from('plan_pins')
    .insert({
      org_id: profile.org_id,
      project_id: input.projectId,
      file_id: input.fileId ?? null,
      page: input.page != null && Number.isFinite(input.page) ? Math.round(input.page) : 1,
      bbox: clampBbox(input.bbox),
      severity: normalizeSeverity(input.severity),
      kind: normalizeKind(input.kind),
      title: input.title?.trim() || null,
      note: input.note?.trim() || null,
      created_by: profile.id,
    })
    .select(PLAN_PIN_SELECT)
    .single()
  if (error) throw error
  return normalizePlanPin(data as Record<string, unknown>)
}
