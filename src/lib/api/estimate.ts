import { supabase } from '../supabase'
import {
  clampBbox,
  normalizeKind,
  normalizeSeverity,
  type PinKind,
  type PinSeverity,
  type PlanPinBbox,
} from '../planPinCore'
import {
  canTransition,
  isStatus,
  normalizeStatus,
  type EstimateStatus,
} from '../estimateCore'
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

// numeric из БД приходит как number | string (jsonb/decimal) | null; нормализуем к числу (fallback 0).
function numOr(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
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

// === ESTIMATE-REVIEW-39 (серия PLAN-TO-ESTIMATE, 3/4): экран «Смета (черновик)». ===
// ТОЛЬКО read + update по живой схеме (estimate_drafts / estimate_items). НЕТ insert/delete estimate_*,
// НЕТ схемы/миграций/rpc. RLS сама гейтит доступ (Финансы = owner/finance) — здесь роль не проверяем.
// Читаем защитно: [] на ошибке/пусто (пустая смета = пустой экран, не падение). Пишем строго —
// updateEstimateStatus/updateEstimateItem бросают при ошибке, UI показывает сбой.

const ESTIMATE_DRAFT_SELECT =
  'id, org_id, project_id, source_file_ids, status, title, subtotal, contingency_pct, total, engine_meta, created_by, created_at, updated_at'

export interface EstimateDraft {
  id: string
  org_id: string
  project_id: string
  source_file_ids: string[]
  status: EstimateStatus
  title: string | null
  subtotal: number
  contingency_pct: number
  total: number
  engine_meta: Record<string, unknown> | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

const ESTIMATE_ITEM_SELECT =
  'id, org_id, draft_id, section, cost_code, description, qty, unit, unit_price, markup_pct, line_total, source, confidence, flag, needs_measure, position, created_at'

// source — свободный jsonb, напр. {kind:'page'|'rule'|'norm'|'catalog', page:N, file_id}. Разбирает
// его чистое ядро estimateCore (sourceKind/sourcePage/sourceFileId), здесь — только сырой объект.
export interface EstimateItemSource {
  kind?: string | null
  page?: number | null
  file_id?: string | null
  [key: string]: unknown
}

export interface EstimateItem {
  id: string
  org_id: string
  draft_id: string
  section: string | null
  cost_code: string | null
  description: string | null
  qty: number
  unit: string | null
  unit_price: number
  markup_pct: number
  line_total: number
  source: EstimateItemSource | null
  confidence: number | null
  flag: string | null
  needs_measure: boolean
  position: number
  created_at: string | null
}

function normalizeDraft(row: Record<string, unknown>): EstimateDraft {
  return {
    id: String(row.id ?? ''),
    org_id: String(row.org_id ?? ''),
    project_id: String(row.project_id ?? ''),
    source_file_ids: Array.isArray(row.source_file_ids)
      ? (row.source_file_ids as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
    status: normalizeStatus(row.status),
    title: str(row.title),
    subtotal: numOr(row.subtotal),
    contingency_pct: numOr(row.contingency_pct),
    total: numOr(row.total),
    engine_meta:
      row.engine_meta && typeof row.engine_meta === 'object' && !Array.isArray(row.engine_meta)
        ? (row.engine_meta as Record<string, unknown>)
        : null,
    created_by: str(row.created_by),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  }
}

function normalizeItem(row: Record<string, unknown>): EstimateItem {
  const rawSource = row.source
  const source =
    rawSource && typeof rawSource === 'object' && !Array.isArray(rawSource)
      ? (rawSource as EstimateItemSource)
      : null
  return {
    id: String(row.id ?? ''),
    org_id: String(row.org_id ?? ''),
    draft_id: String(row.draft_id ?? ''),
    section: str(row.section),
    cost_code: str(row.cost_code),
    description: str(row.description),
    qty: numOr(row.qty),
    unit: str(row.unit),
    unit_price: numOr(row.unit_price),
    markup_pct: numOr(row.markup_pct),
    line_total: numOr(row.line_total),
    source,
    confidence: row.confidence == null ? null : numOr(row.confidence),
    flag: str(row.flag),
    needs_measure: row.needs_measure === true,
    position: numOr(row.position),
    created_at: str(row.created_at),
  }
}

export interface ListEstimateDraftsParams {
  projectId: string
}

// Черновики смет проекта (новейшие сверху). RLS гейтит finance/owner — [] на ошибке/пусто.
export async function listEstimateDrafts(
  _profile: Profile,
  params: ListEstimateDraftsParams,
): Promise<EstimateDraft[]> {
  const { data, error } = await supabase
    .from('estimate_drafts')
    .select(ESTIMATE_DRAFT_SELECT)
    .eq('project_id', params.projectId)
    .order('created_at', { ascending: false })
  if (error) return []
  return ((data as Record<string, unknown>[] | null) ?? []).map(normalizeDraft)
}

export interface ListEstimateItemsParams {
  draftId: string
}

// Строки сметы одного черновика по position, затем created_at. [] на ошибке/пусто.
export async function listEstimateItems(
  _profile: Profile,
  params: ListEstimateItemsParams,
): Promise<EstimateItem[]> {
  const { data, error } = await supabase
    .from('estimate_items')
    .select(ESTIMATE_ITEM_SELECT)
    .eq('draft_id', params.draftId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) return []
  return ((data as Record<string, unknown>[] | null) ?? []).map(normalizeItem)
}

export interface UpdateEstimateStatusParams {
  draftId: string
  status: EstimateStatus
}

// Смена статуса строго вперёд (draft→review→approved, по одному шагу). Текущий статус читаем из БД
// и валидируем canTransition (ядро) ДО записи — никакого авто-approve/отката/скипа. Бросаем при
// запрете перехода или ошибке БД; UI ловит и показывает сбой, список остаётся живым.
export async function updateEstimateStatus(
  _profile: Profile,
  params: UpdateEstimateStatusParams,
): Promise<EstimateDraft> {
  const target = params.status
  if (!isStatus(target)) throw new Error('estimate: invalid target status')
  const { data: current, error: readError } = await supabase
    .from('estimate_drafts')
    .select('status')
    .eq('id', params.draftId)
    .single()
  if (readError) throw readError
  const from = normalizeStatus((current as { status?: unknown } | null)?.status)
  if (!canTransition(from, target)) {
    throw new Error(`estimate: forbidden transition ${from} -> ${target}`)
  }
  const { data, error } = await supabase
    .from('estimate_drafts')
    .update({ status: target, updated_at: new Date().toISOString() })
    .eq('id', params.draftId)
    .select(ESTIMATE_DRAFT_SELECT)
    .single()
  if (error) throw error
  return normalizeDraft(data as Record<string, unknown>)
}

// Правка строки сметы: разрешён только белый список полей. Числа нормализуем, строки тримим к null.
export interface EstimateItemPatch {
  qty?: number | null
  unit?: string | null
  unit_price?: number | null
  description?: string | null
  section?: string | null
  flag?: string | null
  needs_measure?: boolean
}

export interface UpdateEstimateItemParams {
  itemId: string
  patch: EstimateItemPatch
}

export async function updateEstimateItem(
  _profile: Profile,
  params: UpdateEstimateItemParams,
): Promise<EstimateItem> {
  const patch = params.patch ?? {}
  const update: Record<string, unknown> = {}
  // Только явно переданные разрешённые поля попадают в UPDATE (частичный патч).
  if ('qty' in patch) update.qty = numOr(patch.qty)
  if ('unit_price' in patch) update.unit_price = numOr(patch.unit_price)
  if ('unit' in patch) update.unit = patch.unit?.trim() || null
  if ('description' in patch) update.description = patch.description?.trim() || null
  if ('section' in patch) update.section = patch.section?.trim() || null
  if ('flag' in patch) update.flag = patch.flag?.trim() || null
  if ('needs_measure' in patch) update.needs_measure = patch.needs_measure === true
  if (Object.keys(update).length === 0) throw new Error('estimate: empty item patch')
  const { data, error } = await supabase
    .from('estimate_items')
    .update(update)
    .eq('id', params.itemId)
    .select(ESTIMATE_ITEM_SELECT)
    .single()
  if (error) throw error
  return normalizeItem(data as Record<string, unknown>)
}
