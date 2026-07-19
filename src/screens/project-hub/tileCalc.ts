import { supabase } from '../../lib/supabase'
import type { Profile, ProjectMaterial } from '../../lib/types'
import type { ProjectMaterialInput } from '../../lib/api'

export type TileCalcPattern = 'straight' | 'offset' | 'diagonal' | 'herringbone'

export const TILE_CALC_PATTERNS: TileCalcPattern[] = ['straight', 'offset', 'diagonal', 'herringbone']
export const TILE_MATERIAL_SECTION = 'Плитка'

export interface TileCalcRpcInput {
  areaSqft: number
  tileWIn: number
  tileHIn: number
  jointIn: number
  tileThicknessIn: number
  pattern: TileCalcPattern
  boxSqft?: number | null
  pricePerBox?: number | null
  catalogItemId?: string | null
  perimeterLnft?: number | null
  includeSubstrate: boolean
  includeWaterproofing: boolean
}

export interface TileCalcItem {
  key: string
  name: string
  qty: number | null
  unit: string | null
  detail: string | null
  price?: number | null
  total?: number | null
}

export interface TileCalcResult {
  input: Record<string, unknown>
  items: TileCalcItem[]
  totals: {
    known_total: number | null
    complete: boolean
  }
  norms_source: 'org' | 'industry_defaults'
}

const PROJECT_MATERIAL_SELECT =
  'id, org_id, project_id, section, name, qty, unit, supplier, url, note, sort_order, status, task_id, needed_by, created_by, created_at, updated_at, deleted_at'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function buildTileCalcRpcArgs(input: TileCalcRpcInput) {
  return {
    p_area_sqft: input.areaSqft,
    p_tile_w_in: input.tileWIn,
    p_tile_h_in: input.tileHIn,
    p_joint_in: input.jointIn,
    p_tile_thickness_in: input.tileThicknessIn,
    p_pattern: input.pattern,
    p_box_sqft: input.boxSqft ?? null,
    p_price_per_box: input.catalogItemId ? null : input.pricePerBox ?? null,
    p_catalog_item_id: input.catalogItemId || null,
    p_perimeter_lnft: input.perimeterLnft ?? null,
    p_include_substrate: input.includeSubstrate,
    p_include_waterproofing: input.includeWaterproofing,
  }
}

export function normalizeTileCalcResult(value: unknown): TileCalcResult {
  const root = asRecord(value)
  const totals = asRecord(root.totals)
  const rawItems = Array.isArray(root.items) ? root.items : []
  const items = rawItems.map((raw) => {
    const row = asRecord(raw)
    return {
      key: stringOrNull(row.key) ?? stringOrNull(row.name) ?? 'item',
      name: stringOrNull(row.name) ?? '',
      qty: numOrNull(row.qty),
      unit: stringOrNull(row.unit),
      detail: stringOrNull(row.detail),
      price: numOrNull(row.price),
      total: numOrNull(row.total),
    }
  }).filter((row) => row.name)

  return {
    input: asRecord(root.input),
    items,
    totals: {
      known_total: numOrNull(totals.known_total),
      complete: typeof totals.complete === 'boolean' ? totals.complete : false,
    },
    norms_source: root.norms_source === 'org' ? 'org' : 'industry_defaults',
  }
}

export async function calculateTileMaterials(input: TileCalcRpcInput): Promise<TileCalcResult> {
  const { data, error } = await supabase.rpc('calc_tile_materials', buildTileCalcRpcArgs(input))
  if (error) throw error
  return normalizeTileCalcResult(data)
}

export function tileCalcItemsToProjectMaterialInputs(items: TileCalcItem[]): ProjectMaterialInput[] {
  return items
    .filter((item) => item.name.trim())
    .map((item) => ({
      section: TILE_MATERIAL_SECTION,
      name: item.name,
      qty: item.qty,
      unit: item.unit,
      note: item.detail,
    }))
}

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

export async function appendTileCalcMaterials(
  profile: Profile,
  projectId: string,
  items: TileCalcItem[],
): Promise<ProjectMaterial[]> {
  const inputs = tileCalcItemsToProjectMaterialInputs(items)
  if (inputs.length === 0) return []
  const base = await nextMaterialSortOrder(projectId)
  const payload = inputs.map((item, idx) => ({
    org_id: profile.org_id,
    project_id: projectId,
    section: item.section,
    name: item.name,
    qty: item.qty,
    unit: item.unit,
    status: 'plan',
    note: item.note,
    sort_order: base + idx,
    created_by: profile.id,
  }))
  const { data, error } = await supabase.from('project_materials')
    .insert(payload)
    .select(PROJECT_MATERIAL_SELECT)
    .order('sort_order', { ascending: true })
  if (error) throw error
  return (data as unknown as ProjectMaterial[]) ?? []
}
