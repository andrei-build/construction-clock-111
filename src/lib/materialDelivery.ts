import type { ProjectMaterial } from './types'

export interface MaterialDeliveryItemDraft {
  source_material_id: string
  position: number
  title: string
  details: string | null
  needed_by: string | null
}

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text ? text : null
}

function formatQty(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '')
}

function materialQuantityLabel(material: Pick<ProjectMaterial, 'qty' | 'unit'>): string | null {
  const qty = formatQty(material.qty)
  const unit = cleanText(material.unit)
  return [qty, unit].filter((part): part is string => Boolean(part)).join(' ').trim() || null
}

export function materialToDeliveryItemDraft(material: ProjectMaterial, position: number): MaterialDeliveryItemDraft {
  const quantity = materialQuantityLabel(material)
  const section = cleanText(material.section)
  const note = cleanText(material.note)
  const details = [section, note].filter((part): part is string => Boolean(part)).join(' · ') || null
  const neededBy = cleanText(material.needed_by)

  return {
    source_material_id: material.id,
    position,
    title: quantity ? `${material.name} · ${quantity}` : material.name,
    details,
    needed_by: neededBy,
  }
}

export function materialsToDeliveryItemDrafts(materials: ProjectMaterial[]): MaterialDeliveryItemDraft[] {
  return materials.map((material, index) => materialToDeliveryItemDraft(material, index))
}
