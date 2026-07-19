import { describe, expect, it } from 'vitest'
import { materialsToDeliveryItemDrafts, materialToDeliveryItemDraft } from '../src/lib/materialDelivery'
import type { ProjectMaterial } from '../src/lib/types'

function material(patch: Partial<ProjectMaterial>): ProjectMaterial {
  return {
    id: 'mat-1',
    org_id: 'org-1',
    project_id: 'proj-1',
    section: null,
    name: 'Tile',
    qty: null,
    unit: null,
    supplier: null,
    url: null,
    note: null,
    sort_order: 0,
    status: 'plan',
    task_id: null,
    needed_by: null,
    created_by: 'user-1',
    created_at: '2026-07-19T00:00:00Z',
    updated_at: '2026-07-19T00:00:00Z',
    ...patch,
  }
}

describe('material delivery payload mapping', () => {
  it('maps material fields to delivery item title/details/needed_by', () => {
    const draft = materialToDeliveryItemDraft(material({
      name: 'Thinset',
      qty: 3,
      unit: 'bags',
      section: 'Shower walls',
      note: 'White',
      needed_by: '2026-07-25',
    }), 2)

    expect(draft).toEqual({
      source_material_id: 'mat-1',
      position: 2,
      title: 'Thinset · 3 bags',
      details: 'Shower walls · White',
      needed_by: '2026-07-25',
    })
  })

  it('preserves order and keeps empty optional fields null', () => {
    const drafts = materialsToDeliveryItemDrafts([
      material({ id: 'a', name: 'Outlet box' }),
      material({ id: 'b', name: 'Wire', qty: 50, unit: 'ft', note: '12/2' }),
    ])

    expect(drafts.map((row) => row.position)).toEqual([0, 1])
    expect(drafts[0]).toMatchObject({ source_material_id: 'a', title: 'Outlet box', details: null, needed_by: null })
    expect(drafts[1]).toMatchObject({ source_material_id: 'b', title: 'Wire · 50 ft', details: '12/2' })
  })
})
