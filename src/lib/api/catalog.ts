import { supabase } from '../supabase'
import { logEvent, warnReadError } from './_shared'
import { AVATARS_BUCKET, validateUpload, safeFileName, inferUploadContentType } from './storage'
import type { Profile } from '../types'

// CATALOG-UI-1: каталог позиций (таблица catalog_items, миграция 0065). Позиции потом
// расставляются в 3D-визуализации. Схема проверена живьём — колонки НЕ выдумываем.
export type CatalogCategory = 'shower' | 'vanity' | 'cabinet' | 'light' | 'fan' | 'tile' | 'other'
export type CatalogItemSpecs = Record<string, string>

export const CATALOG_CATEGORIES: CatalogCategory[] = ['shower', 'vanity', 'cabinet', 'light', 'fan', 'tile', 'other']

export interface CatalogItem {
  id: string
  org_id: string
  category: CatalogCategory
  name: string
  brand: string | null
  model: string | null
  width_in: number | null
  depth_in: number | null
  height_in: number | null
  photo_path: string | null
  price: number | null
  specs: CatalogItemSpecs | null
  price_updated_at?: string | null
  url: string | null
  note: string | null
  is_active: boolean
  sort_order: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CatalogPriceHistoryRow {
  id?: string
  item_id?: string
  catalog_item_id?: string
  price?: number | string | null
  source?: string | null
  old_price?: number | string | null
  previous_price?: number | string | null
  new_price?: number | string | null
  recorded_at?: string | null
  created_at?: string | null
  changed_at?: string | null
  updated_at?: string | null
  [key: string]: unknown
}

export interface CatalogItemInput {
  category: CatalogCategory
  name: string
  brand?: string | null
  model?: string | null
  width_in?: number | null
  depth_in?: number | null
  height_in?: number | null
  photo_path?: string | null
  price?: number | null
  specs?: CatalogItemSpecs | null
  url?: string | null
  note?: string | null
  is_active?: boolean
  sort_order?: number
}

const CATALOG_SELECT =
  'id, org_id, category, name, brand, model, width_in, depth_in, height_in, photo_path, price, specs, price_updated_at, url, note, is_active, sort_order, created_by, created_at, updated_at'

// Читают все члены орг (кроме роли client) — RLS сам ограничивает выборку своей организацией.
// Порядок: категория → sort_order → имя, чтобы сгруппировать по разделам в UI.
export async function getCatalogItems(): Promise<CatalogItem[]> {
  const { data, error } = await supabase
    .from('catalog_items')
    .select(CATALOG_SELECT)
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (error) {
    warnReadError('getCatalogItems', error)
    return []
  }
  return (data ?? []) as CatalogItem[]
}

export async function getCatalogPriceHistory(catalogItemId: string, limit = 5): Promise<CatalogPriceHistoryRow[]> {
  const capped = Math.max(1, Math.min(20, Math.floor(limit)))
  const ordered = await supabase
    .from('catalog_price_history')
    .select('*')
    .eq('item_id', catalogItemId)
    .order('recorded_at', { ascending: false })
    .limit(capped)
  if (!ordered.error) return (ordered.data ?? []) as CatalogPriceHistoryRow[]

  const fallback = await supabase
    .from('catalog_price_history')
    .select('*')
    .eq('item_id', catalogItemId)
    .limit(capped)
  if (fallback.error) {
    warnReadError('getCatalogPriceHistory', fallback.error)
    return []
  }
  return ((fallback.data ?? []) as CatalogPriceHistoryRow[]).sort((a, b) => {
    const aTime = new Date(String(a.recorded_at ?? a.created_at ?? a.changed_at ?? a.updated_at ?? '')).getTime()
    const bTime = new Date(String(b.recorded_at ?? b.created_at ?? b.changed_at ?? b.updated_at ?? '')).getTime()
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
  })
}

// org_id проставляется по членству текущего пользователя (как в остальных create-функциях).
// is_active/sort_order NOT NULL — задаём явные дефолты, если вызывающий их не передал.
export async function createCatalogItem(p: Profile, input: CatalogItemInput): Promise<CatalogItem> {
  const { data, error } = await supabase
    .from('catalog_items')
    .insert({
      org_id: p.org_id,
      created_by: p.id,
      is_active: input.is_active ?? true,
      sort_order: input.sort_order ?? 0,
      ...input,
    })
    .select(CATALOG_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'catalog_item.created', 'catalog_item', data.id, { category: input.category })
  return data as CatalogItem
}

export async function updateCatalogItem(p: Profile, id: string, input: Partial<CatalogItemInput>): Promise<CatalogItem> {
  const { data, error } = await supabase
    .from('catalog_items')
    .update({ ...input })
    .eq('id', id)
    .select(CATALOG_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'catalog_item.updated', 'catalog_item', id, {})
  return data as CatalogItem
}

// Быстрый тумблер вкл/выкл позиции — не трогает прочие поля.
export async function setCatalogItemActive(p: Profile, id: string, isActive: boolean): Promise<CatalogItem> {
  const { data, error } = await supabase
    .from('catalog_items')
    .update({ is_active: isActive })
    .eq('id', id)
    .select(CATALOG_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'catalog_item.active_toggled', 'catalog_item', id, { is_active: isActive })
  return data as CatalogItem
}

// Жёсткое удаление (в схеме нет deleted_at). RLS пускает только manager+.
export async function deleteCatalogItem(p: Profile, id: string): Promise<void> {
  const { error } = await supabase.from('catalog_items').delete().eq('id', id)
  if (error) throw error
  await logEvent(p, 'catalog_item.deleted', 'catalog_item', id, {})
}

// Фото позиции: переиспользуем публичный bucket аватаров (AVATARS_BUCKET) и те же
// upload-хелперы, что uploadClientLogo — валидация, безопасное имя, content-type. Возвращаем
// публичный URL и кладём его прямо в catalog_items.photo_path (стабильная public-ссылка).
export async function uploadCatalogPhoto(p: Profile, file: File): Promise<string> {
  validateUpload(file, 'photo')
  const ext = safeFileName(file.name, file.type).split('.').pop() || 'jpg'
  const storagePath = `catalog/${p.org_id}/${Date.now()}-${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from(AVATARS_BUCKET)
    .upload(storagePath, file, { contentType: inferUploadContentType(file), upsert: false })
  if (uploadError) throw uploadError
  const { data: pub } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(storagePath)
  return pub.publicUrl
}
